import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS } from '../src/agents';
import { deriveAgentState } from '../src/game/agentState';
import { gameReducer, initialState, levelScore, scenarioOf, stepOf, totalMax, totalScore, type Action, type GameState } from '../src/game/gameReducer';
import { GUIDE, guideById } from '../src/game/guide';
import { BADGES, applyResult, emptyProgress, type HistoryEntry, type LevelResult } from '../src/game/progress';
import { SCENARIOS } from '../src/game/scenarios';
import { AUDITS_PER_LEVEL, FLAG_BONUS, INSPECTIONS_PER_STEP, levelMax, ratingFor, starsFor } from '../src/game/scoring';
import type { Option, Span, Step } from '../src/game/types';

const run = (state: GameState, ...actions: Action[]) => actions.reduce(gameReducer, state);

/** Brings the game to the first decision of the given level. */
function toDecision(level: number): GameState {
  return run(initialState, { type: 'START_LEVEL', level }, { type: 'BEGIN' }, { type: 'SKIP_SIM' });
}

type Pick = (options: Option[], step: Step) => string;

/** Plays a whole level. `inspect` first inspects every real red flag of each step (up to the budget). */
function playLevel(level: number, pick: Pick, inspect = false): GameState {
  let s = toDecision(level);
  let guard = 0;
  while (s.phase !== 'summary') {
    if (++guard > 80) throw new Error('level did not finish');
    if (s.phase === 'decision') {
      if (inspect) {
        for (const c of stepOf(s).clues.filter((x) => x.flag).slice(0, INSPECTIONS_PER_STEP)) s = gameReducer(s, { type: 'INSPECT', clueId: c.id });
      }
      s = gameReducer(s, { type: 'CHOOSE', optionId: pick(s.options, stepOf(s)) });
    } else if (s.phase === 'outcome') s = gameReducer(s, { type: 'CONTINUE' });
    else if (s.phase === 'simulating') s = gameReducer(s, { type: 'SKIP_SIM' });
    else throw new Error(`unexpected phase ${s.phase}`);
  }
  return s;
}

const total = (o: Option) => o.safety + o.work;
/** Audit first when it is on offer and has not been used (the unlocked option is the best one), else the highest total. */
const best: Pick = (options) => {
  const audit = options.find((o) => o.reveal);
  return audit ? audit.id : [...options].sort((a, b) => total(b) - total(a))[0].id;
};
const worst: Pick = (options) => [...options].filter((o) => !o.reveal).sort((a, b) => total(a) - total(b))[0].id;
const always =
  (kind: string): Pick =>
  (options, step) =>
    (options.find((o) => o.kind === kind) ?? options.find((o) => !o.reveal) ?? step.options[0]).id;

/** All final (non-audit) options of a step, including those an Audit unlocks. */
function finals(step: Step): Option[] {
  const out: Option[] = [];
  const walk = (o: Option) => {
    if (!o.reveal) out.push(o);
    o.reveal?.unlock?.forEach(walk);
  };
  step.options.forEach(walk);
  return out;
}

function clueIdsIn(spans: Span[]): string[] {
  return spans.flatMap((sp) => (typeof sp === 'string' || !sp.clue ? [] : [sp.clue]));
}

// ===================================================================== data

describe('scenario data', () => {
  it('has seven levels in order, each with its own id', () => {
    expect(SCENARIOS.map((s) => s.level)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(7);
  });

  it('uses all four agents, and the final shift puts all of them on stage', () => {
    const used = new Set(SCENARIOS.flatMap((s) => s.agents));
    expect([...used].sort()).toEqual(Object.keys(AGENTS).sort());
    expect(SCENARIOS[5].agents).toHaveLength(4);
  });

  for (const sc of SCENARIOS) {
    describe(`level ${sc.level}: ${sc.title}`, () => {
      it('has a briefing, learning points and teaches concepts that exist in the Field Guide', () => {
        expect(sc.briefing.length).toBeGreaterThan(40);
        expect(sc.learning.length).toBeGreaterThan(0);
        expect(sc.concepts.length).toBeGreaterThan(0);
        for (const c of sc.concepts) expect(guideById(c), `guide entry ${c}`).toBeDefined();
      });

      it('has at least two steps, and every actor belongs to the level', () => {
        expect(sc.steps.length).toBeGreaterThanOrEqual(2);
        for (const step of sc.steps) expect(sc.agents).toContain(step.actor);
      });

      it('needs no more audit tokens than the player gets, to reach the best result', () => {
        const audits = sc.steps.filter((st) => {
          const bestOpt = [...st.options].sort((a, b) => total(b) - total(a))[0];
          const viaAudit = st.options.find((o) => o.reveal);
          return viaAudit ? Math.max(...(viaAudit.reveal!.unlock ?? []).map(total), -Infinity) > total(bestOpt) : false;
        }).length;
        expect(audits).toBeLessThanOrEqual(AUDITS_PER_LEVEL);
      });

      for (const step of sc.steps) {
        describe(`step "${step.id}"`, () => {
          it('offers 2-4 options with unique ids, and every option explains itself', () => {
            expect(step.options.length).toBeGreaterThanOrEqual(2);
            expect(step.options.length).toBeLessThanOrEqual(4);
            const ids = step.options.map((o) => o.id);
            expect(new Set(ids).size).toBe(ids.length);
            const all: Option[] = [];
            const walk = (o: Option) => {
              all.push(o);
              o.reveal?.unlock?.forEach(walk);
            };
            step.options.forEach(walk);
            for (const o of all) {
              expect(o.label.length).toBeGreaterThan(0);
              expect(o.hint.length).toBeGreaterThan(0);
              if (o.reveal) expect(o.reveal.text.length).toBeGreaterThan(0);
              else {
                expect(o.consequence.length).toBeGreaterThan(0);
                expect(o.lesson.length).toBeGreaterThan(0);
              }
            }
          });

          it('has the agent speak, a log to show, and an artifact to inspect', () => {
            expect(step.say.length).toBeGreaterThan(10);
            expect(step.log.length).toBeGreaterThan(0);
            expect(step.artifact.title.length).toBeGreaterThan(0);
            expect(step.artifact.body.length).toBeGreaterThan(0);
          });

          it('every clue in the artifact is defined, and every defined clue appears in the artifact', () => {
            const inText = [...step.artifact.meta.flatMap((m) => clueIdsIn(m.v)), ...step.artifact.body.flatMap(clueIdsIn)];
            const defined = step.clues.map((c) => c.id);
            expect(new Set(defined).size).toBe(defined.length);
            for (const id of inText) expect(defined, `clue ${id} in text`).toContain(id);
            for (const id of defined) expect(inText, `clue ${id} defined`).toContain(id);
            for (const c of step.clues) expect(c.note.length).toBeGreaterThan(20);
          });

          if (step.threat) {
            it('is a threat: 2-3 real red flags, at least one decoy, a safe ending and a risky one', () => {
              const flags = step.clues.filter((c) => c.flag).length;
              expect(flags).toBeGreaterThanOrEqual(2);
              expect(flags).toBeLessThanOrEqual(INSPECTIONS_PER_STEP);
              expect(step.clues.some((c) => !c.flag)).toBe(true);
              expect(finals(step).some((o) => o.verdict === 'safe')).toBe(true);
              expect(finals(step).some((o) => o.verdict === 'risky')).toBe(true);
            });

            it('the safe shortcut (block) is not the best result', () => {
              const block = step.options.find((o) => o.kind === 'block');
              const topTotal = Math.max(...finals(step).map(total));
              if (block) expect(total(block)).toBeLessThan(topTotal);
            });
          } else {
            it('is a legitimate request: no red flags, approving is right, blocking is over-blocking', () => {
              expect(step.clues.every((c) => !c.flag)).toBe(true);
              const allow = step.options.find((o) => o.kind === 'allow');
              const block = step.options.find((o) => o.kind === 'block');
              expect(allow?.verdict).toBe('safe');
              expect(block?.verdict).toBe('neutral');
              expect(total(allow!)).toBeGreaterThan(total(block!));
              expect(step.options.some((o) => o.verdict === 'risky')).toBe(false);
            });
          }
        });
      }
    });
  }
});

// ===================================================================== flow

describe('game flow', () => {
  it('walks briefing -> simulating -> decision', () => {
    let s = run(initialState, { type: 'START_LEVEL', level: 0 });
    expect(s.phase).toBe('briefing');
    s = gameReducer(s, { type: 'BEGIN' });
    expect(s.phase).toBe('simulating');
    expect(s.log[0].text).toContain('[SIMULATION]');
    s = gameReducer(s, { type: 'APPEND_NEXT' });
    expect(s.simIndex).toBe(1);
    s = gameReducer(s, { type: 'SKIP_SIM' });
    expect(s.phase).toBe('decision');
    expect(s.simIndex).toBe(stepOf(s).log.length);
  });

  it('ignores actions in the wrong phase', () => {
    const s = initialState;
    expect(gameReducer(s, { type: 'CHOOSE', optionId: 'allow' })).toBe(s);
    expect(gameReducer(s, { type: 'CONTINUE' })).toBe(s);
    expect(gameReducer(s, { type: 'BEGIN' })).toBe(s);
    expect(gameReducer(s, { type: 'INSPECT', clueId: 'sender' })).toBe(s);
  });

  it('ignores an unknown option id', () => {
    const s = toDecision(0);
    expect(gameReducer(s, { type: 'CHOOSE', optionId: 'does-not-exist' })).toBe(s);
  });

  it('a final choice moves to the outcome, keeps the option, and adds safety and work', () => {
    const s = gameReducer(toDecision(0), { type: 'CHOOSE', optionId: 'quarantine' });
    expect(s.phase).toBe('outcome');
    expect(s.lastOption?.id).toBe('quarantine');
    expect(s.levelSafety).toBe(20);
    expect(s.levelWork).toBe(20);
    expect(s.risky).toBe(0);
  });

  it('a risky choice costs safety and is counted', () => {
    const s = gameReducer(toDecision(0), { type: 'CHOOSE', optionId: 'allow' });
    expect(s.levelSafety).toBe(-20);
    expect(s.risky).toBe(1);
  });

  it('blocking a legitimate request is over-blocking: no points, and not counted as risky', () => {
    // level 5: the poisoned tool is step 1, the legitimate calendar tool is step 2
    let s = run(toDecision(4), { type: 'CHOOSE', optionId: 'block' }, { type: 'CONTINUE' }, { type: 'SKIP_SIM' });
    expect(stepOf(s).id).toBe('calendar');
    const before = levelScore(s);
    s = gameReducer(s, { type: 'CHOOSE', optionId: 'block' });
    expect(levelScore(s)).toBe(before);
    expect(s.risky).toBe(0);
    expect(s.lastOption?.verdict).toBe('neutral');
  });

  it('moves on level by level, records the result, and RETRY starts fresh', () => {
    const done = playLevel(0, best);
    expect(done.phase).toBe('summary');
    expect(done.results[0].rating).toBeDefined();
    const retry = gameReducer(done, { type: 'RETRY' });
    expect(retry.phase).toBe('briefing');
    expect(levelScore(retry)).toBe(0);
    expect(retry.history).toEqual([]);
    expect(retry.auditsLeft).toBe(AUDITS_PER_LEVEL);
    const next = gameReducer(done, { type: 'NEXT_LEVEL' });
    expect(next.levelIndex).toBe(1);
    expect(scenarioOf(next).id).toBe('mcp');
    expect(gameReducer(playLevel(SCENARIOS.length - 1, best), { type: 'NEXT_LEVEL' }).phase).toBe('final');
  });
});

describe('inspecting the evidence', () => {
  it('finding a real red flag scores a bonus and uses one inspection', () => {
    const s = gameReducer(toDecision(0), { type: 'INSPECT', clueId: 'sender' });
    expect(s.found).toEqual(['sender']);
    expect(s.inspectLeft).toBe(INSPECTIONS_PER_STEP - 1);
    expect(s.levelBonus).toBe(FLAG_BONUS);
    expect(s.flagsFound).toBe(1);
    expect(s.log[s.log.length - 1].text).toContain('Inspector note');
  });

  it('a decoy costs an inspection and scores nothing', () => {
    const s = gameReducer(toDecision(0), { type: 'INSPECT', clueId: 'date' });
    expect(s.inspectLeft).toBe(INSPECTIONS_PER_STEP - 1);
    expect(s.levelBonus).toBe(0);
    expect(s.flagsFound).toBe(0);
  });

  it('you cannot inspect the same clue twice, an unknown clue, or more than the budget allows', () => {
    let s = gameReducer(toDecision(0), { type: 'INSPECT', clueId: 'sender' });
    expect(gameReducer(s, { type: 'INSPECT', clueId: 'sender' })).toBe(s);
    expect(gameReducer(s, { type: 'INSPECT', clueId: 'nope' })).toBe(s);
    s = run(s, { type: 'INSPECT', clueId: 'urgency' }, { type: 'INSPECT', clueId: 'date' });
    expect(s.inspectLeft).toBe(0);
    expect(gameReducer(s, { type: 'INSPECT', clueId: 'link' })).toBe(s);
  });

  it('the inspection budget resets on the next step', () => {
    let s = run(toDecision(0), { type: 'INSPECT', clueId: 'sender' }, { type: 'INSPECT', clueId: 'link' }, { type: 'CHOOSE', optionId: 'quarantine' }, { type: 'CONTINUE' });
    expect(s.inspectLeft).toBe(INSPECTIONS_PER_STEP);
    expect(s.found).toEqual([]);
    s = gameReducer(s, { type: 'SKIP_SIM' });
    expect(s.inspectLeft).toBe(INSPECTIONS_PER_STEP);
  });

  it('records how many red flags were found for the debrief', () => {
    const s = run(toDecision(0), { type: 'INSPECT', clueId: 'sender' }, { type: 'INSPECT', clueId: 'date' }, { type: 'CHOOSE', optionId: 'quarantine' });
    expect(s.history[0].flagsFound).toBe(1);
    expect(s.history[0].flagsTotal).toBe(3);
  });
});

describe('audits', () => {
  const atInjection = () => run(toDecision(0), { type: 'CHOOSE', optionId: 'quarantine' }, { type: 'CONTINUE' }, { type: 'SKIP_SIM' });

  it('an Audit keeps the decision open, costs a token, reveals the red flags and unlocks a better option', () => {
    const audited = gameReducer(atInjection(), { type: 'CHOOSE', optionId: 'audit' });
    expect(audited.phase).toBe('decision');
    expect(audited.auditsLeft).toBe(AUDITS_PER_LEVEL - 1);
    expect(audited.reveal).not.toBeNull();
    expect(audited.options.map((o) => o.id)).not.toContain('audit');
    expect(audited.options.map((o) => o.id)).toContain('report');
    expect([...audited.revealed].sort()).toEqual(['address', 'hidden', 'ignore']);
  });

  it('an Audit does not reveal the flags you already found yourself, and they keep their bonus', () => {
    const s = run(atInjection(), { type: 'INSPECT', clueId: 'hidden' }, { type: 'CHOOSE', optionId: 'audit' });
    expect(s.revealed).not.toContain('hidden');
    expect(s.found).toContain('hidden');
    expect(s.levelBonus).toBe(FLAG_BONUS);
  });

  it('without audit tokens an Audit cannot be chosen', () => {
    const s = { ...atInjection(), auditsLeft: 0 };
    expect(gameReducer(s, { type: 'CHOOSE', optionId: 'audit' })).toBe(s);
  });
});

// ===================================================================== scoring

describe('scoring', () => {
  it('the best path with every red flag found reaches exactly the maximum, in every level', () => {
    for (let i = 0; i < SCENARIOS.length; i++) {
      const s = playLevel(i, best, true);
      const m = levelMax(SCENARIOS[i]);
      expect(levelScore(s), `level ${i + 1}`).toBe(m.score);
      expect(s.results[i].rating).toBe('Guardian');
      expect(s.results[i].flagsFound).toBe(m.flags);
      expect(s.levelSafety).toBe(m.safety);
      expect(s.levelWork).toBe(m.work);
      expect(s.risky).toBe(0);
    }
  });

  it('the best path without inspecting still earns a Guardian rating', () => {
    for (let i = 0; i < SCENARIOS.length; i++) expect(playLevel(i, best, false).results[i].rating, `level ${i + 1}`).toBe('Guardian');
  });

  it('the riskiest path ends below zero and "At risk", in every level', () => {
    for (let i = 0; i < SCENARIOS.length; i++) {
      const s = playLevel(i, worst);
      expect(levelScore(s), `level ${i + 1}`).toBeLessThan(0);
      expect(s.results[i].rating).toBe('At risk');
    }
  });

  it('blocking everything is safe but not enough: it never earns a Guardian rating', () => {
    for (let i = 0; i < SCENARIOS.length; i++) {
      const s = playLevel(i, always('block'));
      expect(s.results[i].rating, `level ${i + 1}`).not.toBe('Guardian');
      expect(s.results[i].work, `level ${i + 1}`).toBeLessThan(s.results[i].workMax);
    }
  });

  it('allowing everything is never a good result', () => {
    for (let i = 0; i < SCENARIOS.length; i++) expect(playLevel(i, always('allow')).results[i].rating, `level ${i + 1}`).not.toBe('Guardian');
  });

  it('rates by share of the maximum, and stars follow the rating', () => {
    expect(ratingFor(45, 45)).toBe('Guardian');
    expect(ratingFor(36, 45)).toBe('Guardian');
    expect(ratingFor(30, 45)).toBe('Cautious');
    expect(ratingFor(5, 45)).toBe('At risk');
    expect(ratingFor(-20, 45)).toBe('At risk');
    expect([starsFor('At risk'), starsFor('Cautious'), starsFor('Guardian')]).toEqual([1, 2, 3]);
  });

  it('total score adds finished levels to the level in progress, without counting a replayed level twice', () => {
    let s = playLevel(0, best, true);
    const first = s.results[0].score;
    expect(totalScore(s)).toBe(first);
    s = gameReducer(s, { type: 'RETRY' });
    expect(totalScore(s)).toBe(0); // replaying level 1: its old result is not added on top
    s = gameReducer(playLevel(0, best, true), { type: 'NEXT_LEVEL' });
    s = gameReducer(s, { type: 'BEGIN' });
    expect(totalScore(s)).toBe(first);
    expect(totalMax()).toBe(SCENARIOS.reduce((n, sc) => n + levelMax(sc).score, 0));
  });
});

// ===================================================================== agent state

describe('agent state', () => {
  it('is idle before the simulation starts', () => {
    expect(deriveAgentState(run(initialState, { type: 'START_LEVEL', level: 0 }), 'nova')).toBe('idle');
  });

  it('works while simulating and flashes an alert when it asks to do something unsafe', () => {
    const sim = run(initialState, { type: 'START_LEVEL', level: 0 }, { type: 'BEGIN' });
    expect(deriveAgentState(sim, 'nova')).toBe('working');
    expect(deriveAgentState(gameReducer(sim, { type: 'SKIP_SIM' }), 'nova')).toBe('alert');
  });

  it('stays calm for a legitimate request', () => {
    const s = run(toDecision(4), { type: 'CHOOSE', optionId: 'block' }, { type: 'CONTINUE' }, { type: 'SKIP_SIM' });
    expect(stepOf(s).threat).toBe(false);
    expect(deriveAgentState(s, 'nova')).toBe('thinking');
  });

  it('calms down after an Audit and reacts to the final choice', () => {
    const decision = run(toDecision(0), { type: 'CHOOSE', optionId: 'quarantine' }, { type: 'CONTINUE' }, { type: 'SKIP_SIM' });
    expect(deriveAgentState(decision, 'nova')).toBe('alert');
    const audited = gameReducer(decision, { type: 'CHOOSE', optionId: 'audit' });
    expect(deriveAgentState(audited, 'nova')).toBe('thinking');
    expect(deriveAgentState(gameReducer(audited, { type: 'CHOOSE', optionId: 'report' }), 'nova')).toBe('success');
    expect(deriveAgentState(gameReducer(decision, { type: 'CHOOSE', optionId: 'allow' }), 'nova')).toBe('fail');
  });

  it('in the final shift only the agent that is waiting raises the alert', () => {
    const s = run(toDecision(5), { type: 'CHOOSE', optionId: 'allow' }, { type: 'CONTINUE' }, { type: 'SKIP_SIM' });
    expect(stepOf(s).actor).toBe('data');
    expect(deriveAgentState(s, 'data')).toBe('alert');
    expect(deriveAgentState(s, 'nova')).toBe('idle');
    expect(deriveAgentState(s, 'finance')).toBe('idle');
  });
});

// ===================================================================== progress & badges

const result = (over: Partial<LevelResult> = {}): LevelResult => ({
  score: 40,
  max: 44,
  safety: 20,
  safetyMax: 20,
  work: 20,
  workMax: 20,
  bonus: 0,
  flagsFound: 0,
  flagsTotal: 3,
  risky: 0,
  rating: 'Guardian',
  ...over,
});
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  stepId: 's',
  stepTitle: 'S',
  optionId: 'o',
  kind: 'block',
  label: 'Block',
  verdict: 'safe',
  safety: 10,
  work: 0,
  audit: false,
  benign: false,
  lesson: 'l',
  flagsFound: 0,
  flagsTotal: 3,
  ...over,
});
const ids = SCENARIOS.map((s) => s.id);

describe('progress and badges', () => {
  it('keeps the best score and stars and counts plays', () => {
    let p = applyResult(emptyProgress(), 'phishing', result({ score: 30, rating: 'Cautious' }), [entry()], ids).progress;
    p = applyResult(p, 'phishing', result({ score: 20, rating: 'At risk' }), [entry()], ids).progress;
    expect(p.levels.phishing.best).toBe(30);
    expect(p.levels.phishing.stars).toBe(2);
    expect(p.levels.phishing.rating).toBe('Cautious');
    expect(p.levels.phishing.plays).toBe(2);
  });

  it('awards Sharp Eye only when every red flag was found, and Flawless only without risky choices', () => {
    expect(applyResult(emptyProgress(), 'phishing', result({ flagsFound: 3, flagsTotal: 3 }), [entry()], ids).earned).toContain('sharp-eye');
    expect(applyResult(emptyProgress(), 'phishing', result({ flagsFound: 2, flagsTotal: 3 }), [entry()], ids).earned).not.toContain('sharp-eye');
    expect(applyResult(emptyProgress(), 'phishing', result({ risky: 0 }), [entry()], ids).earned).toContain('flawless');
    expect(applyResult(emptyProgress(), 'phishing', result({ risky: 1 }), [entry()], ids).earned).not.toContain('flawless');
  });

  it('awards badges for narrowing, sandboxing and approving legitimate requests', () => {
    const e = applyResult(emptyProgress(), 'tools', result(), [entry({ kind: 'narrow' }), entry({ kind: 'sandbox' }), entry({ kind: 'allow', benign: true })], ids).earned;
    expect(e).toEqual(expect.arrayContaining(['least-privilege', 'safe-hands', 'not-paranoid']));
    expect(applyResult(emptyProgress(), 'tools', result(), [entry({ kind: 'allow', benign: false })], ids).earned).not.toContain('not-paranoid');
  });

  it('counts asking a human across levels and awards the badge on the third time', () => {
    let r = applyResult(emptyProgress(), 'phishing', result(), [entry({ kind: 'human' }), entry({ kind: 'verify' })], ids);
    expect(r.progress.counters.humanAsks).toBe(2);
    expect(r.earned).not.toContain('human-loop');
    r = applyResult(r.progress, 'mcp', result(), [entry({ kind: 'human' })], ids);
    expect(r.earned).toContain('human-loop');
  });

  it('awards Guardian only after a Guardian rating on every level, and reports each badge once', () => {
    let p = emptyProgress();
    for (const id of ids.slice(0, -1)) p = applyResult(p, id, result(), [entry()], ids).progress;
    expect(p.badges).not.toContain('guardian-all');
    const last = applyResult(p, ids[ids.length - 1], result(), [entry()], ids);
    expect(last.earned).toContain('guardian-all');
    expect(applyResult(last.progress, ids[0], result(), [entry()], ids).earned).toEqual([]);
  });

  it('every badge has a name and description, and ids are unique', () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
    for (const b of BADGES) {
      expect(b.name.length).toBeGreaterThan(2);
      expect(b.desc.length).toBeGreaterThan(10);
    }
  });
});

// ===================================================================== guide

describe('field guide', () => {
  it('has unique entries that point at real levels', () => {
    expect(new Set(GUIDE.map((g) => g.id)).size).toBe(GUIDE.length);
    for (const g of GUIDE) {
      expect(g.what.length).toBeGreaterThan(30);
      expect(g.doThis.length).toBeGreaterThan(0);
      for (const l of g.levels) {
        expect(l).toBeGreaterThanOrEqual(1);
        expect(l).toBeLessThanOrEqual(SCENARIOS.length);
      }
    }
  });

  it('every entry is taught by at least one built-in level, or is a concept for missions (see missions.test.ts)', () => {
    const taught = new Set(SCENARIOS.flatMap((s) => s.concepts));
    const missionOnly = GUIDE.filter((g) => !taught.has(g.id)).map((g) => g.id);
    for (const id of missionOnly) expect(GUIDE.find((g) => g.id === id)!.levels, id).toEqual([]);
  });
});

// ===================================================================== safety

describe('safety', () => {
  it('the game code never makes a network call', () => {
    // The game is a simulation. Nothing under src/game may reach the network.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(join(__dirname, '..', 'src', 'game'));
    expect(files.length).toBeGreaterThan(8);
    const banned = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)/;
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
  });

  it('the first log line of every level carries the simulation label', () => {
    for (const sc of SCENARIOS) expect(sc.steps[0].log[0].text, sc.id).toContain('[SIMULATION]');
  });
});
