import { Icon } from '../components/ui';

const NAMES = ['Intro', 'Levels', 'Players', 'Analyse', 'How', 'Trust', 'FAQ'];
const DOT = [0, 2, 4, 6, 8, 10, 13]; // which of the 14 dots the label sits on
const TOP = DOT.map((d) => Math.round((d / 13) * 100)); // % of the rail height

/** Right-hand rail: 14 dots and a label that slides to the section the reader is in. */
export function Rail({ active }: { active: number }) {
  return (
    <aside className="rail" aria-hidden="true">
      <div className="rdots">
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} className={i === DOT[active] ? 'on' : ''} />
        ))}
      </div>
      <div className="rlabel" style={{ top: `${TOP[active]}%` }}>
        <Icon name="dial" />
        <span>{NAMES[active]}</span>
      </div>
      <div className="rmenu">
        <Icon name="menu" style={{ width: 12, height: 10 }} />
        Menu
      </div>
    </aside>
  );
}
