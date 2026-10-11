// End-to-end: a whole cup played by CPU bots in real browsers, peer to peer.
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start      (bots only exist in such a build)
//   PLAYERS=16 node test/e2e.mjs
//
// Needs Playwright (npm i -D playwright, or NODE_PATH pointing at an install).
// Env: BASE (http://localhost:3000), PLAYERS (4), GOALS (2), CAP (60), SKILL (0.7),
//      CHROME (path to a Chromium binary), OUT (screenshot folder), WATCH=1 (big screen spectates)
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
await call('/api/t/' + code + '/admin', { key: adminKey, action: 'rules', rules: { goals: GOALS, capSec: CAP, finalGoals: GOALS, finalCapSec: CAP, modifiers: true } });
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
  screen = await ctx.newPage();
  screen.on('pageerror', e => problems.push('screen: ' + e.message));
  await screen.goto(BASE + '/t/' + code + '/screen');
}
await call('/api/t/' + code + '/admin', { key: adminKey, action: 'start' });
console.log(stamp(), 'draw made');

let last = '', v = null, watched = false, shots = 0;
while (Date.now() - t0 < LIMIT_MS) {
  v = await call('/api/t/' + code);
  const line = v.matches.map(m => m.id + ':' + m.status[0] + (m.status === 'live' || m.status === 'done' ? m.score.join('-') : '')).join(' ');
  if (line !== last) { console.log(stamp(), line); last = line; }
  if (v.status === 'finished') break;
  // the big screen watches the first live match it sees, once
  const live = v.matches.find(m => m.status === 'live' && !m.local);
  if (screen && live && !watched) {
    watched = true;
    try {
      await sleep(2000);
      // the final goes up on the big screen by itself; earlier rounds need a click
      if (live.round !== v.rounds) await screen.getByRole('button', { name: 'Watch' }).first().click({ timeout: 8000 });
      let waited = 0, connected = false;
      for (; waited < 30 && !connected; waited++) {
        await sleep(1000);
        connected = await screen.evaluate(() => !!(window.__cc && window.__cc.game.lastFrameAge < 1000));
      }
      await sleep(1500);
      await screen.screenshot({ path: OUT + '/screen-watching.png' });
      console.log(stamp(), 'big screen watching', live.id, connected ? 'connected after ' + waited + 's' : 'NOT connected after 30s');
      if (!connected) problems.push('big screen could not watch ' + live.id);
      if (live.round !== v.rounds) await screen.getByRole('button', { name: 'Back to the bracket' }).first().click({ timeout: 5000 });
    } catch (e) { problems.push('watch: ' + e.message.split('\n')[0]); }
  }
  if (shots < 1 && v.matches.some(m => m.status === 'live')) {
    const hostPage = pages.find(p => p.url().includes('/m/'));
    if (hostPage) { await hostPage.screenshot({ path: OUT + '/bot-match.png' }); shots++; }
  }
  await sleep(3000);
}
if (screen) { await sleep(2500); await screen.screenshot({ path: OUT + '/screen-final.png' }); }

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
