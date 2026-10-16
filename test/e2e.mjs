// End-to-end: a whole cup played by CPU bots in real browsers, peer to peer.
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start      (bots only exist in such a build)
//   PLAYERS=16 node test/e2e.mjs
//
// Needs Playwright (npm i -D playwright, or NODE_PATH pointing at an install).
// Env: BASE (http://localhost:3000), PLAYERS (4), GOALS (2), CAP (60), SKILL (0.7),
//      CHROME (path to a Chromium binary), OUT (screenshot folder), WATCH=0 (no big screen),
//      EQUAL=1 (the "Equal delay" rule: guests draw the host's snapshots instead of predicting)
// The organiser's big screen shows every match in a grid: each live match has to
// show up there, and one is made to fill the screen once.
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const N = Number(process.env.PLAYERS || 4);
const GOALS = Number(process.env.GOALS || 2), CAP = Number(process.env.CAP || 60);
const SKILL = process.env.SKILL || '0.7';
const OUT = process.env.OUT || 'test-results';
const LIMIT_MS = Number(process.env.LIMIT_MIN || 25) * 60000;
mkdirSync(OUT, { recursive: true });

async function call(path, body) {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's';

const { code, adminKey } = await call('/api/t', { name: 'E2E Cup' });
await call('/api/t/' + code + '/admin', { key: adminKey, action: 'rules', rules: { goals: GOALS, capSec: CAP, finalGoals: GOALS, finalCapSec: CAP, modifiers: true, equalDelay: process.env.EQUAL === '1' } });
console.log(stamp(), 'cup', code, 'players', N);

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows']
});
const problems = [];
const pages = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 300 } });
  const page = await ctx.newPage();
  const name = 'Bot ' + (i + 1);
  page.on('pageerror', e => problems.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(name + ' console: ' + m.text()); });
  await page.goto(BASE + '/t/' + code + '?bot=' + SKILL + '&name=' + encodeURIComponent(name));
  pages.push(page);
}
for (let k = 0; k < 60; k++) {
  const v = await call('/api/t/' + code);
  if (v.players.length >= N) break;
  await sleep(1000);
}
let screen = null;
if (process.env.WATCH !== '0') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(([c, k]) => localStorage.setItem('cc:admin:' + c, JSON.stringify(k)), [code, adminKey]);   // the organiser's browser
  screen = await ctx.newPage();
  screen.on('pageerror', e => problems.push('screen: ' + e.message));
  await screen.goto(BASE + '/t/' + code + '/screen');
}
await call('/api/t/' + code + '/admin', { key: adminKey, action: 'start' });
console.log(stamp(), 'draw made');

let last = '', v = null, shots = 0, gridShot = false, maxShot = false;
const liveSince = new Map(), shown = new Map();      // match id -> when it went live / how long until the big screen had it
while (Date.now() - t0 < LIMIT_MS) {
  v = await call('/api/t/' + code);
  const line = v.matches.map(m => m.id + ':' + m.status[0] + (m.status === 'live' || m.status === 'done' ? m.score.join('-') : '')).join(' ');
  if (line !== last) { console.log(stamp(), line); last = line; }
  if (v.status === 'finished') break;
  // the big screen: every live match should appear in its grid
  if (screen) {
    try {
      const live = v.matches.filter(m => m.status === 'live' && !m.local).map(m => m.id);
      for (const id of live) if (!liveSince.has(id)) liveSince.set(id, Date.now());
      const fresh = await screen.evaluate(ids => ids.filter(id => window.__ccs && window.__ccs[id] && window.__ccs[id].game.lastFrameAge < 1500), live);
      for (const id of fresh) if (!shown.has(id)) { shown.set(id, Math.round((Date.now() - liveSince.get(id)) / 1000)); console.log(stamp(), 'big screen shows', id, '(' + shown.get(id) + 's after kick-off)'); }
      if (!gridShot && live.length >= 2 && fresh.length === live.length) {
        await sleep(1000);
        await screen.screenshot({ path: OUT + '/screen-grid.png' });
        gridShot = true;
      } else if (gridShot && !maxShot && fresh.length >= 2) {
        // 17 browser pages on one test machine keep the big screen busy: give the click time
        await screen.getByRole('button', { name: 'Fill the screen with this match' }).first().click({ timeout: 20000 });
        await sleep(1500);
        if ((await screen.locator('.tile:not([hidden])').count()) !== 1) problems.push('maximize did not hide the other matches');
        await screen.screenshot({ path: OUT + '/screen-max.png' });
        await screen.keyboard.press('Escape');
        await sleep(500);
        if ((await screen.locator('.tile.max').count()) !== 0) problems.push('Esc did not bring the grid back');
        maxShot = true;
      }
    } catch (e) { problems.push('big screen: ' + e.message.split('\n')[0]); }
  }
  if (shots < 1 && v.matches.some(m => m.status === 'live')) {
    const hostPage = pages.find(p => p.url().includes('/m/'));
    if (hostPage) { await hostPage.screenshot({ path: OUT + '/bot-match.png' }); shots++; }
  }
  await sleep(3000);
}
if (screen) {
  await sleep(2500);
  await screen.screenshot({ path: OUT + '/screen-final.png' });
  // a match only counts as missed if it was live long enough for a tile to connect
  for (const m of v.matches) {
    if (m.via !== 'played' || shown.has(m.id) || !m.startedAt || !m.endedAt) continue;
    if (m.endedAt - m.startedAt > 25000) problems.push('big screen never showed ' + m.id);
  }
  const waits = [...shown.values()];
  if (waits.length) console.log(stamp(), 'big screen showed', waits.length, 'matches; seconds after kick-off: max', Math.max(...waits), 'median', waits.sort((a, b) => a - b)[waits.length >> 1]);
}

const players = Object.fromEntries(v.players.map(p => [p.id, p.name]));
const played = v.matches.filter(m => m.via === 'played');
const ok = v.status === 'finished' && !!v.champion && v.matches.every(m => m.status === 'done' && m.winner)
  && played.every(m => Math.max(...m.score) >= 1 && m.score[0] !== m.score[1]
    && m.winner === (m.score[0] > m.score[1] ? m.a : m.b));
console.log(stamp(), 'status', v.status, 'champion', players[v.champion] || '-');
for (const m of v.matches) console.log('   ', m.label.padEnd(15), (players[m.a] || 'bye').padEnd(7), m.score.join('-'), (players[m.b] || 'bye').padEnd(7), m.via, m.endedAt && m.startedAt ? Math.round((m.endedAt - m.startedAt) / 1000) + 's' : '');
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
process.exit(ok && !problems.length ? 0 : 1);
