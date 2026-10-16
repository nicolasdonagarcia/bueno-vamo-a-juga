// Every API route against a running server: good input, bad input, who may do
// what, and many requests at once. Works with either store (memory or Redis).
//
//   npm run build && npm start
//   node test/api.mjs                  (BASE=http://localhost:3000)
//
// Exits non-zero on the first failed check of each group and lists them all at the end.
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const results = [];

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
  assert.deepEqual(v.rules, { goals: 3, capSec: 180, finalGoals: 5, finalCapSec: 300, modifiers: true, equalDelay: false });
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
  assert.deepEqual(v.rules, { goals: 1, capSec: 900, finalGoals: 9, finalCapSec: 0, modifiers: false, equalDelay: false });
  await c.admin('rules', { rules: { goals: 'abc', capSec: 120 } });
  v = await view(c.code);
  assert.deepEqual(v.rules, { goals: 1, capSec: 120, finalGoals: 9, finalCapSec: 0, modifiers: false, equalDelay: false });
  await c.admin('rules', { rules: { equalDelay: true } });            // online without prediction
  v = await view(c.code);
  assert.deepEqual(v.rules, { goals: 1, capSec: 120, finalGoals: 9, finalCapSec: 0, modifiers: false, equalDelay: true });
  await c.admin('rules', { rules: { equalDelay: false } });
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
  assert.equal(v.matches.find(m => m.round === 3).rules.goals, 5);          // the final's own rules
  assert.match(await err(409, '/api/t/' + c.code + '/join', { name: 'Late' }), /already started/);
  const p1 = await ok('/api/t/' + c.code + '/join', { name: 'Renamed', token: c.players[0].token });
  assert.equal(p1.playerId, c.players[0].playerId);
  assert.equal((await view(c.code)).players.find(p => p.id === p1.playerId).name, 'P1');
  assert.equal((await c.admin('remove', { playerId: c.players[1].playerId })).status, 409);
});

await group('match reports: only the host, start, goals, a final needs a winner', async () => {
  const c = await cup(2);
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
  await c.admin('rules', { rules: { goals: 2, capSec: 60, finalGoals: 3, finalCapSec: 90 } });
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
  await c.admin('start');
  const v = await view(c.code);
  const r1 = v.matches.filter(m => m.round === 1);
  const rs = await Promise.all(r1.map(m => req('/api/t/' + c.code + '/m/' + m.id + '/report', { token: tokenOf(c, m.a), kind: 'final', score: [3, 0], winner: 'a' })));
  assert.deepEqual(rs.map(r => r.status), Array(8).fill(200), rs.map(r => r.text).join(' '));
  const after = await view(c.code);
  assert.equal(after.matches.filter(m => m.round === 1 && m.status === 'done').length, 8);
  assert.equal(after.matches.filter(m => m.round === 2 && m.status === 'ready').length, 4);
});

console.log('\n' + results.map(r => r.join('  ')).join('\n'));
const failed = results.filter(r => r[0] !== 'pass').length;
console.log(failed ? failed + ' of ' + results.length + ' groups failed' : 'all ' + results.length + ' groups passed');
process.exit(failed ? 1 : 0);
