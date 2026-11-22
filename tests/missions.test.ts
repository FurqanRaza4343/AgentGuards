import { describe, expect, it } from 'vitest';
import { GUIDE } from '../src/game/guide';
import { SCENARIOS } from '../src/game/scenarios';
import { validateScenario } from '../src/game/validate';
import { buildMissions, buildStep } from '../src/missions/buildScenarios';
import { MISSION_CONCEPTS, TEMPLATES } from '../src/missions/templates';
import type { Category, Finding, Report } from '../src/missions/types';
import { FINDINGS, SAMPLE_REPORT } from './fixtures/sampleReport';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const find = (id: string) => clone(FINDINGS.find((f) => f.id === id)!);
const report = (findings: Finding[]): Report => ({ ...clone(SAMPLE_REPORT), findings });

describe('buildStep', () => {
  it('turns a finding into a code step with real line numbers and a flag on the right lines', () => {
    const built = buildStep(find('secret-1'))!;
    const step = built.step;
    expect(step.artifact.kind).toBe('code');
    expect(step.artifact.startLine).toBe(3);
    expect(step.artifact.title).toBe('src/config.py');
    expect(step.source).toMatchObject({ findingId: 'secret-1', path: 'src/config.py' });
    expect(step.threat).toBe(true);
    const flags = step.clues.filter((c) => c.flag);
    expect(flags).toHaveLength(1);
    // the flag covers lines 6-7, which are body lines 3 and 4 (line 3 is the first line of the window)
    const flagged = step.artifact.body.map((line, i) => ({ n: 3 + i, flagged: line.some((s) => typeof s !== 'string' && s.clue === 'f1') })).filter((x) => x.flagged).map((x) => x.n);
    expect(flagged).toEqual([6, 7]);
  });

  it('uses the scanner\'s look-alike as the decoy, and says so', () => {
    const built = buildStep(find('secret-1'))!;
    expect(built.decoyKind).toBe('lookalike');
    expect(built.step.clues.some((c) => !c.flag && /environment/.test(c.note))).toBe(true);
  });

  it('falls back to an ordinary line as the decoy when the scanner found no look-alike', () => {
    const built = buildStep(find('inj-1'))!;
    expect(built.decoyKind).toBe('ordinary');
    const decoy = built.step.clues.find((c) => !c.flag)!;
    expect(decoy.note).toMatch(/ordinary line/);
    expect(validateScenario({ ...SCENARIOS[0], id: 'x', kind: 'mission', agents: ['nova'], steps: [built.step] }, 'generated').join()).not.toMatch(/decoy/);
  });

  it('returns null when there is nothing to flag, or no line to use as a decoy', () => {
    const none = find('inj-1');
    none.flags = [];
    expect(buildStep(none)).toBeNull();
    const tiny = find('inj-1');
    tiny.context = { startLine: 13, lines: ['x'] };
    tiny.flags = [{ start: 13, end: 13, note: 'The only line of the window is the flag, so there is nothing left for a decoy.' }];
    expect(buildStep(tiny)).toBeNull();
  });

  it('ignores flags that are outside the evidence window and caps the flags at three', () => {
    const f = find('ci-1');
    f.flags = [{ start: 99, end: 99, note: 'This range is outside the window and must be ignored.' }, ...f.flags, { start: 6, end: 6, note: 'Write permission on the contents of the repository.' }, { start: 11, end: 11, note: 'An action that is pinned to a tag, not to a commit.' }];
    const step = buildStep(f)!.step;
    const flags = step.clues.filter((c) => c.flag);
    expect(flags.length).toBeLessThanOrEqual(3);
    expect(flags.every((c) => !/outside the window/.test(c.note))).toBe(true);
  });

  it('pads a flag note that is too short with the template note', () => {
    const f = find('dep-1');
    f.flags = [{ start: 1, end: 1, note: 'Old.' }];
    const note = buildStep(f)!.step.clues.find((c) => c.flag)!.note;
    expect(note.length).toBeGreaterThanOrEqual(20);
    expect(note).toContain('Old.');
  });

  it('builds a legitimate request from a safe match: no flags, approving is right, blocking is over-blocking', () => {
    const step = buildStep(find('inj-ok-1'))!.step;
    expect(step.threat).toBe(false);
    expect(step.clues.every((c) => !c.flag)).toBe(true);
    expect(step.clues.length).toBeGreaterThan(0);
    expect(step.options.find((o) => o.kind === 'block')!.verdict).toBe('neutral');
    expect(step.options.find((o) => o.kind === 'allow')!.verdict).toBe('safe');
  });

  it('charges more safety points for a worse finding', () => {
    const crit = buildStep(find('secret-1'))!.step.options.find((o) => o.kind === 'allow')!;
    const med = buildStep(find('dep-1'))!.step.options.find((o) => o.kind === 'allow')!;
    expect(crit.safety).toBeLessThan(med.safety);
  });

  it('lets a verified model prose override the templates, but keeps the mechanics in code', () => {
    const f = find('dep-1');
    f.prose = { situation: 'Prose written for this finding that is long enough.', say: 'A line the agent says about it.', consequence: 'What happens if you approve it, in prose.', lesson: 'A lesson written for this finding.' };
    const step = buildStep(f)!.step;
    expect(step.situation).toBe(f.prose.situation);
    expect(step.say).toBe(f.prose.say);
    const allow = step.options.find((o) => o.kind === 'allow')!;
    expect(allow.consequence).toBe(f.prose.consequence);
    expect(allow.safety).toBeLessThan(0); // numbers are not taken from the prose
  });

  it('never puts the finding\'s fix code or evidence into the consequence of approving', () => {
    for (const f of FINDINGS.filter((x) => !x.benign)) {
      const allow = buildStep(clone(f))!.step.options.find((o) => o.kind === 'allow')!;
      if (f.evidence.length > 12) expect(allow.consequence).not.toContain(f.evidence);
    }
  });
});

describe('buildMissions', () => {
  it('builds valid missions from the sample report, and uses the legitimate request that exists', () => {
    const { missions, dropped } = buildMissions(SAMPLE_REPORT);
    expect(missions.length).toBeGreaterThan(1);
    expect(dropped).toEqual([]);
    for (const m of missions) {
      expect(validateScenario(m, 'generated'), m.id).toEqual([]);
      expect(m.kind).toBe('mission');
    }
    // the report has one safe look-alike, so exactly one mission gets a legitimate request, placed after the first threat
    const withBenign = missions.filter((m) => m.steps.some((s) => !s.threat));
    expect(withBenign).toHaveLength(1);
    expect(withBenign[0].steps[1].threat).toBe(false);
  });

  it('puts the worst findings first and caps the number of missions and steps', () => {
    const { missions } = buildMissions(SAMPLE_REPORT, { maxMissions: 1, threatsPerMission: 2 });
    expect(missions).toHaveLength(1);
    const threats = missions[0].steps.filter((s) => s.threat);
    expect(threats).toHaveLength(2);
    expect(threats[0].source!.findingId).toBe('secret-1'); // critical first
    expect(threats[1].source!.findingId).toBe('ci-1'); // then high
  });

  it('gives each mission a stable id built from the repository and the commit', () => {
    const a = buildMissions(SAMPLE_REPORT).missions.map((m) => m.id);
    const b = buildMissions(SAMPLE_REPORT).missions.map((m) => m.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe('live-example-demo-service-0123456-1');
  });

  it('works for a single real finding with a single red flag', () => {
    const { missions, dropped } = buildMissions(report([find('dep-1')]));
    expect(dropped).toEqual([]);
    expect(missions).toHaveLength(1);
    expect(missions[0].steps).toHaveLength(1);
  });

  it('returns no missions, and says why, when there is nothing to play', () => {
    const empty = buildMissions(report([]));
    expect(empty.missions).toEqual([]);
    expect(empty.dropped.join()).toMatch(/no finding could be turned/);
    const onlySafe = buildMissions(report([find('inj-ok-1')]));
    expect(onlySafe.missions).toEqual([]);
  });

  it('drops a finding that cannot make a fair step and keeps the others', () => {
    const bad = find('inj-1');
    bad.flags = [];
    const { missions, dropped } = buildMissions(report([bad, find('dep-1')]));
    expect(dropped.join()).toMatch(/inj-1/);
    expect(missions[0].steps.map((s) => s.source?.findingId)).toContain('dep-1');
  });

  it('says in the briefing when the repository was analysed in third-party mode', () => {
    expect(buildMissions(SAMPLE_REPORT).missions[0].briefing).toMatch(/third-party mode/);
    const owned = report(FINDINGS.map((f) => ({ ...clone(f), owned: true })));
    expect(buildMissions(owned).missions[0].briefing).not.toMatch(/third-party mode/);
  });

  it('every generated mission reaches Guardian on the best path and never by blocking or allowing everything', () => {
    // validateScenario plays the mission three ways; an empty error list proves it
    for (const m of buildMissions(SAMPLE_REPORT).missions) expect(validateScenario(m, 'generated')).toEqual([]);
  });
});

describe('templates and the field guide', () => {
  it('has a template for every category, and every concept it teaches exists in the guide', () => {
    const cats: Category[] = ['secret', 'dependency', 'ci', 'docker', 'mcp', 'agent-instructions', 'prompt-injection', 'injection', 'hygiene'];
    for (const c of cats) {
      expect(TEMPLATES[c], c).toBeDefined();
      for (const id of TEMPLATES[c].concepts) expect(GUIDE.map((g) => g.id), `${c} -> ${id}`).toContain(id);
      expect(TEMPLATES[c].flagNote.length).toBeGreaterThan(20);
    }
  });

  it('no template promises an exploit: no commands to run, no payloads', () => {
    for (const t of Object.values(TEMPLATES)) {
      const text = [t.say, t.consequence, t.lesson, t.learning, t.flagNote].join(' ');
      expect(text).not.toMatch(/\b(payload|exploit code|run this|curl )/i);
    }
  });

  it('every field guide entry is taught by a level or by a mission category', () => {
    const taught = new Set([...SCENARIOS.flatMap((s) => s.concepts), ...MISSION_CONCEPTS]);
    expect(GUIDE.filter((g) => !taught.has(g.id)).map((g) => g.id)).toEqual([]);
  });
});
