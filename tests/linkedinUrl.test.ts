import { describe, expect, it } from 'vitest';
import { analyseLinkedInUrl, looksDefault } from '../src/assess/linkedinUrl';
import { buildScorecard } from '../src/assess/scorecard';

const ok = (s: string) => {
  const r = analyseLinkedInUrl(s);
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe('the address of a LinkedIn profile', () => {
  it('is accepted in the forms that people paste, and is turned into one clean address', () => {
    for (const s of ['https://www.linkedin.com/in/ayesha-raza/', 'linkedin.com/in/ayesha-raza', 'http://pk.linkedin.com/in/ayesha-raza?trk=public', 'www.linkedin.com/in/ayesha-raza/details/experience/', '  https://linkedin.com/in/ayesha-raza#top ']) {
      const r = ok(s);
      expect(r.url).toBe('https://www.linkedin.com/in/ayesha-raza/');
      expect(r.handle).toBe('ayesha-raza');
    }
  });

  it('is refused when it is not a person on LinkedIn, with a reason a person can follow', () => {
    expect(analyseLinkedInUrl('')).toMatchObject({ ok: false });
    expect(analyseLinkedInUrl('https://evil.example/in/ayesha-raza')).toMatchObject({ ok: false, message: expect.stringMatching(/not a LinkedIn address/) });
    expect(analyseLinkedInUrl('https://linkedin.com.evil.example/in/ayesha')).toMatchObject({ ok: false });
    expect(analyseLinkedInUrl('https://notlinkedin.com/in/ayesha')).toMatchObject({ ok: false });
    expect(analyseLinkedInUrl('linkedin.com/company/acme')).toMatchObject({ ok: false, message: expect.stringMatching(/company or school/) });
    expect(analyseLinkedInUrl('linkedin.com/feed')).toMatchObject({ ok: false });
    expect(analyseLinkedInUrl('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(analyseLinkedInUrl('ftp://linkedin.com/in/ayesha')).toMatchObject({ ok: false });
    expect(analyseLinkedInUrl('linkedin.com/in/<script>')).toMatchObject({ ok: false });
    expect(analyseLinkedInUrl('x'.repeat(400))).toMatchObject({ ok: false });
  });

  it('never keeps what comes after the name, so the address that is opened is the plain one', () => {
    const r = ok('https://www.linkedin.com/in/ayesha-raza/?utm_source=share&token=SECRET#frag');
    expect(r.url).not.toMatch(/SECRET|utm|#/);
  });

  it('knows LinkedIn\'s default address from a custom one', () => {
    expect(looksDefault('ayesha-raza-6a1b2c3d')).toBe(true);
    expect(looksDefault('ayesha-raza-123456789')).toBe(true);
    expect(looksDefault('muhammad-ali-a1b2c3d4e')).toBe(true);
    expect(looksDefault('ayesha-raza')).toBe(false);
    expect(looksDefault('ayesha-raza-dev')).toBe(false);
    expect(looksDefault('ayeshadev')).toBe(false);
    expect(looksDefault('ali-hassan-engineer')).toBe(false);
  });

  it('gives a finding and a question for a default address, and a strength for a custom one', () => {
    const d = ok('linkedin.com/in/ayesha-raza-6a1b2c3d');
    expect(d.custom).toBe(false);
    expect(d.findings.map((f) => f.rule)).toEqual(['profile.url.default']);
    expect(d.questions[0].findingId).toBe(d.findings[0].id);
    const c = ok('linkedin.com/in/ayesha-raza');
    expect(c.findings).toEqual([]);
    expect(c.strengths[0]).toMatch(/custom one/);
  });
});

describe('the scorecard counts the address', () => {
  it('skips the check without an address, passes with a custom one and warns on a default one', () => {
    const none = buildScorecard('profile', []);
    expect(none.checks.find((c) => c.id === 'url')?.status).toBe('skip');
    const custom = buildScorecard('profile', [], { url: 'linkedin.com/in/ayesha-raza' });
    expect(custom.checks.find((c) => c.id === 'url')?.status).toBe('pass');
    const def = buildScorecard('profile', ok('linkedin.com/in/ayesha-raza-6a1b2c3d').findings, { url: 'x' });
    expect(def.checks.find((c) => c.id === 'url')?.status).toBe('warn');
  });
});
