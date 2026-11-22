import type { Scenario } from './types';

/** Built-in scenarios are "levels". Scenarios generated from a scan of the player's own repository are "missions". */
export const unitOf = (sc?: Pick<Scenario, 'kind'>): 'level' | 'mission' => (sc?.kind === 'mission' ? 'mission' : 'level');
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
