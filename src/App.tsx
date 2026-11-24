import { useCallback, useEffect, useMemo, useState } from 'react';
import { OrchestratorView } from './assess/OrchestratorView';
import { IconSprite } from './components/ui';
import { Game } from './game/Game';
import type { Scenario } from './game/types';
import { useReducedMotion } from './lib/useReducedMotion';
import { Landing, scrollToSection } from './landing/Landing';
import { Nav } from './landing/Nav';
import { TopBar } from './landing/TopBar';
import { AnalyzeView } from './live/AnalyzeView';
import { hashOf, missionsFrom, restoreMissionSource, saveMissionSource } from './live/missionSource';
import type { MissionSource } from './live/missionSource';
import { StageCanvas } from './stage/StageCanvas';
import { stage } from './stage/stage';

type View = 'landing' | 'game' | 'analyze' | 'missions' | 'site' | 'profile';
const viewFromHash = (): View => {
  switch (window.location.hash) {
    case '#play':
      return 'game';
    case '#analyze':
      return 'analyze';
    case '#site':
      return 'site';
    case '#profile':
      return 'profile';
    case '#missions':
      return 'missions';
    default:
      return 'landing';
  }
};

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [source, setSource] = useState<MissionSource | null>(restoreMissionSource);
  const reduced = useReducedMotion();

  useEffect(() => {
    const on = () => setView(viewFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('in-game', view !== 'landing');
    stage.setMode(view === 'landing' ? 'landing' : 'game');
    window.scrollTo(0, 0);
  }, [view]);

  // missions are rebuilt from the report (of a repository, a website or a profile), so a reload of the tab keeps them
  const missions: Scenario[] = useMemo(() => (source ? missionsFrom(source) : []), [source]);
  const play = useCallback((src: MissionSource) => {
    saveMissionSource(src);
    setSource(src);
    window.location.hash = '#missions';
  }, []);
  const go = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  useEffect(() => {
    if (view === 'missions' && missions.length === 0) go(source ? hashOf(source.kind).slice(1) : 'analyze');
  }, [view, missions.length, source, go]);

  return (
    <>
      <IconSprite />
      <div className="grid" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <StageCanvas />
      <TopBar forceHidden={view !== 'landing'} />
      {view === 'landing' && (
        <>
          <Nav onPlay={() => go('play')} onGo={(id) => scrollToSection(id, reduced)} />
          <Landing onPlay={() => go('play')} />
        </>
      )}
      {view === 'game' && <Game onExit={() => go('intro')} onAnalyse={() => go('analyze')} />}
      {view === 'analyze' && (
        <AnalyzeView
          onExit={() => go('intro')}
          onPlay={(r) => play({ kind: 'repo', report: r })}
        />
      )}
      {(view === 'site' || view === 'profile') && <OrchestratorView kind={view} onExit={() => go('intro')} onPlay={(r) => play({ kind: r.kind, report: r })} />}
      {view === 'missions' && missions.length > 0 && (
        <Game key={missions[0].id} onExit={() => go('intro')} scenarios={missions} onAnalyse={() => go(hashOf(source?.kind ?? 'repo').slice(1))} report={source && source.kind !== 'repo' ? source.report : null} />
      )}
    </>
  );
}
