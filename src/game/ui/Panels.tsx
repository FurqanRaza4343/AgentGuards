import { useEffect, useRef, type CSSProperties } from 'react';
import { AGENTS, TOOL_LABEL, type AgentId, type Tool } from '../../agents';
import { Icon, LogoMark } from '../../components/ui';
import type { AgentState } from '../../stage/actors/types';
import { STATE_LABEL } from '../agentState';
import { cap, unitOf } from '../labels';
import { AUDITS_PER_LEVEL } from '../scoring';
import type { LogLine, Option, Scenario } from '../types';

// ------------------------------------------------------------------ header

interface NavProps {
  scenarios: Scenario[];
  levelIndex: number;
  inLevel: boolean;
  score: number;
  muted: boolean;
  onExit: () => void;
  onGuide: () => void;
  onToggleSound: () => void;
}

export function GameNav({ scenarios, levelIndex, inLevel, score, muted, onExit, onGuide, onToggleSound }: NavProps) {
  return (
    <header className="nav gnav">
      <a
        className="logo"
        href="#"
        aria-label="AgentGuard, back to the home page"
        onClick={(e) => {
          e.preventDefault();
          onExit();
        }}
      >
        <LogoMark />
        <span>AGENTGUARD</span>
      </a>
      <div className="menu gprog" aria-label="Progress">
        <span>{inLevel ? `${cap(unitOf(scenarios[0]))} ${levelIndex + 1} of ${scenarios.length}` : `Choose a ${unitOf(scenarios[0])}`}</span>
        <span className="seg" aria-hidden="true">
          {scenarios.map((s, i) => (
            <i key={s.id} className={inLevel ? (i < levelIndex ? 'done' : i === levelIndex ? 'cur' : '') : ''} />
          ))}
        </span>
        {inLevel && <span className="gprog-title">{scenarios[levelIndex].title}</span>}
        <span className="gtools">
          <button type="button" onClick={onGuide} aria-label="Open the field guide">
            <Icon name="book" /> <span>Guide</span>
          </button>
          <button type="button" onClick={onToggleSound} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Turn sound off'}>
            <Icon name={muted ? 'mute' : 'sound'} style={{ width: 14, height: 12 }} />
          </button>
        </span>
      </div>
      <button className="pad" type="button" onClick={onExit}>
        <Icon name="left" style={{ width: 14, height: 9 }} /> Exit
      </button>
      <div className="cta">
        <div className="gscore" aria-live="polite" aria-label={`Score ${score}`}>
          <span>Score</span>
          <b>{score}</b>
        </div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ status bar

function Meter({ label, value, max, tone }: { label: string; value: number; max: number; tone: 'safety' | 'work' }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className={`gmeter ${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.max(0, value)}>
      <span className="gm-label">{label}</span>
      <span className="gm-bar">
        <i style={{ width: `${pct * 100}%` }} />
      </span>
      <b>{value}</b>
    </div>
  );
}

interface StatusProps {
  safety: number;
  safetyMax: number;
  work: number;
  workMax: number;
  auditsLeft: number;
}

/** Safety, work, and audit tokens of the level in progress. Blocking everything fills one bar and starves the other. */
export function StatusBar({ safety, safetyMax, work, workMax, auditsLeft }: StatusProps) {
  return (
    <div className="gstatus">
      <Meter label="Safety" value={safety} max={safetyMax} tone="safety" />
      <Meter label="Work" value={work} max={workMax} tone="work" />
      <div className="gtokens" aria-label={`${auditsLeft} of ${AUDITS_PER_LEVEL} audits left`}>
        <span>Audits</span>
        {Array.from({ length: AUDITS_PER_LEVEL }, (_, i) => (
          <i key={i} className={i < auditsLeft ? 'on' : ''} />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ agents

export function AgentBadge({
  id,
  role,
  state,
  activeTool,
  compact,
  title,
}: {
  id: AgentId;
  /** shown instead of the agent's own name, for the crew of the scanner */
  title?: string;
  role: string;
  state: AgentState;
  activeTool: Tool | null;
  compact: boolean;
}) {
  const info = AGENTS[id];
  return (
    <div className={`gbadge${compact ? ' compact' : ''}`} style={{ '--accent': info.accent } as CSSProperties}>
      <div className="gb-head">
        <span className="gb-name">{title ?? info.name}</span>
        <span className={`gb-state s-${state}`}>
          <i aria-hidden="true" /> {STATE_LABEL[state]}
        </span>
      </div>
      {!compact && (
        <>
          <p className="gb-role">{role}</p>
          <ul className="gb-tools" aria-label={`Tools ${info.name} can use`}>
            {info.tools.map((t) => (
              <li key={t} className={t === activeTool ? 'on' : ''}>
                {TOOL_LABEL[t]}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** What the agent says to the player: routine, urgent or persuasive. */
export function SayBubble({ id, text }: { id: AgentId; text: string }) {
  const info = AGENTS[id];
  return (
    <figure className="gsay" style={{ '--accent': info.accent } as CSSProperties}>
      <figcaption>{info.name} says</figcaption>
      <blockquote>“{text}”</blockquote>
    </figure>
  );
}

// ------------------------------------------------------------------ tabs, log

export type PanelTab = 'evidence' | 'log';

export function PanelTabs({ tab, onTab, logCount }: { tab: PanelTab; onTab: (t: PanelTab) => void; logCount: number }) {
  const keys: PanelTab[] = ['evidence', 'log'];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = keys[(keys.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
      onTab(next);
      document.getElementById(`gtab-${next}`)?.focus();
    }
  };
  return (
    <div className="gtabs" role="tablist" aria-label="Evidence and simulation log" onKeyDown={onKey}>
      {keys.map((k) => (
        <button
          key={k}
          id={`gtab-${k}`}
          type="button"
          role="tab"
          aria-selected={tab === k}
          aria-controls={`gpanel-${k}`}
          tabIndex={tab === k ? 0 : -1}
          onClick={() => onTab(k)}
        >
          {k === 'evidence' ? 'Evidence' : `Log (${logCount})`}
        </button>
      ))}
    </div>
  );
}

export function LogPanel({ lines, simulating, onSkip, title = 'Simulation log · sandbox', empty = 'Waiting for the simulation to start...' }: { lines: LogLine[]; simulating: boolean; onSkip: () => void; title?: string; empty?: string }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <section className="glog" aria-label={title}>
      <header>
        <span>{title}</span>
        {simulating && (
          <button type="button" onClick={onSkip}>
            Skip
          </button>
        )}
      </header>
      <ol ref={listRef} role="log" aria-live="polite">
        {lines.length === 0 && <li className="ll-system">{empty}</li>}
        {lines.map((l, i) => (
          <li key={i} className={`ll-${l.tone ?? 'info'}`}>
            {l.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ decision bar

export function DecisionBar({
  options,
  actorName,
  auditsLeft,
  onChoose,
}: {
  options: Option[];
  actorName: string;
  auditsLeft: number;
  onChoose: (id: string) => void;
}) {
  return (
    <div className="dbar" role="group" aria-label={`Your decision for ${actorName}. Press 1 to ${options.length} to choose.`} tabIndex={-1} data-autofocus="">
      {options.map((o, i) => {
        const noAudit = Boolean(o.reveal) && auditsLeft <= 0;
        return (
          <button
            key={o.id}
            type="button"
            className={`dbtn k-${o.kind}${noAudit ? ' off' : ''}`}
            title={noAudit ? 'No audit tokens left' : o.hint}
            aria-keyshortcuts={String(i + 1)}
            aria-describedby={`hint-${o.id}`}
            aria-disabled={noAudit}
            onClick={() => !noAudit && onChoose(o.id)}
          >
            <span className="dkey" aria-hidden="true">{i + 1}</span>
            <span className="dtext">
              <span className="dlabel">
                {o.label}
                {o.reveal && <em>{auditsLeft} left</em>}
              </span>
              <span className="dhint" id={`hint-${o.id}`}>{noAudit ? 'No audit tokens left in this level.' : o.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
