// The awkward moments of a live cup, in real browsers. On the match server:
//   A  a player reloads mid-match: the match pauses, then both carry on
//   B  the left-hand player reloads mid-match: straight back into the match, score kept
//   C  the organiser opens a running match and sees it; nobody else can watch
//   D  the organiser plays a match on one device ("Play it on this device")
//   E  the left-hand player gives up waiting and plays both sides on their own device
//   F  the organiser awards a walkover while both players wait on the match page
//   G  the big screen: the match on now, live, who's up next, then the next match; organiser only
//   H  the right-hand player's network drops out for a few seconds: the match pauses, then both carry on
//   I  the same for the left-hand player
//   J  a dead ball's countdown ring and the re-drop show on a player's screen
//   K  the match server restarts mid-match: the pages come back and it carries on from the saved score
//      (needs RESTART_MATCH_SERVER, a shell command that restarts it; with npm start, which brings
//       it back by itself: RESTART_MATCH_SERVER='pkill -TERM -f "server/mai[n].ts"')
// Peer to peer (the organiser's switch):
//   P  connected directly, the organiser watches, the dead-ball ring, the guest and then the host reload
//   Q  the guest's connection drops for a few seconds: the host pauses, then both carry on
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/scenarios.mjs             (BASE, CHROME, OUT, ONLY=A,B,...)
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || 'test-results';
const ONLY = (process.env.ONLY || 'A,B,C,D,E,F,G,H,I,J,K,P,Q,R').split(',');
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
  for (const [i, n] of names.entries()) ps.push({ name: n, ...(await call('/api/t/' + code + '/join', { name: n, flag: 'se', color: i % 2 ? 'teal' : 'orange' })) });
  await call('/api/t/' + code + '/admin', { key: adminKey, action: 'start' });
  const v = await call('/api/t/' + code);
  const ready = v.matches.filter(x => x.round === 1 && x.status === 'ready');
  const m = v.matches.find(x => x.id === v.current);           // one match at a time: the one on now
  const who = id => ps.find(p => p.playerId === id);
  return { code, adminKey, m, host: who(m.a), guest: who(m.b), ready, who, v, server: m.rules.net === 'server' };
}
const match = async (code, id) => (await call('/api/t/' + code)).matches.find(m => m.id === id);
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
  throw new Error('timed out: ' + what);
}
function check(cond, what) { if (!cond) throw new Error(what); }

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
});
const errors = [];
const contexts = [];             // closed after each scenario, passed or failed
async function open(code, saved, path, viewport = { width: 900, height: 600 }) {
  const ctx = await browser.newContext({ viewport });
  contexts.push(ctx);
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
const cc = (page, expr, arg) => page.evaluate(expr, arg);
const phase = page => cc(page, () => window.__cc && window.__cc.game.phase);
const engineScore = page => cc(page, () => window.__cc && window.__cc.game.score);
const clock = page => cc(page, () => window.__cc ? window.__cc.game.hostClock : 0);
const lastPress = (page, slot) => page.evaluate(s => window.__cc.game.debug.chars.find(c => c.slot === s).cd, slot);
// the match is going: its clock moves on this page
async function going(page, ms, what) {
  await until(async () => { const a = await clock(page); await sleep(500); return (await clock(page)) - a > 0.25; }, ms, what);
}
async function readyBoth(H, G) {
  await H.getByRole('button', { name: 'I\'m ready' }).click();
  await G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(async () => (await phase(H)) === 'play', 15000, 'kick-off');
}
const results = [];
let serverOn = null;
async function scenario(id, title, fn, needsServer = true) {
  if (!ONLY.includes(id)) return;
  if (serverOn === null) serverOn = (await cup({ goals: 1 })).server;        // does this site send matches to a match server?
  if (needsServer && !serverOn) { results.push([id, 'skip', title, 'this site has no match server']); console.log(results[results.length - 1].join('  ')); return; }
  const t = Date.now();
  try { const note = await fn(); results.push([id, note === 'skip' ? 'skip' : 'pass', title, ((Date.now() - t) / 1000).toFixed(1) + 's' + (note && note !== 'skip' ? ' · ' + note : '')]); }
  catch (e) { results.push([id, 'FAIL', title, e.message.split('\n').filter(l => l.trim() && !/^Call log/.test(l)).slice(0, 2).join(' | ').replace(/\x1b\[[0-9;]*m/g, '')]); }
  for (const c of contexts.splice(0)) await c.close().catch(() => { });
  console.log(results[results.length - 1].join('  '));
}
const NO_LIMITS = { goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false };

// ---------------------------------------------------------------- A + C
await scenario('A', 'a player reloads mid-match: the match pauses, then both carry on', async () => {
  const c = await cup(NO_LIMITS);
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest }, path);
  await readyBoth(H, G);
  await until(async () => (await match(c.code, c.m.id)).status === 'live', 15000, 'match live');
  await until(async () => cc(G, () => window.__cc.game.lastFrameAge < 500), 5000, 'the right-hand player receiving');
  check(await cc(H, () => window.__cc.transport) === 'server', 'not on the match server');
  await G.keyboard.press('Space');
  await sleep(1500);
  // C: the organiser opens the match and sees it; anyone else is turned away
  if (ONLY.includes('C')) {
    const S = await open(c.code, { admin: c.adminKey }, path);
    await until(async () => cc(S, () => window.__cc && window.__cc.game.lastFrameAge < 600), 15000, 'organiser receiving frames');
    await S.getByText('You’re watching as the organiser').waitFor({ timeout: 5000 });
    await S.screenshot({ path: OUT + '/C-organiser-watching.png' });
    const X = await open(c.code, {}, path);
    await X.getByText('Not your match').waitFor({ timeout: 10000 });
    const t1 = await fetch(BASE + '/api/t/' + c.code + '/m/' + c.m.id + '/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'guess' }) });
    const t2 = await fetch(BASE + '/api/t/' + c.code + '/m/' + c.m.id + '/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    if (t1.status !== 403 || t2.status !== 403) throw new Error('watching without the key: ' + [t1.status, t2.status]);
    results.push(['C', 'pass', 'the organiser watches a running match; nobody else can', '']);
    console.log('C  pass  organiser watches, others turned away');
    await S.context().close(); await X.context().close();
  }
  const clock0 = await clock(H);
  await G.reload();
  // the server pauses the match while the page is away; the other player sees why
  await H.getByText(c.guest.name + ' lost the connection').or(H.getByText('Back on')).first().waitFor({ timeout: 10000 });
  await H.screenshot({ path: OUT + '/A-paused.png' });
  await going(H, 25000, 'the match going again');
  await until(async () => cc(G, () => window.__cc && window.__cc.game.lastFrameAge < 500), 5000, 'the reloaded page receiving again');
  await going(G, 5000, 'the reloaded page playing');
  check((await clock(H)) > clock0, 'the clock went back');
  await G.screenshot({ path: OUT + '/A-back.png' });
  await H.context().close(); await G.context().close();
});

// ---------------------------------------------------------------- B
await scenario('B', 'the left-hand player reloads mid-match: straight back in, score kept', async () => {
  const c = await cup(NO_LIMITS);
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path + '?bot=0.95');     // a strong CPU plays the left side
  const G = await open(c.code, { player: c.guest }, path);
  await G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(async () => (await match(c.code, c.m.id)).status === 'live', 15000, 'match live');
  const m1 = await until(async () => { const m = await match(c.code, c.m.id); return m.score[0] + m.score[1] >= 1 ? m : null; }, 90000, 'a goal');
  await sleep(500);
  await H.reload();
  await until(async () => (await phase(H)) === 'play', 30000, 'back and playing');
  await going(H, 10000, 'the match going on the reloaded page');
  const sc = await engineScore(H);
  const m2 = await match(c.code, c.m.id);
  if (sc[0] + sc[1] < m1.score[0] + m1.score[1]) throw new Error('score went back: saved ' + m1.score + ', match ' + sc);
  if (m2.status !== 'live') throw new Error('match not live after the reload');
  await H.screenshot({ path: OUT + '/B-back.png' });
  await H.context().close(); await G.context().close();
  return 'score ' + sc.join('–');
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
}, false);

// ---------------------------------------------------------------- E
await scenario('E', 'the left-hand player moves the match onto their own device', async () => {
  const c = await cup({ goals: 1, capSec: 0, finalGoals: 1, finalCapSec: 0, modifiers: false });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);       // the other player never shows up
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
}, false);

// ---------------------------------------------------------------- F
await scenario('F', 'walkover while both players wait', async () => {
  const c = await cup({ goals: 3, capSec: 90, finalGoals: 5, finalCapSec: 150, modifiers: true });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest }, path);
  await until(async () => (await cc(H, () => !!window.__cc)) && cc(G, () => !!window.__cc), 10000, 'both match pages up');
  await call('/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'result', matchId: c.m.id, winner: 'b', score: [0, 0], via: 'walkover' });
  await H.getByText('The organiser decided this match').waitFor({ timeout: 10000 });
  await G.getByText('The organiser decided this match').waitFor({ timeout: 10000 });
  await G.screenshot({ path: OUT + '/F-walkover.png' });
  await H.context().close(); await G.context().close();
}, false);

// ---------------------------------------------------------------- G
await scenario('G', 'the big screen: the match on now, live, who is up next, then the next match; organiser only', async () => {
  const c = await cup({ goals: 1, capSec: 0, finalGoals: 1, finalCapSec: 0, modifiers: false }, ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal']);
  if (c.ready.length !== 4) throw new Error('expected 4 first-round matches, got ' + c.ready.length);
  const [m1, m2, m3, m4] = c.ready;
  check(c.m.id === m1.id, 'the first match is not the one on now');
  const vs = m => c.who(m.a).name + ' vs ' + c.who(m.b).name;
  const S = await open(c.code, { admin: c.adminKey }, '/t/' + c.code + '/screen', { width: 1280, height: 720 });
  await S.locator('.live-match[aria-label$="' + vs(m1) + '"]').waitFor({ timeout: 10000 });
  await S.locator('.up-next', { hasText: c.who(m2.a).name }).waitFor({ timeout: 5000 });
  await S.locator('.progress-line', { hasText: 'match 1 of 7' }).waitFor({ timeout: 5000 });
  await S.getByText('to open the match').waitFor({ timeout: 15000 });       // nobody's there yet
  // a later match's player: told how many matches come first, and nothing to open
  const L = await open(c.code, { player: c.who(m4.a) }, '/t/' + c.code);
  await L.getByRole('heading', { name: '3 matches before yours' }).waitFor({ timeout: 10000 });
  const links = await L.locator('.bracket a[href*="/m/"]').evaluateAll(as => as.map(a => a.getAttribute('href')));
  if (links.length) throw new Error('a match link before their turn: ' + JSON.stringify(links));
  const L2 = await open(c.code, { player: c.who(m4.a) }, '/t/' + c.code + '/m/' + m4.id);
  await L2.getByRole('heading', { name: 'Not your turn yet' }).waitFor({ timeout: 10000 });
  // nobody else gets the screen, or someone else's match
  const N = await open(c.code, {}, '/t/' + c.code + '/screen');
  await N.getByText('This screen is for the organiser').waitFor({ timeout: 10000 });
  const X = await open(c.code, { player: c.who(m4.b) }, '/t/' + c.code + '/m/' + m1.id);
  await X.getByText('Not your match').waitFor({ timeout: 10000 });
  // the first match is played, CPU on both sides
  const path = '/t/' + c.code + '/m/' + m1.id + '?bot=0.8';
  const P1 = await open(c.code, { player: c.who(m1.a) }, path, { width: 480, height: 330 });
  const P2 = await open(c.code, { player: c.who(m1.b) }, path, { width: 480, height: 330 });
  const t0 = Date.now();
  await until(async () => S.evaluate(() => window.__cc && window.__cc.game.lastFrameAge < 1000 && window.__cc.game.phase === 'play'), 40000, 'the match live on the big screen');
  console.log('   live on the big screen ' + ((Date.now() - t0) / 1000).toFixed(1) + 's after the players opened it');
  await S.locator('.live-match .pill', { hasText: 'Live' }).waitFor({ timeout: 10000 });
  await sleep(1500);
  await S.screenshot({ path: OUT + '/G-live.png' });
  // the bracket, and back
  await S.getByRole('radio', { name: 'Bracket' }).click();
  await S.locator('.bracket').waitFor({ timeout: 3000 });
  await S.getByRole('radio', { name: 'Live match' }).click();
  await S.locator('.live-match').waitFor({ timeout: 3000 });
  // full time: the result stays up a few seconds, then the screen moves on to the next match
  await until(async () => (await match(c.code, m1.id)).status === 'done', 150000, 'the first match finished');
  await S.locator('.live-match .pill', { hasText: 'Full time' }).waitFor({ timeout: 10000 });
  await S.screenshot({ path: OUT + '/G-full-time.png' });
  await S.locator('.live-match[aria-label$="' + vs(m2) + '"]').waitFor({ timeout: 20000 });
  await S.locator('.up-next', { hasText: c.who(m3.a).name }).waitFor({ timeout: 5000 });
  await S.locator('.progress-line', { hasText: 'match 2 of 7' }).waitFor({ timeout: 5000 });
  await L.getByRole('heading', { name: '2 matches before yours' }).waitFor({ timeout: 10000 });
  await S.screenshot({ path: OUT + '/G-next.png' });
  for (const p of [S, L, L2, P1, P2, N, X]) await p.context().close();
});

// ---------------------------------------------------------------- H + I
// The network drops out for 6 seconds without closing anything: the page goes offline and its
// link to the match server goes silent both ways.
async function dropScenario(seat) {
  const c = await cup(NO_LIMITS);
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest }, path);
  await readyBoth(H, G);
  await sleep(2000);
  const D = seat === 0 ? H : G, O = seat === 0 ? G : H, dName = (seat === 0 ? c.host : c.guest).name;
  const sc0 = await engineScore(O), clock0 = await clock(O);
  const t0 = Date.now();
  await D.context().setOffline(true);
  await D.evaluate(() => window.__cc.link.stall(6000));
  // the server gives up on a silent player after 3 seconds: the other player sees the pause
  await O.getByText(dName + ' lost the connection').waitFor({ timeout: 8000 });
  const pausedAfter = ((Date.now() - t0) / 1000).toFixed(1);
  await D.getByText('Reconnecting to the match server').or(D.getByText('Waiting for the match')).first().waitFor({ timeout: 8000 });
  await O.screenshot({ path: OUT + '/' + (seat ? 'right' : 'left') + '-drop-other.png' });
  await D.screenshot({ path: OUT + '/' + (seat ? 'right' : 'left') + '-drop-dropped.png' });
  await sleep(Math.max(0, 6000 - (Date.now() - t0)));
  await D.context().setOffline(false);
  const tBack = Date.now();
  await going(O, 30000, 'the match going again');
  const back = ((Date.now() - tBack) / 1000).toFixed(1);
  await until(() => cc(D, () => window.__cc.game.lastFrameAge < 500), 10000, 'the dropped page receiving again');
  const sc1 = await engineScore(O);
  if (sc1[0] < sc0[0] || sc1[1] < sc0[1]) throw new Error('score went back: ' + sc0 + ' -> ' + sc1);
  if (!((await clock(O)) > clock0)) throw new Error('clock did not go on');
  // the dropped player's buttons still count, on the other screen
  const slot = seat === 0 ? 0 : 2;
  await until(async () => (await lastPress(O, slot)) < -0.5, 4000, 'quiet');
  await D.keyboard.press('ArrowUp');
  await until(async () => (await lastPress(O, slot)) > -0.4, 3000, 'a press after the drop');
  await H.context().close(); await G.context().close();
  return 'paused ' + pausedAfter + 's after the drop, playing again ' + back + 's after the network came back';
}
await scenario('H', 'the right-hand player\'s network drops out: the match pauses, then both carry on', () => dropScenario(1));
await scenario('I', 'the left-hand player\'s network drops out: the same', () => dropScenario(0));

// ---------------------------------------------------------------- J
await scenario('J', 'a dead ball\'s countdown ring and the re-drop show on a player\'s screen', async () => {
  const c = await cup(NO_LIMITS);
  const p2 = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, p2);
  const G = await open(c.code, { player: c.guest }, p2);
  await readyBoth(H, G);
  // nobody presses: the kick-off ball comes to rest, the ring winds down round it, then it drops again
  const warn = await until(() => cc(G, () => { const v = window.__cc.game.debug.view; const b = v && v.balls && v.balls[0]; return b && b.warn > 0.2 ? b.warn : 0; }), 45000, 'the ring on the right-hand player\'s screen');
  await G.screenshot({ path: OUT + '/J-ring.png' });
  await G.getByText('The ball stopped dead').waitFor({ timeout: 15000 });
  await H.getByText('The ball stopped dead').waitFor({ timeout: 5000 });
  await H.context().close(); await G.context().close();
  return 'ring at ' + warn.toFixed(2) + ', re-dropped';
});

// ---------------------------------------------------------------- K
await scenario('K', 'the match server restarts mid-match: the pages come back and it carries on from the saved score', async () => {
  const cmd = process.env.RESTART_MATCH_SERVER;
  if (!cmd) { console.log('   set RESTART_MATCH_SERVER to run this'); return 'skip'; }
  const c = await cup(NO_LIMITS);
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path + '?bot=0.95');
  const G = await open(c.code, { player: c.guest }, path);
  await G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(async () => (await match(c.code, c.m.id)).status === 'live', 15000, 'match live');
  const m1 = await until(async () => { const m = await match(c.code, c.m.id); return m.score[0] + m.score[1] >= 1 ? m : null; }, 90000, 'a goal');
  await sleep(300);
  const t0 = Date.now();
  execSync(cmd, { stdio: 'inherit' });
  await G.getByText('Reconnecting to the match server').or(G.getByText('carries on from')).first().waitFor({ timeout: 15000 });
  await going(G, 30000, 'the match going again');
  const back = ((Date.now() - t0) / 1000).toFixed(1);
  const sc = await engineScore(G);
  if (sc[0] + sc[1] < m1.score[0] + m1.score[1]) throw new Error('carried on from ' + sc + ', saved ' + m1.score);
  check((await match(c.code, c.m.id)).status === 'live', 'not live after the restart');
  await going(H, 5000, 'the left-hand page playing too');
  await G.screenshot({ path: OUT + '/K-after-restart.png' });
  await H.context().close(); await G.context().close();
  return 'saved ' + m1.score.join('–') + ', playing again ' + back + 's after the restart';
});

// ---------------------------------------------------------------- P
await scenario('P', 'peer to peer: connected directly, the organiser watches, the dead-ball ring, the guest and the host reload', async () => {
  const c = await cup({ ...NO_LIMITS, net: 'p2p' });
  check(!c.server, 'not peer to peer');
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest }, path);
  await H.getByText('Connected directly').waitFor({ timeout: 20000 });
  await readyBoth(H, G);
  await until(async () => (await match(c.code, c.m.id)).status === 'live', 15000, 'match live');
  await until(async () => cc(G, () => window.__cc.game.lastFrameAge < 500), 5000, 'guest receiving');
  check(await cc(G, () => window.__cc.transport) === 'p2p', 'not peer to peer on the page');
  // the organiser watches over WebRTC; the viewers' mailboxes need the organiser key
  const S = await open(c.code, { admin: c.adminKey }, path);
  await until(async () => cc(S, () => window.__cc && window.__cc.game.lastFrameAge < 600), 15000, 'organiser receiving frames');
  const sig = '/api/t/' + c.code + '/m/' + c.m.id + '/signal';
  const g1 = await fetch(BASE + sig + '?box=spec:test1234');
  const g2 = await fetch(BASE + sig + '?box=spec:test1234', { headers: { 'x-cc-admin': c.adminKey } });
  const p1 = await fetch(BASE + sig, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'spec:test1234', to: 'host', type: 'offer', sdp: 'x' }) });
  if (g1.status !== 403 || g2.status !== 200 || p1.status !== 403) throw new Error('viewer mailbox not locked: ' + [g1.status, g2.status, p1.status]);
  await S.context().close();
  // a dead ball, put to rest on the turf in the middle on the host: the ring on the guest's screen
  await cc(H, () => { const b = window.__cc.game.debug.balls[0]; b.setTransform({ x: 530 / 80, y: (590 - 19) / 80 }, 0); b.setLinearVelocity({ x: 0, y: 0 }); b.setAngularVelocity(0); });
  await until(() => cc(G, () => { const v = window.__cc.game.debug.view; const b = v && v.balls && v.balls[0]; return b && b.warn > 0.2; }), 12000, 'the ring on the guest\'s screen');
  await G.getByText('The ball stopped dead').waitFor({ timeout: 8000 });
  if ((await cc(H, () => window.__cc.game.stats.out.dead)) < 1) throw new Error('no re-drop on the host');
  // the guest reloads: the host pauses, then both resume
  await G.reload();
  await until(async () => cc(H, () => window.__cc.game.paused), 10000, 'host paused after the guest left');
  await until(async () => cc(H, () => !window.__cc.game.paused), 25000, 'host resumed after the guest came back');
  await until(async () => cc(G, () => window.__cc && window.__cc.game.lastFrameAge < 500), 5000, 'guest receiving again');
  await going(H, 5000, 'host clock running after the resume');
  // the host reloads: the match carries on from the saved score once both are ready again
  // (the guest's page is new since its reload, so it asks the guest too)
  const saved = (await match(c.code, c.m.id)).score;
  await H.reload();
  await H.getByRole('button', { name: 'I\'m ready' }).click({ timeout: 20000 });
  await G.getByRole('button', { name: 'I\'m ready' }).click({ timeout: 20000 });
  await until(async () => (await phase(H)) === 'play', 30000, 'host back and playing');
  const sc = await engineScore(H);
  if (sc[0] + sc[1] < saved[0] + saved[1]) throw new Error('score went back: saved ' + saved + ', host ' + sc);
  if ((await match(c.code, c.m.id)).status !== 'live') throw new Error('match not live after the host reload');
  await H.context().close(); await G.context().close();
}, false);

// ---------------------------------------------------------------- Q
await scenario('Q', 'peer to peer: the guest\'s connection drops for a few seconds, the host pauses, then both carry on', async () => {
  const c = await cup({ ...NO_LIMITS, net: 'p2p' });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest, pcs: true }, path);
  await readyBoth(H, G);
  await sleep(2000);
  const sc0 = await engineScore(H), clock0 = await clock(H);
  const t0 = Date.now();
  await G.context().setOffline(true);
  await G.evaluate(() => window.__pcs.forEach(pc => { try { pc.close(); } catch (e) { } }));
  await until(() => cc(H, () => window.__cc.game.paused), 15000, 'host pauses');
  await H.getByText('lost the connection').waitFor({ timeout: 10000 });
  await sleep(Math.max(0, 6000 - (Date.now() - t0)));
  await G.context().setOffline(false);
  await until(() => cc(H, () => !window.__cc.game.paused), 60000, 'host resumes after the network is back');
  const back = ((Date.now() - t0) / 1000 - 6).toFixed(0);
  await until(() => cc(G, () => window.__cc.game.lastFrameAge < 500), 10000, 'guest receiving again');
  const sc1 = await engineScore(H);
  if (sc1[0] < sc0[0] || sc1[1] < sc0[1]) throw new Error('score went back: ' + sc0 + ' -> ' + sc1);
  if (!((await clock(H)) > clock0)) throw new Error('clock did not go on');
  await until(async () => (await lastPress(H, 2)) < -0.5, 4000, 'quiet');
  await G.keyboard.press('ArrowUp');
  await until(async () => (await lastPress(H, 2)) > -0.4, 2000, 'guest press after the drop');
  await H.context().close(); await G.context().close();
  return 'playing again ' + back + 's after the network came back';
}, false);

// ---------------------------------------------------------------- R
// Found on the droplet (16 October): one player closed their tab mid-match, the organiser went
// back to the lobby and made the draw again, and the new r1m1 opened onto the old match (its
// score and clock), because the match server's room for the old r1m1 was still open.
await scenario('R', 'back to the lobby mid-match and a new draw: the new match starts fresh, not the old one', async () => {
  const c = await cup({ goals: 9, capSec: 90, finalGoals: 9, finalCapSec: 90, modifiers: false });
  const path = '/t/' + c.code + '/m/' + c.m.id;
  const H = await open(c.code, { player: c.host }, path);
  const G = await open(c.code, { player: c.guest }, path);
  await readyBoth(H, G);
  await until(async () => (await clock(H)) > 14, 25000, 'some of the match played');
  const old = await clock(H);           // the room's clock (warm-up and countdown included)
  await G.context().close();                                   // one player closes their tab
  await H.getByText(c.guest.name + ' lost the connection').waitFor({ timeout: 10000 });
  await call('/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'restart' });
  await call('/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'start' });
  const v = await call('/api/t/' + c.code);
  const m = v.matches.find(x => x.id === v.current);
  check(m.id === c.m.id, 'expected the same match id again, got ' + m.id);
  const ps = { [c.host.playerId]: c.host, [c.guest.playerId]: c.guest };
  // the old page (H) stays open, as it did on the droplet; the other player opens the new match
  const other = ps[m.a] === c.host ? ps[m.b] : ps[m.a];
  const G2 = await open(c.code, { player: other }, path);
  await G2.getByRole('button', { name: 'I\'m ready' }).waitFor({ timeout: 15000 });
  // the old page gets the new match too: a ready check of its own (not still ready from the
  // old match), not the old match carrying on
  await H.getByRole('button', { name: 'I\'m ready' }).waitFor({ timeout: 15000 });
  await H.screenshot({ path: OUT + '/R-old-page.png' });
  await readyBoth(H, G2);
  await sleep(1500);
  const t = await clock(G2);
  check(t < old, 'the new room\'s clock is at ' + t.toFixed(1) + ' s, past the old one\'s ' + old.toFixed(1) + ' s: the old match carried on');
  check(String(await engineScore(H)) === '0,0' && String(await engineScore(G2)) === '0,0', 'scores ' + await engineScore(H) + ' / ' + await engineScore(G2));
  const role = await cc(H, () => window.__cc.role);
  return 'the old page moved to the new match as ' + role + ', room clock ' + t.toFixed(1) + ' s (the old one was at ' + old.toFixed(1) + ' s)';
});

console.log('\n' + results.map(r => r.join('  ')).join('\n'));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(results.every(r => r[1] !== 'FAIL') && !errors.length ? 0 : 1);
