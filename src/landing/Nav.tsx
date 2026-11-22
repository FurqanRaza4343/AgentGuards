import { useEffect, useRef, useState } from 'react';
import { Icon, LogoMark } from '../components/ui';
import { EVENT_URL } from '../constants';

interface Props {
  onPlay: () => void;
  onGo: (sectionId: string) => void;
}

/** Sections the menu scrolls to, and pages it opens. Shown in a row on a wide screen, and in a panel on a phone. */
const LINKS: { label: string; id?: string; hash?: string }[] = [
  { label: 'Home', id: 'intro' },
  { label: 'Levels', id: 'levels' },
  { label: 'Players', id: 'players' },
  { label: 'Analyse yours', id: 'analyse' },
  { label: 'How it works', id: 'crew' },
  { label: 'Questions', id: 'faq' },
];

export function Nav({ onPlay, onGo }: Props) {
  const [open, setOpen] = useState(false);
  const burger = useRef<HTMLButtonElement>(null);

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setOpen(false);
    onGo(id);
  };

  // Escape closes the panel and returns focus to its button
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      burger.current?.focus();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);

  return (
    <header className="nav">
      <a className="logo" href="#intro" aria-label="AgentGuard, back to the top" onClick={go('intro')}>
        <LogoMark />
        <span>AGENTGUARD</span>
      </a>
      <nav className="menu" aria-label="Primary">
        {LINKS.map((l) => (
          <a key={l.label} href={`#${l.id}`} onClick={go(l.id!)}>
            {l.label}
          </a>
        ))}
      </nav>
      <a className="pad" href={EVENT_URL} target="_blank" rel="noopener noreferrer">
        DevFest 2026 <Icon name="ne" />
      </a>
      <div className="cta">
        <button className="btn" type="button" onClick={onPlay}>
          <span className="eyes" aria-hidden="true">••</span> Start game
        </button>
      </div>
      <button
        ref={burger}
        className="burger"
        type="button"
        aria-label={open ? 'Close the menu' : 'Open the menu'}
        aria-expanded={open}
        aria-controls="mpanel"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? 'cross' : 'menu'} />
      </button>

      <nav id="mpanel" className={`mpanel${open ? ' open' : ''}`} aria-label="Menu" hidden={!open}>
        {LINKS.map((l) => (
          <a key={l.label} href={`#${l.id}`} onClick={go(l.id!)}>
            {l.label}
          </a>
        ))}
        <a href="#analyze" onClick={() => setOpen(false)}>Scan a repository</a>
        <a href="#site" onClick={() => setOpen(false)}>Check a website</a>
        <a href="#profile" onClick={() => setOpen(false)}>Review a profile</a>
      </nav>
    </header>
  );
}
