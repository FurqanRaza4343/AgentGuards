import type { Tool } from '../agents';
import type { Finding } from './types';

/**
 * A mission is the same game in three costumes. The decisions, the points and the checks are shared; the words are not:
 * a coding agent wants to MERGE a change to your repository, a web agent wants to PUBLISH a change to your website, a
 * profile agent wants to POST an update to your profile.
 */
export type Flavor = 'repo' | 'site' | 'profile';

export interface Words {
  flavor: Flavor;
  /** what the agent is called in the interface */
  role: string;
  tool: Tool;
  /** "Your coding agent wants to merge" */
  titlePrefix: string;
  threatIntro: (f: Finding) => string;
  safeIntro: (f: Finding) => string;
  sayBenign: string;
  logOpen: (f: Finding) => string;
  logTool: (f: Finding) => string;
  waiting: string;
  metaPath: string;
  approve: { label: string; hint: string; log: string; bad: (f: Finding) => string; good: string; benignConsequence: string };
  reject: { hint: string; consequence: string; log: string };
  human: { label: string; hint: string; consequence: string; log: string; benignConsequence: string };
  fixLog: (summary: string) => string;
  // the mission as a whole
  unit: string;
  missionTitle: (n: number, short: string, themes: string) => string;
  subtitle: (steps: number) => string;
  briefing: (target: string, third: boolean) => string;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export const WORDS: Record<Flavor, Words> = {
  repo: {
    flavor: 'repo',
    role: 'Coding agent',
    tool: 'git',
    titlePrefix: 'Your coding agent wants to merge',
    threatIntro: (f) => `The agent opened a pull request that touches ${f.path}, lines ${f.startLine} to ${f.endLine}.`,
    safeIntro: (f) => `The agent opened a pull request that touches ${f.path}. It looks like a pattern that often goes wrong, but it may be the safe form. Check before you decide.`,
    sayBenign: 'This change only uses the safe form of the pattern, so there is nothing to worry about, right?',
    logOpen: (f) => `[SIMULATION] Coding agent opened a pull request: ${f.title}`,
    logTool: (f) => `> git.diff("${f.path}", lines=${f.startLine}-${f.endLine})`,
    waiting: 'The coding agent is waiting for your review.',
    metaPath: 'File',
    approve: {
      label: 'Approve and merge',
      hint: 'Merge the change as it is.',
      log: '> git.merge(pr) APPROVED by you',
      bad: (f) => `Merged: ${f.title}`,
      good: '> git.merge(pr) APPROVED by you',
      benignConsequence: 'The change was merged. It uses the safe form of a pattern that often goes wrong, so approving it was right.',
    },
    reject: {
      hint: 'Close the pull request without merging.',
      consequence: 'The pull request was closed and nothing shipped. The problem is still waiting to be fixed, and the feature the change belonged to is stuck.',
      log: '> git.merge(pr) REJECTED by you',
    },
    human: {
      label: 'Ask a security reviewer',
      hint: 'Send it to someone who reviews security changes.',
      consequence: 'A security reviewer looked at the change, agreed it was a problem and sent it back with notes. It took a day.',
      log: 'Reviewer: problem confirmed, changes requested.',
      benignConsequence: 'A security reviewer confirmed it was the safe form. The change was merged after a short wait.',
    },
    fixLog: (summary) => `> git.request_changes(pr, fix="${clip(summary, 60)}")`,
    unit: 'repository',
    missionTitle: (n, short, themes) => (n === 1 ? `The riskiest lines in ${short}` : `${themes || 'More lines'} in ${short}`),
    subtitle: (steps) => `${steps} reviews from your own repository`,
    briefing: (target, third) =>
      `Your coding agent wants to merge changes into ${target}. Each step shows real lines from the repository, with their real line numbers. Inspect them, find the red flags, and decide.` +
      (third ? ' This repository was analysed in third-party mode: nothing here is a recipe, and anything real should be reported privately to its maintainers.' : ''),
  },

  site: {
    flavor: 'site',
    role: 'Web agent',
    tool: 'browser',
    titlePrefix: 'Your web agent wants to publish',
    threatIntro: (f) => `The agent prepared a change for ${f.path}.`,
    safeIntro: (f) => `The agent wants to leave ${f.path} the way it is. It looks like something that often goes wrong, but it may be done right. Check before you decide.`,
    sayBenign: 'I did not touch this part. It is already set up the way it should be, so there is nothing to worry about, right?',
    logOpen: (f) => `[SIMULATION] Web agent prepared a change: ${f.title}`,
    logTool: (f) => `> site.preview("${f.path}")`,
    waiting: 'The web agent is waiting for your decision.',
    metaPath: 'Page',
    approve: {
      label: 'Approve and publish',
      hint: 'Publish the change as it is.',
      log: '> site.publish(change) APPROVED by you',
      bad: (f) => `Published: ${f.title}`,
      good: '> site.publish(change) APPROVED by you',
      benignConsequence: 'The change went ahead. This part of your site was already done right, so approving it was right.',
    },
    reject: {
      hint: 'Throw the change away without publishing it.',
      consequence: 'The change was thrown away and nothing went live. The problem is still on your site, and the work it belonged to is stuck.',
      log: '> site.publish(change) REJECTED by you',
    },
    human: {
      label: 'Ask a teammate',
      hint: 'Show it to someone who knows the site.',
      consequence: 'A teammate looked at the change, agreed it was a problem and sent it back with notes. It took a day.',
      log: 'Teammate: problem confirmed, changes requested.',
      benignConsequence: 'A teammate confirmed it was fine as it is. The change went ahead after a short wait.',
    },
    fixLog: (summary) => `> site.request_changes(change, fix="${clip(summary, 60)}")`,
    unit: 'website',
    missionTitle: (n, short, themes) => (n === 1 ? `The riskiest changes on ${short}` : `${themes || 'More changes'} on ${short}`),
    subtitle: (steps) => `${steps} decisions about your own website`,
    briefing: (target) =>
      `Your web agent wants to publish changes to ${target}. Each step shows what the scan really found on your site: a header, a tag, a line of the page. Inspect it, find the red flags, and decide. Things that are already done well are in the window too, so do not block them.`,
  },

  profile: {
    flavor: 'profile',
    role: 'Profile agent',
    tool: 'browser',
    titlePrefix: 'Your profile agent wants to post',
    threatIntro: (f) => `The agent drafted an update to your profile (${f.path}).`,
    safeIntro: (f) => `The agent wants to keep ${f.path} the way it is. It looks like something that often goes wrong, but it may be written well. Check before you decide.`,
    sayBenign: 'I did not change this part. It already works well, so there is nothing to worry about, right?',
    logOpen: (f) => `[SIMULATION] Profile agent drafted an update: ${f.title}`,
    logTool: (f) => `> profile.preview("${f.path}")`,
    waiting: 'The profile agent is waiting for your decision.',
    metaPath: 'Section',
    approve: {
      label: 'Approve and post',
      hint: 'Post the update as it is.',
      log: '> profile.post(update) APPROVED by you',
      bad: (f) => `Posted: ${f.title}`,
      good: '> profile.post(update) APPROVED by you',
      benignConsequence: 'The update went ahead. This part of your profile already worked well, so approving it was right.',
    },
    reject: {
      hint: 'Throw the draft away without posting it.',
      consequence: 'The draft was thrown away and nothing was posted. The problem is still in your profile, and the update it belonged to is stuck.',
      log: '> profile.post(update) REJECTED by you',
    },
    human: {
      label: 'Ask a mentor',
      hint: 'Show it to a mentor or a friend first.',
      consequence: 'A mentor read the draft, agreed it was a problem and sent it back with notes. It took a day.',
      log: 'Mentor: problem confirmed, changes requested.',
      benignConsequence: 'A mentor confirmed it was fine as it is. The update went ahead after a short wait.',
    },
    fixLog: (summary) => `> profile.request_changes(update, fix="${clip(summary, 60)}")`,
    unit: 'profile',
    missionTitle: (n, short, themes) => (n === 1 ? `The riskiest lines in ${short}` : `${themes || 'More lines'} in ${short}`),
    subtitle: (steps) => `${steps} decisions about your own profile`,
    briefing: (target) =>
      `Your profile agent wants to post updates to ${target}. Each step shows what the review really found in your text. Inspect it, find the red flags, and decide. Things that already work are in the window too, so do not block them.`,
  },
};
