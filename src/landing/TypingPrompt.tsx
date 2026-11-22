import { useEffect, useState } from 'react';
import { Brk } from '../components/ui';
import { useReducedMotion } from '../lib/useReducedMotion';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The prompt box of the intro. Types 38ms per character, holds 2.6s, deletes two characters
 * every 14ms, waits 250ms, then moves to the next prompt. The upcoming prompt shows in faint ink below.
 */
export function TypingPrompt({ prompts }: { prompts: string[] }) {
  const reduced = useReducedMotion();
  const [typed, setTyped] = useState('');
  const [next, setNext] = useState(prompts[1] ?? '');

  useEffect(() => {
    if (reduced) {
      setTyped(prompts[0]);
      return;
    }
    let cancelled = false;
    (async () => {
      let i = 0;
      while (!cancelled) {
        const s = prompts[i % prompts.length];
        setNext(prompts[(i + 1) % prompts.length]);
        for (let n = 1; n <= s.length && !cancelled; n++) {
          setTyped(s.slice(0, n));
          await sleep(38);
        }
        if (cancelled) break;
        await sleep(2600);
        for (let m = s.length; m > 0 && !cancelled; m -= 2) {
          setTyped(s.slice(0, Math.max(0, m - 2)));
          await sleep(14);
        }
        setTyped('');
        await sleep(250);
        i++;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prompts, reduced]);

  return (
    <div className="prompt rv" aria-hidden="true">
      <div className="ptab">“</div>
      <div className="pbox">
        <span>{typed}</span>
        <span className="caret" />
      </div>
      <div className="pbrk brk">
        <Brk />
      </div>
      <div className="pnext">{next}</div>
    </div>
  );
}
