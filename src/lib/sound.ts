import { useSyncExternalStore } from 'react';

/** Small synthesised sound effects (Web Audio, no files). Quiet by design, with a mute switch that is remembered. */
export type Sfx = 'tick' | 'click' | 'alert' | 'good' | 'bad' | 'flag' | 'badge';

const KEY = 'agentguard.sound.v1';
const listeners = new Set<() => void>();
let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return window.localStorage.getItem(KEY) === 'off';
  } catch {
    return false;
  }
})();

export const isMuted = () => muted;

export function setMuted(value: boolean) {
  muted = value;
  try {
    window.localStorage.setItem(KEY, value ? 'off' : 'on');
  } catch {
    /* storage blocked: the choice just is not remembered */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const useMuted = () => useSyncExternalStore(subscribe, isMuted, () => false);

function audio(): AudioContext | null {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(c: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, gain: number, slideTo?: number) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

export function play(name: Sfx) {
  if (muted) return;
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  switch (name) {
    case 'tick':
      tone(c, 1400, t, 0.03, 'square', 0.012);
      break;
    case 'click':
      tone(c, 620, t, 0.05, 'triangle', 0.04);
      break;
    case 'flag':
      tone(c, 880, t, 0.08, 'sine', 0.05);
      tone(c, 1320, t + 0.07, 0.12, 'sine', 0.05);
      break;
    case 'alert':
      tone(c, 330, t, 0.16, 'sawtooth', 0.035);
      tone(c, 247, t + 0.17, 0.2, 'sawtooth', 0.035);
      break;
    case 'good':
      [523, 659, 784].forEach((f, i) => tone(c, f, t + i * 0.08, 0.18, 'sine', 0.05));
      break;
    case 'bad':
      tone(c, 260, t, 0.45, 'sawtooth', 0.045, 90);
      break;
    case 'badge':
      [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.09, 0.22, 'triangle', 0.05));
      break;
  }
}
