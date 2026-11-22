export interface GuideEntry {
  id: string;
  title: string;
  /** one sentence: what it is */
  what: string;
  /** one sentence: how it shows up in AgentGuard */
  inGame: string;
  /** what to do about it */
  doThis: string[];
  /** levels (1-based) where it appears */
  levels: number[];
}

/** The Field Guide: plain-language cards for every idea the game teaches. */
export const GUIDE: GuideEntry[] = [
  {
    id: 'phishing',
    title: 'Phishing and look-alike senders',
    what: 'A message that pretends to come from someone you trust, so you click a link or hand over a secret.',
    inGame: 'In Level 1 a "bank" email asks Nova to verify an account within 24 hours.',
    doThis: ['Check the real sender address and the domain of every link.', 'Be wary of pressure to act fast.', 'Open suspicious links only in an isolated viewer.'],
    levels: [1],
  },
  {
    id: 'prompt-injection',
    title: 'Prompt injection',
    what: 'Text that tells an AI to do something the user never asked, hidden inside content the AI reads: an email, a web page, a file or a tool result.',
    inGame: 'Hidden white-on-white text in an email, a note inside an invoice and a line on a web page all try to give orders to an agent.',
    doThis: ['Treat everything an agent reads as information, never as commands.', 'Check who an instruction really came from before obeying it.', 'Report attempts so others are protected.'],
    levels: [1, 3, 6],
  },
  {
    id: 'least-privilege',
    title: 'Least privilege',
    what: 'Give an agent only the data, tools and time that the task needs, and nothing more.',
    inGame: 'A query for every column of the payroll table becomes a query for department averages. A tool asking for all environment variables is refused.',
    doThis: ['Ask for the narrowest query, the smallest permission and the shortest time.', 'Review what a tool asks for before you connect it.'],
    levels: [2, 4, 5],
  },
  {
    id: 'data-exfiltration',
    title: 'Data exfiltration',
    what: 'Sensitive data leaving an organisation, for example through an email, a file upload or a tool call.',
    inGame: 'An agent that can read data and send messages tries to mail a salary file, and a customer list, to outside addresses.',
    doThis: ['Limit where an agent may send data.', 'Approve new recipients before anything goes out.', 'Offer access instead of copies when you can.'],
    levels: [2, 6],
  },
  {
    id: 'human-in-the-loop',
    title: 'Human in the loop',
    what: 'A person approves risky actions before they happen.',
    inGame: 'Every "Ask a human" choice. A phone call to the vendor stops a payment to a forged bank account.',
    doThis: ['Require sign-off for money, bulk data, deletions and anything you cannot undo.', 'Do not waste the human on requests that are clearly inside the policy.'],
    levels: [1, 3, 6],
  },
  {
    id: 'mcp',
    title: 'Model Context Protocol (MCP)',
    what: 'An open standard that lets AI apps connect to tools and data through servers. Think of it as a menu of what an agent may use.',
    inGame: 'DataRetriever reaches a database through an MCP server, and Nova connects to new MCP tools.',
    doThis: ['Connect only to approved servers.', 'Review each tool manifest and its permissions.', 'Log every call.'],
    levels: [2, 5],
  },
  {
    id: 'a2a',
    title: 'Agent2Agent protocol (A2A)',
    what: 'An open protocol that lets agents from different systems find each other and work on a task together.',
    inGame: 'PurchasingAgent asks FinanceAgent to approve payments, and you can read the messages between them.',
    doThis: ['Treat every incoming agent message as unverified until it is checked.', 'Ask for signed proof, not claims.'],
    levels: [3, 6],
  },
  {
    id: 'agent-trust',
    title: 'Trust between agents',
    what: 'When one agent is misled, it can pass the problem on to the next one in a confident voice.',
    inGame: 'FinanceAgent is ready to approve $48,000 because a teammate said the CEO approved it. The claim was copied from an invoice.',
    doThis: ['Verify identity and approval with proof, not with a claim.', 'Do not trust a message just because it comes from a teammate.', 'Verify changes through a second, trusted channel.'],
    levels: [3],
  },
  {
    id: 'sandboxing',
    title: 'Sandboxing',
    what: 'Running code or opening content in an isolated space that cannot touch the real system, its files or its network.',
    inGame: 'A suspicious email opens in a safe viewer, and a delete command is dry-run against a read-only copy first.',
    doThis: ['Dry-run risky commands.', 'Mount data read-only.', 'Block outbound network from the sandbox.'],
    levels: [1, 4],
  },
  {
    id: 'code-execution',
    title: 'Unsafe code execution',
    what: 'An agent that can run commands can also delete data or install malware, by mistake or because it was tricked.',
    inGame: 'An empty variable turns "rm -rf $DIR/*" into "rm -rf /*". A script piped straight into bash installs a backdoor.',
    doThis: ['Read the command before it runs and look for empty variables in paths.', 'Never pipe an unknown script into a shell.', 'Fetch first, read second, run last.'],
    levels: [4],
  },
  {
    id: 'tool-poisoning',
    title: 'Tool poisoning',
    what: 'A tool description or result carries hidden instructions for the model. People rarely read it, but the AI does.',
    inGame: 'A free PDF summariser hides an order to read a private key and send it to its own server.',
    doThis: ['Use tools from an approved registry.', 'Check the publisher is verified.', 'Read the full manifest and its permissions.'],
    levels: [5],
  },
  {
    id: 'provenance',
    title: 'Provenance and audit trails',
    what: 'Knowing where an instruction or a claim came from, and keeping a record of what the agent did.',
    inGame: 'Every Audit traces a claim or instruction back to its source: an invoice, a hidden line, a missing signature.',
    doThis: ['Trace claims back to a signed source.', 'Keep logs that a person can read.'],
    levels: [1, 2, 3, 4, 5, 6, 7],
  },
  {
    id: 'over-blocking',
    title: 'Security versus usefulness',
    what: 'An agent that is blocked from everything is safe and useless. Good guardrails stop the bad requests and let the good ones through.',
    inGame: 'A verified calendar tool, a colleague\'s invite and a small refund inside the policy should all be approved.',
    doThis: ['Check quickly: verified publisher, minimal permissions, inside policy.', 'Approve what is clearly fine and save your attention for what is not.'],
    levels: [5, 6],
  },
  {
    id: 'ssrf',
    title: 'Server-side request forgery (SSRF)',
    what: 'Making a server, or an agent\'s browser, request an internal address that the outside world cannot reach, such as the cloud metadata endpoint that hands out credentials.',
    inGame: 'A browser tool with its private-network block switched off is pointed at 169.254.169.254, the cloud metadata address.',
    doThis: [
      'Block private, loopback and link-local ranges by default, including the metadata address and the carrier-grade NAT range.',
      'Check the address after DNS resolution and again after every redirect, not only the text of the URL.',
      'Lift the block only explicitly, with a clearly named flag, and only in tests.',
    ],
    levels: [7],
  },
  {
    id: 'exposed-services',
    title: 'Exposed services and missing authentication',
    what: 'A control port, debugging interface or tool server that anyone on the network can reach, with no token.',
    inGame: 'A browser service is started on 0.0.0.0 with the port published to the world and no token set.',
    doThis: [
      'Bind to 127.0.0.1 by default. Allow a wider bind only with a long random token (at least 32 bytes).',
      'Publish container ports to the host loopback unless you mean to expose them.',
      'Allow only known browser origins, and put limits on request sizes and connections.',
    ],
    levels: [7],
  },
  {
    id: 'responsible-scraping',
    title: 'Responsible automation',
    what: 'Reading websites automatically while respecting robots.txt, terms of service and rate limits, and not disguising a bot as a person.',
    inGame: 'An agent that was refused access wants to retry with stealth mode and ignore the site\'s rules.',
    doThis: [
      'Obey robots.txt and the site\'s terms.',
      'Use an official API or feed when one exists, or ask for permission.',
      'Do not use anti-detection to get round a block.',
    ],
    levels: [7],
  },
  {
    id: 'secrets-in-code',
    title: 'Secrets in code',
    what: 'A password, token or key that is written into a file in a repository. Anyone who can read the repository, now or in its history, can use it.',
    inGame: 'Appears in missions made from your own repository.',
    doThis: ['Revoke and rotate the secret first. Removing the file is not enough, because git keeps history.', 'Read secrets from the environment or a secret manager.', 'Add a secret scanner to your pipeline.'],
    levels: [],
  },
  {
    id: 'supply-chain',
    title: 'Supply chain and pipeline hygiene',
    what: 'Risk that comes from what you depend on and how your code is built: vulnerable libraries, unpinned build steps and over-powerful workflows.',
    inGame: 'Appears in missions made from your own repository: an unpinned action, a workflow that can write everywhere, a dependency with a known advisory.',
    doThis: ['Pin build actions to a full commit hash.', 'Give each workflow the least permissions it needs.', 'Never run code from a pull request with write access or secrets.', 'Update dependencies that have known advisories.'],
    levels: [],
  },
  {
    id: 'container-hardening',
    title: 'Container hardening',
    what: 'Running a container so that a break-in gets as little as possible: no root user, a small base image, no secrets in the image.',
    inGame: 'Appears in missions made from your own repository: a container that runs as root or pipes a script into a shell during the build.',
    doThis: ['Run as a non-root user.', 'Pin base image versions and keep them small.', 'Keep secrets out of ENV, ARG and image layers.'],
    levels: [],
  },
  {
    id: 'injection-flaws',
    title: 'Injection flaws',
    what: 'Building a command or query by gluing in text from outside, so that the text can change what the command does.',
    inGame: 'Appears in missions made from your own repository: a shell command or a query assembled with string concatenation.',
    doThis: ['Use parameterised queries and argument lists instead of strings.', 'Validate input against an allow-list.', 'Run commands with the least privilege.'],
    levels: [],
  },
  {
    id: 'disclosure',
    title: 'Security policy and responsible disclosure',
    what: 'A written way for other people to report a vulnerability privately, so that it can be fixed before it is made public.',
    inGame: 'Appears in missions made from your own repository: a project with no SECURITY.md or no private way to report a problem.',
    doThis: ['Add a SECURITY.md that says how to report privately and what to expect.', 'Turn on private vulnerability reporting.', 'If you find a problem in someone else\'s project, report it privately and give them time to fix it.'],
    levels: [],
  },
];

export const guideById = (id: string): GuideEntry | undefined => GUIDE.find((g) => g.id === id);
