import { useEffect, useRef } from 'react';
import { Icon } from '../../components/ui';
import { GUIDE } from '../guide';

/** A drawer with plain-language cards for every idea in the game. Esc closes it, and focus returns to where it came from. */
export function FieldGuide({ focusId, onClose }: { focusId: string | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        // keep focus inside the drawer
        const items = asideRef.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])');
        if (!items || items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusId) document.getElementById(`guide-${focusId}`)?.scrollIntoView({ block: 'start' });
  }, [focusId]);

  return (
    <div className="gscrim" onClick={onClose}>
      <aside ref={asideRef} className="gguide" role="dialog" aria-modal="true" aria-labelledby="gguide-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="gguide-title">Field guide</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close the field guide">
            <Icon name="cross" />
          </button>
        </header>
        <p className="gguide-intro">Plain-language notes on every idea in the game. Nothing here is a real attack recipe: it is what to look for and what to do.</p>
        <div className="gguide-list">
          {GUIDE.map((g) => (
            <article key={g.id} id={`guide-${g.id}`} className={g.id === focusId ? 'focus' : ''}>
              <h3>{g.title}</h3>
              <p>{g.what}</p>
              <p className="gg-game">
                <b>In the game: </b>
                {g.inGame}
              </p>
              <ul>
                {g.doThis.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <small>{g.levels.length === 0 ? 'Appears in missions made from your own repository' : g.levels.length >= 6 ? 'Appears in most levels' : `Appears in level ${g.levels.join(', ')}`}</small>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
