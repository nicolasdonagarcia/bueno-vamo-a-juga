// The awkward moments of a live cup, in real browsers:
//   A  the guest reloads mid-match: the host pauses, then both resume
//   B  the host reloads mid-match: the match carries on from the saved score
//   C  a spectator joins a running match and sees it
//   D  the organiser plays a match on one device ("Play it on this device")
//   E  the host gives up on the link and plays both sides on their own device
//   F  the organiser awards a walkover while both players wait on the match page
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/scenarios.mjs             (BASE, CHROME, OUT, ONLY=A,B,...)
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || 'test-results';
const ONLY = (process.env.ONLY || 'A,B,C,D,E,F').split(',');
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(path, body) {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
async function cup(rules, names = ['Ana', 'Ben']) {
  const { code, adminKey } = await call('/api/t', { name: 'Scenario' });
  await call('/api/t/' + code + '/admin', { key: adminKey, action: 'rules', rules });
  const ps = [];
  for (const [i, n] of names.entries()) ps.push(await call('/api/t/' + code + '/join', { name: n, flag: 'se', color: i ? 'teal' : 'orange' }));
  await call('/api/t/' + code + '/admin', { key: adminKey, action: 'start' });
  const v = await call('/api/t/' + code);
  const m = v.matches.find(x => x.round === 1 && x.status === 'ready');
  const host = ps.find(p => p.playerId === m.a), guest = ps.find(p => p.playerId === m.b);
  return { code, adminKey, m, host, guest };
}
const match = async (code, id) => (await call('/api/t/' + code)).matches.find(m => m.id === id);
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
  throw new Error('timed out: ' + what);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
});
const errors = [];
async function open(code, saved, path, viewport = { width: 900, height: 600 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([code, saved]) => {
    if (saved.player) localStorage.setItem('cc:player:' + code, JSON.stringify(saved.player));
    if (saved.admin) localStorage.setItem('cc:admin:' + code, JSON.stringify(saved.admin));
  }, [code, saved]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(path + ': ' + e.message));
  page.on('dialog', d => d.accept());          // "leave the match?" on reload
  await page.goto(BASE + path);
  return page;
}
const cc = (page, expr) => page.evaluate(expr);
const phase = page => cc(page, () => window.__cc && window.__cc.game.phase);
const engineScore = page => cc(page, () => window.__cc && window.__cc.game.score);
const results = [];
async function scenario(id, title, fn) {
  if (!ONLY.includes(id)) return;
  const t = Date.now();
  try { await fn(); results.push([id, 'pass', title, ((Date.now() - t) / 1000).toFixed(1) + 's']); }
  catch (e) { results.push([id, 'FAIL', title, e.message]); }
  console.log(results[results.length - 1].join('  '));
}

// ---------------------------------------------------------------- A + C
await scenario('A', 'guest reloads mid-match, host pauses and both resume', async () => {
  const c = await cup({ goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest }, path);
  await H.getByRole('button', { name: 'I\'m ready' }).click();
  await G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(async () => (await match(c.code, c.m.id)).status === 'live', 15000, 'match live');
  await until(async () => (await phase(H)) === 'play', 8000, 'host playing');
  await until(async () => cc(G, () => window.__cc.game.lastFrameAge < 500), 5000, 'guest receiving');
  // the guest presses: the host's man should hop
  await G.keyboard.press('Space');
  await sleep(1500);
  // C: a spectator joins
  if (ONLY.includes('C')) {
    const S = await open(c.code, {}, path);
    await until(async () => cc(S, () => window.__cc && window.__cc.game.lastFrameAge < 600), 15000, 'spectator receiving frames');
    await S.screenshot({ path: OUT + '/C-spectator.png' });
    results.push(['C', 'pass', 'a spectator joins a running match and sees it', '']);
    console.log('C  pass  spectator');
    await S.context().close();
  }
  await G.reload();
  await until(async () => cc(H, () => window.__cc.game.paused), 10000, 'host paused after guest left');
  await H.screenshot({ path: OUT + '/A-host-paused.png' });
  await until(async () => cc(H, () => !window.__cc.game.paused), 25000, 'host resumed after guest returned');
  await until(async () => cc(G, () => window.__cc && window.__cc.game.lastFrameAge < 500), 5000, 'guest receiving again');
  const t1 = await cc(H, () => window.__cc.game.hostClock);
  await sleep(1000);
  const t2 = await cc(H, () => window.__cc.game.hostClock);
  if (!(t2 - t1 > 0.5)) throw new Error('host clock not running after resume');
  await G.screenshot({ path: OUT + '/A-guest-back.png' });
  await H.context().close(); await G.context().close();
});

// ---------------------------------------------------------------- B
await scenario('B', 'host reloads mid-match and carries on from the saved score', async () => {
  const c = await cup({ goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path + '?bot=0.95');     // a strong CPU plays the host side
  const G = await open(c.code, { player: c.guest }, path);
  await G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(async () => (await match(c.code, c.m.id)).status === 'live', 15000, 'match live');
  const m1 = await until(async () => { const m = await match(c.code, c.m.id); return m.score[0] + m.score[1] >= 1 ? m : null; }, 90000, 'a goal');
  await sleep(500);
  await H.reload();
  await until(async () => (await phase(H)) === 'play', 30000, 'host back and playing');
  const sc = await engineScore(H);
  const m2 = await match(c.code, c.m.id);
  if (sc[0] + sc[1] < m1.score[0] + m1.score[1]) throw new Error('score went back: server ' + m1.score + ' engine ' + sc);
  if (m2.status !== 'live') throw new Error('match not live after host reload');
  await H.screenshot({ path: OUT + '/B-host-resumed.png' });
  await H.context().close(); await G.context().close();
});

// ---------------------------------------------------------------- D
await scenario('D', 'organiser plays a match on one device', async () => {
  const c = await cup({ goals: 1, capSec: 0, finalGoals: 1, finalCapSec: 0, modifiers: false });
  const A = await open(c.code, { admin: c.adminKey }, '/t/' + c.code + '/m/' + c.m.id + '?local=1', { width: 1100, height: 760 });
  await A.getByRole('button', { name: 'Kick off' }).click();
  await until(async () => { const m = await match(c.code, c.m.id); return m.status === 'live' && m.local; }, 8000, 'live on one device');
  // two people mashing their keys
  let done = false;
  const masher = (async () => { while (!done) { await A.keyboard.press(Math.random() < 0.5 ? 'KeyW' : 'ArrowUp'); await sleep(90 + Math.random() * 140); } })();
  const m = await until(async () => { const x = await match(c.code, c.m.id); return x.status === 'done' ? x : null; }, 150000, 'local result saved');
  done = true; await masher;
  if (m.via !== 'local' || Math.max(...m.score) !== 1) throw new Error('unexpected result ' + JSON.stringify(m));
  await sleep(3500);
  await A.screenshot({ path: OUT + '/D-local-end.png' });
  await A.context().close();
});

// ---------------------------------------------------------------- E
await scenario('E', 'host moves the match onto their own device', async () => {
  const c = await cup({ goals: 1, capSec: 0, finalGoals: 1, finalCapSec: 0, modifiers: false });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);       // the guest never shows up
  await H.getByRole('button', { name: 'Play on this device' }).click({ timeout: 25000 });
  await H.getByRole('button', { name: 'Kick off' }).click();
  await until(async () => { const m = await match(c.code, c.m.id); return m.status === 'live' && m.local; }, 8000, 'marked local');
  const G = await open(c.code, { player: c.guest }, path);
  await G.getByText('moved this match onto their device').waitFor({ timeout: 10000 });
  let done = false;
  const masher = (async () => { while (!done) { await H.keyboard.press(Math.random() < 0.5 ? 'KeyW' : 'ArrowUp'); await sleep(90 + Math.random() * 140); } })();
  const m = await until(async () => { const x = await match(c.code, c.m.id); return x.status === 'done' ? x : null; }, 150000, 'result saved');
  done = true; await masher;
  if (m.via !== 'played') throw new Error('unexpected via ' + m.via);
  await H.context().close(); await G.context().close();
});

// ---------------------------------------------------------------- F
await scenario('F', 'walkover while both players wait', async () => {
  const c = await cup({ goals: 3, capSec: 180, finalGoals: 5, finalCapSec: 300, modifiers: true });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest }, path);
  await until(async () => (await cc(H, () => !!window.__cc)) && cc(G, () => !!window.__cc), 10000, 'both match pages up');
  await call('/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'result', matchId: c.m.id, winner: 'b', score: [0, 0], via: 'walkover' });
  await H.getByText('The organiser decided this match').waitFor({ timeout: 10000 });
  await G.getByText('The organiser decided this match').waitFor({ timeout: 10000 });
  await G.screenshot({ path: OUT + '/F-walkover.png' });
  await H.context().close(); await G.context().close();
});

console.log('\n' + results.map(r => r.join('  ')).join('\n'));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(results.every(r => r[1] === 'pass') && !errors.length ? 0 : 1);
