import { Icon, LogoMark } from '../components/ui';
import { EVENT_URL } from '../constants';

interface Props {
  onPlay: () => void;
  onGo: (sectionId: string) => void;
}

export function Nav({ onPlay, onGo }: Props) {
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    onGo(id);
  };
  return (
    <header className="nav">
      <a className="logo" href="#intro" aria-label="AgentGuard, back to the top" onClick={go('intro')}>
        <LogoMark />
        <span>AGENTGUARD</span>
      </a>
      <nav className="menu" aria-label="Primary">
        <a href="#intro" onClick={go('intro')}>Home</a>
        <a href="#levels" onClick={go('levels')}>Levels</a>
        <a href="#players" onClick={go('players')}>Players</a>
        <a href="#analyze">Analyse yours</a>
      </nav>
      <a className="pad" href={EVENT_URL} target="_blank" rel="noopener noreferrer">
        DevFest 2026 <Icon name="ne" />
      </a>
      <div className="cta">
        <button className="btn" type="button" onClick={onPlay}>
          <span className="eyes" aria-hidden="true">••</span> Start game
        </button>
      </div>
    </header>
  );
}
