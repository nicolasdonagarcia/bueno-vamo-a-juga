// Bracket logic: seeding, byes, advancing, corrections. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedOrder, buildBracket, applyResult, resetMatch, roundName, rulesFor, removePlayer, restartCup, markLive, currentMatch, matchQueue, playingOrder, publicView, netRule, DEFAULT_RULES } from '../../lib/tournament.ts';

function tournament(n) {
  return {
    code: 'TEST', name: 'Cup', createdAt: 0, adminKeyHash: '', status: 'lobby', rules: { ...DEFAULT_RULES },
    players: Array.from({ length: n }, (_, i) => ({ id: 'p' + (i + 1), name: 'P' + (i + 1), flag: 'un', color: 'orange', tokenHash: '', joinedAt: i })),
    matches: [], rounds: 0, champion: null
  };
}
function rng(seed) { let a = seed; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; }
function playAll(t, pickA = () => true) {
  for (let guard = 0; guard < 200 && t.status === 'running'; guard++) {
    const m = t.matches.find(x => x.status === 'ready');
    if (!m) break;
    const a = pickA(m);
    assert.equal(applyResult(t, m.id, a ? 'a' : 'b', a ? [3, 1] : [0, 3], 'played'), null);
  }
}

test('seed order keeps the top seeds apart', () => {
  const o = seedOrder(16);
  assert.deepEqual(o.slice().sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
  for (let i = 0; i < 16; i += 2) assert.equal(o[i] + o[i + 1], 17);          // 1 v 16, 2 v 15, ...
  assert.ok(o.indexOf(1) < 8 && o.indexOf(2) >= 8);                            // 1 and 2 only meet in the final
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
});

test('16 players: 8 + 4 + 2 + 1 matches, every player once in round 1', () => {
  const t = tournament(16);
  buildBracket(t, rng(1));
  assert.equal(t.rounds, 4);
  assert.equal(t.matches.length, 15);
  const r1 = t.matches.filter(m => m.round === 1);
  assert.equal(r1.length, 8);
  assert.ok(r1.every(m => m.status === 'ready' && m.a && m.b));
  const ids = r1.flatMap(m => [m.a, m.b]).sort();
  assert.deepEqual(ids, t.players.map(p => p.id).sort());
  assert.equal(roundName(1, 4), 'Round of 16');
  assert.equal(roundName(4, 4), 'Final');
  assert.equal(rulesFor(t, 4).goals, 5);
  assert.equal(rulesFor(t, 1).goals, 3);
  assert.equal(rulesFor(t, 1).capSec, 90);
  assert.equal(rulesFor(t, 4).capSec, 150);
});

test('a full 16-player knockout crowns one champion', () => {
  const t = tournament(16);
  buildBracket(t, rng(2));
  playAll(t, m => m.index % 2 === 0);
  assert.equal(t.status, 'finished');
  assert.ok(t.champion);
  assert.ok(t.matches.every(m => m.status === 'done' && m.winner));
  const final = t.matches.find(m => m.round === 4);
  assert.equal(final.winner, t.champion);
});

test('13 players: three byes go straight through', () => {
  const t = tournament(13);
  buildBracket(t, rng(3));
  const byes = t.matches.filter(m => m.via === 'bye');
  assert.equal(byes.length, 3);
  assert.ok(byes.every(m => m.status === 'done' && m.winner));
  playAll(t);
  assert.equal(t.status, 'finished');
});

test('odd small fields: 2, 3, 5 and 9 players all finish', () => {
  for (const n of [2, 3, 5, 9]) {
    const t = tournament(n);
    buildBracket(t, rng(n));
    playAll(t, m => m.round % 2 === 0);
    assert.equal(t.status, 'finished', 'n=' + n);
  }
});

test('results: no double reporting, admin can correct until the next match starts', () => {
  const t = tournament(4);
  buildBracket(t, rng(4));
  const [m1, m2] = t.matches.filter(m => m.round === 1);
  assert.equal(applyResult(t, m1.id, 'a', [3, 0], 'played'), null);
  assert.equal(applyResult(t, m1.id, 'b', [0, 3], 'played'), 'already-done');
  // admin flips it while the final has not started
  assert.equal(applyResult(t, m1.id, 'b', [2, 3], 'admin', true), null);
  const final = t.matches.find(m => m.round === 2);
  assert.equal(final.a, m1.b);
  assert.equal(applyResult(t, m2.id, 'a', [3, 2], 'played'), null);
  assert.equal(final.status, 'ready');
  final.status = 'live';
  assert.equal(applyResult(t, m1.id, 'a', [3, 0], 'admin', true), 'next-started');
  assert.equal(resetMatch(t, m1.id), 'next-started');
  final.status = 'ready';
  assert.equal(resetMatch(t, final.id), null);
  assert.equal(applyResult(t, final.id, 'b', [1, 5], 'played'), null);
  assert.equal(t.champion, m2.a);
  // correcting the final reopens the tournament result
  assert.equal(applyResult(t, final.id, 'a', [5, 4], 'admin', true), null);
  assert.equal(t.champion, m1.b);
});

test('removing a second entry: the numbered copy gets the plain name back', () => {
  const t = tournament(0);
  const add = (id, name) => t.players.push({ id, name, flag: 'un', color: 'orange', tokenHash: '', joinedAt: 0 });
  add('a', 'Ana'); add('b', 'Ben'); add('a2', 'ana 2'); add('a3', 'Ana 3');
  assert.equal(removePlayer(t, 'nobody'), false);
  assert.equal(removePlayer(t, 'a'), true);
  assert.deepEqual(t.players.map(p => p.name), ['Ben', 'ana', 'Ana 3']);          // the lowest number, in its own spelling
  // a long name was cut short to fit the number: it gets the whole name back
  add('c', 'Christopher Smith'); add('c2', 'Christopher Smi 2');
  removePlayer(t, 'c');
  assert.equal(t.players.find(p => p.id === 'c2').name, 'Christopher Smith');
  // removing the numbered one leaves the others alone
  add('d', 'Dee'); add('d2', 'Dee 2');
  removePlayer(t, 'd2');
  assert.deepEqual(t.players.filter(p => p.id[0] === 'd').map(p => p.name), ['Dee']);
  // a name nobody else had: nothing else changes
  const before = t.players.map(p => p.name).join();
  removePlayer(t, 'b');
  assert.equal(t.players.map(p => p.name).join(), before.replace('Ben,', ''));
});

test('one match at a time: bracket order, byes skipped, the next pair called when one ends', () => {
  const t = tournament(6);                     // 8 slots: 2 byes in round 1
  buildBracket(t, rng(6));
  const order = playingOrder(t).map(m => m.id);
  assert.deepEqual(order, ['r1m1', 'r1m2', 'r1m3', 'r1m4', 'r2m1', 'r2m2', 'r3m1']);
  const played = [];
  for (let guard = 0; guard < 20 && t.status === 'running'; guard++) {
    const cur = currentMatch(t);
    assert.ok(cur, 'a match is always on while the cup runs');
    assert.equal(cur.status, 'ready');
    assert.ok(cur.a && cur.b);
    // the queue starts with it and holds everything still to play, in order
    const q = matchQueue(t);
    assert.equal(q[0], cur);
    assert.deepEqual(q.map(m => m.id), order.filter(id => t.matches.find(m => m.id === id).status !== 'done'));
    assert.ok(markLive(cur, undefined, 'server', t));
    assert.equal(currentMatch(t), cur, 'a live match stays the current one');
    played.push(cur.id);
    assert.equal(applyResult(t, cur.id, 'a', [3, 1], 'played'), null);
  }
  assert.equal(t.status, 'finished');
  assert.equal(currentMatch(t), null);
  // byes never come up; everything else in bracket order
  const byes = t.matches.filter(m => m.via === 'bye').map(m => m.id);
  assert.equal(byes.length, 2);
  assert.deepEqual(played, order.filter(id => !byes.includes(id)));
});

test('one match at a time: the organiser can pick the next match, and a walkover moves the cup on', () => {
  const t = tournament(8);
  buildBracket(t, rng(8));
  assert.equal(currentMatch(t).id, 'r1m1');
  t.upNext = 'r1m3';                            // someone in r1m1 is late
  assert.equal(currentMatch(t).id, 'r1m3');
  assert.deepEqual(matchQueue(t).slice(0, 3).map(m => m.id), ['r1m3', 'r1m1', 'r1m2']);
  markLive(t.matches.find(m => m.id === 'r1m3'), undefined, undefined, t);
  assert.equal(t.upNext, null, 'the pick is used up once it kicks off');
  applyResult(t, 'r1m3', 'b', [0, 2], 'played');
  assert.equal(currentMatch(t).id, 'r1m1');
  // a walkover for the match on now: the next one is called
  applyResult(t, 'r1m1', 'a', [0, 0], 'walkover', true);
  assert.equal(currentMatch(t).id, 'r1m2');
  // a pick that is not ready is ignored
  t.upNext = 'r2m2';
  assert.equal(currentMatch(t).id, 'r1m2');
  // a match played out of turn on one device counts as the live one
  markLive(t.matches.find(m => m.id === 'r1m4'), 'admin', undefined, t);
  assert.equal(currentMatch(t).id, 'r1m4');
});

test('resetting a match bumps its generation; the match server rule and input delay', () => {
  const t = tournament(2);
  buildBracket(t, rng(2));
  const m = t.matches[0];
  markLive(m, undefined, 'server', t);
  assert.equal(m.net, 'server');
  assert.equal(resetMatch(t, m.id), null);
  assert.equal(m.gen, 1);
  assert.equal(m.net, undefined);
  assert.equal(m.status, 'ready');
  assert.equal(netRule({}, true), 'server');
  assert.equal(netRule({ net: 'p2p' }, true), 'p2p');
  assert.equal(netRule({ net: 'server' }, false), 'p2p', 'without a match server it is peer to peer');
  assert.equal(rulesFor(t, 1, true).net, 'server');
  assert.equal(rulesFor(t, 1, false).net, 'p2p');
  assert.equal(rulesFor(t, 1, true).inputDelay, 2);
  t.rules.inputDelay = 9;
  assert.equal(rulesFor(t, 1, true).inputDelay, 4);
  // a match keeps the way it was played once it kicked off
  m.net = 'p2p';
  assert.equal(rulesFor(t, 1, true, m).net, 'p2p');
  const v = publicView(t, true);
  assert.equal(v.current, m.id);
  assert.equal(v.matchServer, true);
  assert.deepEqual(v.queue, [m.id]);
});

test('a new draw after going back to the lobby counts generations above the old draw', () => {
  const t = tournament(4);
  buildBracket(t, rng(3));
  assert.equal(t.matches[0].gen, undefined);
  resetMatch(t, 'r1m1'); resetMatch(t, 'r1m1');           // r1m1 is at 2 now
  restartCup(t);
  assert.equal(t.status, 'lobby');
  assert.equal(t.matches.length, 0);
  buildBracket(t, rng(4));
  for (const m of t.matches) assert.equal(m.gen, 3, m.id + ' starts above every old r1m1');
  resetMatch(t, 'r1m2');
  assert.equal(t.matches.find(m => m.id === 'r1m2').gen, 4);
  restartCup(t);
  buildBracket(t, rng(5));
  for (const m of t.matches) assert.equal(m.gen, 5);
});
