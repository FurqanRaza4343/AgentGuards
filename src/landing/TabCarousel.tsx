import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Brk } from '../components/ui';

const LABELS = [
  'Level 1: Phishing and injection',
  'Level 2: Least privilege with MCP',
  'Level 3: Agent-to-agent trust',
  'Level 4: Sandboxing code',
  'Level 5: Poisoned tools',
  'Level 6: The final shift',
  'Inspect the evidence',
  'Human in the loop',
  'Field guide',
  'Badges and stars',
];
const N = LABELS.length;
// three trailing copies of the first tabs make the wrap-around seamless
const LIST = [...LABELS, ...LABELS.slice(0, 3)];

/** Every 2.4s the strip slides one tab left (0.9s). The active tab gets a frame and corner brackets. */
export function TabCarousel() {
  const [ti, setTi] = useState(0);
  const [snap, setSnap] = useState(false);
  const [tabW, setTabW] = useState(0);
  const firstRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const measure = () => firstRef.current && setTabW(firstRef.current.offsetWidth);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTi((i) => i + 1), 2400);
    return () => clearInterval(id);
  }, []);

  // after sliding onto the first copy, jump back to the real first tab without animating
  useEffect(() => {
    if (ti !== N) return;
    const id = setTimeout(() => {
      setSnap(true);
      setTi(0);
    }, 960);
    return () => clearTimeout(id);
  }, [ti]);

  useEffect(() => {
    if (!snap) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSnap(false)));
    return () => cancelAnimationFrame(id);
  }, [snap]);

  return (
    <div className="strip rv" role="presentation">
      <div className="track" style={{ transform: `translateX(${-ti * tabW}px)`, transition: snap ? 'none' : undefined }}>
        {LIST.map((label, k) => (
          <div
            key={k}
            ref={k === 0 ? firstRef : undefined}
            className={`tab brk${k === ti ? ' on' : ''}${k < ti ? ' past' : ''}`}
            aria-hidden={k >= N ? true : undefined}
          >
            <span className="tn">{String((k % N) + 1).padStart(2, '0')}</span>
            <span className="tlb">{label}</span>
            <Brk />
          </div>
        ))}
      </div>
    </div>
  );
}
