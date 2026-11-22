import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessToMarkdown, coerceAssess, countBySeverity, ROLES } from '../src/assess/types';
import type { AssessReport } from '../src/assess/types';
import { beamColour, BEAM } from '../src/assess/beams';
import { parseSse, toLogLine } from '../src/live/scanClient';

/**
 * The contract between the Python Orchestrator and the browser, tested on the two reports it baked:
 * `python -m guardscan.cli bake-demos --model` writes server/demo/demo-site-report.json and demo-profile-report.json.
 */
const load = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, '..', 'public', name), 'utf8'));
const site = coerceAssess(load('demo-site-report.json')) as AssessReport;
const profile = coerceAssess(load('demo-profile-report.json')) as AssessReport;

describe('the baked demo reports', () => {
  it('are understood by the browser', () => {
    expect(site).not.toBeNull();
    expect(profile).not.toBeNull();
    expect(site.kind).toBe('site');
    expect(profile.kind).toBe('profile');
    expect(site.demo && profile.demo).toBe(true);
  });

  it('have a crew that works: every specialist speaks, with a state and a task, and reports to Nova', () => {
    for (const r of [site, profile]) {
      const speakers = new Set(r.runLog.map((l) => l.from));
      for (const id of ['nova', 'data', 'purchasing', 'finance'] as const) expect(speakers.has(id), `${r.kind} ${id}`).toBe(true);
      expect(r.runLog.some((l) => l.from === 'data' && l.state === 'working' && !!l.task)).toBe(true);
      for (const id of ['data', 'purchasing', 'finance'] as const) {
        expect(r.runLog.some((l) => l.from === id && l.to === 'nova' && (l.state === 'success' || l.state === 'alert')), `${r.kind} ${id} reports back`).toBe(true);
      }
      expect(r.agents.map((a) => a.role)).toEqual(['Orchestrator', ...['data', 'purchasing', 'finance'].map((id) => ROLES[r.kind][id as 'data'].title)]);
    }
  });

  it('have ids that refer to each other correctly', () => {
    for (const r of [site, profile]) {
      const ids = new Set(r.findings.map((f) => f.id));
      expect(ids.size).toBe(r.findings.length);
      for (const q of r.questions) expect(q.findingId === null || ids.has(q.findingId)).toBe(true);
      for (const i of r.improvements) expect(i.findingId === null || ids.has(i.findingId)).toBe(true);
      for (const a of r.agents) for (const id of a.findingIds) expect(ids.has(id)).toBe(true);
      expect(r.questions.length).toBeGreaterThanOrEqual(5);
      expect(r.model).toBe(true); // baked with Gemini; each question passed the server's checks
    }
  });

  it('never carry a secret, a link, contact details or a plain IP address', () => {
    const planted = ['ZZ46J3YTB2XQRM5P', '+92 300 1234567', 'ayesha.raza.dev@gmail.com'];
    for (const r of [site, profile]) {
      const text = JSON.stringify(r);
      for (const p of planted) expect(text, p).not.toContain(p);
      for (const q of r.questions) expect(q.text + q.why).not.toMatch(/https?:\/\//);
      for (const i of r.improvements) expect(i.after).not.toMatch(/https?:\/\//);
    }
    expect(JSON.stringify(site)).toContain('AKIA****');
  });

  it('show each planted problem found by the right specialist', () => {
    const byRule = (r: AssessReport, rule: string) => r.findings.find((f) => f.rule === rule);
    expect(byRule(site, 'web.secret-in-source')?.by).toBe('purchasing');
    expect(byRule(site, 'seo.description.missing')?.by).toBe('finance');
    expect(byRule(site, 'content.broken-links')?.by).toBe('data');
    expect(byRule(profile, 'profile.ai-instructions')?.by).toBe('purchasing');
    expect(byRule(profile, 'profile.headline.weak')?.by).toBe('finance');
    expect(site.findings[0].severity).toBe('critical');
  });
});

describe('coerceAssess does not trust the server', () => {
  const minimal = { kind: 'site', target: 'example.com', findings: [], questions: [] };

  it('accepts a minimal report and fills the rest with safe defaults', () => {
    const r = coerceAssess(minimal)!;
    expect(r.stats).toEqual({ pages: 0, bytes: 0, words: 0 });
    expect(r.model).toBe(false);
    expect(r.backup).toBe(false);
    expect(r.runLog).toEqual([]);
    expect(r.search.used).toBe(false);
  });

  it('keeps the flag that says the backup model wrote the questions, and treats anything else as false', () => {
    expect(coerceAssess({ ...minimal, model: true, backup: true })!.backup).toBe(true);
    expect(coerceAssess({ ...minimal, model: true, backup: 'yes' })!.backup).toBe(false);
    expect(site.backup).toBe(false); // the baked demos were written by Gemini
  });

  it.each([
    ['not an object', 'text'],
    ['an unknown kind', { ...minimal, kind: 'repo' }],
    ['findings that are not a list', { ...minimal, findings: 'x' }],
    ['a finding with an unknown area', { ...minimal, findings: [{ id: 'a', rule: 'r', title: 't', fix: 'f', area: 'wizardry', severity: 'low', by: 'data' }] }],
    ['a finding with an unknown severity', { ...minimal, findings: [{ id: 'a', rule: 'r', title: 't', fix: 'f', area: 'seo', severity: 'apocalyptic', by: 'data' }] }],
    ['a finding by an agent that does not exist', { ...minimal, findings: [{ id: 'a', rule: 'r', title: 't', fix: 'f', area: 'seo', severity: 'low', by: 'mallory' }] }],
    ['a question with an unknown area', { ...minimal, questions: [{ id: 'q1', text: 't', area: 'x' }] }],
  ])('refuses %s', (_name, input) => {
    expect(coerceAssess(input)).toBeNull();
  });

  it('cuts long text, drops unknown ids and ignores unknown log fields', () => {
    const f = { id: 'a'.repeat(100), rule: 'r', title: 'T'.repeat(500), fix: 'F'.repeat(900), detail: 'D'.repeat(2000), area: 'seo', severity: 'low', by: 'data' };
    const r = coerceAssess({
      ...minimal,
      findings: [{ ...f, id: 'ok' }],
      questions: [{ id: 'q1', text: 'Q'.repeat(400), why: 'w', area: 'seo', findingId: 'does-not-exist' }],
      improvements: [{ id: 'i1', title: 't', after: 'A'.repeat(900), findingId: 'ok' }],
      runLog: [{ text: 'x'.repeat(900), from: 'nova', state: 'dancing', task: 'T'.repeat(300), extra: 1 }],
    })!;
    expect(r.findings[0].title.length).toBe(200);
    expect(r.findings[0].fix.length).toBe(500);
    expect(r.findings[0].detail.length).toBe(600);
    expect(r.questions[0].text.length).toBe(260);
    expect(r.questions[0].findingId).toBeNull();
    expect(r.improvements[0].after.length).toBe(480);
    expect(r.improvements[0].findingId).toBe('ok');
    expect(r.runLog[0].text.length).toBe(400);
    expect(r.runLog[0].state).toBeUndefined();
    expect(r.runLog[0].task!.length).toBe(90);
  });
});

describe('the report as text and as numbers', () => {
  it('the copied summary has questions, rewrites and fixes, and never the evidence excerpts', () => {
    const md = assessToMarkdown(site);
    expect(md).toContain('## Questions to think about');
    expect(md).toContain('## Suggested rewrites');
    expect(md).toContain('Fix:');
    for (const f of site.findings.filter((x) => x.evidence.length > 25)) expect(md, f.rule).not.toContain(f.evidence);
  });

  it('counts findings by severity', () => {
    const c = countBySeverity(site.findings);
    expect(Object.values(c).reduce((a, b) => a + (b ?? 0), 0)).toBe(site.findings.length);
    expect(c.critical).toBeGreaterThanOrEqual(1);
  });
});

describe('the crew on the stage', () => {
  it('colours the beams: tasks out, results back, hand-offs between specialists, failures in red', () => {
    expect(beamColour('nova', 'data')).toBe(BEAM.task);
    expect(beamColour('data', 'nova')).toBe(BEAM.result);
    expect(beamColour('data', 'purchasing')).toBe(BEAM.handoff);
    expect(beamColour('data', 'nova', 'fail')).toBe(BEAM.fail);
  });

  it('reads state and task from a log line, and refuses anything else', () => {
    expect(toLogLine({ text: 'x', from: 'data', state: 'working', task: 'Reading page 2 of 5' })).toMatchObject({ from: 'data', state: 'working', task: 'Reading page 2 of 5' });
    expect(toLogLine({ text: 'x', from: 'nobody', state: 'angry' })).toMatchObject({ from: undefined, state: undefined });
  });

  it('splits a stream of events and keeps an unfinished one for later', () => {
    const { events, rest } = parseSse('event: log\ndata: {"text":"a"}\n\nevent: log\ndata: {"te');
    expect(events).toHaveLength(1);
    expect(rest).toContain('{"te');
  });
});
