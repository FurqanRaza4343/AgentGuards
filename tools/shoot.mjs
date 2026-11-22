// Visual smoke test: drives the app in headless Chrome, plays the game, and saves screenshots.
// Uses the Chrome that is already installed (no browser download).
//
//   npm run dev                      (in another terminal)
//   node tools/shoot.mjs <outDir> [baseUrl] [suite]
//
// suites: landing | game | mobile | all (default)
// The "game" suite plays all seven levels on the best path and checks that every level ends as Guardian.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [, , outDirArg, baseArg, suiteArg] = process.argv;
const outDir = path.resolve(outDirArg ?? 'shots');
const base = baseArg ?? 'http://127.0.0.1:5173';
const suite = suiteArg ?? 'all';
fs.mkdirSync(outDir, { recursive: true });

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
if (!executablePath) throw new Error('Chrome not found. Set CHROME_PATH.');

// default headless Chrome uses the real GPU through ANGLE; software rendering (swiftshader) is ~1 fps
const browser = await chromium.launch({ executablePath, headless: true, args: ['--ignore-gpu-blocklist'] });

const problems = [];
const failures = [];
async function open(viewport, url) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(3500); // first paint + scene setup, then the reveal transitions
  return { ctx, page };
}
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log('saved', name);
};
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

if (suite === 'all' || suite === 'landing') {
  const { ctx, page } = await open({ width: 1440, height: 900 }, base);
  await shot(page, 'landing-1-intro');
  for (const [i, name] of [[1, 'landing-2-levels'], [2, 'landing-3-players']]) {
    await page.evaluate((y) => window.scrollTo(0, y * window.innerHeight), i);
    await page.waitForTimeout(3500);
    await shot(page, name);
  }
  await ctx.close();
}

/** The best choice (key to press) at every decision of the seven levels, in order. A level step may need an Audit first. */
const BEST = [
  [['3'], ['4', '4']], // L1: quarantine; audit -> report
  [['4', '4'], ['4']], // L2: audit -> narrow; send to the manager only
  [['4', '4'], ['3']], // L3: audit -> reject; verify by phone
  [['4', '4'], ['4']], // L4: audit -> fix path; read it in a sandbox
  [['4', '4'], ['1']], // L5: audit -> approved registry; allow the calendar tool
  [['1'], ['4'], ['4'], ['1'], ['4']], // L6: invite, remote access, ignore the note, refund, ignore the web page
  [['4'], ['4', '4'], ['4'], ['1']], // L7: fetch the public page; audit -> loopback + token; ask for the price feed; allow the docs fetch
];

if (suite === 'all' || suite === 'game') {
  const { ctx, page } = await open({ width: 1440, height: 900 }, `${base}/#play`);
  await shot(page, 'game-0-level-select');

  const click = async (name) => {
    await page.getByRole('button', { name }).first().click();
    await page.waitForTimeout(500);
  };
  const waitForBar = async () => {
    await page.waitForSelector('.dbar', { timeout: 30000 });
    await page.waitForTimeout(900);
  };

  await click(/Begin level 1/i);
  await shot(page, 'game-1-briefing');
  await click(/Start simulation/i);
  await page.waitForTimeout(2600);
  await shot(page, 'game-2-simulating-log');
  await waitForBar();
  await shot(page, 'game-3-evidence-before-inspecting');

  // inspect two things: the page is built so the first clue of a step is a real red flag
  const clues = page.locator('.gart .clue');
  check((await clues.count()) >= 3, 'the evidence window has clickable clues');
  await clues.nth(0).click();
  await page.waitForTimeout(300);
  await clues.nth(3).click(); // the decoy
  await page.waitForTimeout(500);
  await shot(page, 'game-4-evidence-inspected');
  check((await page.locator('.gnotes li').count()) === 2, 'two inspections leave two notes in the notebook');
  check((await page.locator('.gdots i.on').count()) === 1, 'one inspection is left (three minus two)');

  // play every level on the best path
  for (let level = 0; level < BEST.length; level++) {
    if (level > 0) {
      await click(/Start simulation/i);
    }
    const steps = BEST[level];
    for (let s = 0; s < steps.length; s++) {
      await waitForBar();
      if (level === 3 && s === 0) await shot(page, 'game-5-level4-shell');
      if (level === 4 && s === 0) await shot(page, 'game-6-level5-tool');
      if (level === 5 && s === 3) await shot(page, 'game-8-level6-four-agents');
      for (let k = 0; k < steps[s].length; k++) {
        await page.keyboard.press(steps[s][k]);
        await page.waitForTimeout(700);
        if (level === 0 && s === 1 && k === 0) await shot(page, 'game-7-after-audit');
      }
      await page.waitForSelector('.gverdict', { timeout: 8000 });
      if (level === 0 && s === 0) await shot(page, 'game-outcome-safe');
      await page.waitForTimeout(1200);
      await click(s === steps.length - 1 ? /See results/i : /Continue/i);
    }
    await page.waitForSelector('#g-summary', { timeout: 8000 });
    await page.waitForTimeout(1200);
    const title = (await page.textContent('#g-summary')) ?? '';
    check(/Guardian/.test(title), `level ${level + 1} ends as Guardian on the best path (${title.trim().replace(/\s+/g, ' ')})`);
    if (level === 0 || level === 5) await shot(page, `game-summary-level${level + 1}`);
    if (level < BEST.length - 1) await click(/Next level/i);
    else await click(/See your campaign/i);
  }
  await page.waitForSelector('#g-final', { timeout: 8000 });
  await page.waitForTimeout(1200);
  await shot(page, 'game-9-campaign');
  check(/Guardian/.test((await page.textContent('#g-final')) ?? ''), 'the campaign ends as Guardian');
  check((await page.evaluate(() => JSON.parse(localStorage.getItem('agentguard.progress.v2') ?? '{}').badges?.length)) >= 4, 'badges are stored in the browser');

  // field guide
  await click(/All levels/i);
  await page.waitForTimeout(600);
  await shot(page, 'game-10-level-select-after');
  await page.getByRole('button', { name: /Open the field guide/i }).click();
  await page.waitForTimeout(700);
  await shot(page, 'game-11-field-guide');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check((await page.locator('.gguide').count()) === 0, 'Esc closes the field guide');
  await ctx.close();

  // the risky path: allow everything in level 3 (two agents) to see the failure reactions
  const risky = await open({ width: 1440, height: 900 }, `${base}/#play`);
  await risky.page.getByRole('button', { name: /The urgent purchase/i }).click();
  await risky.page.getByRole('button', { name: /Start simulation/i }).click();
  await risky.page.waitForSelector('.dbar', { timeout: 30000 });
  await risky.page.waitForTimeout(1000);
  await shot(risky.page, 'game-12-level3-alert');
  await risky.page.keyboard.press('1');
  await risky.page.waitForTimeout(2600);
  await shot(risky.page, 'game-13-level3-risky-outcome');
  await risky.ctx.close();
}

if (suite === 'all' || suite === 'mobile') {
  const { ctx, page } = await open({ width: 390, height: 844 }, base);
  await shot(page, 'mobile-1-intro');
  await page.evaluate(() => window.scrollTo(0, 2 * window.innerHeight));
  await page.waitForTimeout(3500);
  await shot(page, 'mobile-3-players');
  await page.goto(`${base}/#play`);
  await page.reload();
  await page.waitForTimeout(3000);
  await shot(page, 'mobile-4-level-select');
  await page.getByRole('button', { name: /Begin level 1/i }).first().click();
  await page.getByRole('button', { name: /Start simulation/i }).first().click();
  await page.waitForSelector('.dbar', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot(page, 'mobile-5-decision-evidence');
  await ctx.close();

  const m6 = await open({ width: 390, height: 844 }, `${base}/#play`);
  await m6.page.getByRole('button', { name: /Friday, 5 pm/i }).click();
  await m6.page.getByRole('button', { name: /Start simulation/i }).click();
  await m6.page.waitForSelector('.dbar', { timeout: 30000 });
  await m6.page.waitForTimeout(1500);
  await shot(m6.page, 'mobile-6-final-shift');
  await m6.ctx.close();
}

await browser.close();
console.log(problems.length ? `\nConsole problems (${problems.length}):\n${[...new Set(problems)].join('\n')}` : '\nNo console errors or warnings.');
if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exitCode = 1;
}
