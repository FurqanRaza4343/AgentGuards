import { AUDITS_PER_LEVEL, INSPECTIONS_PER_STEP, levelMax } from './scoring';
import { createInitialState, gameReducer, levelScore, stepOf, type GameState } from './gameReducer';
import { guideById } from './guide';
import type { Option, Scenario, Span, Step } from './types';

/**
 * Checks a scenario against the rules that keep the game fair and its scoring honest.
 * The same checks run in the tests (for the built-in levels) and at runtime (for missions generated from a scan),
 * so a bad generated mission is dropped instead of being played.
 *
 * - `authored`: hand-written levels. A threat has 2-3 real red flags and a decoy.
 * - `generated`: missions built from a scan. Real findings are often a single line, so 1-3 red flags are allowed,
 *   but a deterministic decoy is still required.
 */
export type Profile = 'authored' | 'generated';

const total = (o: Option) => o.safety + o.work;

function clueIdsIn(spans: Span[]): string[] {
  return spans.flatMap((sp) => (typeof sp === 'string' || !sp.clue ? [] : [sp.clue]));
}

/** All final (non-audit) options of a step, including those an Audit unlocks. */
export function finalOptions(step: Step): Option[] {
  const out: Option[] = [];
  const walk = (o: Option) => {
    if (!o.reveal) out.push(o);
    o.reveal?.unlock?.forEach(walk);
  };
  step.options.forEach(walk);
  return out;
}

function checkStep(sc: Scenario, step: Step, profile: Profile, errors: string[]) {
  const at = `${sc.id}/${step.id}`;
  const err = (msg: string) => errors.push(`${at}: ${msg}`);

  if (!sc.agents.includes(step.actor)) err(`actor "${step.actor}" is not one of the level's agents`);
  if (step.say.trim().length < 10) err('the agent says too little');
  if (step.title.trim().length === 0 || step.situation.trim().length < 10) err('title or situation is missing');
  if (step.log.length === 0) err('no log lines');
  if (step.artifact.title.trim().length === 0 || step.artifact.body.length === 0) err('the artifact is empty');

  // options
  if (step.options.length < 2 || step.options.length > 4) err(`${step.options.length} options (need 2-4)`);
  const ids = step.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) err('duplicate option ids');
  const all: Option[] = [];
  const walk = (o: Option) => {
    all.push(o);
    o.reveal?.unlock?.forEach(walk);
  };
  step.options.forEach(walk);
  for (const o of all) {
    if (!o.label.trim() || !o.hint.trim()) err(`option "${o.id}" has no label or hint`);
    if (!Number.isFinite(o.safety) || !Number.isFinite(o.work)) err(`option "${o.id}" has non-numeric points`);
    if (o.reveal) {
      if (!o.reveal.text.trim()) err(`audit "${o.id}" reveals nothing`);
    } else if (!o.consequence.trim() || !o.lesson.trim()) err(`option "${o.id}" needs a consequence and a lesson`);
  }

  // clues: every clue in the text is defined, and every defined clue appears in the text
  const inText = [...step.artifact.meta.flatMap((m) => clueIdsIn(m.v)), ...step.artifact.body.flatMap(clueIdsIn)];
  const defined = step.clues.map((c) => c.id);
  if (new Set(defined).size !== defined.length) err('duplicate clue ids');
  for (const id of inText) if (!defined.includes(id)) err(`clue "${id}" is in the text but not defined`);
  for (const id of defined) if (!inText.includes(id)) err(`clue "${id}" is defined but not in the text`);
  for (const c of step.clues) if (c.note.trim().length < 20) err(`clue "${c.id}" has a note that is too short`);

  const finals = finalOptions(step);
  const flags = step.clues.filter((c) => c.flag).length;
  const decoys = step.clues.length - flags;

  if (step.threat) {
    const min = profile === 'authored' ? 2 : 1;
    if (flags < min || flags > INSPECTIONS_PER_STEP) err(`a threat needs ${min}-${INSPECTIONS_PER_STEP} real red flags (has ${flags})`);
    if (decoys < 1) err('a threat needs at least one decoy');
    if (!finals.some((o) => o.verdict === 'safe')) err('no safe ending');
    if (!finals.some((o) => o.verdict === 'risky')) err('no risky ending');
    const block = step.options.find((o) => o.kind === 'block');
    if (block && total(block) >= Math.max(...finals.map(total))) err('blocking must not be the best result');
  } else {
    if (flags > 0) err('a legitimate request has no red flags');
    const allow = step.options.find((o) => o.kind === 'allow');
    const block = step.options.find((o) => o.kind === 'block');
    if (!allow || allow.verdict !== 'safe') err('approving a legitimate request must be safe');
    if (!block || block.verdict !== 'neutral') err('blocking a legitimate request must be neutral (over-blocking)');
    if (allow && block && total(allow) <= total(block)) err('approving must beat blocking');
    if (step.options.some((o) => o.verdict === 'risky')) err('a legitimate request has no risky option');
  }
}

// ------------------------------------------------------------------ simulated play

type Pick = (options: Option[], step: Step) => string;

function play(sc: Scenario, pick: Pick, inspect: boolean): GameState | null {
  let s = gameReducer(gameReducer(gameReducer(createInitialState([sc]), { type: 'START_LEVEL', level: 0 }), { type: 'BEGIN' }), { type: 'SKIP_SIM' });
  for (let guard = 0; guard < 60; guard++) {
    if (s.phase === 'summary') return s;
    if (s.phase === 'decision') {
      const step = stepOf(s);
      if (inspect) {
        for (const c of step.clues.filter((x) => x.flag).slice(0, INSPECTIONS_PER_STEP)) s = gameReducer(s, { type: 'INSPECT', clueId: c.id });
      }
      s = gameReducer(s, { type: 'CHOOSE', optionId: pick(s.options, step) });
    } else if (s.phase === 'outcome') s = gameReducer(s, { type: 'CONTINUE' });
    else if (s.phase === 'simulating') s = gameReducer(s, { type: 'SKIP_SIM' });
    else return null;
  }
  return null;
}

const best: Pick = (options) => {
  const audit = options.find((o) => o.reveal);
  return audit ? audit.id : [...options].sort((a, b) => total(b) - total(a))[0].id;
};
const always =
  (kind: string): Pick =>
  (options, step) =>
    (options.find((o) => o.kind === kind) ?? options.find((o) => !o.reveal) ?? step.options[0]).id;

function checkScoring(sc: Scenario, errors: string[]) {
  const m = levelMax(sc);
  const top = play(sc, best, true);
  if (!top) return errors.push(`${sc.id}: the best path does not finish`);
  if (levelScore(top) !== m.score) errors.push(`${sc.id}: the best path scores ${levelScore(top)}, not the maximum ${m.score}`);
  if (top.results[0]?.rating !== 'Guardian') errors.push(`${sc.id}: the best path is not rated Guardian`);
  if (play(sc, best, false)?.results[0]?.rating !== 'Guardian') errors.push(`${sc.id}: the best path without inspecting is not Guardian`);
  for (const kind of ['block', 'allow']) {
    const r = play(sc, always(kind), false)?.results[0];
    if (r?.rating === 'Guardian') errors.push(`${sc.id}: choosing "${kind}" every time reaches Guardian`);
  }
}

/** Returns a list of problems. An empty list means the scenario is valid. */
export function validateScenario(sc: Scenario, profile: Profile = 'authored'): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`${sc.id}: ${msg}`);

  if (!sc.id.trim() || !sc.title.trim()) err('id and title are required');
  if (sc.briefing.trim().length < 20) err('the briefing is too short');
  if (sc.agents.length === 0) err('no agents');
  if (sc.learning.length === 0) err('no learning points');
  for (const c of sc.concepts) if (!guideById(c)) err(`concept "${c}" is not in the field guide`);
  const minSteps = profile === 'authored' ? 2 : 1;
  if (sc.steps.length < minSteps) err(`needs at least ${minSteps} step(s)`);
  if (!sc.steps.some((s) => s.threat)) err('needs at least one threat, or allowing everything would be a perfect score');
  const stepIds = sc.steps.map((s) => s.id);
  if (new Set(stepIds).size !== stepIds.length) err('duplicate step ids');

  for (const step of sc.steps) checkStep(sc, step, profile, errors);

  // the scoring checks play the level, so only run them when the structure is sound
  if (errors.length === 0) {
    checkScoring(sc, errors);
    const audits = sc.steps.filter((st) => {
      const viaAudit = st.options.find((o) => o.reveal);
      const bestDirect = Math.max(...st.options.filter((o) => !o.reveal).map(total));
      return viaAudit ? Math.max(...(viaAudit.reveal!.unlock ?? []).map(total), -Infinity) > bestDirect : false;
    }).length;
    if (audits > AUDITS_PER_LEVEL) err(`the best path needs ${audits} audits but a level gives ${AUDITS_PER_LEVEL}`);
  }
  return errors;
}
