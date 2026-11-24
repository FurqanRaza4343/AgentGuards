import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AGENTS, type AgentId } from '../agents';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useReducedMotion } from '../lib/useReducedMotion';
import { play, setMuted, useMuted } from '../lib/sound';
import { stage } from '../stage/stage';
import { deriveAgentState } from './agentState';
import { layoutFor } from './layout';
import { createInitialState, gameReducer, scenarioOf, stepOf, totalScore, type LevelResult } from './gameReducer';
import type { AssessReport } from '../assess/types';
import { autoChoice, PRESSURE_SECONDS, streakOf } from './fixPlan';
import { applyResult, clearProgress, emptyProgress, loadProgress, saveProgress } from './progress';
import { SCENARIOS } from './scenarios';
import type { Scenario } from './types';
import { levelMax } from './scoring';
import { ArtifactView } from './ui/ArtifactView';
import { BriefCard, FinalCard, IntroCard, OutcomeCard, ScenarioCard, SummaryCard } from './ui/Cards';
import { FieldGuide } from './ui/FieldGuide';
import { FixPlan } from './ui/FixPlan';
import { AgentBadge, DecisionBar, GameNav, LogPanel, PanelTabs, PressureBar, StatusBar, type PanelTab } from './ui/Panels';

const LEVEL_IDS = SCENARIOS.map((s) => s.id);
const PRESSURE_KEY = 'agentguard.pressure';
const readPressure = (): boolean => {
  try {
    return window.localStorage.getItem(PRESSURE_KEY) === '1';
  } catch {
    return false;
  }
};

export function Game({ onExit, scenarios = SCENARIOS, onAnalyse, report = null }: { onExit: () => void; scenarios?: Scenario[]; onAnalyse?: () => void; report?: AssessReport | null }) {
  const [state, dispatch] = useReducer(gameReducer, scenarios, createInitialState);
  const [progress, setProgress] = useState(loadProgress);
  const [fresh, setFresh] = useState<string[]>([]);
  const [guide, setGuide] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [tab, setTab] = useState<PanelTab>('evidence');
  const reduced = useReducedMotion();
  const mobile = useMediaQuery('(max-width: 900px)');
  const muted = useMuted();
  const savedResult = useRef<LevelResult | null>(null);
  const [pressure, setPressureState] = useState(readPressure);
  const [left, setLeft] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const { phase } = state;
  const inLevel = phase !== 'intro' && phase !== 'final';
  const scenario = inLevel ? scenarioOf(state) : null;
  const hasStep = phase === 'simulating' || phase === 'decision' || phase === 'outcome';
  const step = hasStep ? stepOf(state) : null;
  const agents: AgentId[] = scenario ? scenario.agents : ['nova'];
  const agentsKey = agents.join(',');
  const max = useMemo(() => (scenario ? levelMax(scenario) : null), [scenario]);

  // ---- 3D stage: mode, who is on stage, where, and what each agent is doing
  useEffect(() => {
    stage.setMode('game');
    return () => {
      stage.setMode('landing');
      stage.showAgents(['nova']);
      stage.setAllAgentStates('idle');
    };
  }, []);

  useEffect(() => {
    stage.showAgents(agents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsKey]);

  useEffect(() => {
    stage.setLayout(layoutFor(agents.length, mobile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length, mobile]);

  useEffect(() => {
    agents.forEach((a) => stage.setAgentState(a, deriveAgentState(state, a)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, state.stepIndex, state.levelIndex, state.lastOption, state.reveal, agentsKey]);

  // a message between two agents sends a packet across the A2A link
  useEffect(() => {
    const line = state.log[state.log.length - 1];
    if (line?.from && line?.to) stage.fireBeam(line.from, line.to);
  }, [state.log]);

  // ---- the simulated agent "works": log lines appear one by one, then it asks for a decision
  const enteredDecision = (s: typeof state) => {
    if (s.phase === 'decision' || s.phase === 'simulating') {
      const st = stepOf(s);
      if (st.threat) play('alert');
    }
  };

  useEffect(() => {
    if (phase !== 'simulating' || guide.open) return;
    if (reduced) {
      enteredDecision(state);
      dispatch({ type: 'SKIP_SIM' });
      return;
    }
    const total = stepOf(state).log.length;
    const id =
      state.simIndex < total
        ? setTimeout(() => {
            play('tick');
            dispatch({ type: 'APPEND_NEXT' });
          }, state.simIndex === 0 ? 450 : 700)
        : setTimeout(() => {
            enteredDecision(state);
            dispatch({ type: 'SIM_DONE' });
          }, 700);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, state.simIndex, state.stepIndex, state.levelIndex, reduced, guide.open]);

  // the panel shows the log while the agent works, the evidence while you decide
  useEffect(() => {
    setTab(phase === 'decision' ? 'evidence' : 'log');
  }, [phase, state.stepIndex, state.levelIndex]);

  // ---- pressure mode (optional): a clock runs while the player decides, and when it ends the agent goes ahead
  const setPressure = (on: boolean) => {
    setPressureState(on);
    try {
      window.localStorage.setItem(PRESSURE_KEY, on ? '1' : '0');
    } catch {
      /* blocked storage: the switch still works for this visit */
    }
  };
  useEffect(() => {
    setLeft(phase === 'decision' && pressure ? PRESSURE_SECONDS : null);
    if (phase === 'decision') setTimedOut(false); // the note stays on screen through the outcome that it explains
    // an Audit does not restart the clock: only a new decision does
  }, [phase, state.stepIndex, state.levelIndex, pressure]);
  useEffect(() => {
    if (left === null || guide.open) return;
    if (left <= 0) {
      const o = autoChoice(state.options);
      setLeft(null);
      if (o) {
        setTimedOut(true);
        choose(o.id, true);
      }
      return;
    }
    const id = setTimeout(() => setLeft((l) => (l === null ? null : l - 1)), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, guide.open]);

  // ---- user actions, with a sound each
  const choose = (optionId: string, timedOut = false) => {
    const option = state.options.find((o) => o.id === optionId);
    if (!option) return;
    if (option.reveal) play('click');
    else play(option.verdict === 'safe' ? 'good' : option.verdict === 'risky' ? 'bad' : 'click');
    dispatch({ type: 'CHOOSE', optionId, timedOut });
  };

  const inspect = (clueId: string) => {
    const clue = step?.clues.find((c) => c.id === clueId);
    play(clue?.flag ? 'flag' : 'click');
    dispatch({ type: 'INSPECT', clueId });
  };

  const skipSim = () => {
    enteredDecision(state);
    dispatch({ type: 'SKIP_SIM' });
  };

  // ---- keys 1-4 choose an option
  useEffect(() => {
    if (phase !== 'decision' || guide.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= state.options.length) {
        const o = state.options[n - 1];
        if (o.reveal && state.auditsLeft <= 0) return;
        choose(o.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, state.options, state.auditsLeft, guide.open]);

  // ---- move focus to the main control of each screen
  useEffect(() => {
    if (guide.open) return;
    const id = requestAnimationFrame(() => document.querySelector<HTMLElement>('.game [data-autofocus]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, state.stepIndex, state.levelIndex]);

  // ---- when a level is finished: store the result, work out the badges
  useEffect(() => {
    if (phase !== 'summary') return;
    const result = state.results[state.levelIndex];
    if (!result || savedResult.current === result) return;
    savedResult.current = result;
    const sc = scenarioOf(state);
    const { progress: next, earned } = applyResult(progress, sc.id, result, state.history, LEVEL_IDS, sc.kind === 'mission' ? sc.source ?? 'repo' : undefined);
    saveProgress(next);
    setProgress(next);
    setFresh(earned);
    if (earned.length) setTimeout(() => play('badge'), 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const openGuide = (id?: string) => setGuide({ open: true, id: id ?? null });
  const resetProgress = () => {
    clearProgress();
    setProgress(emptyProgress());
    setFresh([]);
    savedResult.current = null;
    dispatch({ type: 'RESET' });
  };

  const showBar = phase === 'decision' && step;
  const result = state.results[state.levelIndex];
  const compact = agents.length >= 3;

  return (
    <div className={`game${showBar ? ' has-bar' : ''}`}>
      <GameNav
        scenarios={scenarios}
        levelIndex={state.levelIndex}
        inLevel={inLevel}
        score={totalScore(state)}
        muted={muted}
        onExit={onExit}
        onGuide={() => openGuide()}
        onToggleSound={() => {
          setMuted(!muted);
          if (muted) setTimeout(() => play('click'), 0);
        }}
      />

      <div className="gagents" aria-label="Agents in this level">
        {agents.map((a) => (
          <AgentBadge
            key={a}
            id={a}
            role={scenario?.roles?.[a] ?? AGENTS[a].role}
            state={deriveAgentState(state, a)}
            activeTool={step && step.actor === a ? step.tool : null}
            compact={compact}
          />
        ))}
      </div>

      <div className="gmain">
        {hasStep && max && (
          <StatusBar safety={state.levelSafety} safetyMax={max.safety} work={state.levelWork} workMax={max.work} auditsLeft={state.auditsLeft} />
        )}

        {phase === 'intro' && (
          <IntroCard scenarios={scenarios} progress={progress} onStart={(level) => dispatch({ type: 'START_LEVEL', level })} onGuide={openGuide} onReset={resetProgress} onAnalyse={onAnalyse} />
        )}

        {phase === 'briefing' && scenario && <BriefCard scenario={scenario} onBegin={() => dispatch({ type: 'BEGIN' })} onGuide={openGuide} pressure={pressure} onPressure={setPressure} />}

        {(phase === 'simulating' || phase === 'decision') && scenario && step && (
          <>
            {phase === 'decision' && left !== null && <PressureBar left={left} total={PRESSURE_SECONDS} />}
            <ScenarioCard step={step} stepNumber={state.stepIndex + 1} stepCount={scenario.steps.length} deciding={phase === 'decision'} reveal={state.reveal} />
            <div className="gpanel">
              <PanelTabs tab={tab} onTab={setTab} logCount={state.log.length} />
              <div id={`gpanel-${tab}`} role="tabpanel" aria-labelledby={`gtab-${tab}`} className="gpanel-body">
                {tab === 'evidence' ? (
                  <ArtifactView
                    artifact={step.artifact}
                    clues={step.clues}
                    found={state.found}
                    revealed={state.revealed}
                    inspectLeft={state.inspectLeft}
                    canInspect={phase === 'decision'}
                    onInspect={inspect}
                  />
                ) : (
                  <LogPanel lines={state.log} simulating={phase === 'simulating'} onSkip={skipSim} />
                )}
              </div>
            </div>
          </>
        )}

        {phase === 'outcome' && scenario && state.lastOption && (
          <>
            <OutcomeCard option={state.lastOption} last={state.stepIndex + 1 >= scenario.steps.length} onContinue={() => dispatch({ type: 'CONTINUE' })} streak={streakOf(state.history)} timedOut={timedOut} />
            <LogPanel lines={state.log} simulating={false} onSkip={() => undefined} />
          </>
        )}

        {phase === 'summary' && scenario && result && (
          <SummaryCard
            scenario={scenario}
            result={result}
            history={state.history}
            fresh={fresh}
            isLastLevel={state.levelIndex + 1 >= scenarios.length}
            onRetry={() => dispatch({ type: 'RETRY' })}
            onNext={() => dispatch({ type: 'NEXT_LEVEL' })}
            onMenu={() => dispatch({ type: 'MENU' })}
            onGuide={openGuide}
          />
        )}

        {phase === 'summary' && scenario && result && scenario.kind === 'mission' && <FixPlan scenario={scenario} history={state.history} report={report} />}

        {phase === 'final' && <FinalCard scenarios={scenarios} progress={progress} onMenu={() => dispatch({ type: 'MENU' })} onExit={onExit} />}
      </div>

      {showBar && (
        <DecisionBar options={state.options} actorName={AGENTS[step.actor].name} auditsLeft={state.auditsLeft} onChoose={choose} />
      )}

      {guide.open && <FieldGuide focusId={guide.id} onClose={() => setGuide({ open: false, id: null })} />}
    </div>
  );
}
