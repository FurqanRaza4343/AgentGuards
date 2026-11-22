import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../lib/useReducedMotion';
import { stage } from './stage';

export function StageCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    stage.setReducedMotion(reduced);
  }, [reduced]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    try {
      stage.mount(canvas);
    } catch (err) {
      console.warn('[agentguard] WebGL is unavailable, continuing without the 3D agent.', err);
      document.documentElement.classList.add('no-gl');
      return;
    }
    return () => stage.unmount();
  }, []);

  return <canvas id="stage" ref={ref} aria-hidden="true" />;
}
