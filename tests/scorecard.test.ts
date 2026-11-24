import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coerceAssess } from '../src/assess/types';
import type { AFinding } from '../src/assess/types';
import { buildScorecard, buildScorecards, PROFILE_CHECKS, SECURITY_CHECKS, SITE_CHECKS, scoreAfterFixing, scorecardOf, verdictOf } from '../src/assess/scorecard';

const f = (rule: string, severity: AFinding['severity'], id = rule): AFinding => ({
  id, area: 'seo', severity, rule, title: `Title of ${rule}`, detail: '', evidence: '', location: '', fix: 'Fix it', by: 'finance',
});

const ALL_FACTS = { robots: 'Found', sitemap: '12 pages listed', activity: '8 posts', certs: '3 certifications', recs: '2', url: 'linkedin.com/in/x' };

describe('the scorecards', () => {
  it('weigh exactly 100 points each, with unique ids', () => {
    for (const defs of [SITE_CHECKS, SECURITY_CHECKS, PROFILE_CHECKS]) {
      expect(defs.reduce((n, d) => n + d.weight, 0)).toBe(100);
      expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    }
  });

  it('give 100 when nothing is found and every check could run', () => {
    expect(buildScorecards('site', [], ALL_FACTS).map((c) => c.score)).toEqual([100, 100]);
    expect(buildScorecard('profile', [], ALL_FACTS).score).toBe(100);
  });

  it('give a website two cards, one for search and one for security, and each finding costs points on the card that it belongs to', () => {
    const cards = buildScorecards('site', [f('web.csp.missing', 'medium'), f('seo.title.missing', 'high')], ALL_FACTS);
    expect(cards.map((c) => c.title)).toEqual(['Search health', 'Security health']);
    expect(cards[0].score).toBe(90); // the missing title (10 points) is search
    expect(cards[1].score).toBe(Math.round(100 - 14 * 0.6)); // a medium finding takes 60% of the policy's 14 points, and it is security
    expect(cards[1].checks.find((c) => c.id === 'csp')?.status).toBe('fail');
  });

  it('skip a check that could not run, instead of calling it a pass', () => {
    const c = buildScorecard('site', [], {});
    expect(c.checks.find((x) => x.id === 'sitemap')?.status).toBe('skip');
    expect(c.checks.find((x) => x.id === 'robots')?.status).toBe('skip');
    expect(c.score).toBe(100); // the others pass, and the skipped ones are not counted
    expect(buildScorecard('profile', [], {}).checks.filter((x) => x.status === 'skip').map((x) => x.id)).toEqual(['url', 'activity', 'certs', 'recs']);
  });

  it('turn a medium finding into a fail, a low one into a warning and an info one into nothing (unless the check asks for it)', () => {
    const c = buildScorecard('site', [f('seo.title.missing', 'high'), f('seo.description.length', 'low'), f('seo.sitemap.home-missing', 'info'), f('seo.structured-data', 'info')], ALL_FACTS);
    const by = (id: string) => c.checks.find((x) => x.id === id)!;
    expect(by('title').status).toBe('fail');
    expect(by('description').status).toBe('warn');
    expect(by('sitemap').status).toBe('pass'); // an info finding does not cost points here
    expect(by('structured').status).toBe('warn'); // but for structured data it is the whole point
    expect(by('title').detail).toBe('Title of seo.title.missing');
    // 100 - title 10 (high takes all) - description 8 x 0.3 - structured 4 x 0.15
    expect(c.score).toBe(Math.round(100 - 10 - 8 * 0.3 - 4 * 0.15));
  });

  it('lose points a little at a time: two problems in one check cost more than one, and fixing one of them still helps', () => {
    const two = buildScorecard('site', [f('seo.sitemap.stale', 'low'), f('seo.sitemap.other-host', 'medium')], ALL_FACTS);
    const one = buildScorecard('site', [f('seo.sitemap.other-host', 'medium')], ALL_FACTS);
    const none = buildScorecard('site', [], ALL_FACTS);
    expect(two.score).toBeLessThan(one.score);
    expect(one.score).toBeLessThan(none.score);
    expect(two.checks.find((x) => x.id === 'sitemap')?.credit).toBeCloseTo(0.1, 5);
  });

  it('say how many more there are when several findings land on one check', () => {
    const c = buildScorecard('site', [f('seo.sitemap.stale', 'low'), f('seo.sitemap.other-host', 'medium'), f('seo.sitemap.http', 'low')], ALL_FACTS);
    const s = c.checks.find((x) => x.id === 'sitemap')!;
    expect(s.status).toBe('fail');
    expect(s.detail).toBe('Title of seo.sitemap.other-host (and 2 more)');
  });

  it('use the facts that the server sent for a pass', () => {
    const c = buildScorecard('site', [], { sitemap: '12 pages listed, newest 2026-10-02' });
    expect(c.checks.find((x) => x.id === 'sitemap')?.detail).toBe('12 pages listed, newest 2026-10-02');
  });

  it('name the verdict by the score', () => {
    expect([100, 85, 84, 70, 69, 50, 49, 0].map(verdictOf)).toEqual(['Strong', 'Strong', 'Good', 'Good', 'Needs work', 'Needs work', 'Weak', 'Weak']);
  });

  it('show what the score would be after fixes, and never lower it', () => {
    const findings = [f('seo.title.missing', 'high', 'c1'), f('seo.robots.blocks-assets', 'medium', 'c2')];
    const r = coerceAssess({ kind: 'site', target: 't', findings, questions: [], facts: ALL_FACTS });
    expect(r).not.toBeNull();
    const now = scorecardOf(r!).score;
    expect(scoreAfterFixing(r!, ['c1'])).toBeGreaterThan(now);
    expect(scoreAfterFixing(r!, ['c1', 'c2'])).toBe(100);
    expect(scoreAfterFixing(r!, [])).toBe(now);
  });

  it('read the baked demo reports without trouble', () => {
    for (const name of ['demo-site-report.json', 'demo-profile-report.json']) {
      const r = coerceAssess(JSON.parse(readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')));
      expect(r).not.toBeNull();
      const c = scorecardOf(r!);
      expect(c.score).toBeGreaterThan(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(c.checks.length).toBeGreaterThanOrEqual(11);
    }
  });
});

describe('facts from the server', () => {
  it('are kept short and only as text', () => {
    const r = coerceAssess({ kind: 'site', target: 't', findings: [], questions: [], facts: { ok: 'fine', n: 5, long: 'x'.repeat(500), ['k'.repeat(40)]: 'no' } });
    expect(r!.facts.ok).toBe('fine');
    expect(r!.facts.n).toBeUndefined();
    expect(r!.facts.long.length).toBe(140);
    expect(Object.keys(r!.facts)).toEqual(['ok', 'long']);
  });
  it('are optional: an older report has none', () => {
    expect(coerceAssess({ kind: 'site', target: 't', findings: [], questions: [] })!.facts).toEqual({});
  });
});
