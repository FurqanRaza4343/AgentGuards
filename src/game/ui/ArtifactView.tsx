import { Icon } from '../../components/ui';
import { INSPECTIONS_PER_STEP } from '../scoring';
import type { Artifact, Clue, Span } from '../types';

interface Props {
  artifact: Artifact;
  clues: Clue[];
  /** clues the player inspected */
  found: string[];
  /** flags an Audit revealed */
  revealed: string[];
  inspectLeft: number;
  /** only while the agent is waiting for a decision */
  canInspect: boolean;
  onInspect: (clueId: string) => void;
}

/** The thing the agent is looking at or about to do, drawn as a small window the player can inspect. */
export function ArtifactView({ artifact, clues, found, revealed, inspectLeft, canInspect, onInspect }: Props) {
  const byId = new Map(clues.map((c) => [c.id, c]));

  const renderSpans = (spans: Span[]) =>
    spans.map((sp, i) => {
      if (typeof sp === 'string') return <span key={i}>{sp}</span>;
      if (!sp.clue) return <span key={i} className={sp.faint ? 'faint' : undefined}>{sp.t}</span>;
      const clue = byId.get(sp.clue);
      const isFound = found.includes(sp.clue);
      const isRevealed = revealed.includes(sp.clue);
      const state = isFound ? (clue?.flag ? 'found-flag' : 'found-ok') : isRevealed ? 'revealed' : '';
      const disabled = !canInspect || isFound || isRevealed || inspectLeft <= 0;
      const label = isFound
        ? clue?.flag
          ? `${sp.t} (red flag, found)`
          : `${sp.t} (checked, looks normal)`
        : isRevealed
          ? `${sp.t} (red flag, shown by the audit)`
          : `${sp.t} (inspect this)`;
      return (
        <button
          key={i}
          type="button"
          className={`clue ${state}${sp.faint ? ' faint' : ''}`}
          aria-label={label}
          disabled={disabled && !state}
          aria-disabled={disabled}
          onClick={() => !disabled && onInspect(sp.clue as string)}
        >
          {sp.t}
        </button>
      );
    });

  const notes = [
    ...found.map((id) => ({ id, how: 'found' as const })),
    ...revealed.map((id) => ({ id, how: 'audit' as const })),
  ].flatMap((n) => {
    const c = byId.get(n.id);
    return c ? [{ ...n, clue: c }] : [];
  });
  const flagsTotal = clues.filter((c) => c.flag).length;
  const flagsSeen = notes.filter((n) => n.clue.flag).length;

  return (
    <div className="gevidence">
      <section className={`gart k-${artifact.kind}`} aria-label={artifact.title}>
        <header className="gart-bar">
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <span>{artifact.title}</span>
        </header>
        <dl className="gart-meta">
          {artifact.meta.map((m) => (
            <div key={m.k}>
              <dt>{m.k}</dt>
              <dd>{renderSpans(m.v)}</dd>
            </div>
          ))}
        </dl>
        <div className="gart-body">
          {artifact.body.map((line, i) =>
            artifact.kind === 'code' ? (
              <p key={i} className="codeline">
                <span className="ln" aria-hidden="true">{(artifact.startLine ?? 1) + i}</span>
                <span className="lc">{line.length === 0 ? ' ' : renderSpans(line)}</span>
              </p>
            ) : (
              <p key={i}>{renderSpans(line)}</p>
            ),
          )}
        </div>
      </section>

      <section className="gnotes" aria-label="Inspector's notebook" aria-live="polite">
        <header>
          <span>Inspector&apos;s notebook</span>
          <span className="gdots" aria-label={`${inspectLeft} of ${INSPECTIONS_PER_STEP} inspections left`}>
            {Array.from({ length: INSPECTIONS_PER_STEP }, (_, i) => (
              <i key={i} className={i < inspectLeft ? 'on' : ''} />
            ))}
          </span>
        </header>
        {notes.length === 0 ? (
          <p className="gnote-empty">
            {canInspect
              ? `Click anything that looks suspicious. You can check ${INSPECTIONS_PER_STEP} things, and some of them are fine.`
              : 'The agent is still working.'}
          </p>
        ) : (
          <ul>
            {notes.map((n) => (
              <li key={n.id} className={n.clue.flag ? 'flag' : 'ok'}>
                <Icon name={n.clue.flag ? 'flag' : 'check'} />
                <span>
                  {n.how === 'audit' && <b>Audit: </b>}
                  {n.clue.note}
                </span>
              </li>
            ))}
          </ul>
        )}
        {notes.length > 0 && (
          <p className="gnote-count">
            Red flags seen: {flagsSeen} of {flagsTotal}
          </p>
        )}
      </section>
    </div>
  );
}
