import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coerceAssess } from '../src/assess/types';
import { scorecardsOf, scoresAfterFixing } from '../src/assess/scorecard';
import { createInitialState, gameReducer } from '../src/game/gameReducer';
import { autoChoice, buildFixPlan, fixPlanToMarkdown, PRESSURE_SECONDS, streakOf } from '../src/game/fixPlan';
import { BADGES, applyResult, emptyProgress, KIND_BADGE, type HistoryEntry, type LevelResult } from '../src/game/progress';
import type { Scenario } from '../src/game/types';
import { buildAssessMissions } from '../src/missions/assessReport';

const demo = (name: string) => coerceAssess(JSON.parse(readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')))!;

const entry = (o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  stepId: 's', stepTitle: 't', optionId: 'o', kind: 'block', label: 'Block', verdict: 'safe', safety: 3, work: 0, audit: false, benign: false, lesson: '', flagsFound: 1, flagsTotal: 1, ...o,
});
const result = (o: Partial<LevelResult> = {}): LevelResult => ({
  score: 30, max: 40, safety: 20, safetyMax: 25, work: 8, workMax: 10, bonus: 2, flagsFound: 1, flagsTotal: 2, risky: 1, rating: 'Guardian', ...o,
});

function missionOf(name: string): Scenario {
  const m = buildAssessMissions(demo(name)).missions;
  expect(m.length).toBeGreaterThan(0);
  return m[0];
}

describe('the fix list at the end of a mission', () => {
  const mission = missionOf('demo-site-report.json');
  const threats = mission.steps.filter((s) => s.threat);

  it('has one item per real finding, each with its place and what to do', () => {
    const plan = buildFixPlan(mission, []);
    expect(plan).toHaveLength(threats.length);
    for (const i of plan) {
      expect(i.findingId).toMatch(/\S/);
      expect(i.fix.length).toBeGreaterThan(5);
      expect(i.title).not.toMatch(/^Your web agent wants to publish:/); // the agent's lead-in is cut off, the finding stays
    }
  });

  it('tells apart: asked for the fix, only blocked, and let through, and lists the worst first', () => {
    expect(threats.length).toBeGreaterThanOrEqual(2);
    const [a, b] = threats;
    const plan = buildFixPlan(mission, [entry({ stepId: a.id, kind: 'narrow' }), entry({ stepId: b.id, kind: 'allow', verdict: 'risky' })]);
    expect(plan.find((i) => i.stepId === a.id)?.state).toBe('requested');
    expect(plan.find((i) => i.stepId === b.id)?.state).toBe('missed');
    expect(plan[0].state).toBe('missed');
    expect(plan[plan.length - 1].state).toBe('requested');
    const blocked = buildFixPlan(mission, [entry({ stepId: a.id, kind: 'block' })]);
    expect(blocked.find((i) => i.stepId === a.id)?.state).toBe('open');
  });

  it('counts the last real choice, not an Audit', () => {
    const [a] = threats;
    const plan = buildFixPlan(mission, [entry({ stepId: a.id, kind: 'narrow' }), entry({ stepId: a.id, kind: 'audit', audit: true })]);
    expect(plan.find((i) => i.stepId === a.id)?.state).toBe('requested');
  });

  it('is a checklist that can be pasted, with the done ones ticked', () => {
    const [a] = threats;
    const md = fixPlanToMarkdown(buildFixPlan(mission, [entry({ stepId: a.id, kind: 'narrow' })]), 'Fix list for my website');
    expect(md).toMatch(/^# Fix list for my website/);
    expect(md).toMatch(/^- \[x\] \*\*/m);
    expect(md).toMatch(/^- \[ \] \*\*/m);
  });

  it('shows what the fixes are worth: a website has two scores and a profile one, none gets lower, and fixing a mission raises one of them', () => {
    for (const [name, cards] of [['demo-site-report.json', 2], ['demo-profile-report.json', 1]] as const) {
      const report = demo(name);
      const now = scorecardsOf(report).map((c) => c.score);
      expect(now).toHaveLength(cards);
      for (const mission of buildAssessMissions(report).missions) {
        const ids = buildFixPlan(mission, []).map((i) => i.findingId);
        const one = scoresAfterFixing(report, ids.slice(0, 1));
        const all = scoresAfterFixing(report, ids);
        now.forEach((n, k) => {
          expect(one[k]).toBeGreaterThanOrEqual(n);
          expect(all[k]).toBeGreaterThanOrEqual(one[k]);
        });
        expect(all.some((a, k) => a > now[k])).toBe(true);
      }
    }
  });
});

describe('the streak', () => {
  it('counts safe choices in a row from the latest, and a risky choice breaks it', () => {
    expect(streakOf([])).toBe(0);
    expect(streakOf([entry(), entry(), entry()])).toBe(3);
    expect(streakOf([entry(), entry({ verdict: 'risky' }), entry()])).toBe(1);
    expect(streakOf([entry(), entry({ verdict: 'neutral' })])).toBe(0);
  });
  it('is not changed by an Audit in between', () => {
    expect(streakOf([entry(), entry({ audit: true, verdict: 'neutral' }), entry()])).toBe(2);
  });
});

describe('pressure mode', () => {
  it('lets the agent go ahead (allow) when time runs out, and never starts an Audit', () => {
    const base = { label: '', hint: '', verdict: 'safe' as const, safety: 0, work: 0, reaction: 'idle' as const, consequence: '', lesson: '', log: [] };
    const options = [
      { ...base, id: 'a', kind: 'audit' as const, reveal: { title: '', text: '', log: [] } },
      { ...base, id: 'b', kind: 'block' as const },
      { ...base, id: 'c', kind: 'allow' as const },
    ];
    expect(autoChoice(options)?.id).toBe('c');
    expect(autoChoice(options.slice(0, 2))).toBeUndefined();
    expect(PRESSURE_SECONDS).toBeGreaterThanOrEqual(15);
  });
});

describe('a badge for each of the three games', () => {
  const ids = ['x'];
  it('goes to a Guardian mission of that kind, and only that kind', () => {
    const site = applyResult(emptyProgress(), 'live-site-1', result(), [entry()], ids, 'site');
    expect(site.earned).toContain(KIND_BADGE.site);
    expect(site.earned).not.toContain(KIND_BADGE.repo);
    const weak = applyResult(emptyProgress(), 'live-site-1', result({ rating: 'Cautious' }), [entry()], ids, 'site');
    expect(weak.earned).not.toContain(KIND_BADGE.site);
    const level = applyResult(emptyProgress(), 'phishing', result(), [entry()], ids);
    expect(level.earned.filter((b) => Object.values(KIND_BADGE).includes(b as never))).toEqual([]); // a campaign level is not a game of the three
  });
  it('makes a Triple Play when all three have been won', () => {
    let p = emptyProgress();
    for (const k of ['repo', 'site'] as const) p = applyResult(p, `m-${k}`, result(), [entry()], ids, k).progress;
    expect(p.badges).not.toContain('triple-play');
    const last = applyResult(p, 'm-profile', result(), [entry()], ids, 'profile');
    expect(last.earned).toContain('triple-play');
  });
  it('are listed with a name and a description', () => {
    for (const id of ['repo-guardian', 'site-guardian', 'profile-guardian', 'triple-play']) {
      const b = BADGES.find((x) => x.id === id);
      expect(b?.name.length).toBeGreaterThan(3);
      expect(b?.desc.length).toBeGreaterThan(15);
    }
  });
});

describe('when pressure mode runs out of time', () => {
  const play = (timedOut: boolean) => {
    const mission = missionOf('demo-site-report.json');
    let s = createInitialState([mission]);
    s = gameReducer(s, { type: 'START_LEVEL', level: 0 });
    s = gameReducer(s, { type: 'BEGIN' });
    s = gameReducer(s, { type: 'SKIP_SIM' });
    const allow = s.options.find((o) => o.kind === 'allow')!;
    return gameReducer(s, { type: 'CHOOSE', optionId: allow.id, timedOut });
  };

  it('the log does not claim that the player approved it', () => {
    const chosen = play(false).log.map((l) => l.text).join('\n');
    const timed = play(true).log.map((l) => l.text).join('\n');
    expect(chosen).toMatch(/APPROVED by you/);
    expect(timed).not.toMatch(/by you/);
    expect(timed).toMatch(/APPROVED automatically \(no decision was made\)/);
  });

  it('is still scored as the choice that the agent made, so waiting is never the safe move', () => {
    const a = play(false);
    const b = play(true);
    expect(b.levelSafety).toBe(a.levelSafety);
    expect(b.history[b.history.length - 1].kind).toBe('allow');
    expect(b.phase).toBe('outcome');
  });
});
