import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ExportError, LIMITS, parseCsv, parseDate, readExportFiles, readExportZip, sampleExport, toTable } from '../src/assess/linkedinExport';

const NOW = new Date(Date.UTC(2026, 10, 22, 12, 0, 0));
const rules = (r: ReturnType<typeof sampleExport>) => r.findings.map((f) => f.rule);

describe('the CSV reader', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside a field, and a byte-order mark', () => {
    const rows = parseCsv('﻿Name,Note\r\n"Smith, J","He said ""hi""\nand left"\r\nPlain,ok\n');
    expect(rows).toEqual([['Name', 'Note'], ['Smith, J', 'He said "hi"\nand left'], ['Plain', 'ok']]);
  });

  it('finds the header row after a note, which LinkedIn puts in front of Connections.csv', () => {
    const rows = parseCsv('Notes:\n"When exporting your connections, you may notice that some email addresses are missing."\n\nFirst Name,Last Name,Email Address\nA,B,a@example.com\n');
    expect(toTable(rows, 'first name')).toEqual([{ 'first name': 'A', 'last name': 'B', 'email address': 'a@example.com' }]);
    expect(toTable(rows, 'no such column')).toEqual([]);
  });

  it('refuses a file with an absurd number of rows instead of freezing the page', () => {
    const lines = 'a\n'.repeat(LIMITS.rows + 10);
    expect(() => parseCsv(lines)).toThrow(ExportError);
  });
});

describe('dates', () => {
  it.each([
    ['2026-03-14 09:30:00', '2026-03-14'],
    ['2026-03-14', '2026-03-14'],
    ['Mar 2026', '2026-03-01'],
    ['March 2026', '2026-03-01'],
    ['03/14/2026', '2026-03-14'],
    ['2024', '2024-01-01'],
  ])('reads %s', (input, day) => {
    expect(parseDate(input)?.toISOString().slice(0, 10)).toBe(day);
  });

  it('says null for what it cannot read', () => {
    for (const s of ['', 'soon', '31st of never']) expect(parseDate(s)).toBeNull();
  });
});

describe('the numbers behind the activity', () => {
  const r = sampleExport(NOW);

  it('count posts per month over the last 12 months, this month included, oldest first', () => {
    expect(r.stats.months).toHaveLength(12);
    expect(r.stats.months[11].month).toBe('2026-11');
    expect(r.stats.months[0].month).toBe('2025-12');
    expect(r.stats.postsLast12).toBe(6);
    expect(r.stats.avgPerMonth).toBe(0.5);
    expect(r.stats.months.reduce((n, m) => n + m.posts, 0)).toBe(6);
    expect(r.stats.lastPost).toBe('2026-09-02');
    expect(r.stats.daysSinceLastPost).toBe(81);
  });

  it('find the longest silence and the certifications', () => {
    expect(r.stats.longestGapDays).toBeGreaterThan(120);
    expect(r.stats.certifications).toEqual([{ name: 'Python Basics', authority: 'Example Academy', finished: 'Feb 2023' }]);
    expect(r.stats.latestCertificate).toBe('2023-02-01');
    expect(r.stats.positions).toBe(1);
    expect(r.stats.skills).toBe(3);
  });

  it('become findings that say what is wrong and how to fix it', () => {
    expect(rules(r)).toEqual(['profile.activity.gap', 'profile.certs.few', 'profile.recommendations.none']);
    for (const f of r.findings) {
      expect(f.by).toBe('finance');
      expect(f.fix.length).toBeGreaterThan(30);
      expect(f.detail.length).toBeGreaterThan(30);
    }
    expect(new Set(r.findings.map((f) => f.id)).size).toBe(r.findings.length);
  });

  it('become questions that point at their findings', () => {
    expect(r.questions).toHaveLength(r.findings.length);
    const ids = new Set(r.findings.map((f) => f.id));
    for (const q of r.questions) {
      expect(q.findingId && ids.has(q.findingId)).toBe(true);
      expect(q.text.endsWith('?')).toBe(true);
    }
  });
});

describe('what the rules say in other situations', () => {
  const files = (shares: string, certs = 'Name,Url,Authority,Started On,Finished On,License Number') => ({
    'profile.csv': 'First Name,Last Name,Headline,Summary\nSara,Khan,Backend engineer,I build things.',
    'shares.csv': shares,
    'certifications.csv': certs,
  });
  const header = 'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility';

  it('no post for months is a medium finding with the date of the last post', () => {
    const r = readExportFiles(files(`${header}\n2025-12-01 10:00:00,,x,,,`), NOW);
    const f = r.findings.find((x) => x.rule === 'profile.activity.none');
    expect(f?.severity).toBe('medium');
    expect(f?.evidence).toContain('2025-12-01');
  });

  it('no posts at all is the same finding, and an empty certification file is a finding too', () => {
    const r = readExportFiles(files(header), NOW);
    expect(rules(r)).toContain('profile.activity.none');
    expect(r.findings.find((x) => x.rule === 'profile.certs.none')?.area).toBe('discoverability');
  });

  it('twelve posts a month apart and three recent certificates are strengths, with no findings about them', () => {
    const posts = Array.from({ length: 12 }, (_, i) => `${new Date(Date.UTC(2026, 10 - i, 5)).toISOString().slice(0, 10)} 10:00:00,,x,,,`).join('\n');
    const certs = 'Name,Url,Authority,Started On,Finished On,License Number\nA,,X,Jan 2026,Feb 2026,\nB,,X,Jan 2025,Feb 2025,\nC,,X,Jan 2025,Mar 2025,';
    const r = readExportFiles(files(`${header}\n${posts}`, certs), NOW);
    expect(rules(r)).toEqual([]);
    expect(r.strengths.join(' ')).toMatch(/posted 12 times/);
    expect(r.strengths.join(' ')).toMatch(/3 certifications/);
  });

  it('an old newest certificate is called stale', () => {
    const posts = Array.from({ length: 12 }, (_, i) => `${new Date(Date.UTC(2026, 10 - i, 5)).toISOString().slice(0, 10)} 10:00:00,,x,,,`).join('\n');
    const certs = 'Name,Url,Authority,Started On,Finished On,License Number\nA,,X,Jan 2021,Feb 2021,\nB,,X,Jan 2022,Feb 2022,\nC,,X,Jan 2022,Mar 2022,';
    expect(rules(readExportFiles(files(`${header}\n${posts}`, certs), NOW))).toEqual(['profile.certs.stale']);
  });

  it('a missing file is not a finding: nothing is said about what was not asked for', () => {
    const r = readExportFiles({ 'profile.csv': 'First Name,Last Name,Headline\nSara,Khan,Engineer' }, NOW);
    expect(r.findings).toEqual([]);
    expect(r.stats.hasPosts).toBe(false);
    expect(r.summary).toBe('0 positions, 0 skills, 0 recommendations received');
  });
});

describe('what leaves the browser', () => {
  const files = {
    'profile.csv': 'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location\nSara,Khan,Ali,House 12 Street 4 Block C,4 May 1995,Backend engineer,I build payment systems.,Software,54000,"Karachi, Pakistan"',
    'connections.csv': 'Notes:\nsomething\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nA,B,https://example.com/a,a@example.com,X,Y,01 Jan 2024\nC,D,,c@example.com,X,Y,02 Jan 2024',
    'positions.csv': 'Company Name,Title,Description,Location,Started On,Finished On\nPay Ltd,Engineer,"Built a retry service that recovered 12,000 payments a month.",Karachi,Jan 2022,',
  };
  const r = readExportFiles(files, NOW);

  it('the text for the review has no address, birth date, zip code, maiden name or email', () => {
    expect(r.text).toContain('Sara Khan');
    expect(r.text).toContain('Backend engineer');
    expect(r.text).toContain('Karachi, Pakistan');
    expect(r.text).toContain('Built a retry service');
    for (const secret of ['House 12', '1995', '54000', 'Ali', 'a@example.com', 'c@example.com']) expect(r.text, secret).not.toContain(secret);
  });

  it('connections are only counted, never kept', () => {
    expect(r.stats.connections).toBe(2);
    expect(JSON.stringify(r)).not.toContain('example.com');
  });

  it('the one-line summary for Nova has numbers and dates only', () => {
    expect(r.summary).toMatch(/^1 positions, 0 skills, 0 recommendations received$/);
    expect(r.summary.length).toBeLessThanOrEqual(600);
  });
});

describe('the ZIP', () => {
  const zip = (entries: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));

  it('is read from a folder, in any letter case, and only the wanted files are used', () => {
    const r = readExportZip(
      zip({
        'Basic_LinkedInDataExport_11-22-2026/Profile.csv': 'First Name,Last Name,Headline\nSara,Khan,Engineer',
        'Basic_LinkedInDataExport_11-22-2026/Skills.csv': 'Name\nPython\nSQL',
        'Basic_LinkedInDataExport_11-22-2026/Messages.csv': 'FROM,CONTENT\nsomeone,a private message',
        'Basic_LinkedInDataExport_11-22-2026/Invitations.csv': 'x\ny',
      }),
      NOW,
    );
    expect(r.stats.skills).toBe(2);
    expect(r.stats.found).toEqual(['profile.csv', 'skills.csv']); // messages and invitations were never even decompressed
    expect(JSON.stringify(r)).not.toContain('private message');
  });

  it('says so plainly when a file is not a ZIP or holds nothing useful', () => {
    expect(() => readExportZip(strToU8('this is not a zip file at all'), NOW)).toThrow(/does not look like a ZIP/);
    expect(() => readExportZip(zip({ 'readme.txt': 'hello' }), NOW)).toThrow(/No profile data was found/);
  });

  it('refuses a file that unpacks to something huge (a zip bomb) before unpacking it', () => {
    const bomb = zip({ 'Shares.csv': new Uint8Array(LIMITS.fileBytes + 1024) });
    expect(bomb.byteLength).toBeLessThan(200_000); // it is tiny on disk
    expect(() => readExportZip(bomb, NOW)).toThrow(/too large/);
  });

  it('refuses a ZIP with far too many files', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < LIMITS.files + 5; i++) many[`f${i}.txt`] = 'x';
    expect(() => readExportZip(zip(many), NOW)).toThrow(/too many files/);
  });
});
