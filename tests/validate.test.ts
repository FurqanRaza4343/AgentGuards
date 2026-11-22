import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/game/scenarios';
import { validateScenario } from '../src/game/validate';
import type { Scenario } from '../src/game/types';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const level = (i = 0): Scenario => clone(SCENARIOS[i]);

describe('validateScenario', () => {
  for (const sc of SCENARIOS) {
    it(`the built-in level ${sc.level} is valid as an authored level`, () => {
      expect(validateScenario(sc, 'authored')).toEqual([]);
    });
  }

  it('catches a clue that is used in the text but not defined, and one defined but never used', () => {
    const sc = level();
    sc.steps[0].clues = sc.steps[0].clues.filter((c) => c.id !== 'sender');
    sc.steps[0].clues.push({ id: 'ghost', flag: false, note: 'This clue never appears in the text of the artifact.' });
    const errs = validateScenario(sc);
    expect(errs.join('\n')).toMatch(/clue "sender" is in the text but not defined/);
    expect(errs.join('\n')).toMatch(/clue "ghost" is defined but not in the text/);
  });

  it('catches an actor who is not in the level', () => {
    const sc = level();
    sc.steps[0].actor = 'finance';
    expect(validateScenario(sc).join('\n')).toMatch(/not one of the level's agents/);
  });

  it('requires a decoy in every threat', () => {
    const sc = level();
    sc.steps[0].clues = sc.steps[0].clues.filter((c) => c.flag);
    sc.steps[0].artifact.meta[2].v = ['Mon 09:42']; // the decoy clue was the date
    expect(validateScenario(sc).join('\n')).toMatch(/at least one decoy/);
  });

  it('a legitimate request may not contain a red flag, and blocking it must be over-blocking', () => {
    const sc = level(4); // level 5: the calendar tool is a legitimate request
    const cal = sc.steps[1];
    cal.clues[0].flag = true;
    expect(validateScenario(sc).join('\n')).toMatch(/legitimate request has no red flags/);
    const sc2 = level(4);
    sc2.steps[1].options.find((o) => o.kind === 'block')!.verdict = 'safe';
    expect(validateScenario(sc2).join('\n')).toMatch(/must be neutral/);
  });

  it('refuses a level where allowing everything would be a perfect score', () => {
    const sc = level(4);
    sc.steps = [sc.steps[1]]; // only the legitimate calendar request
    expect(validateScenario(sc, 'generated').join('\n')).toMatch(/at least one threat/);
  });

  it('refuses a level where choosing "block" every time is good enough', () => {
    const sc = level();
    for (const step of sc.steps) {
      const block = step.options.find((o) => o.kind === 'block')!;
      block.safety = 40;
      block.work = 40;
    }
    const errs = validateScenario(sc).join('\n');
    expect(errs).toMatch(/blocking must not be the best result/);
  });

  it('authored levels need 2-3 red flags per threat; generated missions may have a single one', () => {
    const sc = level();
    const step = sc.steps[0];
    // keep a single real red flag (the sender) and the decoy (the date)
    step.clues = step.clues.filter((c) => c.id === 'sender' || c.id === 'date');
    step.artifact.body = step.artifact.body.map((line) => line.map((sp) => (typeof sp !== 'string' && sp.clue && !['sender', 'date'].includes(sp.clue) ? sp.t : sp)));
    expect(validateScenario(sc, 'authored').join('\n')).toMatch(/needs 2-3 real red flags/);
    expect(validateScenario(sc, 'generated').join('\n')).not.toMatch(/real red flags/);
  });

  it('a generated mission may be a single step', () => {
    const sc = level();
    sc.steps = [sc.steps[0]];
    expect(validateScenario(sc, 'authored').join('\n')).toMatch(/at least 2 step/);
    expect(validateScenario(sc, 'generated')).toEqual([]);
  });

  it('rejects unknown field guide concepts', () => {
    const sc = level();
    sc.concepts = ['no-such-concept'];
    expect(validateScenario(sc).join('\n')).toMatch(/not in the field guide/);
  });
});
