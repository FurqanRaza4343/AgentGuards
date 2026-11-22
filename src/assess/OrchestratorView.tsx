import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId } from '../agents';
import { Brk, Icon, LogoMark } from '../components/ui';
import { layoutFor } from '../game/layout';
import type { LogLine } from '../game/types';
import { LogPanel } from '../game/ui/Panels';
import { ScanError } from '../live/scanClient';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useReducedMotion } from '../lib/useReducedMotion';
import { stage } from '../stage/stage';
import { loadAssessDemo, runAssess } from './assessClient';
import { beamColour, CREW_ORDER, emptyTasks, idleStates } from './beams';
import type { CrewStates, CrewTasks } from './beams';
import { CrewStatus, StageCaptions } from './Crew';
import { ModeTabs } from './ModeTabs';
import { AREA_LABEL, assessToMarkdown, countBySeverity } from './types';
import type { AFinding, AssessKind, AssessReport } from './types';

type Phase = 'form' | 'running' | 'done' | 'error';

const COPY: Record<AssessKind, { label: string; title: string; intro: string; run: string; busy: string; busyText: string }> = {
  site: {
    label: 'AgentGuard Orchestrator · website',
    title: 'Let the crew read your website.',
    intro:
      'Nova, the orchestrator, sends three specialists to read the public pages: a Scraper, a Security checker and a Content reviewer. They work at the same time and report back, and Nova turns what they found into questions and rewrites for you.',
    run: 'Read this website',
    busy: 'The crew is reading the site.',
    busyText: 'Ordinary page requests only. robots.txt is read first and obeyed, nothing is submitted, and nothing is stored.',
  },
  profile: {
    label: 'AgentGuard Orchestrator · profile',
    title: 'Let the crew review your profile.',
    intro:
      'Paste the text of your LinkedIn (or any professional) profile. Nova sends a Reader, a Privacy checker and an Impact reviewer, then asks the questions that would make it stronger. Nothing is fetched from LinkedIn: only what you paste is read.',
    run: 'Review this profile',
    busy: 'The crew is reading your profile.',
    busyText: 'Only the text you pasted is read. Contact details are replaced before any excerpt goes to a language model.',
  },
};

const SEV_ORDER: AFinding['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];

export function OrchestratorView({ kind, onExit }: { kind: AssessKind; onExit: () => void }) {
  const copy = COPY[kind];
  const [phase, setPhase] = useState<Phase>('form');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [role, setRole] = useState('');
  const [consent, setConsent] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [report, setReport] = useState<AssessReport | null>(null);
  const [error, setError] = useState('');
  const [states, setStates] = useState<CrewStates>(idleStates);
  const [tasks, setTasks] = useState<CrewTasks>(emptyTasks);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const mobile = useMediaQuery('(max-width: 900px)');
  const reduced = useReducedMotion();

  // ---- the crew stands on the stage: Nova first, then the three specialists
  useEffect(() => {
    stage.setMode('game');
    stage.showAgents(CREW_ORDER);
    return () => {
      stage.setMode('landing');
      stage.showAgents(['nova']);
      stage.setAllAgentStates('idle');
    };
  }, []);
  useEffect(() => stage.setLayout(layoutFor(4, mobile)), [mobile]);
  useEffect(() => CREW_ORDER.forEach((id) => stage.setAgentState(id, states[id])), [states]);

  // a different page (website <-> profile) starts clean
  useEffect(() => {
    abort.current?.abort();
    setPhase('form');
    setReport(null);
    setLog([]);
    setStates(idleStates());
    setTasks(emptyTasks());
    setCopied(false);
    setShowAll(false);
  }, [kind]);

  const handleLine = useCallback((line: LogLine) => {
    setLog((l) => [...l, line]);
    const who = line.from;
    if (who && line.state) {
      setStates((s) => ({ ...s, [who]: line.state! }));
      if (line.task) setTasks((t) => ({ ...t, [who]: line.task! }));
    }
    if (who && line.to) {
      stage.fireBeam(who, line.to, beamColour(who, line.to, line.state));
      // a task has been handed out: the receiver starts thinking about it
      if (who === 'nova' && line.to !== 'nova') {
        const to = line.to;
        setStates((s) => (s[to] === 'idle' ? { ...s, [to]: 'thinking' } : s));
        setTasks((t) => (t[to] ? t : { ...t, [to]: 'Task received' }));
      }
    }
  }, []);

  const begin = () => {
    setLog([]);
    setStates(idleStates());
    setTasks(emptyTasks());
    setCopied(false);
    setShowAll(false);
    setPhase('running');
  };

  const finish = (r: AssessReport) => {
    setReport(r);
    setPhase('done');
    setStates((s) => ({ ...s, nova: 'success' }));
  };

  const fail = (message: string) => {
    setError(message);
    setPhase('error');
    setStates({ nova: 'fail', data: 'idle', purchasing: 'idle', finance: 'idle' });
  };

  const start = async () => {
    begin();
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      finish(await runAssess(kind === 'site' ? { kind, url: url.trim() } : { kind, text, role: role.trim() }, handleLine, ctl.signal));
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPhase('form');
        setStates(idleStates());
        setTasks(emptyTasks());
      } else fail(err instanceof ScanError ? err.message : 'Something went wrong while reading.');
    }
  };

  const demo = async () => {
    begin();
    try {
      const r = await loadAssessDemo(kind);
      // replay the recorded run so the crew works through the same steps
      for (const line of r.runLog) {
        handleLine(line);
        if (!reduced) await new Promise((res) => setTimeout(res, 300));
      }
      finish(r);
    } catch (err) {
      fail(err instanceof ScanError ? err.message : 'The demo could not be loaded.');
    }
  };

  const copySummary = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(assessToMarkdown(report));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const counts = report ? countBySeverity(report.findings) : {};
  const real = useMemo(() => (report ? report.findings.filter((f) => f.severity !== 'info') : []), [report]);
  const shown = showAll ? report?.findings ?? [] : (report?.findings ?? []).slice(0, 10);
  const summaries = useMemo(() => {
    const out: Partial<Record<AgentId, string>> = {};
    for (const a of report?.agents ?? []) out[a.id] = a.summary;
    return out;
  }, [report]);
  const byId = useMemo(() => new Map((report?.findings ?? []).map((f) => [f.id, f])), [report]);
  const canRun = consent && (kind === 'site' ? url.trim().length >= 3 : text.trim().length >= 120);

  return (
    <div className="game live">
      <header className="nav gnav">
        <a className="logo" href="#" aria-label="AgentGuard, back to the home page" onClick={(e) => { e.preventDefault(); onExit(); }}>
          <LogoMark />
          <span>AGENTGUARD</span>
        </a>
        <div className="menu gprog" aria-label="Where you are">
          <span>{kind === 'site' ? 'Orchestrator · your website' : 'Orchestrator · your profile'}</span>
        </div>
        <button className="pad" type="button" onClick={onExit}>
          <Icon name="left" style={{ width: 14, height: 9 }} /> Exit
        </button>
        <div className="cta" />
      </header>

      <StageCaptions kind={kind} states={states} tasks={tasks} show={!mobile && phase !== 'form'} />

      <div className="gmain">
        {phase === 'form' && (
          <section className="gcard brk lform" aria-labelledby="o-title">
            <ModeTabs mode={kind} />
            <p className="glabel">{copy.label}</p>
            <h2 id="o-title">{copy.title}</h2>
            <p>{copy.intro}</p>
            {kind === 'site' ? (
              <>
                <label htmlFor="site-url">Website address</label>
                <input id="site-url" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="example.com" value={url} onChange={(e) => setUrl(e.target.value)} data-autofocus="" />
              </>
            ) : (
              <>
                <label htmlFor="profile-text">Profile text</label>
                <textarea id="profile-text" rows={9} spellCheck={false} placeholder={'Your name\nYour headline\nAbout\n...\nExperience\n...'} value={text} onChange={(e) => setText(e.target.value)} data-autofocus="" />
                <p className="lhint">
                  Open your profile, select the page text (Ctrl+A), copy and paste it here. Or use LinkedIn&apos;s <b>Save to PDF</b> and copy the text. Start with your name and headline. Nothing is fetched from LinkedIn.
                </p>
                <label htmlFor="profile-role">The role you want (optional)</label>
                <input id="profile-role" type="text" autoComplete="off" maxLength={80} placeholder="Backend engineer" value={role} onChange={(e) => setRole(e.target.value)} />
              </>
            )}
            <label className="lcheck">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                {kind === 'site'
                  ? 'I own this website or I am allowed to check it. I understand that a few ordinary page requests are made (robots.txt obeyed, nothing submitted), and that short masked excerpts may be sent to a language model to write the questions.'
                  : 'This is my own profile. I understand that short excerpts, with contact details replaced, may be sent to a language model to write the questions, and that only the role I typed may be sent to a search engine.'}
              </span>
            </label>
            <div className="gactions">
              <button className="gbtn primary" type="button" disabled={!canRun} onClick={start}>
                {copy.run} <Icon name="right" />
              </button>
              <button className="gbtn" type="button" onClick={demo}>
                Play the demo (no network)
              </button>
            </div>
            <p className="gnote">
              {kind === 'site'
                ? 'Findings explain what and why, without attack steps. If you find a real problem on a site that is not yours, tell its owner privately.'
                : 'Suggestions are starting points. Never claim results or skills that are not yours.'}
            </p>
            <Brk />
          </section>
        )}

        {phase === 'running' && (
          <>
            <section className="gcard brk" aria-labelledby="o-run">
              <p className="glabel">Working</p>
              <h2 id="o-run">{copy.busy}</h2>
              <p>{copy.busyText}</p>
              <CrewStatus kind={kind} states={states} tasks={tasks} />
              {abort.current && (
                <div className="gactions">
                  <button className="gbtn" type="button" onClick={() => abort.current?.abort()}>
                    Cancel
                  </button>
                </div>
              )}
              <Brk />
            </section>
            <LogPanel lines={log} simulating={false} onSkip={() => undefined} title="Crew log · read-only" empty="Nova is getting ready to send the first task..." />
          </>
        )}

        {phase === 'error' && (
          <section className="gcard brk" aria-labelledby="o-err">
            <p className="glabel">Could not finish</p>
            <h2 id="o-err">The run did not work out.</h2>
            <p role="alert" className="lerr">
              {error}
            </p>
            <div className="gactions">
              <button className="gbtn primary" type="button" data-autofocus="" onClick={() => setPhase('form')}>
                Try again
              </button>
              <button className="gbtn" type="button" onClick={demo}>
                Play the demo instead
              </button>
            </div>
            <Brk />
          </section>
        )}

        {phase === 'done' && report && (
          <>
            <section className="gcard brk" aria-labelledby="o-done">
              <p className="glabel">
                {report.demo ? 'Demo report' : 'Report'} · {report.target}
              </p>
              <h2 id="o-done">
                {real.length === 0 ? 'Nothing needs fixing.' : `${real.length} thing${real.length === 1 ? '' : 's'} to look at.`}
              </h2>
              <div className="lsev" aria-label="Findings by severity">
                {SEV_ORDER.map((s) => (counts[s] ? <span key={s} className={s}>{counts[s]} {s}</span> : null))}
              </div>
              <p>
                {report.kind === 'site'
                  ? `${report.stats.pages} page${report.stats.pages === 1 ? '' : 's'} read (${report.stats.words} words). `
                  : `${report.stats.words} words read. `}
                {report.model
                  ? report.backup
                    ? 'A backup language model wrote the questions below (Gemini was not available), and each one was checked.'
                    : 'Gemini wrote the questions below, and each one was checked.'
                  : 'The questions below come from templates (no model was used for this run).'}
              </p>
              <CrewStatus kind={kind} states={states} tasks={tasks} summaries={summaries} />
              <div className="gactions">
                <button className="gbtn primary" type="button" data-autofocus="" onClick={copySummary}>
                  Copy a summary
                </button>
                <button className="gbtn" type="button" onClick={() => { setPhase('form'); setReport(null); }}>
                  Analyse another
                </button>
              </div>
              {copied && <p className="gnote" role="status">Copied. The summary lists questions, rewrites and fixes, never the excerpts.</p>}
              <Brk />
            </section>

            {report.questions.length > 0 && (
              <section className="gcard brk" aria-label="Questions from Nova">
                <p className="glabel">Nova asks</p>
                <ol className="lq">
                  {report.questions.map((q) => {
                    const f = q.findingId ? byId.get(q.findingId) : undefined;
                    return (
                      <li key={q.id}>
                        <p className="lq-text">{q.text}</p>
                        {q.why && <p className="lq-why">{q.why}</p>}
                        <p className="lq-meta">
                          <span className="chip">{AREA_LABEL[q.area]}</span>
                          {f && <span>About: {f.title}</span>}
                        </p>
                      </li>
                    );
                  })}
                </ol>
                <Brk />
              </section>
            )}

            {report.improvements.length > 0 && (
              <section className="gcard brk" aria-label="Suggested rewrites">
                <p className="glabel">Suggested rewrites</p>
                <ul className="limp">
                  {report.improvements.map((i) => (
                    <li key={i.id}>
                      <b>{i.title}</b>
                      {i.before && (
                        <p className="limp-before">
                          <small>Now</small>
                          {i.before}
                        </p>
                      )}
                      <p className="limp-after">
                        <small>Try</small>
                        {i.after}
                      </p>
                    </li>
                  ))}
                </ul>
                <Brk />
              </section>
            )}

            <section className="gcard brk" aria-label="What the crew found">
              <p className="glabel">What the crew found</p>
              <ul className="lfind">
                {shown.map((f) => (
                  <li key={f.id}>
                    <span className={`sev ${f.severity}`}>{f.severity}</span>
                    <details>
                      <summary>
                        <b>{f.title}</b>
                        <small>{AREA_LABEL[f.area]}{f.location ? ` · ${f.location}` : ''}</small>
                      </summary>
                      <p>{f.detail}</p>
                      {f.evidence && <p className="lev"><code>{f.evidence}</code></p>}
                      <p className="lfix"><b>Fix.</b> {f.fix}</p>
                    </details>
                  </li>
                ))}
              </ul>
              {report.findings.length > 10 && (
                <div className="gactions">
                  <button className="gbtn" type="button" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer' : `Show all ${report.findings.length}`}
                  </button>
                </div>
              )}
              {report.strengths.length > 0 && (
                <>
                  <p className="glabel lgood-label">Already good</p>
                  <ul className="lgood">
                    {report.strengths.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="gnote">{report.search.note}</p>
              {report.disclaimers.map((d) => (
                <p key={d} className="gnote">{d}</p>
              ))}
              <Brk />
            </section>

            {log.length > 0 && (
              <details className="lrunlog">
                <summary>What the crew did ({log.length} lines)</summary>
                <LogPanel lines={log} simulating={false} onSkip={() => undefined} title="Crew log · read-only" />
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
