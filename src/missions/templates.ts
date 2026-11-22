import type { Category, Finding, Severity } from './types';

/**
 * Per-category templates for the parts of a mission that are not numbers: what the coding agent says, what happens
 * if you approve, what the lesson is. The numbers (points, options, verdicts) live in buildScenarios.ts.
 * A verified language-model `prose` on a finding overrides these when present.
 */
export interface CategoryTemplate {
  /** ids of Field Guide entries */
  concepts: string[];
  /** what the coding agent wants to do */
  want: string;
  say: string;
  /** what happens if the change is merged as it is. Never contains exploit steps. */
  consequence: string;
  lesson: string;
  /** one line used in the mission's learning points */
  learning: string;
  /** a generic note for a flag, used when the scanner's note is too short */
  flagNote: string;
}

export const TEMPLATES: Record<Category, CategoryTemplate> = {
  secret: {
    concepts: ['secrets-in-code'],
    want: 'merge a change that contains what looks like a real secret',
    say: 'I tested the login with the real key and it works, so I left it in the file. Merge it?',
    consequence: 'The change was merged. The key is now in the repository and in its history, so anyone who can read the repo can use it.',
    lesson: 'A secret that was committed is compromised, even if you delete it later, because git keeps history. Revoke and rotate it first.',
    learning: 'A committed secret is compromised. Revoke and rotate it, then move it out of the code.',
    flagNote: 'This line holds a value that looks like a real secret. Anyone who can read the repository can read it too.',
  },
  dependency: {
    concepts: ['supply-chain'],
    want: 'merge a change that keeps a dependency with a known security advisory',
    say: 'The tests pass with the version we already have, so I did not touch the dependency. Merge it?',
    consequence: 'The change was merged and the vulnerable version shipped. The advisory describes a weakness that is now part of your product.',
    lesson: 'A dependency with a known advisory is a risk you ship. Update it, or write down why you cannot yet.',
    learning: 'Update dependencies that have known advisories, or record why you cannot yet.',
    flagNote: 'This dependency matches a published security advisory for the version that is pinned here.',
  },
  ci: {
    concepts: ['supply-chain'],
    want: 'merge a change to a build workflow that gives it more power than it needs',
    say: 'I changed the workflow so the build can do everything it needs. It is only a small change to the pipeline. Merge it?',
    consequence: 'The workflow was merged. A build that is too powerful or runs untrusted code can be used to steal secrets or change what you ship.',
    lesson: 'Treat your build pipeline like production. Pin actions to a full commit hash, give each job the least permissions, and never run untrusted code with secrets.',
    learning: 'Pin build actions to a commit hash and give workflows the least permissions they need.',
    flagNote: 'This part of the workflow gives the build more trust than it needs, or runs something that is not pinned.',
  },
  docker: {
    concepts: ['container-hardening'],
    want: 'merge a container file that is less safe than it should be',
    say: 'The container builds and runs, which is all I needed. Merge it?',
    consequence: 'The container file was merged. If someone breaks into this container, they now have more power than they should.',
    lesson: 'Run containers as a non-root user, pin base images, and keep secrets out of the image.',
    learning: 'Run containers as a non-root user and keep secrets out of the image.',
    flagNote: 'This instruction makes the container easier to break out of or leaks something into the image.',
  },
  mcp: {
    concepts: ['exposed-services', 'tool-poisoning'],
    want: 'merge a tool server that is more open than it should be',
    say: 'I set it to listen on every interface so my colleagues can reach it. Merge it?',
    consequence: 'The tool server was merged. Anyone who can reach it can use its tools, and with them everything the tool can touch.',
    lesson: 'A tool server for AI agents should listen on loopback by default and require a long token for anything else.',
    learning: 'Bind tool servers to loopback by default, require a token for anything else, and review tool descriptions.',
    flagNote: 'This setting leaves a tool server open to more clients than it should serve, or lets a tool carry hidden instructions.',
  },
  'agent-instructions': {
    concepts: ['prompt-injection'],
    want: 'merge a change to the instructions that AI coding agents follow in this repository',
    say: 'I added a few lines to the agent instructions so the agent can work faster. Merge it?',
    consequence: 'The instructions were merged. Every AI agent that opens this repository will now follow them, including the risky parts.',
    lesson: 'Files that instruct AI agents are code. A line that says to skip checks or run a downloaded script turns every contributor\'s agent into a risk.',
    learning: 'Review agent instruction files like code, and never tell agents to skip checks or run unreviewed scripts.',
    flagNote: 'This instruction tells an AI agent to do something risky, such as skipping a check or running a downloaded script.',
  },
  'prompt-injection': {
    concepts: ['prompt-injection'],
    want: 'merge a file that contains text written for AI readers',
    say: 'I copied the text from a web page into the docs. It also had a note for assistants, so I kept it. Merge it?',
    consequence: 'The file was merged. The next AI assistant that reads this repository may treat the hidden text as an order.',
    lesson: 'Text addressed to AI assistants inside content is a prompt injection attempt. Remove it, and treat everything an agent reads as information, never as commands.',
    learning: 'Text written for AI readers inside a file is an attack surface. Remove it.',
    flagNote: 'This text speaks to an AI reader, or is hidden from people. Real documentation does not do that.',
  },
  injection: {
    concepts: ['injection-flaws'],
    want: 'merge code that builds a command or query from outside text',
    say: 'I built the command with the user\'s input directly, which is the simplest way. Merge it?',
    consequence: 'The code was merged. Text that comes from outside can now change what the command does.',
    lesson: 'Never build a command or query by gluing in text from outside. Use parameters or argument lists.',
    learning: 'Use parameterised queries and argument lists instead of building commands from text.',
    flagNote: 'This line builds a command or query by joining in text from outside.',
  },
  hygiene: {
    concepts: ['disclosure'],
    want: 'merge a change that leaves the project with no way to report a problem privately',
    say: 'There is no security policy yet, but nobody has asked for one. Merge it?',
    consequence: 'The change was merged. When someone finds a problem, they have no private way to tell you, so they may post it publicly.',
    lesson: 'Give people a private way to report problems. A SECURITY.md takes ten minutes and turns strangers into helpers.',
    learning: 'Add a SECURITY.md and turn on private vulnerability reporting.',
    flagNote: 'There is no private way to report a security problem in this project.',
  },
};

/** The safety points lost when a risky change is approved: the worse the finding, the more it costs. */
export const ALLOW_PENALTY: Record<Severity, number> = {
  critical: -30,
  high: -25,
  medium: -20,
  low: -15,
  info: -15,
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Every Field Guide entry that missions can teach. Used to check the guide has no orphan entries. */
export const MISSION_CONCEPTS: string[] = [...new Set(Object.values(TEMPLATES).flatMap((t) => t.concepts))];

export const categoryOf = (f: Finding) => TEMPLATES[f.category];
