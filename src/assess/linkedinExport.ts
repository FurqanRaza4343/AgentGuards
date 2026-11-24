import { strFromU8, unzipSync } from 'fflate';
import type { AFinding, AssessReport, Question } from './types';

/**
 * Reads the data export that LinkedIn gives a member ("Get a copy of your data"), in the browser.
 *
 * Why an export and not the profile page: LinkedIn does not allow automated access to profile pages, puts a login wall in front
 * of them, and blocks servers. AgentGuard does not try. The export is the member's own data, handed over by LinkedIn on purpose,
 * and it holds more than a page shows: every post with its date and every certification. The ZIP is read here, in the browser.
 * Nothing in it is uploaded. Only the text of the profile (without an address, a birth date or an email) and a one-line summary
 * of the activity numbers are sent for the review.
 */

export const LIMITS = { zipBytes: 80 * 1024 * 1024, fileBytes: 25 * 1024 * 1024, totalBytes: 90 * 1024 * 1024, files: 400, rows: 200_000 };

/** Only these files are ever decompressed. Anything else in the ZIP is left alone. */
const WANTED = ['profile.csv', 'positions.csv', 'education.csv', 'skills.csv', 'certifications.csv', 'shares.csv', 'recommendations_received.csv', 'connections.csv'];

export class ExportError extends Error {}

export interface MonthCount {
  /** "2026-03" */
  month: string;
  posts: number;
}

export interface Certification {
  name: string;
  authority: string;
  finished: string;
}

export interface ExportStats {
  found: string[];
  months: MonthCount[];
  hasPosts: boolean;
  postsLast12: number;
  avgPerMonth: number;
  lastPost: string | null;
  daysSinceLastPost: number | null;
  longestGapDays: number | null;
  hasCertFile: boolean;
  certifications: Certification[];
  latestCertificate: string | null;
  positions: number;
  education: number;
  skills: number;
  recommendations: number;
  connections: number | null;
}

export interface ExportResult {
  /** the profile as text, for the review (no address, birth date or email) */
  text: string;
  stats: ExportStats;
  /** what the activity numbers say, as findings the way the specialists report them */
  findings: AFinding[];
  strengths: string[];
  questions: Question[];
  /** one line for Nova, with only numbers and dates in it */
  summary: string;
}

// ------------------------------------------------------------------ CSV

/** A small CSV reader (RFC 4180): quoted fields, doubled quotes, line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length > LIMITS.rows) throw new ExportError('A file in the export has too many rows.');
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

type Table = Record<string, string>[];

/** Finds the header row (some files start with a note before it) and returns the rows as objects keyed by lower-case column name. */
export function toTable(rows: string[][], mustHave: string): Table {
  const at = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === mustHave));
  if (at < 0) return [];
  const head = rows[at].map((c) => c.trim().toLowerCase());
  return rows.slice(at + 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ------------------------------------------------------------------ dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2026-03-14 09:30:00", "2026-03-14", "Mar 2026", "03/14/2026" -> a Date (UTC), or null. */
export function parseDate(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(t);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)));
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{4})$/.exec(t);
  if (m && MONTHS.includes(m[1].toLowerCase())) return new Date(Date.UTC(+m[2], MONTHS.indexOf(m[1].toLowerCase()), 1));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = /^(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[1], 0, 1));
  return null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const DAY = 86_400_000;

// ------------------------------------------------------------------ reading the files

/** `files` maps a lower-case file name (without a folder) to its text. */
export function readExportFiles(files: Record<string, string>, now: Date = new Date()): ExportResult {
  const get = (name: string, must: string): Table | null => (files[name] === undefined ? null : toTable(parseCsv(files[name]), must));
  const profile = get('profile.csv', 'first name')?.[0] ?? {};
  const positions = get('positions.csv', 'company name') ?? [];
  const education = get('education.csv', 'school name') ?? [];
  const skills = get('skills.csv', 'name') ?? [];
  const certRows = get('certifications.csv', 'name');
  const shares = get('shares.csv', 'date');
  const recs = get('recommendations_received.csv', 'first name') ?? [];
  const connections = get('connections.csv', 'first name');

  // ---- posts per month, for the last 12 months (this month included)
  const months: MonthCount[] = [];
  for (let i = 11; i >= 0; i--) months.push({ month: monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))), posts: 0 });
  const dates = (shares ?? []).map((r) => parseDate(r.date)).filter((d): d is Date => d !== null && d.getTime() <= now.getTime() + DAY).sort((a, b) => a.getTime() - b.getTime());
  for (const d of dates) {
    const slot = months.find((m) => m.month === monthKey(d));
    if (slot) slot.posts++;
  }
  const postsLast12 = months.reduce((n, m) => n + m.posts, 0);
  const last = dates.length > 0 ? dates[dates.length - 1] : null;
  const recent = dates.filter((d) => now.getTime() - d.getTime() <= 365 * DAY);
  let longestGap: number | null = null;
  if (recent.length > 0) {
    const edges = [new Date(now.getTime() - 365 * DAY), ...recent, now];
    longestGap = Math.round(Math.max(...edges.slice(1).map((d, i) => (d.getTime() - edges[i].getTime()) / DAY)));
  } else if (shares) longestGap = 365;

  const certifications: Certification[] = (certRows ?? []).filter((r) => r.name).map((r) => ({ name: r.name, authority: r.authority ?? '', finished: r['finished on'] || r['started on'] || '' }));
  const certDates = certifications.map((c) => parseDate(c.finished)).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime());
  const latestCert = certDates.length > 0 ? certDates[certDates.length - 1] : null;

  const stats: ExportStats = {
    found: Object.keys(files).sort(),
    months,
    hasPosts: shares !== null,
    postsLast12,
    avgPerMonth: Math.round((postsLast12 / 12) * 10) / 10,
    lastPost: last ? day(last) : null,
    daysSinceLastPost: last ? Math.max(0, Math.floor((now.getTime() - last.getTime()) / DAY)) : null,
    longestGapDays: longestGap,
    hasCertFile: certRows !== null,
    certifications,
    latestCertificate: latestCert ? day(latestCert) : null,
    positions: positions.length,
    education: education.length,
    skills: skills.length,
    recommendations: recs.length,
    connections: connections ? connections.length : null,
  };

  const text = profileText(profile, positions, education, skills, certifications);
  const { findings, strengths, questions } = activityFindings(stats, now);
  return { text, stats, findings, strengths, questions, summary: summaryLine(stats) };
}

/** The profile as the review reads it. An address, a birth date, a zip code and emails are left out on purpose. */
function profileText(profile: Record<string, string>, positions: Table, education: Table, skills: Table, certs: Certification[]): string {
  const lines: string[] = [];
  const name = `${profile['first name'] ?? ''} ${profile['last name'] ?? ''}`.trim();
  if (name) lines.push(name);
  if (profile.headline) lines.push(profile.headline);
  if (profile['geo location']) lines.push(profile['geo location']);
  if (profile.summary) lines.push('', 'About', profile.summary);
  if (positions.length > 0) {
    lines.push('', 'Experience');
    for (const p of positions.slice(0, 12)) {
      lines.push(p.title ?? '', `${p['company name'] ?? ''} · ${p['started on'] ?? ''} - ${p['finished on'] || 'Present'}`.trim());
      if (p.description) lines.push(p.description.slice(0, 900));
    }
  }
  if (education.length > 0) {
    lines.push('', 'Education');
    for (const e of education.slice(0, 6)) lines.push(e['school name'] ?? '', `${e['degree name'] ?? ''} ${e['start date'] ?? ''} - ${e['end date'] ?? ''}`.trim());
  }
  if (skills.length > 0) lines.push('', 'Skills', ...skills.slice(0, 60).map((s) => s.name));
  if (certs.length > 0) lines.push('', 'Certifications', ...certs.slice(0, 20).flatMap((c) => [c.name, c.authority].filter(Boolean)));
  return lines.join('\n').slice(0, 19_000);
}

function summaryLine(s: ExportStats): string {
  const parts: string[] = [];
  if (s.hasPosts) parts.push(`${s.postsLast12} posts in the last 12 months (about ${s.avgPerMonth} a month)${s.lastPost ? `, the last on ${s.lastPost}` : ', none yet'}`);
  if (s.hasCertFile) parts.push(`${s.certifications.length} certification${s.certifications.length === 1 ? '' : 's'}${s.latestCertificate ? `, the newest finished ${s.latestCertificate}` : ''}`);
  parts.push(`${s.positions} positions, ${s.skills} skills, ${s.recommendations} recommendations received`);
  return parts.join('; ').slice(0, 600);
}

// ------------------------------------------------------------------ what the numbers say

const QUESTIONS: Record<string, { text: string; why: string }> = {
  'profile.activity.none': { text: 'What is one thing you built, fixed or learned this month that would make a useful three-line post?', why: 'People remember profiles that show up in their feed. A short, honest post about real work does more than a perfect post that never gets written.' },
  'profile.activity.rare': { text: 'What could you post about twice a month, with almost no extra work, that your next employer would want to read?', why: 'Consistency beats length: a profile that posts a little every month looks alive, and recruiters check for that.' },
  'profile.activity.gap': { text: 'What stopped you posting for a long stretch, and what is the smallest habit that would fill it?', why: 'Long silences make a profile look abandoned. A simple rhythm, such as one post on the first Monday of the month, is easier to keep than a big plan.' },
  'profile.certs.none': { text: 'Which certificate or course would a recruiter for your target role value most, and when will you finish it?', why: 'Certificates are proof that is easy to scan, and they matter most when your work history is short.' },
  'profile.certs.few': { text: 'Which course or certificate that you already finished is missing from your profile?', why: 'Many people complete courses and never list them. Each one is a keyword and a piece of proof.' },
  'profile.certs.stale': { text: 'What have you learned since your last certificate that deserves a new one?', why: 'A newest certificate that is years old tells a reader your skills may be too. A recent one shows you keep learning.' },
  'profile.recommendations.none': { text: 'Who has seen your work closely enough to write you two honest sentences, and will you ask them this week?', why: 'A recommendation is the one thing on a profile that you cannot write yourself, and it is the most trusted.' },
};

function activityFindings(s: ExportStats, now: Date): { findings: AFinding[]; strengths: string[]; questions: Question[] } {
  const findings: AFinding[] = [];
  const strengths: string[] = [];
  const add = (rule: string, severity: AFinding['severity'], title: string, detail: string, evidence: string, fix: string, location: string, area: AFinding['area'] = 'content') =>
    findings.push({ id: `x${findings.length + 1}`, area, severity, rule, title, detail, evidence, location, fix, by: 'finance' });

  if (s.hasPosts) {
    if (s.postsLast12 === 0 || (s.daysSinceLastPost ?? 0) > 120) {
      add('profile.activity.none', 'medium', 'You have not posted for months',
        'A profile that has been silent for months looks inactive, and the platform shows inactive profiles to fewer people. Recruiters who check your activity find nothing.',
        s.lastPost ? `Last post: ${s.lastPost} (${s.daysSinceLastPost} days ago)` : 'No posts in the export', 'Post once or twice a month: a lesson you learned, a result, a small project. Consistency matters more than length.', 'Posts');
    } else if (s.postsLast12 < 6) {
      add('profile.activity.rare', 'low', `Only ${s.postsLast12} post${s.postsLast12 === 1 ? '' : 's'} in the last 12 months`,
        'Fewer than one post every two months is too little to be noticed. Regular posts keep your name in front of the people who might hire you.',
        `${s.postsLast12} posts in 12 months, last on ${s.lastPost}`, 'Aim for two short posts a month about real work. Write them down when the work happens, so that posting is only copying.', 'Posts');
    } else if ((s.longestGapDays ?? 0) > 120) {
      add('profile.activity.gap', 'low', `A gap of about ${s.longestGapDays} days without a post`,
        'Posting in bursts and then going quiet for months makes a profile look abandoned between the bursts.', `Longest gap in the last 12 months: ${s.longestGapDays} days`,
        'Keep a simple rhythm, such as the first Monday of each month, even if the post is short.', 'Posts');
    } else strengths.push(`You posted ${s.postsLast12} times in the last 12 months, without a long silence`);
  }
  if (s.hasCertFile) {
    const n = s.certifications.length;
    const age = s.latestCertificate ? (now.getTime() - new Date(s.latestCertificate).getTime()) / DAY : null;
    if (n === 0) {
      add('profile.certs.none', 'medium', 'No certifications are listed',
        'Certifications are proof that is easy to scan, and they help your profile appear when recruiters search by skill. They matter most when your work history is short.',
        '0 certifications in the export', 'Add the certificates and courses you have finished, with the issuer and the date. Pick one that fits the role you want and finish it this quarter.', 'Certifications', 'discoverability');
    } else if (n < 3) {
      add('profile.certs.few', 'low', `Only ${n} certification${n === 1 ? '' : 's'} listed`,
        'Few certificates means little proof of what you can do. Courses you finished but never listed are a missed keyword each.', `${n} certification${n === 1 ? '' : 's'}${s.latestCertificate ? `, newest ${s.latestCertificate}` : ''}`,
        'List every course and certificate you completed in the last few years, and add one that matches your target role.', 'Certifications', 'discoverability');
    } else if (age !== null && age > 730) {
      add('profile.certs.stale', 'low', 'Your newest certification is more than two years old',
        'A newest certificate from years ago suggests that your skills may have stopped growing.', `Newest certification: ${s.latestCertificate}`,
        'Finish one current course or certificate and add it, so that the top of the list is recent.', 'Certifications', 'discoverability');
    } else strengths.push(`${n} certifications are listed${s.latestCertificate ? `, the newest from ${s.latestCertificate}` : ''}`);
  }
  if (s.recommendations === 0 && s.found.includes('recommendations_received.csv')) {
    add('profile.recommendations.none', 'low', 'No recommendations received', 'A recommendation is the one thing on your profile that you cannot write yourself, and readers trust it most.',
      '0 recommendations received', 'Ask two people who saw your work closely to write two honest sentences each, and offer to do the same for them.', 'Recommendations');
  }
  const questions: Question[] = findings.flatMap((f, i) => {
    const q = QUESTIONS[f.rule];
    return q ? [{ id: `xq${i + 1}`, text: q.text, why: q.why, area: f.area, findingId: f.id }] : [];
  });
  return { findings, strengths, questions };
}

/** Adds what the export's numbers say to the report that the server made from the profile text. */
export function mergeActivity(r: AssessReport, ex: Pick<ExportResult, 'findings' | 'strengths' | 'questions'>): AssessReport {
  const rank: Record<AFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return {
    ...r,
    findings: [...r.findings, ...ex.findings].sort((a, b) => rank[a.severity] - rank[b.severity]),
    strengths: [...r.strengths, ...ex.strengths],
    questions: [...r.questions, ...ex.questions.map((q, i) => ({ ...q, id: `q${r.questions.length + i + 1}` }))],
  };
}

// ------------------------------------------------------------------ the ZIP

/** Reads the ZIP the member downloaded. Only the files listed in WANTED are decompressed, and the sizes are checked first. */
export function readExportZip(zip: Uint8Array, now: Date = new Date()): ExportResult {
  if (zip.byteLength > LIMITS.zipBytes) throw new ExportError('That file is too large to be a LinkedIn export.');
  let total = 0;
  let entries = 0;
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(zip, {
      filter: (f) => {
        entries++;
        if (entries > LIMITS.files) throw new ExportError('The ZIP holds too many files.');
        const base = f.name.split('/').pop()?.toLowerCase() ?? '';
        if (!WANTED.includes(base)) return false;
        if (f.originalSize > LIMITS.fileBytes) throw new ExportError(`${base} is too large.`);
        total += f.originalSize;
        if (total > LIMITS.totalBytes) throw new ExportError('The files in the ZIP are too large.');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ExportError) throw err;
    throw new ExportError('That does not look like a ZIP file. Choose the file LinkedIn sent you, without opening it.');
  }
  const files: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(unpacked)) files[name.split('/').pop()!.toLowerCase()] = strFromU8(bytes);
  if (Object.keys(files).length === 0) {
    throw new ExportError('No profile data was found in that ZIP. Ask LinkedIn for the data again and tick Profile, Positions, Skills, Certifications and Shares.');
  }
  return readExportFiles(files, now);
}

// ------------------------------------------------------------------ a fictional sample, so that the feature can be tried without an export

export function sampleExport(now: Date = new Date()): ExportResult {
  const d = (monthsAgo: number, dayOfMonth: number) => day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, dayOfMonth)));
  const shares = ['Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility', ...[[9, 3], [9, 20], [8, 11], [3, 5], [3, 14], [2, 2]].map(([m, dd]) => `${d(m, dd)} 10:15:00,,"Sample post",,,MEMBER_NETWORK`)].join('\n');
  return readExportFiles(
    {
      'profile.csv': 'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\nAyesha,Raza,,,,Passionate software developer seeking opportunities,"I am a hard-working team player who loves technology and learning new things.",Software,,"Lahore, Pakistan",,,',
      'positions.csv': 'Company Name,Title,Description,Location,Started On,Finished On\nExample Tech Ltd,Software Developer Intern,Responsible for backend tasks and helping the team.,Lahore,Jun 2024,',
      'education.csv': 'School Name,Start Date,End Date,Notes,Degree Name,Activities\nExample University,2020,2024,,BS Computer Science,',
      'skills.csv': 'Name\nPython\nJavaScript\nHTML',
      'certifications.csv': 'Name,Url,Authority,Started On,Finished On,License Number\nPython Basics,,Example Academy,Jan 2023,Feb 2023,',
      'shares.csv': shares,
      'recommendations_received.csv': 'First Name,Last Name,Company,Job Title,Text,Creation Date,Status',
    },
    now,
  );
}
