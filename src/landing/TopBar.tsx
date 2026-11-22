import { useEffect, useState } from 'react';
import { Icon } from '../components/ui';
import { EVENT_URL } from '../constants';

/** Announcement bar: slides away after 40px of scroll, or when dismissed. Always hidden inside the game. */
export function TopBar({ forceHidden }: { forceHidden: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 40);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  const hidden = forceHidden || dismissed || scrolled;
  useEffect(() => {
    document.body.classList.toggle('tb-off', hidden);
  }, [hidden]);

  return (
    <div className="topbar">
      <a href={EVENT_URL} target="_blank" rel="noopener noreferrer" tabIndex={hidden ? -1 : 0}>
        <b>New:</b> AgentGuard - The AI Agent Safety Game for DevFest Pakistan 2026 <Icon name="ne" />
      </a>
      <button className="tb-x" type="button" aria-label="Dismiss announcement" tabIndex={hidden ? -1 : 0} onClick={() => setDismissed(true)}>
        ×
      </button>
    </div>
  );
}
