// Every API route against a running server: good input, bad input, who may do
// what, and many requests at once. Works with either store (memory or Redis), with or
// without a match server.
//
//   npm run build && npm start
//   node test/api.mjs                  (BASE=http://localhost:3000; MATCH_SECRET=<the site's> also
//                                       checks the tickets' signatures and the match server's reports)
//
// Exits non-zero on the first failed check of each group and lists them all at the end.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:3000';
const SECRET = process.env.MATCH_SECRET || '';
const results = [];
const DEFAULTS = { goals: 3, capSec: 90, finalGoals: 5, finalCapSec: 150, modifiers: true, equalDelay: false, net: 'server', inputDelay: 2 };

async function req(path, body, headers) {
  const r = await fetch(BASE + path, body !== undefined
    ? { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }
    : { headers: headers || {} });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, j, text, headers: r.headers };
}
const ok = async (path, body, headers) => {
  const r = await req(path, body, headers);
  assert.equal(r.status, 200, path + ' -> ' + r.status + ' ' + r.text);
  return r.j;
};
const err = async (status, path, body, headers) => {
  const r = await req(path, body, headers);
  assert.equal(r.status, status, path + ' expected ' + status + ', got ' + r.status + ' ' + r.text);
  assert.ok(r.j && typeof r.j.error === 'string' && r.j.error.length, 'error message for ' + path);
  return r.j.error;
};
async function group(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['pass', name, ((Date.now() - t) / 1000).toFixed(1) + 's']); }
  catch (e) { results.push(['FAIL', name, e.message]); }
  console.log(results[results.length - 1].join('  '));
}
async function cup(n, name = 'API Cup') {
  const { code, adminKey } = await ok('/api/t', { name });
  const players = [];
  for (let i = 0; i < n; i++) players.push({ name: 'P' + (i + 1), ...(await ok('/api/t/' + code + '/join', { name: 'P' + (i + 1), flag: 'se', color: 'teal' })) });
  return { code, adminKey, players, admin: (action, extra) => req('/api/t/' + code + '/admin', { key: adminKey, action, ...extra }) };
}
const view = (code, q = '') => ok('/api/t/' + code + q);
const tokenOf = (c, id) => c.players.find(p => p.playerId === id).token;

await group('create a cup: name cleaned, code and key returned', async () => {
  const a = await ok('/api/t', { name: '  <b>Office</b>\u0007 Cup  ' });
  assert.match(a.code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.ok(a.adminKey.length >= 20);
  const v = await view(a.code);
  assert.equal(v.name, 'bOffice/b Cup');
  assert.equal(v.status, 'lobby');
  assert.deepEqual(v.rules, DEFAULTS);
  const b = await ok('/api/t', { name: 'x'.repeat(60) });
  assert.equal((await view(b.code)).name.length, 18);
  const c = await ok('/api/t', {});
  assert.equal((await view(c.code)).name, 'The Coterie Cup');
  const d = await ok('/api/t', 'not json');
  assert.equal((await view(d.code)).name, 'The Coterie Cup');
});

await group('reading a cup: lowercase codes work, unknown codes are 404, no secrets leak', async () => {
  const c = await cup(2);
  const r = await req('/api/t/' + c.code.toLowerCase());
  assert.equal(r.status, 200);
  assert.ok(!/tokenHash|adminKeyHash/.test(r.text), 'hashes in the public view');
  assert.ok(!r.text.includes(c.players[0].token), 'a token in the public view');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(typeof r.j.now === 'number' && Math.abs(r.j.now - Date.now()) < 60000);
  assert.equal(r.j.you, null);
  assert.equal(typeof r.j.matchServer, 'boolean');
  assert.equal(r.j.current, null);
  assert.deepEqual(r.j.queue, []);
  await err(404, '/api/t/ZZZZZ');
  await err(404, '/api/t/' + c.code + 'X');
});

await group('joining: validation, duplicate names, editing your entry, online', async () => {
  const { code } = await ok('/api/t', { name: 'Join' });
  await err(400, '/api/t/' + code + '/join', { name: '   ' });
  await err(400, '/api/t/' + code + '/join', {});
  const a = await ok('/api/t/' + code + '/join', { name: 'Ana', flag: 'nope', color: 'mauve' });
  const b = await ok('/api/t/' + code + '/join', { name: 'ana', flag: 'ar', color: 'red' });
  let v = await view(code);
  const pa = v.players.find(p => p.id === a.playerId), pb = v.players.find(p => p.id === b.playerId);
  assert.equal(pa.flag, '');
  assert.equal(pa.color, 'orange');
  assert.equal(pb.name, 'ana 2');
  // editing keeps the same player
  const a2 = await ok('/api/t/' + code + '/join', { name: 'Ana María', flag: 'es', color: 'green', token: a.token });
  assert.equal(a2.playerId, a.playerId);
  v = await view(code, '?me=' + encodeURIComponent(a.token));
  assert.equal(v.players.length, 2);
  assert.equal(v.you, a.playerId);
  assert.equal(v.online[a.playerId], true);
  assert.deepEqual(v.players.find(p => p.id === a.playerId), { id: a.playerId, name: 'Ana María', flag: 'es', color: 'green' });
  // a wrong token joins as someone new
  const c = await ok('/api/t/' + code + '/join', { name: 'Cy', token: 'made-up' });
  assert.notEqual(c.playerId, a.playerId);
  await err(404, '/api/t/NOPE2/join', { name: 'Ana' });
});

await group('a cup holds 64 players at most', async () => {
  const { code } = await ok('/api/t', { name: 'Full' });
  for (let i = 0; i < 64; i += 8) await Promise.all(Array.from({ length: 8 }, (_, k) => ok('/api/t/' + code + '/join', { name: 'N' + (i + k) })));
  assert.equal((await view(code)).players.length, 64);
  assert.match(await err(409, '/api/t/' + code + '/join', { name: 'One too many' }), /full/);
});

await group('16 people joining at the same moment all get in', async () => {
  const { code } = await ok('/api/t', { name: 'Rush' });
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => req('/api/t/' + code + '/join', { name: 'Rush ' + i })));
  assert.deepEqual(rs.map(r => r.status), Array(16).fill(200), JSON.stringify(rs.filter(r => r.status !== 200).map(r => r.text)));
  const v = await view(code);
  assert.equal(v.players.length, 16);
  assert.equal(new Set(v.players.map(p => p.id)).size, 16);
});

await group('organiser key: wrong or missing keys are refused', async () => {
  const c = await cup(2);
  await err(403, '/api/t/' + c.code + '/admin', { key: 'wrong', action: 'check' });
  await err(403, '/api/t/' + c.code + '/admin', { action: 'check' });
  await err(403, '/api/t/' + c.code + '/admin', { key: c.players[0].token, action: 'start' });
  assert.equal((await c.admin('check')).status, 200);
  assert.equal((await c.admin('dance')).status, 409);
  assert.equal((await view(c.code)).status, 'lobby');
});

await group('organiser: rules are clamped, rename, remove players', async () => {
  const c = await cup(3);
  assert.equal((await c.admin('rules', { rules: { goals: 0, capSec: 5000, finalGoals: 99, finalCapSec: -4, modifiers: false } })).status, 200);
  let v = await view(c.code);
  const base = { goals: 1, capSec: 900, finalGoals: 9, finalCapSec: 0, modifiers: false, equalDelay: false, net: 'server', inputDelay: 2 };
  assert.deepEqual(v.rules, base);
  await c.admin('rules', { rules: { goals: 'abc', capSec: 120 } });
  v = await view(c.code);
  assert.deepEqual(v.rules, { ...base, capSec: 120 });
  await c.admin('rules', { rules: { equalDelay: true } });            // peer to peer without prediction
  v = await view(c.code);
  assert.deepEqual(v.rules, { ...base, capSec: 120, equalDelay: true });
  await c.admin('rules', { rules: { equalDelay: false } });
  // the organiser's switch, and the input delay (0 to 4 ticks)
  await c.admin('rules', { rules: { net: 'p2p', inputDelay: 9 } });
  v = await view(c.code);
  assert.deepEqual([v.rules.net, v.rules.inputDelay], ['p2p', 4]);
  await c.admin('rules', { rules: { net: 'carrier pigeon', inputDelay: -3 } });
  v = await view(c.code);
  assert.deepEqual([v.rules.net, v.rules.inputDelay], ['p2p', 0]);
  await c.admin('rules', { rules: { net: 'server', inputDelay: 'soon' } });
  v = await view(c.code);
  assert.deepEqual([v.rules.net, v.rules.inputDelay], ['server', 0]);
  await c.admin('rules', { rules: { inputDelay: 2 } });
  await c.admin('rename', { name: 'Friday Cup' });
  await c.admin('rename', { name: '   ' });
  assert.equal((await view(c.code)).name, 'Friday Cup');
  await c.admin('remove', { playerId: c.players[2].playerId });
  await c.admin('remove', { playerId: 'nobody' });
  v = await view(c.code);
  assert.deepEqual(v.players.map(p => p.name), ['P1', 'P2']);
  // a removed player's token no longer works
  const again = await view(c.code, '?me=' + c.players[2].token);
  assert.equal(again.you, null);
});

await group('organiser: someone who joined twice (a frozen browser) keeps one entry and their name', async () => {
  const c = await cup(2);
  const second = await ok('/api/t/' + c.code + '/join', { name: 'p1', flag: 'ar', color: 'red' });       // from another browser
  let v = await view(c.code);
  assert.deepEqual(v.players.map(p => p.name), ['P1', 'P2', 'p1 2']);
  assert.equal((await c.admin('remove', { playerId: c.players[0].playerId })).status, 200);
  v = await view(c.code);
  assert.deepEqual(v.players.map(p => p.name), ['P2', 'p1']);
  assert.equal(v.players.find(p => p.name === 'p1').id, second.playerId);
  assert.equal((await view(c.code, '?me=' + c.players[0].token)).you, null);       // the frozen browser's entry is gone
  assert.equal((await view(c.code, '?me=' + second.token)).you, second.playerId);
  // not once the draw is made
  await c.admin('start');
  assert.equal((await c.admin('remove', { playerId: second.playerId })).status, 409);
});

await group('the draw: needs two players, byes go through, entries close', async () => {
  const solo = await cup(1);
  assert.equal((await solo.admin('start')).status, 409);
  const c = await cup(5);
  assert.equal((await c.admin('start')).status, 200);
  assert.equal((await c.admin('start')).status, 409);
  const v = await view(c.code);
  assert.equal(v.status, 'running');
  assert.equal(v.rounds, 3);
  assert.equal(v.matches.length, 7);
  const r1 = v.matches.filter(m => m.round === 1);
  assert.equal(r1.filter(m => m.status === 'ready').length, 1);
  assert.equal(r1.filter(m => m.via === 'bye').length, 3);
  const ids = r1.flatMap(m => [m.a, m.b]).filter(Boolean).sort();
  assert.deepEqual(ids, v.players.map(p => p.id).sort());
  assert.ok(v.matches.every(m => m.label && m.rules && typeof m.rules.goals === 'number'));
  assert.ok(v.matches.every(m => m.rules.equalDelay === false));           // prediction on unless the organiser says
  assert.ok(v.matches.every(m => m.rules.net === (v.matchServer ? 'server' : 'p2p') && m.rules.inputDelay === 2));
  assert.equal(v.matches.find(m => m.round === 3).rules.goals, 5);          // the final's own rules
  // one match at a time: the only real first-round match is on, the rest follow in order
  const real = r1.find(m => m.status === 'ready');
  assert.equal(v.current, real.id);
  assert.equal(v.queue[0], real.id);
  assert.equal(v.queue.length, 1 + v.matches.filter(m => m.round > 1).length);
  assert.equal(v.next, v.queue[1]);
  assert.match(await err(409, '/api/t/' + c.code + '/join', { name: 'Late' }), /already started/);
  const p1 = await ok('/api/t/' + c.code + '/join', { name: 'Renamed', token: c.players[0].token });
  assert.equal(p1.playerId, c.players[0].playerId);
  assert.equal((await view(c.code)).players.find(p => p.id === p1.playerId).name, 'P1');
  assert.equal((await c.admin('remove', { playerId: c.players[1].playerId })).status, 409);
});

await group('match reports, peer to peer: only the host, start, goals, a final needs a winner', async () => {
  const c = await cup(2);
  await c.admin('rules', { rules: { net: 'p2p' } });
  await c.admin('start');
  const m = (await view(c.code)).matches[0];
  const base = '/api/t/' + c.code + '/m/' + m.id + '/report';
  const host = tokenOf(c, m.a), guest = tokenOf(c, m.b);
  await err(403, base, { token: guest, kind: 'start' });
  await err(403, base, { kind: 'start' });
  await err(404, '/api/t/' + c.code + '/m/r9m9/report', { token: host, kind: 'start' });
  await ok(base, { token: host, kind: 'start' });
  let x = (await view(c.code)).matches[0];
  assert.equal(x.status, 'live');
  assert.ok(x.startedAt);
  await ok(base, { token: host, kind: 'score', score: [1, 0] });
  await ok(base, { token: host, kind: 'score', score: [400, -2] });
  x = (await view(c.code)).matches[0];
  assert.deepEqual(x.score, [99, 0]);
  await err(409, base, { token: host, kind: 'final', score: [2, 2] });
  await err(409, base, { token: host, kind: 'final', score: [3, 1], winner: 'b' });
  await err(409, base, { token: host, kind: 'final' });
  await ok(base, { token: host, kind: 'final', score: [3, 1], winner: 'a' });
  await ok(base, { token: host, kind: 'final', score: [0, 3], winner: 'b' });      // a repeat changes nothing
  const v = await view(c.code);
  assert.equal(v.status, 'finished');
  assert.equal(v.champion, m.a);
  assert.deepEqual(v.matches[0].score, [3, 1]);
  assert.equal(v.matches[0].via, 'played');
  // goals after the end change nothing
  await ok(base, { token: host, kind: 'score', score: [9, 9] });
  assert.deepEqual((await view(c.code)).matches[0].score, [3, 1]);
});

await group('the host moves a live match onto their own device', async () => {
  const c = await cup(2);
  await c.admin('rules', { rules: { net: 'p2p' } });
  await c.admin('start');
  const m = (await view(c.code)).matches[0];
  const base = '/api/t/' + c.code + '/m/' + m.id + '/report';
  await ok(base, { token: tokenOf(c, m.a), kind: 'start' });
  await ok(base, { token: tokenOf(c, m.a), kind: 'start', local: true });
  const x = (await view(c.code)).matches[0];
  assert.equal(x.status, 'live');
  assert.equal(x.local, 'host');
});

await group('organiser: walkovers, corrections until the next match starts, resets', async () => {
  const c = await cup(4);
  await c.admin('rules', { rules: { net: 'p2p' } });
  await c.admin('start');
  let v = await view(c.code);
  const [s1, s2] = v.matches.filter(m => m.round === 1);
  const fin = v.matches.find(m => m.round === 2);
  assert.match(await err(409, '/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'result', matchId: fin.id, winner: 'a', score: [1, 0] }), /two players/);
  assert.match(await err(409, '/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'result', matchId: s1.id, winner: 'x' }), /winner/);
  assert.match(await err(409, '/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'result', matchId: 'r7m1', winner: 'a' }), /does not exist/);
  assert.equal((await c.admin('result', { matchId: s1.id, winner: 'b', score: [0, 0], via: 'walkover' })).status, 200);
  assert.equal((await c.admin('result', { matchId: s2.id, winner: 'a', score: [150, -1] })).status, 200);
  v = await view(c.code);
  let f = v.matches.find(m => m.round === 2);
  assert.equal(f.status, 'ready');
  assert.equal(f.a, s1.b);
  assert.equal(f.b, s2.a);
  assert.deepEqual(v.matches.find(m => m.id === s2.id).score, [99, 0]);
  assert.equal(v.matches.find(m => m.id === s2.id).via, 'admin');
  // correct the first semi: the final's slot changes
  assert.equal((await c.admin('result', { matchId: s1.id, winner: 'a', score: [2, 1] })).status, 200);
  f = (await view(c.code)).matches.find(m => m.round === 2);
  assert.equal(f.a, s1.a);
  // reset the second semi: the final waits again
  assert.equal((await c.admin('reset', { matchId: s2.id })).status, 200);
  v = await view(c.code);
  assert.equal(v.matches.find(m => m.id === s2.id).status, 'ready');
  assert.equal(v.matches.find(m => m.round === 2).status, 'waiting');
  // once the final is live, the semis are locked
  await c.admin('result', { matchId: s2.id, winner: 'b', score: [0, 1] });
  f = (await view(c.code)).matches.find(m => m.round === 2);
  await ok('/api/t/' + c.code + '/m/' + f.id + '/report', { token: tokenOf(c, f.a), kind: 'start' });
  assert.match(await err(409, '/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'result', matchId: s1.id, winner: 'b', score: [0, 1] }), /next match has already started/);
  assert.match(await err(409, '/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'reset', matchId: s1.id }), /next match has already started/);
  // the organiser decides the final; then takes it back
  await c.admin('result', { matchId: f.id, winner: 'b', score: [1, 2] });
  v = await view(c.code);
  assert.equal(v.status, 'finished');
  assert.equal(v.champion, f.b);
  await c.admin('reset', { matchId: f.id });
  v = await view(c.code);
  assert.equal(v.status, 'running');
  assert.equal(v.champion, null);
  // back to the lobby keeps the players
  await c.admin('restart');
  v = await view(c.code);
  assert.equal(v.status, 'lobby');
  assert.equal(v.matches.length, 0);
  assert.equal(v.players.length, 4);
  assert.equal((await ok('/api/t/' + c.code + '/join', { name: 'Late but in' })).playerId.length > 0, true);
});

await group('a match on the organiser\'s device: live, score, result', async () => {
  const c = await cup(2);
  await c.admin('start');
  const m = (await view(c.code)).matches[0];
  assert.equal((await c.admin('live', { matchId: 'r5m5' })).status, 409);
  assert.equal((await c.admin('live', { matchId: m.id })).status, 200);
  let x = (await view(c.code)).matches[0];
  assert.equal(x.status, 'live');
  assert.equal(x.local, 'admin');
  await c.admin('score', { matchId: m.id, score: [2, 1] });
  assert.deepEqual((await view(c.code)).matches[0].score, [2, 1]);
  await c.admin('result', { matchId: m.id, winner: 'a', score: [3, 1], via: 'local' });
  x = (await view(c.code)).matches[0];
  assert.equal(x.via, 'local');
  assert.equal((await view(c.code)).status, 'finished');
});

await group('signaling mailboxes: players reach only their own, viewers need the organiser key', async () => {
  const c = await cup(2);
  await c.admin('start');
  const m = (await view(c.code)).matches[0];
  const sig = '/api/t/' + c.code + '/m/' + m.id + '/signal';
  const host = tokenOf(c, m.a), guest = tokenOf(c, m.b);
  await ok(sig + '?box=host&token=' + host);
  await ok(sig + '?box=guest&token=' + guest);
  await err(403, sig + '?box=guest&token=' + host);
  await err(403, sig + '?box=host&token=' + guest);
  await err(403, sig + '?box=spec:abcd1234');
  await err(403, sig + '?box=spec:abcd1234', undefined, { 'x-cc-admin': 'wrong' });
  await ok(sig + '?box=spec:abcd1234', undefined, { 'x-cc-admin': c.adminKey });
  await err(403, sig + '?box=spec:BAD!&token=' + host);
  // posting
  await ok(sig, { token: host, from: 'host', to: 'guest', type: 'offer', session: 's1', sdp: 'v=0 offer' });
  await err(403, sig, { token: guest, from: 'guest', to: 'host', type: 'offer', sdp: 'x' });
  await err(403, sig, { token: guest, from: 'host', to: 'guest', type: 'offer', sdp: 'x' });
  await ok(sig, { token: guest, from: 'guest', to: 'host', type: 'answer', session: 's1', sdp: 'v=0 answer', inst: 'i1' });
  await err(403, sig, { from: 'spec:abcd1234', to: 'host', type: 'offer', sdp: 'x' });
  await ok(sig, { from: 'spec:abcd1234', key: c.adminKey, to: 'host', type: 'offer', session: 's2', sdp: 'v=0 viewer' });
  await ok(sig, { token: host, from: 'host', to: 'spec:abcd1234', type: 'answer', session: 's2', sdp: 'v=0 to viewer' });
  // reading: in order, only newer ones, long SDPs cut
  await ok(sig, { token: host, from: 'host', to: 'guest', type: 'offer', session: 's3', sdp: 'y'.repeat(30000) });
  const all = await ok(sig + '?box=guest&token=' + guest);
  assert.equal(all.msgs.length, 2);
  assert.deepEqual(all.msgs.map(x => x.i), [0, 1]);
  assert.equal(all.msgs[0].sdp, 'v=0 offer');
  assert.equal(all.msgs[1].sdp.length, 20000);
  assert.ok(typeof all.now === 'number');
  const newer = await ok(sig + '?box=guest&token=' + guest + '&after=0');
  assert.deepEqual(newer.msgs.map(x => x.session), ['s3']);
  const toHost = await ok(sig + '?box=host&token=' + host);
  assert.deepEqual(toHost.msgs.map(x => x.from), ['guest', 'spec:abcd1234']);
  const toViewer = await ok(sig + '?box=spec:abcd1234', undefined, { 'x-cc-admin': c.adminKey });
  assert.equal(toViewer.msgs[0].sdp, 'v=0 to viewer');
  await err(404, '/api/t/' + c.code + '/m/r9m1/signal?box=host&token=' + host);
});

await group('relay servers: without a TURN key the app hands out STUN only', async () => {
  const j = await ok('/api/ice');
  assert.ok(Array.isArray(j.iceServers) && j.iceServers.length >= 1);
  assert.ok(j.iceServers.every(s => [].concat(s.urls).every(u => /^(stun|turns?):/.test(u))));
  if (process.env.EXPECT_RELAY === '0') assert.equal(j.relay, false);
});

await group('a whole 6-player cup through the API, with reports racing each other', async () => {
  const c = await cup(6);
  await c.admin('rules', { rules: { goals: 2, capSec: 60, finalGoals: 3, finalCapSec: 90, net: 'p2p' } });
  await c.admin('start');
  for (let round = 1; round <= 3; round++) {
    const v = await view(c.code);
    const ready = v.matches.filter(m => m.round === round && m.status === 'ready');
    // every host reports kick-off, two goals and the result at the same time as the others
    await Promise.all(ready.map(async (m, i) => {
      const base = '/api/t/' + c.code + '/m/' + m.id + '/report', tk = tokenOf(c, m.a), win = i % 2 ? 'b' : 'a';
      const g = m.rules.goals;
      await ok(base, { token: tk, kind: 'start' });
      await ok(base, { token: tk, kind: 'score', score: win === 'a' ? [1, 0] : [0, 1] });
      await ok(base, { token: tk, kind: 'final', score: win === 'a' ? [g, 1] : [1, g], winner: win });
    }));
  }
  const v = await view(c.code);
  assert.equal(v.status, 'finished');
  assert.ok(v.matches.every(m => m.status === 'done' && m.winner));
  const fin = v.matches.find(m => m.round === v.rounds);
  assert.equal(v.champion, fin.winner);
  assert.equal(Math.max(...fin.score), 3);
});

await group('results from all eight round-one matches at the same moment are all kept', async () => {
  const c = await cup(16);
  await c.admin('rules', { rules: { net: 'p2p' } });
  await c.admin('start');
  const v = await view(c.code);
  const r1 = v.matches.filter(m => m.round === 1);
  const rs = await Promise.all(r1.map(m => req('/api/t/' + c.code + '/m/' + m.id + '/report', { token: tokenOf(c, m.a), kind: 'final', score: [3, 0], winner: 'a' })));
  assert.deepEqual(rs.map(r => r.status), Array(8).fill(200), rs.map(r => r.text).join(' '));
  const after = await view(c.code);
  assert.equal(after.matches.filter(m => m.round === 1 && m.status === 'done').length, 8);
  assert.equal(after.matches.filter(m => m.round === 2 && m.status === 'ready').length, 4);
});

await group('one match at a time: the playing order, the organiser\'s pick, one live match', async () => {
  const c = await cup(8);
  await c.admin('rules', { rules: { net: 'p2p' } });
  await c.admin('start');
  let v = await view(c.code);
  const ids = v.matches.slice().sort((a, b) => a.round - b.round || a.index - b.index).map(m => m.id);
  assert.deepEqual(ids.slice(0, 4), ['r1m1', 'r1m2', 'r1m3', 'r1m4']);
  assert.deepEqual([v.current, v.next, v.upNext], ['r1m1', 'r1m2', null]);
  assert.deepEqual(v.queue, ids);
  // someone in r1m1 is late: the organiser calls r1m3 instead
  assert.equal((await c.admin('next', { matchId: 'r2m1' })).status, 409);      // no players yet
  assert.equal((await c.admin('next', { matchId: 'r9m9' })).status, 409);
  assert.equal((await c.admin('next', { matchId: 'r1m3' })).status, 200);
  v = await view(c.code);
  assert.deepEqual([v.current, v.next, v.upNext], ['r1m3', 'r1m1', 'r1m3']);
  assert.equal(v.queue[0], 'r1m3');
  // r1m3 kicks off: the pick is used up; another match can't go live alongside it
  const m3 = v.matches.find(m => m.id === 'r1m3');
  await ok('/api/t/' + c.code + '/m/r1m3/report', { token: tokenOf(c, m3.a), kind: 'start' });
  v = await view(c.code);
  assert.deepEqual([v.current, v.next, v.upNext], ['r1m3', 'r1m1', null]);
  assert.match(await err(409, '/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'live', matchId: 'r1m1' }), /One match at a time/);
  // it ends: back to the order
  await ok('/api/t/' + c.code + '/m/r1m3/report', { token: tokenOf(c, m3.a), kind: 'final', score: [3, 0], winner: 'a' });
  v = await view(c.code);
  assert.deepEqual([v.current, v.next], ['r1m1', 'r1m2']);
  assert.ok(!v.queue.includes('r1m3'));
  // a pick can be taken back
  await c.admin('next', { matchId: 'r1m4' });
  assert.equal((await view(c.code)).current, 'r1m4');
  await c.admin('next', { matchId: null });
  v = await view(c.code);
  assert.deepEqual([v.current, v.upNext], ['r1m1', null]);
  // the organiser deciding the match on now moves the cup on, like a played one
  await c.admin('result', { matchId: 'r1m1', winner: 'b', score: [0, 0], via: 'walkover' });
  assert.equal((await view(c.code)).current, 'r1m2');
});

await group('tickets for the match server: your match when it\'s on, the organiser any match', async () => {
  const c = await cup(4);
  const v0 = await view(c.code);
  const tk = (id, body) => req('/api/t/' + c.code + '/m/' + id + '/ticket', body);
  if (!v0.matchServer) {
    await c.admin('start');
    assert.equal((await tk('r1m1', { token: c.players[0].token })).status, 503);
    return;
  }
  await c.admin('start');
  const v = await view(c.code);
  const [m1, m2] = v.matches.filter(m => m.round === 1);
  const decode = s => JSON.parse(Buffer.from(s.split('.')[0], 'base64url').toString('utf8'));
  // the players of the match on now
  const a = await tk(m1.id, { token: tokenOf(c, m1.a) });
  assert.equal(a.status, 200, a.text);
  assert.equal(typeof a.j.url, 'string');
  const ta = decode(a.j.ticket);
  assert.equal(ta.s, 0);
  assert.deepEqual([ta.c, ta.m, ta.st, ta.g, ta.a.id, ta.b.id, ta.lb], [c.code, m1.id, 'ready', 0, m1.a, m1.b, 'Semi-finals']);
  assert.deepEqual(ta.r, { goals: 3, capSec: 90, modifiers: true, inputDelay: 2 });
  assert.ok(ta.x > Date.now() + 9 * 60000 && ta.x < Date.now() + 11 * 60000, 'lasts about 10 minutes');
  assert.ok(!JSON.stringify(ta).includes(tokenOf(c, m1.a)), 'a token in the ticket');
  if (SECRET) {
    const [body, sig] = a.j.ticket.split('.');
    assert.equal(sig, createHmac('sha256', SECRET).update(body).digest('base64url'), 'signed with MATCH_SECRET');
  }
  assert.equal(decode((await tk(m1.id, { token: tokenOf(c, m1.b) })).j.ticket).s, 1);
  // the organiser watches any match, on or not
  const o1 = await tk(m2.id, { key: c.adminKey });
  assert.equal(o1.status, 200);
  assert.equal(decode(o1.j.ticket).s, -1);
  // turned away: other people, wrong keys, the next match's players, odd matches
  assert.match(await err(403, '/api/t/' + c.code + '/m/' + m1.id + '/ticket', { token: tokenOf(c, m2.a) }), /Not your match/);
  await err(403, '/api/t/' + c.code + '/m/' + m1.id + '/ticket', { key: 'wrong' });
  await err(403, '/api/t/' + c.code + '/m/' + m1.id + '/ticket', {});
  assert.match(await err(409, '/api/t/' + c.code + '/m/' + m2.id + '/ticket', { token: tokenOf(c, m2.a) }), /Not your turn/);
  await err(409, '/api/t/' + c.code + '/m/r2m1/ticket', { key: c.adminKey });
  await err(404, '/api/t/' + c.code + '/m/r7m7/ticket', { key: c.adminKey });
  await err(404, '/api/t/QQQQQ/m/r1m1/ticket', { key: c.adminKey });
  // a match on one device, a peer-to-peer match, a finished match
  await c.admin('live', { matchId: m1.id });
  assert.match(await err(409, '/api/t/' + c.code + '/m/' + m1.id + '/ticket', { token: tokenOf(c, m1.a) }), /one device/);
  await c.admin('result', { matchId: m1.id, winner: 'a', score: [3, 1], via: 'local' });
  assert.match(await err(410, '/api/t/' + c.code + '/m/' + m1.id + '/ticket', { token: tokenOf(c, m1.a) }), /over/);
  await c.admin('rules', { rules: { net: 'p2p' } });
  assert.match(await err(409, '/api/t/' + c.code + '/m/' + m2.id + '/ticket', { token: tokenOf(c, m2.a) }), /peer to peer/);
  // the score and status carry over, so a restarted match server carries on
  await c.admin('rules', { rules: { net: 'server' } });
  await req('/api/t/' + c.code + '/m/' + m2.id + '/report', { kind: 'start' }, { 'x-cc-server': SECRET || 'x' });
  if (SECRET) {
    await req('/api/t/' + c.code + '/m/' + m2.id + '/report', { kind: 'score', score: [1, 2] }, { 'x-cc-server': SECRET });
    const t2 = decode((await tk(m2.id, { token: tokenOf(c, m2.b) })).j.ticket);
    assert.deepEqual([t2.st, t2.sc], ['live', [1, 2]]);
  }
  // back to the lobby and a new draw: the same match ids, but tickets of a newer generation
  // (so the match server closes the old draw's room), and the old draw's reports are refused
  const g0 = decode(o1.j.ticket).g;
  await c.admin('restart');
  await c.admin('start');
  const n1 = (await view(c.code)).matches.find(m => m.id === m2.id);
  const g1 = decode((await tk(n1.id, { key: c.adminKey })).j.ticket).g;
  assert.ok(g1 > g0, 'new draw generation ' + g1 + ' above ' + g0);
  if (SECRET) assert.match(await err(409, '/api/t/' + c.code + '/m/' + n1.id + '/report', { kind: 'score', score: [1, 0], gen: g0 }, { 'x-cc-server': SECRET }), /reset/);
});

await group('anyone with the cup\'s link can watch the match on now, and nothing else', async () => {
  const c = await cup(4);
  const v0 = await view(c.code);
  const tkUrl = id => '/api/t/' + c.code + '/m/' + id + '/ticket';
  const tk = (id, body) => req(tkUrl(id), body);
  const watch = id => tk(id, { watch: true });
  const decode = s => JSON.parse(Buffer.from(s.split('.')[0], 'base64url').toString('utf8'));
  if (!v0.matchServer) {
    await c.admin('start');
    assert.equal((await watch('r1m1')).status, 503);
    return;
  }
  await err(404, tkUrl('r1m1'), { watch: true });                      // no draw yet, so no matches
  await c.admin('start');
  const v = await view(c.code);
  const [m1, m2] = v.matches.filter(m => m.round === 1);
  // no token, no key: a ticket for the match on now, to watch from (seat -1)
  const a = await watch(m1.id);
  assert.equal(a.status, 200, a.text);
  assert.equal(typeof a.j.url, 'string');
  const ta = decode(a.j.ticket);
  assert.deepEqual([ta.s, ta.c, ta.m, ta.st, ta.g, ta.a.id, ta.b.id, ta.lb], [-1, c.code, m1.id, 'ready', 0, m1.a, m1.b, 'Semi-finals']);
  assert.ok(ta.x > Date.now() + 9 * 60000 && ta.x < Date.now() + 11 * 60000, 'lasts about 10 minutes');
  assert.ok(!JSON.stringify(ta).includes(tokenOf(c, m1.a)), 'a token in the ticket');
  if (SECRET) {
    const [body, sig] = a.j.ticket.split('.');
    assert.equal(sig, createHmac('sha256', SECRET).update(body).digest('base64url'), 'signed with MATCH_SECRET');
  }
  // a player's token in the body doesn't turn a watch ticket into a seat in that match
  assert.equal(decode((await tk(m1.id, { watch: true, token: tokenOf(c, m1.a) })).j.ticket).s, -1);
  // only the match on now, and only one that can be shown
  assert.match(await err(409, tkUrl(m2.id), { watch: true }), /not on yet/);
  await err(409, tkUrl('r2m1'), { watch: true });                      // no players yet
  await err(404, tkUrl('r7m7'), { watch: true });
  await err(404, '/api/t/QQQQQ/m/r1m1/ticket', { watch: true });
  // `watch` is not a way in for anything else
  await err(403, tkUrl(m1.id), {});
  await err(403, tkUrl(m1.id), { watch: 'yes' });
  await err(403, tkUrl(m1.id), { watch: false });
  await err(403, tkUrl(m1.id), { key: 'wrong', watch: true });
  // the organiser calls the other match: the tickets follow the match on now
  assert.equal((await c.admin('next', { matchId: m2.id })).status, 200);
  assert.equal((await watch(m2.id)).status, 200);
  assert.match(await err(409, tkUrl(m1.id), { watch: true }), /not on yet/);
  assert.equal((await tk(m1.id, { token: tokenOf(c, m1.a) })).status, 409);
  assert.equal((await tk(m2.id, { token: tokenOf(c, m2.a) })).status, 200);
  await c.admin('next', { matchId: null });
  assert.equal((await watch(m1.id)).status, 200);
  // (calling m2 took m1's turn, so m1 is on a newer generation now: see the next group)
  const g1 = (await view(c.code)).matches.find(m => m.id === m1.id).gen || 0;
  assert.ok(g1 > 0, 'm1 kept its generation after losing its turn');
  assert.equal(decode((await watch(m1.id)).j.ticket).g, g1);
  // live: still watchable, and the ticket carries the score
  if (SECRET) {
    const rep = '/api/t/' + c.code + '/m/' + m1.id + '/report';
    await ok(rep, { kind: 'start', gen: g1 }, { 'x-cc-server': SECRET });
    await ok(rep, { kind: 'score', score: [1, 2], gen: g1 }, { 'x-cc-server': SECRET });
    const t1 = decode((await watch(m1.id)).j.ticket);
    assert.deepEqual([t1.s, t1.st, t1.sc], [-1, 'live', [1, 2]]);
    assert.match(await err(409, tkUrl(m2.id), { watch: true }), /not on yet/);      // one match at a time: the live one stays the one on
  }
  // a match on one device can't be shown, nor can a finished one
  await c.admin('live', { matchId: m1.id });
  assert.match(await err(409, tkUrl(m1.id), { watch: true }), /one device/);
  await c.admin('result', { matchId: m1.id, winner: 'a', score: [3, 1], via: 'local' });
  assert.match(await err(410, tkUrl(m1.id), { watch: true }), /over/);
  // the next match is on now; peer to peer matches can't be watched from here
  assert.equal((await watch(m2.id)).status, 200);
  await c.admin('rules', { rules: { net: 'p2p' } });
  assert.match(await err(409, tkUrl(m2.id), { watch: true }), /peer to peer/);
});

await group('one match at a time, airtight: the organiser calls another match while the first one\'s players wait', async () => {
  // Ana is in the match on now and ready; Ben has its page open too, but went for a coffee.
  // The organiser calls the next match instead, and it kicks off. Ben comes back and presses
  // ready: the first match's room (on its old tickets) must not kick off alongside.
  const c = await cup(4);
  const v0 = await view(c.code);
  if (!v0.matchServer || !SECRET) return;
  const srv = { 'x-cc-server': SECRET };
  const tk = (id, body) => req('/api/t/' + c.code + '/m/' + id + '/ticket', body);
  const rep = id => '/api/t/' + c.code + '/m/' + id + '/report';
  const decode = s => JSON.parse(Buffer.from(s.split('.')[0], 'base64url').toString('utf8'));
  const live = x => x.matches.filter(m => m.status === 'live').map(m => m.id);
  await c.admin('start');
  let v = await view(c.code);
  const [x, y] = v.matches.filter(m => m.round === 1);
  assert.equal(v.current, x.id);
  const old = decode((await tk(x.id, { token: tokenOf(c, x.a) })).j.ticket);    // x's players are in its room
  decode((await tk(x.id, { token: tokenOf(c, x.b) })).j.ticket);
  assert.equal((await c.admin('next', { matchId: y.id })).status, 200);
  v = await view(c.code);
  assert.equal(v.current, y.id);
  const gy = v.matches.find(m => m.id === y.id).gen || 0;
  assert.equal(decode((await tk(y.id, { token: tokenOf(c, y.a) })).j.ticket).g, gy);
  await ok(rep(y.id), { kind: 'start', gen: gy }, srv);
  // x's room kicks off on its old tickets: refused, so only y is live
  assert.match(await err(409, rep(x.id), { kind: 'start', gen: old.g }, srv), /reset/);
  v = await view(c.code);
  assert.deepEqual(live(v), [y.id], 'two matches live: ' + live(v).join(', '));
  assert.ok((v.matches.find(m => m.id === x.id).gen || 0) > old.g, 'x keeps its old generation');
  // nor do its goals or result count
  await err(409, rep(x.id), { kind: 'final', score: [3, 0], winner: 'a', gen: old.g }, srv);
  // y is played; then x is on again, with new tickets of the new generation
  await ok(rep(y.id), { kind: 'final', score: [3, 1], winner: 'a', gen: gy }, srv);
  v = await view(c.code);
  assert.equal(v.current, x.id);
  const fresh = decode((await tk(x.id, { token: tokenOf(c, x.a) })).j.ticket);
  assert.ok(fresh.g > old.g, 'new tickets of a newer generation');
  await ok(rep(x.id), { kind: 'start', gen: fresh.g }, srv);
  assert.deepEqual(live(await view(c.code)), [x.id]);
  // calling the match that is already on changes nothing; taking a call back drops the called one's room
  const c2 = await cup(4);
  await c2.admin('start');
  const v2 = await view(c2.code);
  const [p, q] = v2.matches.filter(m => m.round === 1);
  await c2.admin('next', { matchId: p.id });
  assert.equal((await view(c2.code)).matches.find(m => m.id === p.id).gen || 0, p.gen || 0, 'calling the match on now gave it a new generation');
  await c2.admin('next', { matchId: q.id });
  await c2.admin('next', { matchId: null });
  const v3 = await view(c2.code);
  assert.equal(v3.current, p.id);
  assert.ok((v3.matches.find(m => m.id === q.id).gen || 0) > (q.gen || 0), 'the call taken back kept its room');
  // the organiser plays another match on their own device ("Play here") while the first one's pair waits: the same
  const c3 = await cup(4);
  await c3.admin('start');
  const v4 = await view(c3.code);
  const [r, s] = v4.matches.filter(m => m.round === 1);
  const tk3 = (id, body) => req('/api/t/' + c3.code + '/m/' + id + '/ticket', body);
  const oldR = decode((await tk3(r.id, { token: tokenOf(c3, r.a) })).j.ticket);
  assert.equal((await c3.admin('live', { matchId: s.id })).status, 200);
  assert.match(await err(409, '/api/t/' + c3.code + '/m/' + r.id + '/report', { kind: 'start', gen: oldR.g }, srv), /reset/);
  assert.deepEqual(live(await view(c3.code)), [s.id]);
});

await group('a ten-player cup plays one match at a time, and everyone else can watch it', async () => {
  const c = await cup(10);
  const v0 = await view(c.code);
  const viaServer = !!(v0.matchServer && SECRET);
  const srv = { 'x-cc-server': SECRET };
  const tk = (id, body) => req('/api/t/' + c.code + '/m/' + id + '/ticket', body);
  const decode = s => JSON.parse(Buffer.from(s.split('.')[0], 'base64url').toString('utf8'));
  const live = x => x.matches.filter(m => m.status === 'live').map(m => m.id);
  await c.admin('start');
  let v = await view(c.code);
  // 10 players in a 16-slot bracket: 6 byes, so 2 first-round matches, 4 quarter-finals, 2 semi-finals, the final
  assert.equal(v.matches.filter(m => m.via === 'bye').length, 6);
  assert.equal(v.matches.filter(m => m.via !== 'bye').length, 9);
  const order = v.matches.slice().sort((a, b) => a.round - b.round || a.index - b.index).map(m => m.id);
  const played = [];
  let watchTickets = 0;
  for (let step = 0; step < 20 && v.status === 'running'; step++) {
    const cur = v.matches.find(m => m.id === v.current);
    const firstOpen = order.map(id => v.matches.find(m => m.id === id)).find(m => m.status === 'ready' || m.status === 'live');
    assert.equal(cur.id, firstOpen.id, 'the match on now is the first open one in the playing order');
    assert.deepEqual(live(v), [], 'nothing is live before the kick-off');
    const others = v.matches.filter(m => m.status === 'ready' && m.id !== cur.id);
    const rep = '/api/t/' + c.code + '/m/' + cur.id + '/report';
    if (viaServer) {
      // its two players get their seats; nobody else gets into a match that isn't on
      assert.equal(decode((await tk(cur.id, { token: tokenOf(c, cur.a) })).j.ticket).s, 0);
      assert.equal(decode((await tk(cur.id, { token: tokenOf(c, cur.b) })).j.ticket).s, 1);
      for (const o of others) {
        assert.equal((await tk(o.id, { token: tokenOf(c, o.a) })).status, 409, o.id + ': not their turn');
        assert.equal((await tk(o.id, { watch: true })).status, 409, o.id + ': not on yet');
      }
      // everybody else watches it: a seat to watch from, never one to play from
      const watchers = c.players.filter(p => p.playerId !== cur.a && p.playerId !== cur.b);
      assert.equal(watchers.length, 8);
      for (const w of watchers) {
        const r = await tk(cur.id, { watch: true, token: w.token });
        assert.equal(r.status, 200, r.text);
        assert.equal(decode(r.j.ticket).s, -1);
        watchTickets++;
      }
      await ok(rep, { kind: 'start', gen: cur.gen || 0 }, srv);
    } else {
      await c.admin('live', { matchId: cur.id });
    }
    v = await view(c.code);
    assert.deepEqual(live(v), [cur.id], 'exactly one match is live');
    assert.equal(v.current, cur.id);
    // with one live, the organiser can't kick off another, and the others stay shut
    if (others[0]) assert.match(await err(409, '/api/t/' + c.code + '/admin', { key: c.adminKey, action: 'live', matchId: others[0].id }), /One match at a time/);
    if (viaServer) {
      assert.equal(decode((await tk(cur.id, { watch: true })).j.ticket).st, 'live', 'still watchable once it has kicked off');
      for (const o of others) assert.equal((await tk(o.id, { token: tokenOf(c, o.a) })).status, 409);
    }
    const sc = step % 2 ? [1, 3] : [3, 1], side = sc[0] > sc[1] ? 'a' : 'b';
    if (viaServer) {
      await ok(rep, { kind: 'score', score: [1, 0], gen: cur.gen || 0 }, srv);
      await ok(rep, { kind: 'final', score: sc, winner: side, gen: cur.gen || 0 }, srv);
    } else {
      await c.admin('result', { matchId: cur.id, winner: side, score: sc, via: 'local' });
    }
    played.push(cur.id);
    v = await view(c.code);
    assert.deepEqual(live(v), [], 'nothing is live after the final whistle');
  }
  assert.equal(v.status, 'finished');
  assert.ok(v.champion, 'a champion');
  assert.equal(played.length, 9, 'nine matches, one after another');
  assert.deepEqual(played, order.filter(id => played.includes(id)), 'played in the bracket\'s order');
  if (viaServer) assert.equal(watchTickets, 9 * 8, 'eight watchers for each of the nine matches');
});

await group('reports from the match server: the shared secret, start, goals, result, a reset match', async () => {
  const c = await cup(2);
  const v0 = await view(c.code);
  await c.admin('start');
  const m = (await view(c.code)).matches[0];
  const base = '/api/t/' + c.code + '/m/' + m.id + '/report';
  const host = tokenOf(c, m.a);
  if (!v0.matchServer) {
    await err(403, base, { kind: 'start' }, { 'x-cc-server': 'anything' });
    return;
  }
  // on the match server, the host's page doesn't report (unless the match moved onto its device)
  assert.match(await err(403, base, { token: host, kind: 'start' }), /match server reports/);
  await err(403, base, { kind: 'start' }, { 'x-cc-server': 'not-the-secret' });
  if (!SECRET) return;
  const srv = { 'x-cc-server': SECRET };
  await ok(base, { kind: 'start', gen: 0 }, srv);
  let x = (await view(c.code)).matches[0];
  assert.deepEqual([x.status, x.net], ['live', 'server']);
  await ok(base, { kind: 'score', score: [1, 0], gen: 0 }, srv);
  assert.deepEqual((await view(c.code)).matches[0].score, [1, 0]);
  // the organiser resets the match: reports about the old one don't count
  await c.admin('reset', { matchId: m.id });
  x = (await view(c.code)).matches[0];
  assert.deepEqual([x.status, x.gen, x.net], ['ready', 1, undefined]);
  assert.match(await err(409, base, { kind: 'score', score: [2, 0], gen: 0 }, srv), /reset/);
  await ok(base, { kind: 'start', gen: 1 }, srv);
  await ok(base, { kind: 'final', score: [1, 3], winner: 'b', gen: 1 }, srv);
  await ok(base, { kind: 'final', score: [1, 3], winner: 'b', gen: 1 }, srv);      // a retry changes nothing
  const v = await view(c.code);
  assert.deepEqual([v.status, v.champion, v.matches[0].via], ['finished', m.b, 'played']);
});

await group('the host moves a match on the match server onto their own device', async () => {
  const c = await cup(2);
  const v0 = await view(c.code);
  if (!v0.matchServer) return;
  await c.admin('start');
  const m = (await view(c.code)).matches[0];
  const base = '/api/t/' + c.code + '/m/' + m.id + '/report';
  const host = tokenOf(c, m.a);
  await ok(base, { token: host, kind: 'start', local: true });
  const x = (await view(c.code)).matches[0];
  assert.deepEqual([x.status, x.local], ['live', 'host']);
  await ok(base, { token: host, kind: 'score', score: [0, 1] });
  await ok(base, { token: host, kind: 'final', score: [0, 2], winner: 'b' });
  assert.equal((await view(c.code)).champion, m.b);
});

console.log('\n' + results.map(r => r.join('  ')).join('\n'));
const failed = results.filter(r => r[0] !== 'pass').length;
console.log(failed ? failed + ' of ' + results.length + ' groups failed' : 'all ' + results.length + ' groups passed');
process.exit(failed ? 1 : 0);
