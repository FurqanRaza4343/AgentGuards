export type Mode = 'repo' | 'site' | 'profile';

interface Tab {
  id: Mode;
  game: string;
  label: string;
  verb: string;
  href: string;
  accent: string;
}

/** Three separate games. Each tile says which game it is, what it reads, and what the player decides. */
const TABS: Tab[] = [
  { id: 'repo', game: 'Game 1', label: 'GitHub repo', verb: 'Merge or block?', href: '#analyze', accent: '#ff6a3d' },
  { id: 'site', game: 'Game 2', label: 'Website', verb: 'Publish or stop?', href: '#site', accent: '#1fa3c9' },
  { id: 'profile', game: 'Game 3', label: 'LinkedIn', verb: 'Post or fix?', href: '#profile', accent: '#8b5cf6' },
];

function Glyph({ id }: { id: Mode }) {
  return (
    <svg className="lmode-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {id === 'repo' && (
        <>
          <circle cx="6" cy="5" r="2.2" />
          <circle cx="6" cy="19" r="2.2" />
          <circle cx="18" cy="9" r="2.2" />
          <path d="M6 7.2v9.6M18 11.2c0 4-5 3.2-11 6.2" />
        </>
      )}
      {id === 'site' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
        </>
      )}
      {id === 'profile' && (
        <>
          <circle cx="12" cy="8" r="3.6" />
          <path d="M4.5 20c.6-4.2 3.6-6.2 7.5-6.2s6.9 2 7.5 6.2" />
        </>
      )}
    </svg>
  );
}

/** Switches between the three games. They are separate pages, so these are links. */
export function ModeTabs({ mode }: { mode: Mode }) {
  return (
    <nav className="lmodes" aria-label="Choose a game">
      {TABS.map((t) => (
        <a
          key={t.id}
          href={t.href}
          aria-current={t.id === mode ? 'page' : undefined}
          className={t.id === mode ? 'on' : ''}
          style={{ ['--accent' as string]: t.accent }}
        >
          <span className="lmode-game">
            <Glyph id={t.id} />
            {t.game}
          </span>
          <span className="lmode-label">{t.label}</span>
          <span className="lmode-verb">{t.verb}</span>
        </a>
      ))}
    </nav>
  );
}
