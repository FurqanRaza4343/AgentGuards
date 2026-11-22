import { Icon } from '../components/ui';

const NAMES = ['Intro', 'Levels', 'Players'];
const TOP = [0, 31, 62]; // % of the rail height
const DOT = [0, 4, 8]; // which of the 14 dots the label sits on

/** Right-hand rail: 14 dots and a label that slides to the section that is more than half visible. */
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
