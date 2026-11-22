import { Brk } from '../components/ui';
import type { ExportStats } from './linkedinExport';

const MONTH_LETTER = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** The numbers from the member's own LinkedIn export: posts per month, certifications. Drawn with plain CSS bars. */
export function ActivityCard({ stats }: { stats: ExportStats }) {
  const max = Math.max(1, ...stats.months.map((m) => m.posts));
  return (
    <section className="gcard brk lact" aria-label="Your activity">
      <p className="glabel">Your activity · from your own LinkedIn export</p>
      {stats.hasPosts && (
        <>
          <ol className="lbars" aria-label="Posts per month, last 12 months">
            {stats.months.map((m) => (
              <li key={m.month} title={`${m.month}: ${m.posts} post${m.posts === 1 ? '' : 's'}`}>
                <span className="lbar" style={{ height: `calc((100% - 34px) * ${m.posts / max})` }} data-zero={m.posts === 0 ? '' : undefined} />
                <small>{MONTH_LETTER[Number(m.month.slice(5)) - 1]}</small>
                <b>{m.posts}</b>
              </li>
            ))}
          </ol>
          <dl className="lstats">
            <div>
              <dt>Posts, last 12 months</dt>
              <dd>{stats.postsLast12}</dd>
            </div>
            <div>
              <dt>Per month</dt>
              <dd>{stats.avgPerMonth}</dd>
            </div>
            <div>
              <dt>Last post</dt>
              <dd>{stats.lastPost ? `${stats.daysSinceLastPost} days ago` : 'none'}</dd>
            </div>
            <div>
              <dt>Longest silence</dt>
              <dd>{stats.longestGapDays === null ? 'n/a' : `${stats.longestGapDays} days`}</dd>
            </div>
          </dl>
        </>
      )}
      {stats.hasCertFile && (
        <>
          <p className="glabel lcert-label">
            Certifications · {stats.certifications.length}
          </p>
          {stats.certifications.length === 0 ? (
            <p className="gnote">None are listed.</p>
          ) : (
            <ul className="lcerts">
              {stats.certifications.slice(0, 6).map((c) => (
                <li key={`${c.name}-${c.finished}`}>
                  <b>{c.name}</b>
                  <small>{[c.authority, c.finished].filter(Boolean).join(' · ')}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="gnote">
        {stats.positions} position{stats.positions === 1 ? '' : 's'} · {stats.skills} skills · {stats.recommendations} recommendation{stats.recommendations === 1 ? '' : 's'}
        {stats.connections !== null ? ` · ${stats.connections} connections` : ''}. This file was read in your browser and was not uploaded.
      </p>
      <Brk />
    </section>
  );
}
