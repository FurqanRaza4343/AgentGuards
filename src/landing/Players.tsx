import { useRef, useState } from 'react';
import { Brk, Icon } from '../components/ui';

interface Persona {
  name: string;
  role: string;
  quote: string;
  shirt: string;
  hair: string;
  skin: string;
}

/** The three personas from the project brief. They are personas, not customer testimonials. */
const PERSONAS: Persona[] = [
  {
    name: 'Sara',
    role: 'Software engineer',
    quote: '“I want to learn how agentic systems can be misused or safeguarded, without any risk to real systems.”',
    shirt: '#202026',
    hair: '#2b2420',
    skin: '#e5bd96',
  },
  {
    name: 'Ali',
    role: 'Computer science student',
    quote: '“I want to see what happens if I accidentally give my assistant too many permissions.”',
    shirt: '#2f4a6b',
    hair: '#17120f',
    skin: '#c99a70',
  },
  {
    name: 'Nida',
    role: 'Project manager',
    quote: '“I need to know how much autonomy to give future AI features, and where a human must stay in the loop.”',
    shirt: '#6b2f4a',
    hair: '#241b18',
    skin: '#d9ab84',
  },
];

function Avatar({ p }: { p: Persona }) {
  return (
    <svg className="avatar" viewBox="0 0 56 56" role="img" aria-label={`Illustration of ${p.name}, in front of a brick wall`}>
      <defs>
        <pattern id="brick" width="14" height="14" patternUnits="userSpaceOnUse">
          <rect width="14" height="14" fill="#c0603f" />
          <path d="M0 .5H14M0 7.5H14M.5 0V7M7.5 7V14" stroke="#e6d6c6" strokeWidth="1" fill="none" />
        </pattern>
        <linearGradient id="avshade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".28" />
        </linearGradient>
      </defs>
      <rect width="56" height="56" fill="url(#brick)" />
      <rect width="56" height="56" fill="url(#avshade)" />
      <path d="M7 56c0-11 8-16.5 21-16.5S49 45 49 56z" fill={p.shirt} />
      <path d="M22.5 39.5 28 46l5.5-6.5" fill="#e9e5dd" />
      <rect x="24.2" y="31" width="7.6" height="9" rx="2" fill={p.skin} />
      <ellipse cx="28" cy="24.5" rx="8.4" ry="9.6" fill={p.skin} />
      <path d="M19.4 23.5c-.6-8.2 4.3-12.2 9.8-12 5.6.2 9.4 4.4 8.4 12-1.4-3.6-3.6-5.4-6.6-5.9-3.6-.6-9 .2-11.6 5.9z" fill={p.hair} />
    </svg>
  );
}

/** Third section: who the game is for. Arrows fade the text out (0.45s), swap it, and fade it back in. */
export function Players({ onPlay }: { onPlay: () => void }) {
  const [idx, setIdx] = useState(0);
  const [out, setOut] = useState(false);
  const busy = useRef(false);

  const go = (d: number) => {
    if (busy.current) return;
    busy.current = true;
    setOut(true);
    setTimeout(() => {
      setIdx((i) => (i + d + PERSONAS.length) % PERSONAS.length);
      setOut(false);
      setTimeout(() => {
        busy.current = false;
      }, 450);
    }, 450);
  };

  const p = PERSONAS[idx];
  const upcoming = PERSONAS[(idx + 1) % PERSONAS.length];
  const sw = `sw${out ? ' out' : ''}`;

  return (
    <>
      <div className="rhead rv">
        <div className="rtag">
          <span>Players</span>
          <span className="rnum brk">
            {String(idx + 1).padStart(2, '0')}
            <Brk />
          </span>
        </div>
        <div className="rwho">
          <Avatar p={p} />
          <i className="rdot" />
          <div className="rtxt">
            <span className={`rname ${sw}`}>{p.name}</span>
            <span className={`rrole ${sw}`}>Persona · {p.role}</span>
          </div>
        </div>
      </div>

      <div className="rbody">
        <blockquote className="rquote rv d1">
          <span className={sw} aria-live="polite">{p.quote}</span>
        </blockquote>
        <button className="rtry rv d2" type="button" onClick={onPlay}>
          Try for yourself (Click Here)
        </button>
      </div>

      <div className="rnav rv d3">
        <button type="button" aria-label="Previous persona" onClick={() => go(-1)}>
          <Icon name="left" />
        </button>
        <button type="button" aria-label="Next persona" onClick={() => go(1)}>
          <Icon name="right" />
        </button>
      </div>

      <div className="ghost rv d3" aria-hidden="true">
        <span className={sw}>{upcoming.quote}</span>
      </div>
    </>
  );
}
