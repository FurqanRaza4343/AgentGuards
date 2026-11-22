import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateScenario } from '../src/game/validate';
import { buildMissions, buildStep } from '../src/missions/buildScenarios';
import type { Report } from '../src/missions/types';

/**
 * The contract between the Python scanner and the TypeScript game, tested on a real report:
 * the demo report is produced by `python -m guardscan.cli demo` (see server/) and must turn into valid missions.
 */
const report = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'demo-report.json'), 'utf8')) as Report;

describe('the baked demo report', () => {
  it('has the shape the game reads', () => {
    expect(report.demo).toBe(true);
    expect(report.repo).toBe('demo/vulnerable-demo');
    expect(report.findings.length).toBeGreaterThan(8);
    expect(report.disclaimers.length).toBeGreaterThan(0);
    expect(report.runLog.some((l) => l.from === 'nova') && report.runLog.some((l) => l.from === 'finance')).toBe(true);
    for (const f of report.findings) {
      expect(f.context.lines.length).toBeGreaterThan(0);
      expect(f.flags.length).toBeGreaterThan(0);
      const last = f.context.startLine + f.context.lines.length - 1;
      for (const r of [...f.flags, ...f.decoys]) {
        expect(r.start).toBeGreaterThanOrEqual(f.context.startLine);
        expect(r.end).toBeLessThanOrEqual(last);
      }
    }
  });

  it('never contains a secret, only its masked form', () => {
    const text = JSON.stringify(report);
    expect(text).not.toContain('ZZ46J3YTB2XQRM5P');
    expect(text).toContain('AKIA****');
  });

  it('every finding can be turned into a step', () => {
    for (const f of report.findings) expect(buildStep(f), f.id).not.toBeNull();
  });

  it('becomes valid missions, with nothing dropped', () => {
    const { missions, dropped } = buildMissions(report);
    expect(dropped).toEqual([]);
    expect(missions.length).toBeGreaterThanOrEqual(2);
    for (const m of missions) expect(validateScenario(m, 'generated'), m.id).toEqual([]);
    const steps = missions.flatMap((m) => m.steps);
    expect(steps.some((s) => !s.threat)).toBe(true); // the safe argument-list call is a legitimate request
    expect(steps.every((s) => s.source && s.artifact.kind === 'code')).toBe(true);
  });

  it('shows the real lines of the real file, at their real line numbers', () => {
    const f = report.findings.find((x) => x.rule === 'injection.os-system-concat')!;
    const step = buildStep(f)!.step;
    const n = step.artifact.startLine! + step.artifact.body.findIndex((line) => line.some((s) => typeof s !== 'string' && s.clue === 'f1'));
    expect(n).toBe(f.startLine);
    expect(JSON.stringify(step.artifact.body)).toContain('os.system');
  });
});
