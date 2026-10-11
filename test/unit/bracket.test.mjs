// Bracket logic: seeding, byes, advancing, corrections. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedOrder, buildBracket, applyResult, resetMatch, roundName, rulesFor, DEFAULT_RULES } from '../../lib/tournament.ts';

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
