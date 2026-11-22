export type Mode = 'repo' | 'site' | 'profile';

const TABS: { id: Mode; label: string; href: string }[] = [
  { id: 'repo', label: 'GitHub repo', href: '#analyze' },
  { id: 'site', label: 'Website', href: '#site' },
  { id: 'profile', label: 'Profile', href: '#profile' },
];

/** Switches between the three things AgentGuard can read. They are separate pages, so these are links. */
export function ModeTabs({ mode }: { mode: Mode }) {
  return (
    <nav className="lmodes" aria-label="What to analyse">
      {TABS.map((t) => (
        <a key={t.id} href={t.href} aria-current={t.id === mode ? 'page' : undefined} className={t.id === mode ? 'on' : ''}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}
