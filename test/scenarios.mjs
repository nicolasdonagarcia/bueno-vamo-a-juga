// The awkward moments of a live cup, in real browsers:
//   A  the guest reloads mid-match: the host pauses, then both resume
//   B  the host reloads mid-match: the match carries on from the saved score
//   C  the organiser opens a running match and sees it; nobody else can watch
//   D  the organiser plays a match on one device ("Play it on this device")
//   E  the host gives up on the link and plays both sides on their own device
//   F  the organiser awards a walkover while both players wait on the match page
//   G  the big screen: every match in a grid, one fills the screen, organiser only
//   H  the guest's connection drops for a few seconds: the host pauses, then both carry on
//   I  the host's connection drops for a few seconds: the same, the other way round
//   J  a dead ball's countdown ring and the re-drop show on the other player's screen
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/scenarios.mjs             (BASE, CHROME, OUT, ONLY=A,B,...)
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || 'test-results';
const ONLY = (process.env.ONLY || 'A,B,C,D,E,F,G,H,I,J').split(',');
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
  const ready = v.matches.filter(x => x.round === 1 && x.status === 'ready');
  const m = ready[0];
  const host = ps.find(p => p.playerId === m.a), guest = ps.find(p => p.playerId === m.b);
  const who = id => ps.find(p => p.playerId === id);
  return { code, adminKey, m, host, guest, ready, who, v };
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
    if (saved.pcs) {          // keep hold of the page's WebRTC connections, so a test can cut them
      const Orig = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
      window.RTCPeerConnection.prototype = Orig.prototype;
    }
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
  // C: the organiser opens the match and sees it; anyone else is turned away
  if (ONLY.includes('C')) {
    const S = await open(c.code, { admin: c.adminKey }, path);
    await until(async () => cc(S, () => window.__cc && window.__cc.game.lastFrameAge < 600), 15000, 'organiser receiving frames');
    await S.screenshot({ path: OUT + '/C-organiser-watching.png' });
    const X = await open(c.code, {}, path);
    await X.getByText('Not your match').waitFor({ timeout: 10000 });
    const sig = '/api/t/' + c.code + '/m/' + c.m.id + '/signal';
    const g1 = await fetch(BASE + sig + '?box=spec:test1234');
    const g2 = await fetch(BASE + sig + '?box=spec:test1234', { headers: { 'x-cc-admin': c.adminKey } });
    const p1 = await fetch(BASE + sig, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'spec:test1234', to: 'host', type: 'offer', sdp: 'x' }) });
    if (g1.status !== 403 || g2.status !== 200 || p1.status !== 403) throw new Error('viewer mailbox not locked: ' + [g1.status, g2.status, p1.status]);
    results.push(['C', 'pass', 'the organiser watches a running match; nobody else can', '']);
    console.log('C  pass  organiser watches, others turned away');
    await S.context().close(); await X.context().close();
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

// ---------------------------------------------------------------- G
await scenario('G', 'big screen: every match in a grid, one fills the screen, organiser only', async () => {
  const c = await cup({ goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false }, ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal']);
  if (c.ready.length !== 4) throw new Error('expected 4 first-round matches, got ' + c.ready.length);
  const S = await open(c.code, { admin: c.adminKey }, '/t/' + c.code + '/screen', { width: 1280, height: 720 });
  await until(async () => (await S.locator('.tile').count()) === 4, 10000, 'four tiles');
  // two matches get played (CPU on both sides), two players never turn up
  const played = c.ready.slice(0, 2), ctxs = [];
  for (const m of played) {
    const path = '/t/' + c.code + '/m/' + m.id + '?bot=0.8';
    ctxs.push(await open(c.code, { player: c.who(m.a) }, path, { width: 480, height: 330 }));
    ctxs.push(await open(c.code, { player: c.who(m.b) }, path, { width: 480, height: 330 }));
  }
  const t0 = Date.now();
  const ids = played.map(m => m.id);
  await until(async () => S.evaluate(ids => ids.every(id => window.__ccs && window.__ccs[id] && window.__ccs[id].game.lastFrameAge < 1000), ids), 40000, 'both played matches on the big screen');
  console.log('   grid tiles showing both matches after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  await S.getByText('to open the match').first().waitFor({ timeout: 20000 });
  await sleep(1500);
  await S.screenshot({ path: OUT + '/G-grid.png' });
  // fill the screen with one, then back
  await S.locator('.tile').nth(0).getByRole('button', { name: 'Fill the screen with this match' }).click();
  await until(async () => (await S.locator('.tile:not([hidden])').count()) === 1 && (await S.locator('.tile.max').count()) === 1, 3000, 'one tile fills the screen');
  await sleep(1200);
  await S.screenshot({ path: OUT + '/G-max.png' });
  await S.keyboard.press('Escape');
  await until(async () => (await S.locator('.tile:not([hidden])').count()) === 4, 3000, 'Esc shows all four again');
  await S.keyboard.press('2');
  await until(async () => (await S.locator('.tile.max').count()) === 1, 3000, 'key 2 fills the screen');
  const maxLabel = await S.locator('.tile.max').getAttribute('aria-label');
  const second = c.v.players.find(p => p.id === c.ready[1].a).name;
  if (!maxLabel.includes(second)) throw new Error('key 2 opened the wrong match: ' + maxLabel);
  await S.keyboard.press('ArrowRight');
  await until(async () => (await S.locator('.tile.max').getAttribute('aria-label')) !== maxLabel, 3000, '→ moves to the next match');
  await S.getByRole('button', { name: 'Back to all matches' }).click();
  await until(async () => (await S.locator('.tile:not([hidden])').count()) === 4, 3000, 'button shows all four again');
  await S.getByRole('radio', { name: 'Bracket' }).click();
  await S.locator('.bracket').waitFor({ timeout: 3000 });
  await S.getByRole('radio', { name: /Matches/ }).click();
  await until(async () => (await S.locator('.tile').count()) === 4, 3000, 'back to the grid');
  // the tiles kept their connections through all of that
  if (!(await S.evaluate(ids => ids.every(id => window.__ccs[id].game.lastFrameAge < 1500), ids))) throw new Error('a tile lost its match');
  // nobody else gets the screen, or someone else's match
  const N = await open(c.code, {}, '/t/' + c.code + '/screen');
  await N.getByText('This screen is for the organiser').waitFor({ timeout: 10000 });
  const idle = c.ready[3];
  const P = await open(c.code, { player: c.who(played[0].a) }, '/t/' + c.code + '/m/' + idle.id);
  await P.getByText('Not your match').waitFor({ timeout: 10000 });
  const H = await open(c.code, { player: c.who(idle.a) }, '/t/' + c.code);
  await H.locator('.bracket').waitFor({ timeout: 10000 });
  const links = await H.locator('.bracket a[href*="/m/"]').evaluateAll(as => as.map(a => a.getAttribute('href')));
  if (links.length !== 1 || !links[0].includes(idle.id)) throw new Error('player page links other matches: ' + JSON.stringify(links));
  for (const p of [...ctxs, S, N, P, H]) await p.context().close();
});

// ---------------------------------------------------------------- H + I
// A connection drop: the page's WebRTC connections die and its network is gone for 6 seconds.
async function drop(page) {
  await page.context().setOffline(true);
  await page.evaluate(() => window.__pcs.forEach(pc => { try { pc.close(); } catch (e) { } }));
  await sleep(6000);
  await page.context().setOffline(false);
}
const lastPress = (page, slot) => page.evaluate(s => window.__cc.game.debug.chars.find(c => c.slot === s).cd, slot);
async function dropScenario(who) {
  const c = await cup({ goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host, pcs: who === 'host' }, path);
  const G = await open(c.code, { player: c.guest, pcs: who === 'guest' }, path);
  await H.getByRole('button', { name: 'I\'m ready' }).click();
  await G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(async () => (await phase(H)) === 'play', 15000, 'kick-off');
  await sleep(2000);
  const sc0 = await engineScore(H), clock0 = await cc(H, () => window.__cc.game.hostClock);
  const t0 = Date.now();
  const dropping = drop(who === 'host' ? H : G);
  await until(() => cc(H, () => window.__cc.game.paused), 15000, 'host pauses');
  if (who === 'guest') await H.getByText('lost the connection').waitFor({ timeout: 10000 });
  else await G.getByText('Reconnecting to').or(G.getByText('Waiting for')).first().waitFor({ timeout: 15000 });
  await H.screenshot({ path: OUT + '/' + who + '-drop-host.png' });
  await G.screenshot({ path: OUT + '/' + who + '-drop-guest.png' });
  await dropping;
  await until(() => cc(H, () => !window.__cc.game.paused), 60000, 'host resumes after the network is back');
  const back = ((Date.now() - t0) / 1000 - 6).toFixed(0);
  await until(() => cc(G, () => window.__cc.game.lastFrameAge < 500), 10000, 'guest receiving again');
  const clock1 = await cc(H, () => window.__cc.game.hostClock);
  const sc1 = await engineScore(H);
  if (sc1[0] < sc0[0] || sc1[1] < sc0[1]) throw new Error('score went back: ' + sc0 + ' -> ' + sc1);
  if (!(clock1 > clock0)) throw new Error('clock did not go on');
  // the guest's buttons still reach the host
  await until(async () => (await lastPress(H, 2)) < -0.5, 4000, 'quiet');
  await G.keyboard.press('ArrowUp');
  await until(async () => (await lastPress(H, 2)) > -0.4, 2000, 'guest press after the drop');
  console.log('   ' + who + ' drop: playing again ' + back + 's after the network came back');
  await H.context().close(); await G.context().close();
}
await scenario('H', 'the guest\'s connection drops for a few seconds: the host pauses, then both carry on', () => dropScenario('guest'));
await scenario('I', 'the host\'s connection drops for a few seconds: both wait, then carry on', () => dropScenario('host'));

// ---------------------------------------------------------------- J
await scenario('J', 'a dead ball\'s countdown ring and the re-drop show on the other player\'s screen', async () => {
  const c = await cup({ goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false });
  const p2 = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, p2);
  const G = await open(c.code, { player: c.guest }, p2);
  await H.getByRole('button', { name: 'I\'m ready' }).click();
  await G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(async () => (await phase(H)) === 'play', 15000, 'kick-off');
  await sleep(1500);
  // nobody presses; the ball is put to rest on the turf in the middle, away from everyone
  await cc(H, () => { const b = window.__cc.game.debug.balls[0]; b.setTransform({ x: 530 / 80, y: (590 - 19) / 80 }, 0); b.setLinearVelocity({ x: 0, y: 0 }); b.setAngularVelocity(0); });
  const warn = await until(() => cc(G, () => { const v = window.__cc.game.debug.view; const b = v && v.balls && v.balls[0]; return b && b.warn > 0.2 ? b.warn : 0; }), 10000, 'the ring on the guest\'s screen');
  await G.screenshot({ path: OUT + '/J-ring-guest.png' });
  await G.getByText('The ball stopped dead').waitFor({ timeout: 8000 });
  const dead = await cc(H, () => window.__cc.game.stats.out.dead);
  if (dead < 1) throw new Error('no re-drop on the host');
  console.log('   ring seen on the guest at ' + warn.toFixed(2) + ', re-dropped');
  await H.context().close(); await G.context().close();
});

console.log('\n' + results.map(r => r.join('  ')).join('\n'));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(results.every(r => r[1] === 'pass') && !errors.length ? 0 : 1);
