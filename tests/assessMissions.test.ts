import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coerceAssess } from '../src/assess/types';
import type { AssessReport } from '../src/assess/types';
import { GUIDE } from '../src/game/guide';
import { validateScenario } from '../src/game/validate';
import { buildAssessMissions, assessToReport } from '../src/missions/assessReport';
import { buildMissions } from '../src/missions/buildScenarios';
import { MISSION_CONCEPTS } from '../src/missions/templates';
import type { Report } from '../src/missions/types';

const load = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, '..', 'public', name), 'utf8'));
const site = coerceAssess(load('demo-site-report.json')) as AssessReport;
const profile = coerceAssess(load('demo-profile-report.json')) as AssessReport;
const repo = load('demo-report.json') as Report;

const text = (m: ReturnType<typeof buildAssessMissions>['missions'][number]) => JSON.stringify(m);

describe('missions made from a website', () => {
  const { missions, dropped } = buildAssessMissions(site);

  it('are valid missions, with nothing that cannot be played left in', () => {
    expect(missions.length).toBeGreaterThanOrEqual(2);
    for (const m of missions) expect(validateScenario(m, 'generated'), m.id).toEqual([]);
    expect(dropped.length).toBeLessThan(site.findings.length);
  });

  it('speak about a website, a web agent and publishing, not about a repository or a merge', () => {
    for (const m of missions) {
      const s = text(m);
      expect(m.kind).toBe('mission');
      expect(m.source).toBe('site');
      expect(m.id.startsWith('live-site-')).toBe(true);
      expect(m.roles?.nova).toBe('Web agent');
      expect(s).toContain('Approve and publish');
      expect(s).not.toMatch(/pull request|Approve and merge|git\./);
      expect(m.steps.every((st) => st.tool === 'browser')).toBe(true);
    }
    expect(missions[0].title).toMatch(/^The riskiest changes on /);
  });

  it('show what the scan really found on the site, as the flagged line', () => {
    const body = JSON.stringify(missions.flatMap((m) => m.steps.map((s) => s.artifact.body)));
    expect(body).toContain('AKIA****'); // the planted key, as the specialist saw it: masked
    expect(body).not.toContain('ZZ46J3YTB2XQRM5P');
    expect(body).toContain('password field');
    const flagged = missions.flatMap((m) => m.steps).filter((s) => s.threat);
    expect(flagged.length).toBeGreaterThanOrEqual(4);
    for (const st of flagged) {
      expect(st.clues.filter((c) => c.flag).length).toBeGreaterThanOrEqual(1);
      expect(st.clues.some((c) => !c.flag)).toBe(true); // a safe look-alike to be tempted by
    }
  });

  it('include a legitimate request when the site really does something well', () => {
    const withStrengths = { ...site, strengths: ['HSTS is on, so browsers keep using HTTPS', 'A Content-Security-Policy is set'] };
    const m = buildAssessMissions(withStrengths).missions;
    expect(m.flatMap((x) => x.steps).some((s) => !s.threat)).toBe(true);
    for (const x of m) expect(validateScenario(x, 'generated'), x.id).toEqual([]);
  });
});

describe('missions made from a profile', () => {
  const { missions } = buildAssessMissions(profile);

  it('are valid, and speak about a profile agent that wants to post an update', () => {
    expect(missions.length).toBeGreaterThanOrEqual(1);
    for (const m of missions) {
      expect(validateScenario(m, 'generated'), m.id).toEqual([]);
      const s = text(m);
      expect(m.source).toBe('profile');
      expect(m.id.startsWith('live-profile-')).toBe(true);
      expect(m.roles?.nova).toBe('Profile agent');
      expect(s).toContain('Approve and post');
      expect(s).not.toMatch(/pull request|Approve and merge|Approve and publish/);
    }
    expect(missions[0].title).toBe('The riskiest lines in your profile');
  });

  it('use the findings the review really made, and a phone number is a privacy mission', () => {
    const steps = missions.flatMap((m) => m.steps);
    expect(JSON.stringify(steps.map((s) => s.title))).toMatch(/phone number/i);
    const mapped = assessToReport(profile).findings.find((f) => f.rule === 'profile.phone');
    expect(mapped?.category).toBe('profile-privacy');
    expect(mapped?.owned).toBe(true);
  });
});

describe('the three kinds do not get mixed up', () => {
  it('a repository report still produces the repository words', () => {
    const { missions } = buildMissions(repo);
    expect(missions.length).toBeGreaterThanOrEqual(2);
    for (const m of missions) {
      expect(m.source).toBe('repo');
      expect(m.id.startsWith('live-demo-')).toBe(true);
      expect(m.roles?.nova).toBe('Coding agent');
      expect(text(m)).toContain('Approve and merge');
    }
  });

  it('the same engine gives the same shape: every step has the four decisions of a threat or the three of a legitimate request', () => {
    for (const set of [buildAssessMissions(site).missions, buildAssessMissions(profile).missions]) {
      for (const st of set.flatMap((m) => m.steps)) expect(st.options.length).toBe(st.threat ? 4 : 3);
    }
  });

  it('every idea the new missions teach has a Field Guide entry, and no entry is left without a mission', () => {
    const ids = new Set(GUIDE.map((g) => g.id));
    for (const c of MISSION_CONCEPTS) expect(ids.has(c), c).toBe(true);
    for (const id of ['web-hardening', 'privacy-exposure', 'findability', 'profile-impact']) {
      expect(MISSION_CONCEPTS).toContain(id);
      expect(GUIDE.find((g) => g.id === id)?.levels).toEqual([]);
    }
  });

  it('a report with nothing wrong gives no missions and says why, instead of an empty game', () => {
    const clean: AssessReport = { ...site, findings: [], strengths: ['HSTS is on, so browsers keep using HTTPS'] };
    const r = buildAssessMissions(clean);
    expect(r.missions).toEqual([]);
    expect(r.dropped.length).toBeGreaterThan(0);
  });
});
