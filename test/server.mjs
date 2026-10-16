// The match server with two pretend players, all in Node: no browser, no app. Each
// pretend player is what a match page runs (the WebSocket link and the prediction, with
// the CPU pressing through it like a person), and a fake app collects the results.
// One player is next to the server (a few ms away), the other far (by default 75 ms each
// way plus up to 15 ms of jitter, about New Jersey to Buenos Aires).
//
// For every ball and crazy round it checks that both players predict (their copies match
// the server most of the time, their own men barely slide, presses arrive in time and go
// in on the tick they were stamped with), then plays two whole matches to the end and
// checks the results reach the app. Then the awkward moments: a player whose network goes
// silent (the match pauses, and carries on once they're back), and the match server
// restarting mid-match (it carries on from the saved score).
//
//   node test/server.mjs              (SECONDS=8 per round, LAG=75, JITTER=15, NEAR=4, DELAY=2 input delay;
//                                      ONLY=football,silent,restart runs just those)
import { spawn } from 'child_process';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { signTicket } from '../lib/ticket.ts';
import { createServerLink } from '../lib/net/serverLink.js';
import { createPredictor } from '../lib/engine/predict.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECONDS = Number(process.env.SECONDS || 8), LAG = Number(process.env.LAG || 75), JITTER = Number(process.env.JITTER || 15);
const NEAR = Number(process.env.NEAR || 4), DELAY = Number(process.env.DELAY ?? 2);
const SECRET = 'test-secret-' + Math.random().toString(36).slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROUNDS = [
  ['football', { ball: 'normal' }],
  ['beach ball', { ball: 'beach' }],
  ['rugby ball', { ball: 'rugby' }],
  ['American football', { ball: 'american' }],
  ['baseball', { ball: 'baseball' }],
  ['giant ball', { ball: 'giant' }],
  ['tiny ball', { ball: 'tiny' }],
  ['balloon', { ball: 'balloon' }],
  ['moon gravity', { gravity: 0.62 }],
  ['heavy gravity', { gravity: 1.35 }],
  ['ice pitch', { slippery: true }],
  ['bouncy pitch', { bouncy: true }],
  ['two balls', { twoBalls: true }],
  ['big heads', { bigHeads: true }],
  ['long legs', { longLegs: true }],
  ['big goals', { goalScale: 1.25 }],
  ['small goals', { goalScale: 0.8 }],
  ['everything at once', { ball: 'american', gravity: 0.62, slippery: true, twoBalls: true, bigHeads: true, longLegs: true, goalScale: 1.25 }]
].filter(([n]) => !process.env.ONLY || process.env.ONLY.split(',').some(x => n.includes(x)));
const want = name => !process.env.ONLY || process.env.ONLY.split(',').some(x => name.includes(x));

// ---- a fake app: it only takes the match server's reports ----
const reports = [];
const app = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const m = /^\/api\/t\/([^/]+)\/m\/([^/]+)\/report$/.exec(req.url || '');
    if (!m || req.headers['x-cc-server'] !== SECRET) { res.writeHead(403); res.end('{"error":"no"}'); return; }
    reports.push({ code: m[1], match: m[2], ...JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
});
await new Promise(r => app.listen(0, '127.0.0.1', r));
const appPort = app.address().port;

// ---- the match server ----
const port = 3950 + Math.floor(Math.random() * 40);
let srvLog = '';
async function startServer() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], {
    cwd: ROOT, env: { ...process.env, MATCH_SECRET: SECRET, MATCH_PORT: String(port), MATCH_HOST: '127.0.0.1', APP_URL: 'http://127.0.0.1:' + appPort, MATCH_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => { srvLog += d; if (process.env.VERBOSE) process.stdout.write('[server] ' + d); });
  child.stderr.on('data', d => { srvLog += d; process.stdout.write('[server] ' + d); });
  for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) break; } catch { } await sleep(100); }
  return child;
}
let srv = await startServer();
const URL_WS = 'ws://127.0.0.1:' + port + '/ws';

const players = [{ id: 'pa', name: 'Nico', color: 'orange', flag: 'us' }, { id: 'pb', name: 'Sofi', color: 'teal', flag: 'ar' }];
function ticket(match, seat, o = {}) {
  return signTicket({ c: 'TEST', m: match, s: seat, x: Date.now() + 600000, g: o.gen || 0, a: players[0], b: players[1],
    r: { goals: o.goals || 99, capSec: o.capSec || 0, modifiers: !!o.modifiers, inputDelay: DELAY }, sc: o.score || [0, 0], st: o.status || 'ready', lb: 'Test',
    ...(o.force ? { fr: o.force } : {}) }, SECRET);
}

// a pretend player: what MatchStage does with the link and the engine, without the drawing
function pretend(match, seat, o) {
  const errors = [];
  const st = { open: false, lobby: null, events: [], result: null, denied: null, welcome: null };
  const pred = createPredictor({ team: seat, inputDelay: DELAY, players, bot: o.bot != null ? o.bot : 0.85,
    onPress: p => link.send({ k: 'press', s: p.slots, n: p.n, q: p.seq, l: p.leans, v: p.v }) });
  const link = createServerLink({
    getTicket: async () => ({ ticket: ticket(match, seat, o), url: URL_WS }),
    fakeLag: { ms: seat === 1 ? o.lag : o.near, jitter: seat === 1 ? o.jitter : 2 },
    handlers: {
      onOpen: w => { st.open = true; st.welcome = w; if (o.ready !== false) link.send({ k: 'ready' }); },
      onClose: () => { st.open = false; },
      onDenied: why => { st.denied = why; },
      log: process.env.LINKLOG ? s => console.log("[link " + seat + "] " + s) : undefined,
      onState: buf => pred.pushFullState(buf),
      onRtt: ms => pred.setRtt(ms),
      onCtl: msg => {
        if (msg.k === 'sync') pred.reset();
        else if (msg.k === 'lobby') st.lobby = msg;
        else if (msg.k === 'pa') pred.pressAck(msg.q, msg.sl);
        else if (msg.k === 'op') pred.otherPress(msg.s, msg.n, msg.l, msg.r);
        else if (msg.k === 'ev') st.events.push(msg.ev);
        else if (msg.k === 'result') st.result = msg;
      }
    }
  });
  let last = performance.now();
  const iv = setInterval(() => {
    const now = performance.now();
    try { pred.update(Math.min(0.1, (now - last) / 1000)); } catch (e) { errors.push(e.stack || String(e)); }
    last = now;
  }, 16);
  return { pred, link, st, errors, stop() { clearInterval(iv); link.close(); } };
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  throw new Error('timed out: ' + what);
}
const health = async () => (await fetch('http://127.0.0.1:' + port + '/health')).json();

const results = [];
let n = 0;
for (const [name, force] of ROUNDS) {
  const match = 'r' + (++n);
  const o = { force, lag: LAG, jitter: JITTER, near: NEAR };
  const A = pretend(match, 0, o), B = pretend(match, 1, o);
  const problems = [];
  try {
    await until(() => A.st.events.some(e => e.k === 'kickoff') && B.st.events.some(e => e.k === 'kickoff'), 15000, 'kick-off');
    await sleep(SECONDS * 1000);
    const h = (await health()).matches.find(x => x.key === 'TEST:' + match);
    const stats = [A.pred.stats, B.pred.stats];
    const line = stats.map((p, i) => {
      const checks = p.same + Object.values(p.why).reduce((a, b) => a + b, 0), share = checks ? p.same / checks : 0;
      const who = i ? 'far' : 'near';
      if (!p.on) problems.push(who + ' never started predicting');
      if (share < 0.5) problems.push(who + ' matched the server only ' + Math.round(share * 100) + '% of the time');
      if (p.ownCorrP50 > 6 || p.ownCorrP90 > 60) problems.push(who + '\'s own men slid ' + p.ownCorrP50 + '/' + p.ownCorrP90 + ' px');
      if (p.late > Math.max(3, p.acks * 0.15)) problems.push(who + ': ' + p.late + ' of ' + p.acks + ' presses late');
      return who + ' ' + Math.round(share * 100) + '% of ' + checks + ' (' + p.reconciles + ' re-runs, ' + p.costMs + ' ms), own ' + p.ownCorrP50 + '/' + p.ownCorrP90 + ' px, other ' + p.oppCorrP50 + '/' + p.oppCorrP90 + ' px, ' + p.acks + ' presses ' + p.late + ' late, ahead ' + p.aheadMs + ' ms, reveals ' + p.reveals + ' (' + p.played + ' played)' + (process.env.WHY ? ' why ' + JSON.stringify(p.why) + ' by ' + JSON.stringify(p.recBy) + ' rebuilt ' + p.rebuilt : '');
    });
    // presses go in on the tick they were stamped with, with the lean the player saw
    if (h.leans.own > Math.max(2, (h.leans.accepted + h.leans.own) * 0.1)) problems.push('the server used its own lean for ' + h.leans.own + ' of ' + (h.leans.accepted + h.leans.own) + ' presses');
    const errs = A.errors.concat(B.errors);
    if (errs.length) problems.push('errors: ' + errs[0].split('\n').slice(0, 3).join(' | '));
    results.push([problems.length ? 'FAIL' : 'pass', name, line.join(' · ') + ' · leans ' + JSON.stringify(h.leans) + (problems.length ? ' · ' + problems.join('; ') : '')]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
  A.stop(); B.stop();
  console.log(results[results.length - 1].join('  '));
}

// two whole matches to the end: first to 2 with a 40-second limit (then golden goal)
for (let k = 0; k < (want('whole') ? 2 : 0); k++) {
  const match = 'full' + k;
  const o = { goals: 2, capSec: 40, modifiers: true, lag: LAG, jitter: JITTER, near: NEAR };
  const A = pretend(match, 0, o), B = pretend(match, 1, o);
  const t0 = Date.now();
  try {
    await until(() => A.st.events.some(e => e.k === 'end') && B.st.events.some(e => e.k === 'end'), 150000, 'full time');
    await until(() => A.st.result && B.st.result, 15000, 'the result saved');
    const end = A.st.events.find(e => e.k === 'end');
    const mine = reports.filter(r => r.match === match);
    const final = mine.find(r => r.kind === 'final');
    const problems = [];
    if (!mine.some(r => r.kind === 'start')) problems.push('no kick-off report');
    if (!final) problems.push('no final report');
    else if (final.score.join('-') !== end.score.join('-') || final.winner !== (end.winner === 0 ? 'a' : 'b')) problems.push('final report ' + JSON.stringify(final) + ' does not match the end ' + JSON.stringify(end));
    if (!A.st.result.saved || !B.st.result.saved) problems.push('players not told the result was saved');
    const goals = A.st.events.filter(e => e.k === 'goal').length;
    if (goals !== end.score[0] + end.score[1]) problems.push(goals + ' goal events for a score of ' + end.score.join('-'));
    const errs = A.errors.concat(B.errors);
    if (errs.length) problems.push('errors: ' + errs[0].split('\n')[0]);
    results.push([problems.length ? 'FAIL' : 'pass', 'whole match ' + (k + 1), end.score.join('-') + ' (' + end.reason + ') in ' + Math.round((Date.now() - t0) / 1000) + ' s, ' + mine.length + ' reports' + (problems.length ? ' · ' + problems.join('; ') : '')]);
  } catch (e) {
    results.push(['FAIL', 'whole match ' + (k + 1), e.message]);
  }
  A.stop(); B.stop();
  console.log(results[results.length - 1].join('  '));
}

// health: the full list only for this machine (the deploy script); /ws/health, which goes
// through Caddy, only says the server is up
{
  const full = await health(), pub = await (await fetch('http://127.0.0.1:' + port + '/ws/health')).json();
  const problems = [];
  if (!Array.isArray(full.matches)) problems.push('/health has no match list');
  if (!pub.ok || 'matches' in pub) problems.push('/ws/health lists the matches');
  results.push([problems.length ? 'FAIL' : 'pass', 'health', problems.join('; ') || 'match list only on /health; a tick of the last matches took ' + full.tickMs + ' ms, the server uses ' + full.memMB + ' MB']);
  console.log(results[results.length - 1].join('  '));
}

const room = async match => (await health()).matches.find(x => x.key === 'TEST:' + match);

// a player whose network goes silent without closing anything: the server gives up on them
// after 3 seconds and pauses; their page notices and comes back by itself; the match goes on
if (want('silent')) {
  const match = 'silent';
  const o = { lag: LAG, jitter: JITTER, near: NEAR };
  const A = pretend(match, 0, o), B = pretend(match, 1, o);
  try {
    await until(() => A.st.events.some(e => e.k === 'kickoff'), 15000, 'kick-off');
    await sleep(1500);
    const t0 = Date.now();
    B.link.stall(6000);
    await until(async () => (await room(match))?.paused, 8000, 'the match to pause');
    const pausedAfter = Date.now() - t0;
    await until(() => A.st.lobby && A.st.lobby.paused, 3000, 'the other player told');
    await until(async () => { const r = await room(match); return r && !r.paused && r.seats[1]; }, 15000, 'the silent player back and the match going again');
    const backAfter = Date.now() - t0 - 6000;
    const tk = (await room(match)).ticks;
    await sleep(1000);
    const going = (await room(match)).ticks - tk;
    const problems = [];
    if (pausedAfter > 4500) problems.push('paused only after ' + pausedAfter + ' ms');
    if (going < 40) problems.push('only ' + going + ' ticks in the second after');
    if (A.errors.length || B.errors.length) problems.push('errors: ' + A.errors.concat(B.errors)[0].split('\n')[0]);
    results.push([problems.length ? 'FAIL' : 'pass', 'a silent player', 'paused ' + (pausedAfter / 1000).toFixed(1) + ' s after they went quiet, playing again ' + (backAfter / 1000).toFixed(1) + ' s after they were back' + (problems.length ? ' · ' + problems.join('; ') : '')]);
  } catch (e) {
    results.push(['FAIL', 'a silent player', e.message]);
  }
  A.stop(); B.stop();
  console.log(results[results.length - 1].join('  '));
}

// the match server restarts mid-match (a deploy with --now, a crash): the pages come back with
// new tickets, which carry the saved score, and the match carries on from it
if (want('restart')) {
  const match = 'restart';
  const o = { goals: 9, lag: LAG, jitter: JITTER, near: NEAR };
  const A = pretend(match, 0, o), B = pretend(match, 1, o);
  try {
    await until(() => A.st.events.some(e => e.k === 'kickoff'), 15000, 'kick-off');
    await until(() => reports.some(r => r.match === match && r.kind === 'score'), 90000, 'a goal');
    const saved = reports.filter(r => r.match === match && r.kind === 'score').pop().score;
    o.status = 'live'; o.score = saved;                  // what the app's bracket now says
    const t0 = Date.now();
    srv.kill('SIGTERM');
    await new Promise(r => srv.once('exit', r));
    await sleep(1500);                                   // systemd waits a second before starting it again
    srv = await startServer();
    let carry = null;
    await until(() => { if (A.st.lobby && A.st.lobby.carryOn) carry = A.st.lobby.carryOn; return A.st.open && B.st.open; }, 20000, 'both back');
    await until(async () => { const r = await room(match); return r && r.started && !r.paused; }, 10000, 'the match going again');
    const backAfter = Date.now() - t0;
    const r1 = await room(match);
    const problems = [];
    if (r1.score.join('-') !== saved.join('-') && r1.score[0] + r1.score[1] <= saved[0] + saved[1]) problems.push('carried on from ' + r1.score.join('-') + ', saved ' + saved.join('-'));
    if (carry && carry.join('-') !== saved.join('-')) problems.push('told the players ' + carry.join('-'));
    // the next goal still reaches the app
    const before = reports.length;
    await until(() => reports.slice(before).some(r => r.match === match && r.kind === 'score' && r.score[0] + r.score[1] > saved[0] + saved[1]), 90000, 'a goal after the restart');
    const after = reports.slice(before).filter(r => r.match === match && r.kind === 'score').pop().score;
    if (A.errors.length || B.errors.length) problems.push('errors: ' + A.errors.concat(B.errors)[0].split('\n')[0]);
    results.push([problems.length ? 'FAIL' : 'pass', 'the match server restarting', 'saved ' + saved.join('-') + ', playing again ' + (backAfter / 1000).toFixed(1) + ' s after the restart, next goal reported ' + after.join('-') + (problems.length ? ' · ' + problems.join('; ') : '')]);
  } catch (e) {
    results.push(['FAIL', 'the match server restarting', e.message]);
  }
  A.stop(); B.stop();
  console.log(results[results.length - 1].join('  '));
}

// viewers: anyone with the cup's link watches the match on now. A viewer is a seat of -1 on
// the ticket: they get the lobby messages and the 30-a-second frames, they are never a player,
// and a room takes only so many of them (MAX_VIEWERS, here 2)
function viewer(match, url = URL_WS) {
  const st = { open: false, welcome: null, lobby: null, denied: null, frames: 0, bytes: 0 };
  const link = createServerLink({
    getTicket: async () => ({ ticket: ticket(match, -1), url }),
    handlers: {
      onOpen: w => { st.open = true; st.welcome = w; },
      onClose: () => { st.open = false; },
      onDenied: why => { st.denied = why; },
      onState: buf => { st.frames++; st.bytes += buf.byteLength || 0; },
      onCtl: msg => { if (msg.k === 'lobby') st.lobby = msg; }
    }
  });
  return { st, link, stop() { link.close(); } };
}
if (want('viewers')) {
  const match = 'viewers';
  const o = { lag: LAG, jitter: JITTER, near: NEAR };
  const A = pretend(match, 0, o), B = pretend(match, 1, o);
  const views = [];
  const problems = [];
  let fps = [], kb = 0, cap = '';
  try {
    await until(() => A.st.events.some(e => e.k === 'kickoff'), 15000, 'kick-off');
    for (let i = 0; i < 3; i++) views.push(viewer(match));
    await until(() => views.every(v => v.st.open), 5000, 'the viewers in');
    const f0 = views.map(v => v.st.frames), b0 = views.map(v => v.st.bytes);
    await sleep(3000);
    fps = views.map((v, i) => (v.st.frames - f0[i]) / 3);
    kb = Math.round(views.map((v, i) => v.st.bytes - b0[i]).reduce((a, b) => a + b, 0) / views.length / 3 / 100) / 10;
    const r = await room(match);
    if (!views.every(v => v.st.welcome && v.st.welcome.seat === -1)) problems.push('a viewer was not welcomed as a viewer');
    if (fps.some(x => x < 20)) problems.push('a viewer got only ' + Math.min(...fps).toFixed(0) + ' frames a second');
    if (!r || r.viewers !== 3) problems.push('the room counts ' + (r && r.viewers) + ' viewers, not 3');
    if (!r || !r.seats[0] || !r.seats[1]) problems.push('the players lost their seats');
    if (!views.every(v => v.st.lobby && v.st.lobby.viewers >= 1)) problems.push('a viewer was not told about the viewers');
    // a viewer pressing or "readying" does nothing
    const ticks0 = r.ticks;
    views[0].link.send({ k: 'press', s: [0, 1, 2, 3], n: 1, q: 1, l: [0, 0, 0, 0] });
    views[0].link.send({ k: 'ready' });
    await sleep(500);
    if ((await room(match)).ticks <= ticks0) problems.push('the match stopped');
    // one leaves: the count follows
    views[2].stop();
    await until(async () => (await room(match)).viewers === 2, 5000, 'the count to drop to 2');
    if (A.errors.length || B.errors.length) problems.push('errors: ' + A.errors.concat(B.errors)[0].split('\n')[0]);
  } catch (e) {
    problems.push(e.message);
  }
  results.push([problems.length ? 'FAIL' : 'pass', 'viewers', '3 viewers each got ' + fps.map(x => x.toFixed(0)).join('/') + ' frames a second (' + kb + ' KB/s each), counted in the room, never players' + (problems.length ? ' · ' + problems.join('; ') : '')]);
  console.log(results[results.length - 1].join('  '));
  A.stop(); B.stop(); for (const v of views) v.stop();

  // a room that takes two viewers: the third is turned away, not left hanging
  const port2 = port + 41;
  const small = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], {
    cwd: ROOT, env: { ...process.env, MATCH_SECRET: SECRET, MATCH_PORT: String(port2), MATCH_HOST: '127.0.0.1', APP_URL: 'http://127.0.0.1:' + appPort, MATCH_TEST: '1', MAX_VIEWERS: '2' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const vs = [];
  const problems2 = [];
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:' + port2 + '/health'); if (r.ok) break; } catch { } await sleep(100); }
    const url2 = 'ws://127.0.0.1:' + port2 + '/ws';
    vs.push(viewer('capped', url2), viewer('capped', url2));
    await until(() => vs.every(v => v.st.open), 5000, 'two viewers in');
    vs.push(viewer('capped', url2));
    await until(() => vs[2].st.denied, 5000, 'the third viewer to be turned away');
    if (vs[2].st.denied !== 'full') problems2.push('the third was told "' + vs[2].st.denied + '"');
    const h = await (await fetch('http://127.0.0.1:' + port2 + '/health')).json();
    const rr = (h.matches || []).find(x => x.key === 'TEST:capped');
    if (!rr || rr.viewers !== 2) problems2.push('the room counts ' + (rr && rr.viewers) + ' viewers, not 2');
    if (!vs[0].st.open || !vs[1].st.open) problems2.push('the first two were dropped');
  } catch (e) {
    problems2.push(e.message);
  }
  results.push([problems2.length ? 'FAIL' : 'pass', 'the viewer limit', 'with room for 2, the third was turned away as "full"' + (problems2.length ? ' · ' + problems2.join('; ') : '')]);
  console.log(results[results.length - 1].join('  '));
  for (const v of vs) v.stop();
  small.kill('SIGTERM');
}

srv.kill('SIGTERM');
app.close();
const failed = results.filter(r => r[0] !== 'pass').length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
if (/tick failed|Error/.test(srvLog)) console.log('server log has errors:\n' + srvLog.split('\n').filter(l => /tick failed|Error/.test(l)).slice(0, 5).join('\n'));
process.exit(failed ? 1 : 0);
