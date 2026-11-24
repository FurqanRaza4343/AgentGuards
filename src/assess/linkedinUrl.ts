import type { AFinding, Question } from './types';

/**
 * The address of a LinkedIn profile, looked at as a piece of text. The page behind it is never opened: LinkedIn forbids automated
 * access, shows a login wall to programs and blocks servers, and a profile belongs to a person who has not agreed to be read by a
 * tool. What can honestly be checked is the address itself, which is also something that a profile owner can improve: LinkedIn
 * gives every member a long default address with random letters, and lets them choose a short one.
 */
export interface LinkedInUrl {
  ok: true;
  /** the clean address, which is safe to open in a new tab */
  url: string;
  handle: string;
  /** false when the handle looks like the default one that LinkedIn makes (a name followed by random letters and digits) */
  custom: boolean;
  findings: AFinding[];
  strengths: string[];
  questions: Question[];
}
export interface LinkedInUrlError {
  ok: false;
  message: string;
}

const HOST = /^(?:[a-z]{2,3}\.|www\.)?linkedin\.com$/;
const HANDLE = /^[\p{L}\p{N}%_-]{3,100}$/u;

/** A name followed by `-` and 6 to 10 letters and digits that mix both, or a long run of digits: LinkedIn's default. */
export function looksDefault(handle: string): boolean {
  const tail = handle.toLowerCase().match(/-([a-z0-9]{6,10})$/)?.[1];
  if (!tail) return false;
  if (/^\d{6,}$/.test(tail)) return true;
  return /\d/.test(tail) && /[a-z]/.test(tail) && !/^[a-z]+$/.test(tail);
}

export function analyseLinkedInUrl(input: string): LinkedInUrl | LinkedInUrlError {
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, message: 'Type or paste the address of your profile, for example linkedin.com/in/your-name.' };
  if (raw.length > 300 || /[\s\u0000-\u001f]/.test(raw)) return { ok: false, message: 'That does not look like an address.' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, message: 'That does not look like an address.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, message: 'Use the web address of your profile (it starts with linkedin.com/in/).' };
  const host = u.hostname.toLowerCase();
  if (!HOST.test(host)) return { ok: false, message: 'That is not a LinkedIn address. A profile address looks like linkedin.com/in/your-name.' };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'in' || !parts[1]) {
    const hint = parts[0] === 'company' || parts[0] === 'school' ? 'That is the address of a company or school page. ' : '';
    return { ok: false, message: `${hint}A profile address looks like linkedin.com/in/your-name.` };
  }
  let handle: string;
  try {
    handle = decodeURIComponent(parts[1]);
  } catch {
    return { ok: false, message: 'That address has a part that could not be read.' };
  }
  if (!HANDLE.test(handle)) return { ok: false, message: 'The name in that address has characters that LinkedIn does not use.' };

  const custom = !looksDefault(handle);
  const url = `https://www.linkedin.com/in/${encodeURIComponent(handle)}/`;
  const findings: AFinding[] = [];
  const strengths: string[] = [];
  const questions: Question[] = [];
  if (!custom) {
    findings.push({
      id: 'u1',
      area: 'discoverability',
      severity: 'low',
      rule: 'profile.url.default',
      title: 'Your public profile address looks like the default one',
      detail:
        'LinkedIn gives every profile a long address that ends in random letters and digits. A short, custom address is easier to read out, to put on a CV or an email signature, and to remember, and it looks more careful.',
      evidence: `linkedin.com/in/${handle}`,
      fix: 'In LinkedIn open Edit public profile & URL, choose Edit your custom URL, and pick your name (for example ayesha-raza), or a variant with your field if the name is taken.',
      location: 'Public profile address',
      by: 'data',
    });
    questions.push({
      id: 'uq1',
      text: 'If someone read your profile address out loud, would they get it right the first time? What short version of your name would you be proud to put on a CV?',
      why: 'A custom address is a small thing that every reader sees, and it takes two minutes to change.',
      area: 'discoverability',
      findingId: 'u1',
    });
  } else {
    strengths.push(`Your public profile address is a custom one (linkedin.com/in/${handle.slice(0, 40)})`);
  }
  return { ok: true, url, handle, custom, findings, strengths, questions };
}
