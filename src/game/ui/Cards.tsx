import { useState, type CSSProperties } from 'react';
import { AGENTS, TOOL_LABEL } from '../../agents';
import { Brk, Icon } from '../../components/ui';
import { guideById } from '../guide';
import type { HistoryEntry, LevelResult } from '../gameReducer';
import { BADGES, badgeById, type Progress } from '../progress';
import { cap, unitOf } from '../labels';
import { SayBubble } from './Panels';
import { RATING_TEXT, ratingFor, starsFor, type Rating } from '../scoring';
import type { Option, Scenario, Step } from '../types';

function Card({ label, children, labelledBy }: { label: string; children: React.ReactNode; labelledBy: string }) {
  return (
    <section className="gcard brk" aria-labelledby={labelledBy}>
      <p className="glabel">{label}</p>
      {children}
      <Brk />
    </section>
  );
}

export function Stars({ n }: { n: number }) {
  return (
    <span className="gstars" role="img" aria-label={`${n} of 3 stars`}>
      {[1, 2, 3].map((i) => (
        <Icon key={i} name="star" className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

function Chips({ ids, onGuide }: { ids: string[]; onGuide: (id: string) => void }) {
  return (
    <ul className="gchips" aria-label="Concepts in this level">
      {ids.map((id) => (
        <li key={id}>
          <button type="button" onClick={() => onGuide(id)}>
            <Icon name="book" /> {guideById(id)?.title ?? id}
          </button>
        </li>
      ))}
    </ul>
  );
}

function BadgeRow({ earned, fresh }: { earned: string[]; fresh?: string[] }) {
  return (
    <ul className="gbadges" aria-label="Badges">
      {BADGES.map((b) => {
        const has = earned.includes(b.id);
        return (
          <li key={b.id} className={`${has ? 'has' : ''}${fresh?.includes(b.id) ? ' new' : ''}`} title={`${b.name}: ${b.desc}`}>
            <Icon name={has ? 'star' : 'flag'} />
            <span>
              <b>{b.name}</b>
              <small>{has ? b.desc : `Locked. ${b.desc}`}</small>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ level select

export function IntroCard({
  scenarios,
  progress,
  onStart,
  onGuide,
  onReset,
  onAnalyse,
}: {
  scenarios: Scenario[];
  progress: Progress;
  onStart: (level: number) => void;
  onGuide: (id?: string) => void;
  onReset: () => void;
  /** opens the scanner, so the player can make missions from their own repository */
  onAnalyse?: () => void;
}) {
  const unit = unitOf(scenarios[0]);
  const source = scenarios[0]?.source ?? 'repo';
  const thing = source === 'site' ? 'website' : source === 'profile' ? 'profile' : 'repository';
  const [sure, setSure] = useState(false);
  const next = Math.max(0, scenarios.findIndex((s) => !progress.levels[s.id]));
  const nextIdx = scenarios.every((s) => progress.levels[s.id]) ? 0 : next;
  const played = Object.keys(progress.levels).length > 0;
  const allDone = scenarios.every((s) => progress.levels[s.id]);
  return (
    <Card label="AgentGuard · Inspector briefing" labelledBy="g-intro">
      <h2 id="g-intro">{unit === 'mission' ? `Your ${thing}, as a game.` : 'You are the human in the loop.'}</h2>
      <p id="g-intro-body">
        {unit === 'mission'
          ? source === 'site'
            ? 'Each mission is built from what the scan really found on your website. Your web agent wants to publish a change: inspect it, find the red flags, and decide. Things your site already does well are in the game too, so do not block them. Ask for the specific fix.'
            : source === 'profile'
              ? 'Each mission is built from what the review really found in your profile. Your profile agent wants to post an update: inspect it, find the red flags, and decide. Things that already work are in the game too, so do not block them. Ask for the specific fix.'
              : 'Each mission is built from real lines of your repository. Your coding agent wants to merge a change: inspect the lines, find the red flags, and decide. Block everything and nothing gets done, so ask for the specific fix.'
          : 'AI agents read email, query databases and talk to each other. They are useful, and they can be tricked. Inspect what an agent is about to do, then decide. Block everything and nothing gets done, so find the safe way to get the work finished.'}
      </p>
      <div className="gactions">
        <button className="gbtn primary" type="button" data-autofocus="" aria-describedby="g-intro-body" onClick={() => onStart(nextIdx)}>
          {allDone ? `Replay from ${unit} 1` : played ? `Continue with ${unit} ${nextIdx + 1}` : `Begin ${unit} 1`} <Icon name="right" />
        </button>
        <button className="gbtn" type="button" onClick={() => onGuide()}>
          <Icon name="book" /> Field guide
        </button>
        {onAnalyse && (
          <button className="gbtn" type="button" onClick={onAnalyse}>
            {unit === 'mission' ? (source === 'site' ? 'Analyse another website' : source === 'profile' ? 'Review another profile' : 'Scan another repository') : 'Make missions from my repo, site or profile'}
          </button>
        )}
      </div>

      <h3 className="gh3">{cap(unit)}s</h3>
      <ol className="glevels">
        {scenarios.map((s, i) => {
          const rec = progress.levels[s.id];
          return (
            <li key={s.id}>
              <button type="button" className={i === nextIdx ? 'rec' : ''} onClick={() => onStart(i)}>
                <span className="lv-n">{s.level}</span>
                <span className="lv-t">
                  <b>{s.title}</b>
                  <small>{s.subtitle}</small>
                </span>
                <span className="lv-agents" aria-label={s.agents.map((a) => AGENTS[a].name).join(', ')}>
                  {s.agents.map((a) => (
                    <i key={a} style={{ background: AGENTS[a].accent }} />
                  ))}
                </span>
                <span className="lv-r">{rec ? <Stars n={rec.stars} /> : <small>New</small>}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <h3 className="gh3">
        Badges <small>{progress.badges.length} of {BADGES.length}</small>
      </h3>
      <BadgeRow earned={progress.badges} />

      {played && (
        <button
          type="button"
          className="glink"
          onClick={() => {
            if (sure) {
              onReset();
              setSure(false);
            } else setSure(true);
          }}
          onBlur={() => setSure(false)}
        >
          {sure ? 'Click again to erase your progress' : 'Reset progress'}
        </button>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ briefing

export function BriefCard({ scenario, onBegin, onGuide }: { scenario: Scenario; onBegin: () => void; onGuide: (id: string) => void }) {
  return (
    <Card label={`${cap(unitOf(scenario))} ${scenario.level} · ${scenario.subtitle}`} labelledBy="g-brief">
      <h2 id="g-brief">{scenario.title}</h2>
      <p id="g-brief-body">{scenario.briefing}</p>
      <p className="gmeta">
        <span>{scenario.agents.length > 1 ? 'Agents' : 'Agent'}</span>
        {scenario.agents.map((a) => AGENTS[a].name).join(', ')}
      </p>
      <Chips ids={scenario.concepts} onGuide={onGuide} />
      <div className="gactions">
        <button className="gbtn primary" type="button" data-autofocus="" aria-describedby="g-brief-body" onClick={onBegin}>
          Start simulation <Icon name="right" />
        </button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ step

interface ScenarioProps {
  step: Step;
  stepNumber: number;
  stepCount: number;
  deciding: boolean;
  reveal: { title: string; text: string } | null;
}

export function ScenarioCard({ step, stepNumber, stepCount, deciding, reveal }: ScenarioProps) {
  return (
    <Card label={`Step ${stepNumber} of ${stepCount} · ${TOOL_LABEL[step.tool]}`} labelledBy="g-step">
      <h2 id="g-step">{step.title}</h2>
      <p>{step.situation}</p>
      <SayBubble id={step.actor} text={step.say} />
      {reveal && (
        <div className="greveal" role="status">
          <p className="glabel">
            <Icon name="info" /> {reveal.title}
          </p>
          <p>{reveal.text}</p>
        </div>
      )}
      <p className="gprompt">{deciding ? `What should ${AGENTS[step.actor].name} do?` : `${AGENTS[step.actor].name} is working...`}</p>
    </Card>
  );
}

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

export function OutcomeCard({ option, last, onContinue }: { option: Option; last: boolean; onContinue: () => void }) {
  const tone = option.verdict;
  return (
    <Card label="Outcome" labelledBy="g-outcome">
      <div className={`gverdict ${tone}`} role="status">
        <Icon name={tone === 'safe' ? 'check' : tone === 'risky' ? 'cross' : 'info'} />
        <span id="g-outcome">{tone === 'safe' ? 'Safe choice' : tone === 'risky' ? 'Risky choice' : 'Safe, but nothing got done'}</span>
        <b className="gdelta">
          Safety {sign(option.safety)} · Work {sign(option.work)}
        </b>
      </div>
      <p id="g-outcome-body">{option.consequence}</p>
      <div className="glesson">
        <p className="glabel">Lesson</p>
        <p>{option.lesson}</p>
      </div>
      <div className="gactions">
        <button className="gbtn primary" type="button" data-autofocus="" aria-describedby="g-outcome-body" onClick={onContinue}>
          {last ? 'See results' : 'Continue'} <Icon name="right" />
        </button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ summary

function Debrief({ scenario, entry }: { scenario: Scenario; entry: HistoryEntry }) {
  const step = scenario.steps.find((s) => s.id === entry.stepId);
  if (entry.audit) {
    return (
      <li className="neutral">
        <Icon name="info" />
        <div>
          <b>Audit</b>
          <span>You looked before you decided.</span>
        </div>
      </li>
    );
  }
  const counter: Option | undefined = step?.options.find((o) => o.kind === (step.threat ? 'allow' : 'block'));
  const showCounter = counter && counter.kind !== entry.kind;
  return (
    <li className={entry.verdict}>
      <Icon name={entry.verdict === 'safe' ? 'check' : entry.verdict === 'risky' ? 'cross' : 'info'} />
      <div>
        <b>
          {entry.label}
          <em>
            Safety {sign(entry.safety)} · Work {sign(entry.work)}
          </em>
        </b>
        <span>{entry.lesson}</span>
        <small>
          Red flags found: {entry.flagsFound} of {entry.flagsTotal}
        </small>
        {showCounter && (
          <details>
            <summary>{step?.threat ? 'What if you had allowed it?' : 'What if you had blocked it?'}</summary>
            <p>{counter.consequence}</p>
          </details>
        )}
      </div>
    </li>
  );
}

export function SummaryCard({
  scenario,
  result,
  history,
  fresh,
  isLastLevel,
  onRetry,
  onNext,
  onMenu,
  onGuide,
}: {
  scenario: Scenario;
  result: LevelResult;
  history: HistoryEntry[];
  fresh: string[];
  isLastLevel: boolean;
  onRetry: () => void;
  onNext: () => void;
  onMenu: () => void;
  onGuide: (id: string) => void;
}) {
  return (
    <Card label={`${cap(unitOf(scenario))} ${scenario.level} complete`} labelledBy="g-summary">
      <h2 id="g-summary">
        {result.rating} <Stars n={starsFor(result.rating)} />
        <span className="gscorebig">
          {result.score} / {result.max} points
        </span>
      </h2>
      <p id="g-summary-body">{RATING_TEXT[result.rating]}</p>
      <dl className="gresult">
        <div>
          <dt>Safety</dt>
          <dd>{result.safety} / {result.safetyMax}</dd>
        </div>
        <div>
          <dt>Work done</dt>
          <dd>{result.work} / {result.workMax}</dd>
        </div>
        <div>
          <dt>Red flags found</dt>
          <dd>{result.flagsFound} / {result.flagsTotal}</dd>
        </div>
      </dl>
      {fresh.length > 0 && (
        <div className="gnewbadge" role="status">
          <Icon name="star" className="on" />
          <span>
            Badge unlocked: <b>{fresh.map((id) => badgeById(id)?.name).join(', ')}</b>
          </span>
        </div>
      )}
      <ul className="ghistory">
        {history.map((h, i) => (
          <Debrief key={i} scenario={scenario} entry={h} />
        ))}
      </ul>
      <p className="glabel gtop">What you practised</p>
      <Chips ids={scenario.concepts} onGuide={onGuide} />
      <div className="gactions">
        <button className="gbtn primary" type="button" data-autofocus="" aria-describedby="g-summary-body" onClick={onNext}>
          {isLastLevel ? 'See your campaign' : `Next ${unitOf(scenario)}`} <Icon name="right" />
        </button>
        <button className="gbtn" type="button" onClick={onRetry}>
          Retry {unitOf(scenario)}
        </button>
        <button className="gbtn" type="button" onClick={onMenu}>
          All {unitOf(scenario)}s
        </button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ campaign

export function FinalCard({
  scenarios,
  progress,
  onMenu,
  onExit,
}: {
  scenarios: Scenario[];
  progress: Progress;
  onMenu: () => void;
  onExit: () => void;
}) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const recs = scenarios.map((s) => progress.levels[s.id]);
  const done = recs.filter(Boolean).length;
  const total = recs.reduce((n, r) => n + (r?.best ?? 0), 0);
  const max = scenarios.reduce((n, _s, i) => n + (recs[i]?.max ?? 0), 0);
  const rating: Rating = ratingFor(total, max);
  const text = `AgentGuard (DevFest Pakistan 2026): ${rating}, ${total} of ${max} points, ${done} of ${scenarios.length} levels, ${progress.badges.length} badges. Can you beat it? ${window.location.origin}${window.location.pathname}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <Card label="Your campaign" labelledBy="g-final">
      <h2 id="g-final">
        {done === 0 ? 'No levels played yet' : rating}
        <span className="gscorebig">
          {total} / {max} points · {done} of {scenarios.length} levels
        </span>
      </h2>
      <p id="g-final-body">{done === scenarios.length ? RATING_TEXT[rating] : 'Play the remaining levels to complete the campaign.'}</p>
      <ul className="ghistory">
        {scenarios.map((s, i) => {
          const r = recs[i];
          const ok = r && ratingFor(r.best, r.max) !== 'At risk';
          return (
            <li key={s.id} className={r ? (ok ? 'safe' : 'risky') : 'neutral'}>
              <Icon name={r ? (ok ? 'check' : 'cross') : 'info'} />
              <div>
                <b>
                  {cap(unitOf(s))} {s.level}: {s.title}
                  <em>{r ? `${r.best} / ${r.max}` : 'not played'}</em>
                </b>
                <span>{s.learning[0]}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <h3 className="gh3">
        Badges <small>{progress.badges.length} of {BADGES.length}</small>
      </h3>
      <BadgeRow earned={progress.badges} />
      <div className="gactions">
        <button className="gbtn primary" type="button" data-autofocus="" aria-describedby="g-final-body" onClick={copy}>
          Copy my result
        </button>
        <button className="gbtn" type="button" onClick={onMenu}>
          All levels
        </button>
        <button className="gbtn" type="button" onClick={onExit}>
          Back to home
        </button>
      </div>
      {copied !== 'idle' && (
        <p className="gnote" role="status" style={{ marginTop: 12 } as CSSProperties}>
          {copied === 'ok' ? 'Copied. Paste it anywhere to challenge a friend.' : `Could not copy automatically. Select this text: ${text}`}
        </p>
      )}
    </Card>
  );
}
