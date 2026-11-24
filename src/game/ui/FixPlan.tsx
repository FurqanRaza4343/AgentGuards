import { useState } from 'react';
import { Icon } from '../../components/ui';
import { scoresAfterFixing, scorecardsOf } from '../../assess/scorecard';
import type { AssessReport } from '../../assess/types';
import { buildFixPlan, fixPlanToMarkdown, STATE_LABEL } from '../fixPlan';
import type { HistoryEntry } from '../progress';
import type { Scenario } from '../types';

const NAME = { repo: 'repository', site: 'website', profile: 'profile' } as const;

/** After a mission: the real fixes it was about, with how many points they are worth when the report has a scorecard. */
export function FixPlan({ scenario, history, report }: { scenario: Scenario; history: HistoryEntry[]; report: AssessReport | null }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const items = buildFixPlan(scenario, history);
  if (items.length === 0) return null;
  const source = scenario.source ?? 'repo';
  const requested = items.filter((i) => i.state === 'requested');

  // a website or a profile has a score: show what these fixes are worth
  let rows: { title: string; now: number; asked: number; all: number }[] = [];
  if (report && (source === 'site' || source === 'profile') && report.kind === source) {
    const cards = scorecardsOf(report);
    const asked = scoresAfterFixing(report, requested.map((i) => i.findingId));
    const all = scoresAfterFixing(report, items.map((i) => i.findingId));
    // only the scores that these fixes can move: a mission about security says nothing about search
    rows = cards.map((c, n) => ({ title: c.title, now: c.score, asked: asked[n], all: all[n] })).filter((r) => r.all > r.now);
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fixPlanToMarkdown(items, `Fix list for my ${NAME[source]}`));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <section className="gcard gfix" aria-labelledby="g-fix">
      <p className="glabel">Your fix list</p>
      <h2 id="g-fix">
        {requested.length === items.length ? `You asked for all ${items.length} fixes.` : `${items.length - requested.length} of ${items.length} things still need fixing.`}
      </h2>
      {rows.map((r) => (
        <div key={r.title} className="gfix-row" role="group" aria-label={`${r.title} if these are fixed`}>
          <p className="gfix-name">{r.title}, out of 100</p>
          <div className="gfix-score">
            <div>
              <small>Now</small>
              <b>{r.now}</b>
            </div>
            <Icon name="right" />
            <div>
              <small>With your fixes</small>
              <b>{r.asked}</b>
            </div>
            <Icon name="right" />
            <div className="best">
              <small>With all of them</small>
              <b>{r.all}</b>
            </div>
          </div>
        </div>
      ))}
      <ol className="gfix-list">
        {items.map((i) => (
          <li key={i.stepId} className={i.state}>
            <span className="gfix-tag">{STATE_LABEL[i.state]}</span>
            <b>{i.title}</b>
            {i.fix && <span className="gfix-do">{i.fix}</span>}
            {i.where && <small>{i.where}</small>}
          </li>
        ))}
      </ol>
      <div className="gactions">
        <button className="gbtn" type="button" onClick={copy}>
          Copy my fix list
        </button>
      </div>
      {copied !== 'idle' && (
        <p className="gnote" role="status">
          {copied === 'ok' ? 'Copied. It is a checklist you can paste into an issue or a note.' : 'Could not copy automatically.'}
        </p>
      )}
    </section>
  );
}
