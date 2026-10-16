// End-to-end: a whole cup played by CPU bots in real browsers, one match at a time.
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start      (bots only exist in such a build)
//   PLAYERS=16 node test/e2e.mjs
//
// Needs Playwright (npm i -D playwright, or NODE_PATH pointing at an install).
// Env: BASE (http://localhost:3000), PLAYERS (4), GOALS (2), CAP (60), SKILL (0.7),
//      CHROME (path to a Chromium binary), OUT (screenshot folder), WATCH=0 (no big screen),
//      NET=p2p (the organiser's switch: peer to peer instead of the match server),
//      EQUAL=1 (peer to peer: the "Equal delay" rule)
// Checks that the matches go one after another, never two at once, that each bot's page
// opens its match when it's on, and that the organiser's big screen follows along: every
// match has to show up there live.
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const N = Number(process.env.PLAYERS || 4);
const GOALS = Number(process.env.GOALS || 2), CAP = Number(process.env.CAP || 60);
const SKILL = process.env.SKILL || '0.7';
const OUT = process.env.OUT || 'test-results';
const LIMIT_MS = Number(process.env.LIMIT_MIN || 40) * 60000;
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
await call('/api/t/' + code + '/admin', { key: adminKey, action: 'rules', rules: { goals: GOALS, capSec: CAP, finalGoals: GOALS, finalCapSec: CAP, modifiers: true, equalDelay: process.env.EQUAL === '1', net: process.env.NET === 'p2p' ? 'p2p' : 'server' } });
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

let last = '', v = null, shots = 0, maxLive = 0;
const liveSince = new Map(), shown = new Map();      // match id -> when it went live / how long until the big screen had it
while (Date.now() - t0 < LIMIT_MS) {
  v = await call('/api/t/' + code);
  const line = v.matches.filter(m => m.via !== 'bye').map(m => m.id + ':' + m.status[0] + (m.status === 'live' || m.status === 'done' ? m.score.join('-') : '') + (m.id === v.current ? '*' : '')).join(' ');
  if (line !== last) { console.log(stamp(), line); last = line; }
  if (v.status === 'finished') break;
  const live = v.matches.filter(m => m.status === 'live');
  maxLive = Math.max(maxLive, live.length);
  if (live.length > 1) problems.push(stamp() + ' two matches live at once: ' + live.map(m => m.id).join(', '));
  for (const m of live) if (!liveSince.has(m.id)) liveSince.set(m.id, Date.now());
  // the big screen shows the match on now
  if (screen) {
    try {
      const s = await screen.evaluate(() => window.__cc ? { match: window.__cc.match, age: window.__cc.game.lastFrameAge, phase: window.__cc.game.phase } : null);
      const m = live.find(x => !x.local);
      if (m && s && s.match === m.id && s.age < 1500 && !shown.has(m.id)) {
        shown.set(m.id, Math.round((Date.now() - liveSince.get(m.id)) / 1000));
        console.log(stamp(), 'big screen shows', m.id, '(' + shown.get(m.id) + 's after kick-off)');
        if (shown.size === 1) { await sleep(1000); await screen.screenshot({ path: OUT + '/screen-live.png' }); }
      }
    } catch (e) { problems.push('big screen: ' + e.message.split('\n')[0]); }
  }
  if (shots < 1 && live.length) {
    const p = pages.find(x => x.url().includes('/m/' + live[0].id));
    if (p) { await p.screenshot({ path: OUT + '/bot-match.png' }); shots++; }
  }
  await sleep(2000);
}
if (screen) {
  await sleep(2500);
  await screen.screenshot({ path: OUT + '/screen-final.png' });
  // a match only counts as missed if it was live long enough for the screen to connect
  for (const m of v.matches) {
    if (m.via !== 'played' || shown.has(m.id) || !m.startedAt || !m.endedAt) continue;
    if (m.endedAt - m.startedAt > 20000) problems.push('big screen never showed ' + m.id);
  }
  const waits = [...shown.values()];
  if (waits.length) console.log(stamp(), 'big screen showed', waits.length, 'matches; seconds after kick-off: max', Math.max(...waits), 'median', waits.sort((a, b) => a - b)[waits.length >> 1]);
}

// one after another: each match kicked off after the one before had ended
const timed = v.matches.filter(m => m.startedAt && m.endedAt).sort((a, b) => a.startedAt - b.startedAt);
const gaps = [];
for (let i = 1; i < timed.length; i++) {
  if (timed[i].startedAt < timed[i - 1].endedAt) problems.push(timed[i].id + ' kicked off before ' + timed[i - 1].id + ' ended');
  gaps.push(Math.round((timed[i].startedAt - timed[i - 1].endedAt) / 1000));
}
const players = Object.fromEntries(v.players.map(p => [p.id, p.name]));
const played = v.matches.filter(m => m.via === 'played');
const ok = v.status === 'finished' && !!v.champion && v.matches.every(m => m.status === 'done' && m.winner)
  && played.every(m => Math.max(...m.score) >= 1 && m.score[0] !== m.score[1]
    && m.winner === (m.score[0] > m.score[1] ? m.a : m.b));
console.log(stamp(), 'status', v.status, 'champion', players[v.champion] || '-');
for (const m of v.matches) console.log('   ', m.label.padEnd(15), (players[m.a] || 'bye').padEnd(7), m.score.join('-'), (players[m.b] || 'bye').padEnd(7), m.via, m.endedAt && m.startedAt ? Math.round((m.endedAt - m.startedAt) / 1000) + 's' : '');
if (gaps.length) console.log('    between matches (s): median', gaps.slice().sort((a, b) => a - b)[gaps.length >> 1], 'max', Math.max(...gaps), '· the whole cup took', Math.round((Date.now() - t0) / 60000), 'min');
console.log('most matches live at once:', maxLive);
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
process.exit(ok && !problems.length ? 0 : 1);
