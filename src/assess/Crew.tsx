import { useEffect, useRef } from 'react';
import { AGENTS } from '../agents';
import type { AgentId } from '../agents';
import { stage } from '../stage/stage';
import type { AgentState } from '../stage/actors/types';
import { CREW_ORDER } from './beams';
import type { CrewStates, CrewTasks } from './beams';
import { ROLES } from './types';
import type { AssessKind } from './types';

/** The game says "Needs a decision" and "Safe". For a crew at work the honest words are these. */
const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  alert: 'Found problems',
  success: 'Done',
  fail: 'Failed',
};

interface CrewProps {
  kind: AssessKind;
  states: CrewStates;
  tasks: CrewTasks;
  /** what each specialist finished with, shown once the run is over */
  summaries?: Partial<Record<AgentId, string>>;
}

/** A plain list of who is doing what. It is the text version of the 3D stage, and the only version on a phone. */
export function CrewStatus({ kind, states, tasks, summaries }: CrewProps) {
  return (
    <ul className="lcrew" aria-label="What each agent is doing">
      {CREW_ORDER.map((id) => {
        const role = ROLES[kind][id];
        const line = summaries?.[id] ?? (tasks[id] || (states[id] === 'idle' ? 'Waiting for its task' : STATE_LABEL[states[id]]));
        return (
          <li key={id} className={`lcrew-row s-${states[id]}`} style={{ '--accent': AGENTS[id].accent } as React.CSSProperties}>
            <span className="lcrew-dot" aria-hidden="true" />
            <span className="lcrew-name">
              <b>{role.title}</b>
              <small>{role.does}</small>
            </span>
            <span className="lcrew-task">
              <span className="lcrew-state">{STATE_LABEL[states[id]]}</span>
              {line}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Small captions that follow the robots on the 3D stage, under their pedestals. They are decoration for people who can
 * see the stage; the same words are in CrewStatus, so this is hidden from screen readers.
 */
export function StageCaptions({ kind, states, tasks, show }: { kind: AssessKind; states: CrewStates; tasks: CrewTasks; show: boolean }) {
  const refs = useRef<Partial<Record<AgentId, HTMLDivElement | null>>>({});
  useEffect(() => {
    if (!show) return;
    let raf = 0;
    const tick = () => {
      for (const id of CREW_ORDER) {
        const el = refs.current[id];
        const pos = stage.screenPos(id, 'base');
        if (!el) continue;
        if (!pos) {
          el.style.opacity = '0';
          continue;
        }
        el.style.opacity = '1';
        el.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y + 10)}px) translateX(-50%)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [show]);
  if (!show) return null;
  return (
    <div className="lcaps" aria-hidden="true">
      {CREW_ORDER.map((id) => (
        <div key={id} className={`lcap s-${states[id]}`} style={{ '--accent': AGENTS[id].accent } as React.CSSProperties} ref={(el) => void (refs.current[id] = el)}>
          <b>{ROLES[kind][id].title}</b>
          <span>{tasks[id] || (states[id] === 'idle' ? 'waiting' : STATE_LABEL[states[id]])}</span>
        </div>
      ))}
    </div>
  );
}
