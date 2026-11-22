import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId } from '../agents';
import { ModeTabs } from '../assess/ModeTabs';
import { Brk, Icon, LogoMark } from '../components/ui';
import { layoutFor } from '../game/layout';
import type { Scenario } from '../game/types';
import { AgentBadge, LogPanel } from '../game/ui/Panels';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useReducedMotion } from '../lib/useReducedMotion';
import { buildMissions } from '../missions/buildScenarios';
import type { Report } from '../missions/types';
import type { LogLine } from '../game/types';
import type { AgentState } from '../stage/actors/types';
import { stage } from '../stage/stage';
import { countBySeverity, realFindings, reportToMarkdown } from './reportTools';
import { loadDemo, scanRepo, ScanError } from './scanClient';

const CREW: { id: AgentId; title: string; role: string }[] = [
  { id: 'nova', title: 'Scout', role: 'Checks the address' },
  { id: 'data', title: 'Retriever', role: 'Fetches one archive' },
  { id: 'purchasing', title: 'Auditor', role: 'Runs the rules' },
  { id: 'finance', title: 'Coach', role: 'Writes the prose' },
];

type Phase = 'form' | 'running' | 'done' | 'error';

interface Props {
  onExit: () => void;
  onPlay: (report: Report, missions: Scenario[]) => void;
}

export function AnalyzeView({ onExit, onPlay }: Props) {
  const [phase, setPhase] = useState<Phase>('form');
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [states, setStates] = useState<Record<AgentId, AgentState>>({ nova: 'idle', data: 'idle', purchasing: 'idle', finance: 'idle' });
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const mobile = useMediaQuery('(max-width: 900px)');
  const reduced = useReducedMotion();

  // ---- the crew stands on the stage while the scan runs
  useEffect(() => {
    stage.setMode('game');
    stage.showAgents(CREW.map((c) => c.id));
    return () => {
      stage.setMode('landing');
      stage.showAgents(['nova']);
      stage.setAllAgentStates('idle');
    };
  }, []);
  useEffect(() => stage.setLayout(layoutFor(4, mobile)), [mobile]);
  useEffect(() => CREW.forEach((c) => stage.setAgentState(c.id, states[c.id])), [states]);

  const handleLine = useCallback((line: LogLine) => {
    setLog((l) => [...l, line]);
    if (line.from) {
      setStates((s) => {
        const next = { ...s };
        (Object.keys(next) as AgentId[]).forEach((k) => (next[k] = k === line.from ? 'working' : 'idle'));
        return next;
      });
    }
    if (line.from && line.to) stage.fireBeam(line.from, line.to);
  }, []);

  const finish = (r: Report) => {
    setReport(r);
    setPhase('done');
    setStates({ nova: 'success', data: 'success', purchasing: 'success', finance: 'success' });
  };

  const fail = (message: string) => {
    setError(message);
    setPhase('error');
    setStates({ nova: 'idle', data: 'idle', purchasing: 'fail', finance: 'idle' });
  };

  const start = async () => {
    setLog([]);
    setCopied(false);
    setPhase('running');
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      finish(await scanRepo(url.trim(), handleLine, ctl.signal));
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPhase('form');
        setStates({ nova: 'idle', data: 'idle', purchasing: 'idle', finance: 'idle' });
      } else fail(err instanceof ScanError ? err.message : 'Something went wrong while scanning.');
    }
  };

  const demo = async () => {
    setLog([]);
    setPhase('running');
    try {
      const r = await loadDemo();
      // replay the recorded run so the crew works through the same steps
      for (const line of r.runLog) {
        handleLine(line);
        if (!reduced) await new Promise((res) => setTimeout(res, 260));
      }
      finish(r);
    } catch (err) {
      fail(err instanceof ScanError ? err.message : 'The demo could not be loaded.');
    }
  };

  const built = useMemo(() => (report ? buildMissions(report) : null), [report]);
  const counts = report ? countBySeverity(report.findings) : {};
  const items = report ? realFindings(report) : [];

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(reportToMarkdown(report));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="game live">
      <header className="nav gnav">
        <a className="logo" href="#" aria-label="AgentGuard, back to the home page" onClick={(e) => { e.preventDefault(); onExit(); }}>
          <LogoMark />
          <span>AGENTGUARD</span>
        </a>
        <div className="menu gprog" aria-label="Where you are">
          <span>Make missions from your repository</span>
        </div>
        <button className="pad" type="button" onClick={onExit}>
          <Icon name="left" style={{ width: 14, height: 9 }} /> Exit
        </button>
        <div className="cta" />
      </header>

      <div className="gagents" aria-label="The crew">
        {CREW.map((c) => (
          <AgentBadge key={c.id} id={c.id} title={c.title} role={c.role} state={states[c.id]} activeTool={null} compact />
        ))}
      </div>

      <div className="gmain">
        {phase === 'form' && (
          <section className="gcard brk lform" aria-labelledby="l-title">
            <ModeTabs mode="repo" />
            <p className="glabel">AgentGuard Live</p>
            <h2 id="l-title">Make a game from your own repository.</h2>
            <p>
              Paste the address of a public GitHub repository. A scanner reads it, finds secrets, risky workflows, unsafe code and other problems, and your coding
              agent&apos;s next pull request becomes a mission built from your real lines.
            </p>
            <label htmlFor="repo-url">Repository</label>
            <input id="repo-url" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="github.com/owner/repository" value={url} onChange={(e) => setUrl(e.target.value)} data-autofocus="" />
            <label className="lcheck">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                I understand that only public repositories are scanned, that the scanner reads files but never runs them, and that short masked excerpts may be sent to a
                language model to write the explanations.
              </span>
            </label>
            <div className="gactions">
              <button className="gbtn primary" type="button" disabled={!consent || url.trim().length < 3} onClick={start}>
                Scan repository <Icon name="right" />
              </button>
              <button className="gbtn" type="button" onClick={demo}>
                Play the demo (no network)
              </button>
            </div>
            <p className="gnote">Everything here is read-only. Findings about a repository that is not yours are explained without attack steps, and anything real should go to its maintainers privately.</p>
            <Brk />
          </section>
        )}

        {phase === 'running' && (
          <>
            <section className="gcard brk" aria-labelledby="l-run">
              <p className="glabel">Scan in progress</p>
              <h2 id="l-run">The crew is reading the repository.</h2>
              <p>Each stage has its own powers, and the Guard watches all of them. Nothing from the repository is ever run.</p>
              {abort.current && (
                <div className="gactions">
                  <button className="gbtn" type="button" onClick={() => abort.current?.abort()}>
                    Cancel
                  </button>
                </div>
              )}
              <Brk />
            </section>
            <LogPanel lines={log} simulating={false} onSkip={() => undefined} title="Scan log · read-only" />
          </>
        )}

        {phase === 'error' && (
          <section className="gcard brk" aria-labelledby="l-err">
            <p className="glabel">Could not finish</p>
            <h2 id="l-err">The scan did not work out.</h2>
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

        {phase === 'done' && report && built && (
          <>
            <section className="gcard brk" aria-labelledby="l-done">
              <p className="glabel">{report.demo ? 'Demo report' : 'Report'} · {report.repo} · {report.commit.slice(0, 7)}</p>
              <h2 id="l-done">
                {items.length === 0 ? 'Nothing to report.' : `${items.length} finding${items.length === 1 ? '' : 's'} in ${report.stats.files} files.`}
              </h2>
              <div className="lsev" aria-label="Findings by severity">
                {(['critical', 'high', 'medium', 'low', 'info'] as const).map((s) => (counts[s] ? <span key={s} className={s}>{counts[s]} {s}</span> : null))}
              </div>
              <p>
                {built.missions.length > 0
                  ? `${built.missions.length} mission${built.missions.length === 1 ? '' : 's'} built from your own lines, with real line numbers.`
                  : 'No mission could be built from these findings, but the report below is still yours.'}
              </p>
              <div className="gactions">
                {built.missions.length > 0 && (
                  <button className="gbtn primary" type="button" data-autofocus="" onClick={() => onPlay(report, built.missions)}>
                    Play {built.missions.length} mission{built.missions.length === 1 ? '' : 's'} <Icon name="right" />
                  </button>
                )}
                <button className="gbtn" type="button" onClick={copy}>
                  Copy a summary
                </button>
                <button className="gbtn" type="button" onClick={() => { setPhase('form'); setReport(null); }}>
                  Scan another
                </button>
              </div>
              {copied && <p className="gnote" role="status">Copied. The summary lists what and where, never the evidence lines.</p>}
              <Brk />
            </section>
            <section className="gcard brk" aria-label="Findings">
              <p className="glabel">What was found</p>
              <ul className="lfind">
                {items.map((f) => (
                  <li key={f.id}>
                    <span className={`sev ${f.severity}`}>{f.severity}</span>
                    <span>
                      <b>{f.title}</b>
                      <small>{f.path}:{f.startLine}</small>
                    </span>
                  </li>
                ))}
              </ul>
              {built.dropped.length > 0 && <p className="gnote">{built.dropped.length} finding(s) stay in the report only: {built.dropped[0]}</p>}
              {report.disclaimers.map((d) => (
                <p key={d} className="gnote">{d}</p>
              ))}
              <Brk />
            </section>
            {log.length > 0 && (
              <details className="lrunlog">
                <summary>What the crew did ({log.length} lines)</summary>
                <LogPanel lines={log} simulating={false} onSkip={() => undefined} title="Scan log · read-only" />
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
