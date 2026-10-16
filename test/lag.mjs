// Lag: two players a long way away (by default 75 ms each way plus up to 15 ms of jitter,
// about New Jersey to Buenos Aires). On the match server both players are that far from
// it; peer to peer (NET=p2p), from each other. Measures, for presses made by each player:
//   own        press to the man kicking on the presser's own screen
//   seen       press to the other player's screen showing the kick or jump
//   lean       the lean a jump went in with, against the lean on the presser's screen
// and checks that with prediction both players see their own presses at once and jumps
// go the way the presser saw. With equalDelay (NET=p2p FAIR=1) both wait the round trip.
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/lag.mjs [one-way ms=75] [jitter ms=15] [presses=12]     (BASE, CHROME, NET=p2p, FAIR=1,
//                                      HEALTH=<the match server's /health, from this machine>)
//   NEAR=5 node test/lag.mjs 75 15    on the match server: the left player 5 ms from it, the right one
//                                      75 ms (a server in New York, players in New Jersey and Argentina)
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const FAIR = process.env.FAIR === '1', NET = process.env.NET === 'p2p' || FAIR ? 'p2p' : 'server';
const HEALTH = process.env.HEALTH || 'http://127.0.0.1:' + (process.env.MATCH_PORT || 3001) + '/health';
const LAG = +(process.argv[2] || 75), JIT = +(process.argv[3] || 15), N = +(process.argv[4] || 12);
const NEAR = process.env.NEAR != null ? +process.env.NEAR : null;       // the left player's own distance
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(path, body) {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
const errors = [];
let failed = false;
try {
  const { code, adminKey } = await call('/api/t', { name: 'Lag' });
  await call('/api/t/' + code + '/admin', { key: adminKey, action: 'rules', rules: { goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false, equalDelay: FAIR, net: NET } });
  const ps = [];
  for (const n of ['Nico', 'Sofi']) ps.push(await call('/api/t/' + code + '/join', { name: n }));
  await call('/api/t/' + code + '/admin', { key: adminKey, action: 'start' });
  const m = (await call('/api/t/' + code)).matches[0];
  const server = m.rules.net === 'server';
  const open = async (p, lag = LAG, jit = JIT) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 620 } });
    await ctx.addInitScript(([c, s]) => localStorage.setItem('cc:player:' + c, JSON.stringify(s)), [code, { token: p.token, playerId: p.playerId }]);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/t/' + code + '/m/' + m.id + '?lag=' + lag + '&jitter=' + jit);
    return page;
  };
  const who = id => ps.find(p => p.playerId === id);
  const H = NEAR != null ? await open(who(m.a), NEAR, Math.min(JIT, 2)) : await open(who(m.a)), G = await open(who(m.b));
  await H.getByRole('button', { name: "I'm ready" }).click();
  await G.getByRole('button', { name: "I'm ready" }).click();
  for (let i = 0; i < 100 && !(await H.evaluate(() => window.__cc && window.__cc.game.phase === 'play')); i++) await sleep(200);
  await sleep(4000);       // the round trip is measured, the guest's copy settles

  // press Space in a page; resolves when that man shows his kick on that screen
  const press = (page, slot) => page.evaluate(slot => new Promise(res => {
    const g = window.__cc.game, man = () => g.debug.view && g.debug.view.bySlot && g.debug.view.bySlot[slot];
    const t0 = Date.now(), seen = man() ? Math.atan2(Math.sin(man().torso.angle), Math.cos(man().torso.angle)) : null;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    const tick = () => {
      const c = man();
      if (c && c.kickT > 0) return res({ t0, at: Date.now(), seen });
      if (Date.now() - t0 > 2000) return res({ t0, at: null, seen });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), slot);
  // the other page: when that man's kick, or his jump, shows
  const watch = (page, slot) => page.evaluate(slot => new Promise(res => {
    const g = window.__cc.game, t0 = Date.now(), man = () => g.debug.view && g.debug.view.bySlot && g.debug.view.bySlot[slot];
    const y0 = man() ? man().torso.position.y : null;
    const tick = () => {
      const c = man();
      if (c && (c.kickT > 0 || (y0 != null && c.torso.position.y < y0 - 18))) return res(Date.now());
      if (Date.now() - t0 > 2500) return res(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), slot);
  const out = { hostOwn: [], guestOwn: [], guestSeesHost: [], hostSeesGuest: [], lean: [] };
  for (let i = 0; i < N; i++) {
    const w1 = watch(G, 0); await sleep(30);
    const h = await press(H, 0), g1 = await w1;
    if (h.at) out.hostOwn.push(h.at - h.t0);
    if (g1) out.guestSeesHost.push(g1 - h.t0);
    await sleep(800);
    const before = await H.evaluate(() => { const r = window.__cc.game.debug.lastGuestPress; return r && r[2] ? r[2].seq : -1; });
    const w2 = watch(H, 2); await sleep(30);
    const r = await press(G, 2), h2 = await w2;
    if (r.at) out.guestOwn.push(r.at - r.t0);
    if (h2) out.hostSeesGuest.push(h2 - r.t0);
    await sleep(300);
    const lg = await H.evaluate(() => { const r = window.__cc.game.debug.lastGuestPress; return r && r[2] ? r[2] : null; });
    if (lg && lg.seq !== before && r.seen != null) out.lean.push(Math.abs(Math.atan2(Math.sin(lg.lean - r.seen), Math.cos(lg.lean - r.seen))) * 57.3);
    await sleep(700);
  }
  const pred = await G.evaluate(() => window.__cc.game.debug.pred);
  const predL = server ? await H.evaluate(() => window.__cc.game.debug.pred) : null;
  const rtt = Math.round(await H.evaluate(() => window.__cc.link.rtt));
  // on the match server: the leans it took from the players (it uses its own when one is too far off)
  let leans = null;
  if (server) {
    try { const h = await (await fetch(HEALTH)).json(); const r = h.matches && h.matches.find(x => x.key === code + ':' + m.id); leans = r ? r.leans : null; } catch { /* not on this machine */ }
  }
  const med = a => a.length ? Math.round(a.slice().sort((x, y) => x - y)[a.length >> 1]) : null;
  const line = (label, a, unit = 'ms') => console.log(label.padEnd(36) + 'median ' + med(a) + ' ' + unit + ', worst ' + (a.length ? Math.round(Math.max(...a)) : '-') + ' ' + unit + ' (' + a.length + ' presses)');
  const [L, R] = server ? ['left', 'right'] : ['host', 'guest'];
  const rttR = Math.round(await G.evaluate(() => window.__cc.link.rtt));
  console.log((server ? 'Match server, ' + (NEAR != null ? 'left player ' + NEAR + ' ms from it, right player ' : 'both players ') : FAIR ? 'Peer to peer, equal delay, ' : 'Peer to peer, prediction, ') + LAG + ' ms each way + up to ' + JIT + ' ms jitter: round trip ' + rtt + ' ms' + (server ? (NEAR != null ? ' and ' + rttR + ' ms' : '') + ' to the server, input delay ' + m.rules.inputDelay + ' ticks' : ''));
  line(L + ' presses, ' + L + ' screen', out.hostOwn);
  line(R + ' presses, ' + R + ' screen', out.guestOwn);
  line(L + ' presses, ' + R + ' screen', out.guestSeesHost);
  line(R + ' presses, ' + L + ' screen', out.hostSeesGuest);
  if (out.lean.length) line('guest jump lean vs what guest saw', out.lean, 'deg');
  if (leans) console.log('leans the server took from the players: ' + leans.accepted + ', its own: ' + leans.own);
  const copyLine = (who, p) => console.log(who + ' copy: ' + p.same + ' full states matched, ' + p.reconciles + ' re-runs of ' + p.resimAvg + ' ticks on average, ' + p.late + ' late presses, ' + p.costMs + ' ms a re-run');
  if (predL) copyLine(L, predL);
  if (!FAIR) copyLine(R, pred);
  const check = (ok, what) => { if (!ok) { failed = true; console.log('FAIL ' + what); } };
  check(errors.length === 0, 'page errors: ' + errors.slice(0, 3).join(' | '));
  check(out.hostOwn.length >= N - 1 && out.guestOwn.length >= N - 1, 'presses that never showed');
  if (server) {
    // an input delay of a couple of ticks is there on purpose: own presses show that much later
    const allow = 60 + (m.rules.inputDelay || 0) * 17;
    check(med(out.hostOwn) < allow && med(out.guestOwn) < allow, 'own presses should show within a few frames');
    check(!leans || leans.own <= Math.max(2, (leans.accepted + leans.own) * 0.1), 'jumps should go the way the player saw');
    check(predL.on && pred.on && predL.late + pred.late <= Math.ceil(N / 2), 'the copies should run far enough ahead for presses to arrive in time');
  } else if (!FAIR) {
    check(med(out.hostOwn) < 60 && med(out.guestOwn) < 60, 'own presses should show within a few frames');
    check(med(out.lean) <= 3, 'the guest\'s jumps should go the way the guest saw');
    check(pred.on && pred.late <= Math.ceil(N / 4), 'the copy should run far enough ahead for presses to arrive in time');
  } else {
    check(med(out.hostOwn) > rtt * 0.8 && med(out.guestOwn) > rtt * 0.8, 'with equal delay both should wait about the round trip');
  }
} catch (e) { failed = true; console.log('FAIL ' + (e && e.stack || e)); }
await browser.close();
console.log(failed ? 'lag test failed' : 'lag test passed');
process.exit(failed ? 1 : 0);
