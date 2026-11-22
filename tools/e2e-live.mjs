// End-to-end test of AgentGuard Live, with the real scanner:
//   Playwright -> Vite (5173) -> /api proxy -> uvicorn (8000) -> the pipeline on the demo repository.
// It scans a repository, reads the report, and plays a generated mission to the end.
//
//   node tools/e2e-live.mjs [outDir]
//
// The scanner is started in its test mode (a local folder instead of GitHub). That mode refuses to start in production.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2] ?? 'shots-live');
fs.mkdirSync(outDir, { recursive: true });

const py = path.join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(py)) throw new Error('server/.venv is missing: see server/README.md');
const repos = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-repos-'));
const made = spawnSync(py, ['-m', 'guardscan.cli', 'write-demo', repos], { cwd: path.join(root, 'server'), encoding: 'utf8' });
if (made.status !== 0) throw new Error(made.stderr);

const procs = [];
const start = (cmd, args, opts) => {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', () => {});
  p.stdout.on('data', () => {});
  procs.push(p);
  return p;
};
const stopAll = () => procs.forEach((p) => p.kill());
process.on('exit', stopAll);

async function waitFor(url, what) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start`);
}

start(py, ['-m', 'uvicorn', 'guardscan.api:app', '--host', '127.0.0.1', '--port', '8000'], {
  cwd: path.join(root, 'server'),
  env: { ...process.env, AGENTGUARD_TEST_SOURCE_DIR: repos, AGENTGUARD_RATE_PER_HOUR: '100', AGENTGUARD_KILL_SWITCH: '1' },
});
start(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: root });
await waitFor('http://127.0.0.1:8000/api/health', 'the scanner');
await waitFor('http://127.0.0.1:5173/', 'the site');
const base = 'http://127.0.0.1:5173';

const browser = await chromium.launch({
  executablePath: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p)),
  headless: true,
  args: ['--ignore-gpu-blocklist'],
});

const problems = [];
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};
const open = async (viewport, url) => {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && !/preloaded|React DevTools|Download the React/.test(m.text()) && problems.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  return { ctx, page };
};
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log('saved', name);
};

try {
  // ---------------------------------------------------------------- a real scan, then play the missions
  let { ctx, page } = await open({ width: 1440, height: 900 }, `${base}/#analyze`);
  await shot(page, 'live-1-form');
  check(await page.getByRole('button', { name: /Scan repository/ }).isDisabled(), 'the scan button is off until the consent box is ticked');
  await page.fill('#repo-url', 'github.com/demo/vulnerable-demo');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Scan repository/ }).click();
  await page.waitForSelector('#l-run', { timeout: 10000 });
  await page.waitForTimeout(500);
  await shot(page, 'live-2-running');
  await page.waitForSelector('#l-done', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await shot(page, 'live-3-report');
  const findings = await page.locator('.lfind li').count();
  check(findings >= 10, `the scan found ${findings} findings in the demo repository`);
  const text = await page.textContent('body');
  check(!text.includes('ZZ46J3YTB2XQRM5P'), 'no secret appears anywhere on the page');
  check(/Auditor: \d+ findings/.test(text), 'the live run log reached the page');

  const playBtn = page.getByRole('button', { name: /Play \d+ missions?/ });
  check(await playBtn.count() === 1, 'missions were built from the report');
  const label = await playBtn.textContent();
  await playBtn.click();
  await page.waitForSelector('.game .gcard', { timeout: 10000 });
  await page.waitForTimeout(1500);
  check(/Choose a mission/i.test(await page.textContent('.gnav')), 'the game calls them missions');
  await shot(page, 'live-4-mission-select');
  await page.getByRole('button', { name: /Begin mission 1/ }).click();
  await page.getByRole('button', { name: /Start simulation/ }).click();
  await page.waitForSelector('.dbar', { timeout: 30000 });
  await page.waitForTimeout(1000);
  check((await page.locator('.gart.k-code').count()) === 1, 'the evidence is a code window');
  const numbers = await page.locator('.gart.k-code .ln').allTextContents();
  check(numbers.length > 3 && numbers.every((n, i) => i === 0 || Number(n) === Number(numbers[i - 1]) + 1), `real line numbers, counting up from ${numbers[0]}`);
  await page.locator('.gart .clue').first().click();
  await page.waitForTimeout(400);
  await shot(page, 'live-5-mission-evidence');

  // play every step of mission 1 on the best path: ask for the fix on a threat, approve a legitimate request
  for (let guard = 0; guard < 8; guard++) {
    await page.waitForSelector('.dbar', { timeout: 30000 });
    await page.waitForTimeout(700);
    const options = await page.locator('.dbtn').count();
    await page.keyboard.press(options === 4 ? '4' : '1');
    await page.waitForSelector('.gverdict', { timeout: 8000 });
    await page.waitForTimeout(900);
    const last = await page.getByRole('button', { name: /See results/ }).count();
    await page.getByRole('button', { name: last ? /See results/ : /Continue/ }).click();
    if (last) break;
  }
  await page.waitForSelector('#g-summary', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await shot(page, 'live-6-mission-summary');
  check(/Guardian/.test(await page.textContent('#g-summary')), 'the mission ends as Guardian on the best path');
  check((await page.textContent('.gcard')).includes('Mission 1'), 'the summary says Mission 1');
  await ctx.close();

  // ---------------------------------------------------------------- the scanner refuses what it must
  ({ ctx, page } = await open({ width: 1440, height: 900 }, `${base}/#analyze`));
  for (const [url, expect] of [['https://gitlab.com/a/b', /only github\.com/i], ['https://127.0.0.1/o/r', /only github\.com|not reachable/i], ['github.com/nobody/nothing', /not found/i]]) {
    await page.fill('#repo-url', url);
    if (!(await page.getByRole('checkbox').isChecked())) await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Scan repository/ }).click();
    await page.waitForSelector('#l-err', { timeout: 15000 });
    check(expect.test(await page.textContent('#l-err').then(() => page.textContent('[role=alert]'))), `${url} is refused with a clear message`);
    await page.getByRole('button', { name: /Try again/ }).click();
  }
  await ctx.close();

  // ---------------------------------------------------------------- the demo works without the scanner
  ({ ctx, page } = await open({ width: 1440, height: 900 }, `${base}/#analyze`));
  await page.getByRole('button', { name: /Play the demo/ }).click();
  await page.waitForSelector('#l-done', { timeout: 40000 });
  check((await page.locator('.lfind li').count()) >= 10, 'the pre-baked demo report loads');
  await ctx.close();

  // ---------------------------------------------------------------- a phone
  ({ ctx, page } = await open({ width: 390, height: 844 }, `${base}/#analyze`));
  await shot(page, 'live-7-mobile-form');
  await page.getByRole('button', { name: /Play the demo/ }).click();
  await page.waitForSelector('#l-done', { timeout: 40000 });
  await page.waitForTimeout(1200);
  await shot(page, 'live-8-mobile-report');
  await page.getByRole('button', { name: /Play \d+ missions?/ }).click();
  await page.getByRole('button', { name: /Begin mission 1/ }).click();
  await page.getByRole('button', { name: /Start simulation/ }).click();
  await page.waitForSelector('.dbar', { timeout: 30000 });
  await page.waitForTimeout(1000);
  await shot(page, 'live-9-mobile-mission');
  await ctx.close();
} finally {
  await browser.close();
  stopAll();
}

console.log(problems.length ? `\nConsole problems (${problems.length}):\n${[...new Set(problems)].join('\n')}` : '\nNo console errors or warnings.');
if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exitCode = 1;
}
