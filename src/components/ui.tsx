import type { CSSProperties } from 'react';

/** Stroked icons shared by the whole UI. Rendered once, referenced with <use>. */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <symbol id="i-ne" viewBox="0 0 10 10"><path d="M2.2 7.8 7.8 2.2M3.2 2.2h4.6v4.6" /></symbol>
      <symbol id="i-left" viewBox="0 0 17 11"><path d="M16 5.5H1.6M5.6 1.4 1.4 5.5l4.2 4.1" /></symbol>
      <symbol id="i-right" viewBox="0 0 17 11"><path d="M1 5.5h14.4M11.4 1.4l4.2 4.1-4.2 4.1" /></symbol>
      <symbol id="i-down" viewBox="0 0 10 14"><path d="M5 .8v11.6M1.2 8.8 5 12.6l3.8-3.8" /></symbol>
      <symbol id="i-caret" viewBox="0 0 8 6"><path d="M1 1h6L4 5z" fill="currentColor" stroke="none" /></symbol>
      <symbol id="i-menu" viewBox="0 0 12 10"><path d="M0 1.5h12M0 5h12M0 8.5h12" /></symbol>
      <symbol id="i-dial" viewBox="0 0 12 12">
        <circle cx="6" cy="6" r="5" />
        <path d="M6 6 8.6 3.4" />
        <circle cx="6" cy="6" r=".9" fill="currentColor" stroke="none" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 12 12"><path d="M1.5 6.5 4.8 9.8 10.5 2.5" /></symbol>
      <symbol id="i-cross" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" /></symbol>
      <symbol id="i-star" viewBox="0 0 12 12"><path d="M6 1.2l1.55 3.2 3.5.45-2.6 2.4.68 3.5L6 8.95 2.87 10.75l.68-3.5-2.6-2.4 3.5-.45z" /></symbol>
      <symbol id="i-flag" viewBox="0 0 12 12"><path d="M2.5 11V1.5M2.5 2h6.6l-1.4 2.2 1.4 2.2H2.5" /></symbol>
      <symbol id="i-sound" viewBox="0 0 14 12"><path d="M1.5 4.5h2.4L7 2v8L3.9 7.5H1.5z M9.2 4.2a2.8 2.8 0 0 1 0 3.6 M10.8 2.6a5 5 0 0 1 0 6.8" /></symbol>
      <symbol id="i-mute" viewBox="0 0 14 12"><path d="M1.5 4.5h2.4L7 2v8L3.9 7.5H1.5z M9.5 4.5l3 3 M12.5 4.5l-3 3" /></symbol>
      <symbol id="i-book" viewBox="0 0 12 12"><path d="M1.5 2.2c1.6-.5 3.2-.3 4.5.7 1.3-1 2.9-1.2 4.5-.7v7.6c-1.6-.5-3.2-.3-4.5.7-1.3-1-2.9-1.2-4.5-.7zM6 2.9v7.6" /></symbol>
      <symbol id="i-info" viewBox="0 0 12 12">
        <circle cx="6" cy="6" r="5" />
        <path d="M6 5.2v3.3" />
        <circle cx="6" cy="3.4" r=".7" fill="currentColor" stroke="none" />
      </symbol>
    </svg>
  );
}

export type IconName = 'ne' | 'left' | 'right' | 'down' | 'caret' | 'menu' | 'dial' | 'check' | 'cross' | 'info' | 'star' | 'flag' | 'sound' | 'mute' | 'book';

export function Icon({ name, className = '', style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return (
    <svg className={`ic ${className}`.trim()} style={style} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** The four rounded corner brackets. Use inside an element with the `brk` class. */
export function Brk() {
  return (
    <>
      <i className="tl" />
      <i className="tr" />
      <i className="bl" />
      <i className="br" />
    </>
  );
}

export function LogoMark() {
  return (
    <svg viewBox="0 0 27 27" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb347" />
          <stop offset=".5" stopColor="#ff5a5f" />
          <stop offset="1" stopColor="#ff3d8b" />
        </linearGradient>
      </defs>
      <path
        d="M25 11V9A7 7 0 0 0 18 2H9A7 7 0 0 0 2 9V18A7 7 0 0 0 9 25H18A7 7 0 0 0 25 18V16"
        fill="none"
        stroke="url(#lg)"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <circle cx="9.5" cy="13.5" r="1.9" fill="#141414" />
      <circle cx="16.5" cy="13.5" r="1.9" fill="#141414" />
    </svg>
  );
}
