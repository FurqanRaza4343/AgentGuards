import { EVENT_URL, REPO_URL } from '../constants';

interface Props {
  onGo: (sectionId: string) => void;
}

/** The end of the landing page: where to go next, the project, and what it is. */
export function Footer({ onGo }: Props) {
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    onGo(id);
  };
  return (
    <footer className="foot">
      <div className="foot-in">
        <div className="foot-brand">
          <a className="foot-word" href="#intro" aria-label="AgentGuard, back to the top" onClick={go('intro')}>
            AGENTGUARD
          </a>
          <p>Learn to supervise AI agents. Inspect what an agent is about to do, spot the red flags, and decide. Nothing real is at risk.</p>
        </div>

        <nav className="foot-col" aria-label="Play">
          <h2>Play</h2>
          <a href="#play">The seven levels</a>
          <a href="#analyze">Your repository</a>
          <a href="#site">Your website</a>
          <a href="#profile">Your profile</a>
        </nav>

        <nav className="foot-col" aria-label="This page">
          <h2>On this page</h2>
          <a href="#levels" onClick={go('levels')}>Levels</a>
          <a href="#players" onClick={go('players')}>Players</a>
          <a href="#crew" onClick={go('crew')}>How it works</a>
          <a href="#trust" onClick={go('trust')}>Trust and limits</a>
          <a href="#faq" onClick={go('faq')}>Questions</a>
        </nav>

        <nav className="foot-col" aria-label="Project">
          <h2>Project</h2>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">Source code</a>
          <a href={`${REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noopener noreferrer">Security policy</a>
          <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">DevFest Pakistan 2026</a>
        </nav>
      </div>
      <p className="foot-line">
        <span>AGENTGUARD · AI SEEKHO · DEVFEST PAKISTAN 2026</span>
        <span>Made with Gemini and the Agent Development Kit. The robots are drawn in code.</span>
      </p>
    </footer>
  );
}
