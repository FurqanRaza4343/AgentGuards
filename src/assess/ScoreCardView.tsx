import { Brk } from '../components/ui';
import type { CheckStatus, Scorecard } from './scorecard';

const MARK: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '×', skip: '–' };
const WORD: Record<CheckStatus, string> = { pass: 'Fine', warn: 'Could be better', fail: 'Needs fixing', skip: 'Not checked' };
const ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2, skip: 3 };

const R = 52;
const C = 2 * Math.PI * R;

/** One number out of 100 with a ring, and the checklist behind it: what passes, what could be better, what needs fixing. */
export function ScoreCardView({ card, before }: { card: Scorecard; before?: number }) {
  const fails = card.checks.filter((c) => c.status === 'fail').length;
  const warns = card.checks.filter((c) => c.status === 'warn').length;
  const passes = card.checks.filter((c) => c.status === 'pass').length;
  const tone = card.score >= 85 ? 'good' : card.score >= 70 ? 'ok' : card.score >= 50 ? 'mid' : 'bad';
  const sorted = [...card.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <section className={`gcard brk lscore t-${tone}`} aria-label={card.title}>
      <p className="glabel">{card.title}</p>
      <div className="lscore-top">
        <svg className="lring" viewBox="0 0 120 120" role="img" aria-label={`${card.score} out of 100: ${card.verdict}`}>
          <circle className="lring-bg" cx="60" cy="60" r={R} />
          <circle className="lring-fg" cx="60" cy="60" r={R} strokeDasharray={`${(card.score / 100) * C} ${C}`} transform="rotate(-90 60 60)" />
          <text x="60" y="64" textAnchor="middle" className="lring-n">{card.score}</text>
          <text x="60" y="84" textAnchor="middle" className="lring-of">out of 100</text>
        </svg>
        <div>
          <p className="lscore-verdict">{card.verdict}</p>
          <p className="lscore-cap">{card.caption}</p>
          <p className="lscore-count">
            <b>{fails}</b> to fix · <b>{warns}</b> to improve · <b>{passes}</b> fine
            {before !== undefined && before !== card.score ? <> · was {before}</> : null}
          </p>
        </div>
      </div>
      <ul className="lchecks">
        {sorted.map((c) => (
          <li key={c.id} className={`c-${c.status}`}>
            <span className="cmark" aria-hidden="true">{MARK[c.status]}</span>
            <span className="clabel">
              {c.label}
              <span className="vh"> — {WORD[c.status]}</span>
            </span>
            <span className="cdetail">{c.detail}</span>
          </li>
        ))}
      </ul>
      <Brk />
    </section>
  );
}
