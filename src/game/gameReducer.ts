import type { HistoryEntry, LevelResult } from './progress';
import { SCENARIOS } from './scenarios';
import { AUDITS_PER_LEVEL, FLAG_BONUS, INSPECTIONS_PER_STEP, levelMax, ratingFor } from './scoring';
import type { LogLine, Option, Scenario, Step } from './types';

export type { HistoryEntry, LevelResult } from './progress';

export type Phase = 'intro' | 'briefing' | 'simulating' | 'decision' | 'outcome' | 'summary' | 'final';

export interface GameState {
  /** the levels (or missions) being played: the built-in six, or missions generated from a scan */
  scenarios: Scenario[];
  phase: Phase;
  levelIndex: number;
  stepIndex: number;
  /** how many lines of the current step's log have been shown */
  simIndex: number;
  log: LogLine[];
  /** options currently on offer (changes after an Audit) */
  options: Option[];
  reveal: { title: string; text: string } | null;
  lastOption: Option | null;
  // meters of the level in progress
  levelSafety: number;
  levelWork: number;
  levelBonus: number;
  auditsLeft: number;
  /** inspections left on the current artifact */
  inspectLeft: number;
  /** clue ids the player inspected on the current step */
  found: string[];
  /** clue ids an Audit revealed on the current step */
  revealed: string[];
  flagsFound: number;
  risky: number;
  history: HistoryEntry[];
  results: Record<number, LevelResult>;
}

export type Action =
  | { type: 'START_LEVEL'; level: number }
  | { type: 'BEGIN' }
  | { type: 'APPEND_NEXT' }
  | { type: 'SKIP_SIM' }
  | { type: 'SIM_DONE' }
  | { type: 'INSPECT'; clueId: string }
  /** `timedOut`: pressure mode ran out of time, so the agent acted by itself and the log must not say that the player approved it */
  | { type: 'CHOOSE'; optionId: string; timedOut?: boolean }
  | { type: 'CONTINUE' }
  | { type: 'NEXT_LEVEL' }
  | { type: 'RETRY' }
  | { type: 'MENU' }
  | { type: 'RESET' };

/** What the log says when the agent went ahead because nobody decided: the same line, without "by you". */
export const byItself = (line: LogLine): LogLine => ({ ...line, text: line.text.replace(/\bby you\b/gi, 'automatically (no decision was made)') });

export const createInitialState = (scenarios: Scenario[] = SCENARIOS): GameState => ({
  scenarios,
  phase: 'intro',
  levelIndex: 0,
  stepIndex: 0,
  simIndex: 0,
  log: [],
  options: [],
  reveal: null,
  lastOption: null,
  levelSafety: 0,
  levelWork: 0,
  levelBonus: 0,
  auditsLeft: AUDITS_PER_LEVEL,
  inspectLeft: INSPECTIONS_PER_STEP,
  found: [],
  revealed: [],
  flagsFound: 0,
  risky: 0,
  history: [],
  results: {},
});

export const initialState: GameState = createInitialState();

export const scenarioOf = (s: GameState): Scenario => s.scenarios[s.levelIndex];
export const stepOf = (s: GameState): Step => scenarioOf(s).steps[s.stepIndex];

const IN_LEVEL: Phase[] = ['briefing', 'simulating', 'decision', 'outcome'];

/** Level score so far: security points, work points and the bonus for red flags you spotted. */
export const levelScore = (s: GameState) => s.levelSafety + s.levelWork + s.levelBonus;

/** Score shown to the player: finished levels plus the level in progress. */
export function totalScore(s: GameState): number {
  const inLevel = IN_LEVEL.includes(s.phase);
  const done = Object.entries(s.results)
    .filter(([i]) => !(inLevel && Number(i) === s.levelIndex))
    .reduce((sum, [, r]) => sum + r.score, 0);
  return done + (inLevel ? levelScore(s) : 0);
}

export function totalMax(scenarios: Scenario[] = SCENARIOS): number {
  return scenarios.reduce((sum, sc) => sum + levelMax(sc).score, 0);
}

const freshStep = { inspectLeft: INSPECTIONS_PER_STEP, found: [] as string[], revealed: [] as string[] };

function startLevel(state: GameState, level: number): GameState {
  return {
    ...state,
    phase: 'briefing',
    levelIndex: level,
    stepIndex: 0,
    simIndex: 0,
    log: [],
    options: [],
    reveal: null,
    lastOption: null,
    levelSafety: 0,
    levelWork: 0,
    levelBonus: 0,
    auditsLeft: AUDITS_PER_LEVEL,
    ...freshStep,
    flagsFound: 0,
    risky: 0,
    history: [],
  };
}

export function gameReducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'START_LEVEL':
      return startLevel(state, action.level);

    case 'RETRY':
      return startLevel(state, state.levelIndex);

    case 'NEXT_LEVEL':
      return state.levelIndex + 1 < state.scenarios.length ? startLevel(state, state.levelIndex + 1) : { ...state, phase: 'final' };

    case 'MENU':
      return { ...state, phase: 'intro', reveal: null, lastOption: null, log: [], options: [] };

    case 'RESET':
      return createInitialState(state.scenarios);

    case 'BEGIN': {
      if (state.phase !== 'briefing') return state;
      const sc = scenarioOf(state);
      return {
        ...state,
        phase: 'simulating',
        stepIndex: 0,
        simIndex: 0,
        options: sc.steps[0].options,
        reveal: null,
        lastOption: null,
        ...freshStep,
        log: [{ text: `[SIMULATION] Level ${sc.level}: ${sc.title}`, tone: 'system' }],
      };
    }

    case 'APPEND_NEXT': {
      if (state.phase !== 'simulating') return state;
      const step = stepOf(state);
      if (state.simIndex >= step.log.length) return state;
      return { ...state, log: [...state.log, step.log[state.simIndex]], simIndex: state.simIndex + 1 };
    }

    case 'SKIP_SIM': {
      if (state.phase !== 'simulating') return state;
      const step = stepOf(state);
      return { ...state, phase: 'decision', log: [...state.log, ...step.log.slice(state.simIndex)], simIndex: step.log.length };
    }

    case 'SIM_DONE':
      return state.phase === 'simulating' ? { ...state, phase: 'decision' } : state;

    case 'INSPECT': {
      if (state.phase !== 'decision' || state.inspectLeft <= 0) return state;
      const clue = stepOf(state).clues.find((c) => c.id === action.clueId);
      if (!clue || state.found.includes(clue.id) || state.revealed.includes(clue.id)) return state;
      return {
        ...state,
        inspectLeft: state.inspectLeft - 1,
        found: [...state.found, clue.id],
        flagsFound: state.flagsFound + (clue.flag ? 1 : 0),
        levelBonus: state.levelBonus + (clue.flag ? FLAG_BONUS : 0),
        log: [...state.log, { text: `Inspector note: ${clue.note}`, tone: clue.flag ? 'warn' : 'info' }],
      };
    }

    case 'CHOOSE': {
      if (state.phase !== 'decision') return state;
      const option = state.options.find((o) => o.id === action.optionId);
      if (!option) return state;
      if (option.reveal && state.auditsLeft <= 0) return state; // no audit tokens left
      const step = stepOf(state);
      const flagIds = step.clues.filter((c) => c.flag).map((c) => c.id);
      const entry: HistoryEntry = {
        stepId: step.id,
        stepTitle: step.title,
        optionId: option.id,
        kind: option.kind,
        label: option.label,
        verdict: option.verdict,
        safety: option.safety,
        work: option.work,
        audit: Boolean(option.reveal),
        benign: !step.threat,
        lesson: option.lesson,
        flagsFound: state.found.filter((id) => flagIds.includes(id)).length,
        flagsTotal: flagIds.length,
      };

      if (option.reveal) {
        // an Audit shows everything it found and lets the player decide again, with a new set of options
        return {
          ...state,
          auditsLeft: state.auditsLeft - 1,
          levelSafety: state.levelSafety + option.safety,
          levelWork: state.levelWork + option.work,
          history: [...state.history, entry],
          log: [...state.log, ...option.log, ...option.reveal.log],
          options: state.options.filter((o) => o.id !== option.id).concat(option.reveal.unlock ?? []),
          reveal: { title: option.reveal.title, text: option.reveal.text },
          revealed: flagIds.filter((id) => !state.found.includes(id)).concat(state.revealed),
        };
      }

      return {
        ...state,
        phase: 'outcome',
        levelSafety: state.levelSafety + option.safety,
        levelWork: state.levelWork + option.work,
        risky: state.risky + (option.verdict === 'risky' ? 1 : 0),
        history: [...state.history, entry],
        log: [...state.log, ...(action.timedOut ? option.log.map(byItself) : option.log)],
        lastOption: option,
      };
    }

    case 'CONTINUE': {
      if (state.phase !== 'outcome') return state;
      const sc = scenarioOf(state);
      const next = state.stepIndex + 1;
      if (next < sc.steps.length) {
        return {
          ...state,
          phase: 'simulating',
          stepIndex: next,
          simIndex: 0,
          options: sc.steps[next].options,
          reveal: null,
          lastOption: null,
          ...freshStep,
          log: [...state.log, { text: `---- Step ${next + 1} of ${sc.steps.length} ----`, tone: 'system' }],
        };
      }
      const m = levelMax(sc);
      const score = levelScore(state);
      const result: LevelResult = {
        score,
        max: m.score,
        safety: state.levelSafety,
        safetyMax: m.safety,
        work: state.levelWork,
        workMax: m.work,
        bonus: state.levelBonus,
        flagsFound: state.flagsFound,
        flagsTotal: m.flags,
        risky: state.risky,
        rating: ratingFor(score, m.score),
      };
      return { ...state, phase: 'summary', reveal: null, results: { ...state.results, [state.levelIndex]: result } };
    }

    default:
      return state;
  }
}
