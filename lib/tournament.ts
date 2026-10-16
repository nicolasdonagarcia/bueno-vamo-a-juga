// The knockout bracket: pure functions over a plain JSON document, so the same
// code runs in API routes and in tests.

export type Player = { id: string; name: string; flag: string; color: string; tokenHash: string; joinedAt: number };
export type MatchStatus = 'waiting' | 'ready' | 'live' | 'done';
export type Match = {
  id: string; round: number; index: number;
  a: string | null; b: string | null;
  status: MatchStatus; score: [number, number]; winner: string | null;
  via?: 'played' | 'walkover' | 'admin' | 'bye' | 'local';
  local?: 'admin' | 'host';       // being played on one device instead of online: the organiser's, or the host's
  startedAt?: number; endedAt?: number; updatedAt?: number;
};
// equalDelay: no prediction online: both players see the match equally late (the round trip)
export type Rules = { goals: number; capSec: number; finalGoals: number; finalCapSec: number; modifiers: boolean; equalDelay?: boolean };
export type Tournament = {
  code: string; name: string; createdAt: number; adminKeyHash: string;
  status: 'lobby' | 'running' | 'finished';
  rules: Rules; players: Player[]; matches: Match[]; rounds: number;
  champion: string | null; startedAt?: number; finishedAt?: number;
};

export const DEFAULT_RULES: Rules = { goals: 3, capSec: 180, finalGoals: 5, finalCapSec: 300, modifiers: true, equalDelay: false };
export const MAX_PLAYERS = 64;

export function roundName(round: number, rounds: number): string {
  const left = rounds - round;
  if (left === 0) return 'Final';
  if (left === 1) return 'Semi-finals';
  if (left === 2) return 'Quarter-finals';
  return 'Round of ' + (2 ** (left + 1));
}

export function rulesFor(t: Pick<Tournament, 'rules' | 'rounds'>, round: number) {
  const final = round === t.rounds;
  return {
    goals: final ? t.rules.finalGoals : t.rules.goals,
    capSec: final ? t.rules.finalCapSec : t.rules.capSec,
    modifiers: t.rules.modifiers,
    equalDelay: !!t.rules.equalDelay,
    label: roundName(round, t.rounds)
  };
}

// 1 v 16, 8 v 9, ... so the top seeds meet last and byes go to the top seeds
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2 + 1;
    order = order.flatMap(s => [s, n - s]);
  }
  return order;
}

export function matchId(round: number, index: number) { return 'r' + round + 'm' + (index + 1); }

export function buildBracket(t: Tournament, rand: () => number = Math.random) {
  const ps = t.players.slice();
  for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; }
  const n = ps.length;
  let size = 2;
  while (size < n) size *= 2;
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const matches: Match[] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let i = 0; i < count; i++) {
      const m: Match = { id: matchId(r, i), round: r, index: i, a: null, b: null, status: 'waiting', score: [0, 0], winner: null };
      if (r === 1) {
        const sa = order[i * 2], sb = order[i * 2 + 1];
        m.a = sa <= n ? ps[sa - 1].id : null;
        m.b = sb <= n ? ps[sb - 1].id : null;
      }
      matches.push(m);
    }
  }
  t.matches = matches;
  t.rounds = rounds;
  t.champion = null;
  t.status = 'running';
  t.startedAt = Date.now();
  // byes: a lone player goes straight through
  for (const m of matches.filter(x => x.round === 1)) {
    if (m.a && m.b) m.status = 'ready';
    else if (m.a || m.b) finish(t, m, (m.a || m.b) as string, [0, 0], 'bye');
  }
}

export function getMatch(t: Tournament, id: string) { return t.matches.find(m => m.id === id) || null; }

function nextOf(t: Tournament, m: Match) {
  if (m.round >= t.rounds) return null;
  return { match: getMatch(t, matchId(m.round + 1, Math.floor(m.index / 2))) as Match, slot: (m.index % 2 === 0 ? 'a' : 'b') as 'a' | 'b' };
}

function finish(t: Tournament, m: Match, winner: string, score: [number, number], via: Match['via']) {
  m.winner = winner; m.score = score; m.status = 'done'; m.via = via; m.endedAt = Date.now(); m.updatedAt = Date.now();
  const nx = nextOf(t, m);
  if (!nx) { t.champion = winner; t.status = 'finished'; t.finishedAt = Date.now(); return; }
  nx.match[nx.slot] = winner;
  if (nx.match.a && nx.match.b && nx.match.status === 'waiting') nx.match.status = 'ready';
}

export type ResultError = 'no-match' | 'not-ready' | 'already-done' | 'bad-winner' | 'next-started';

// a match kicking off (online, or on one device when local)
export function markLive(m: Match, local?: 'admin' | 'host') {
  if (m.status !== 'ready' && m.status !== 'live') return false;
  if (m.status === 'ready') { m.startedAt = Date.now(); m.score = [0, 0]; }
  m.status = 'live';
  if (local) m.local = local;
  m.updatedAt = Date.now();
  return true;
}

// record a result; admins may correct a finished match as long as the next one has not started
export function applyResult(t: Tournament, id: string, winnerSide: 'a' | 'b', score: [number, number], via: NonNullable<Match['via']>, admin = false): ResultError | null {
  const m = getMatch(t, id);
  if (!m) return 'no-match';
  if (!m.a || !m.b) return 'not-ready';
  const winner = winnerSide === 'a' ? m.a : m.b;
  if (!winner) return 'bad-winner';
  if (m.status === 'done') {
    if (!admin) return 'already-done';
    const nx = nextOf(t, m);
    if (nx && (nx.match.status === 'live' || nx.match.status === 'done')) return 'next-started';
    if (nx) { nx.match[nx.slot] = null; nx.match.status = 'waiting'; nx.match.score = [0, 0]; }
    if (!nx) { t.champion = null; t.status = 'running'; }
  }
  finish(t, m, winner, score, via);
  return null;
}

export function resetMatch(t: Tournament, id: string): ResultError | null {
  const m = getMatch(t, id);
  if (!m) return 'no-match';
  if (m.status === 'done') {
    const nx = nextOf(t, m);
    if (nx && (nx.match.status === 'live' || nx.match.status === 'done')) return 'next-started';
    if (nx) { nx.match[nx.slot] = null; nx.match.status = 'waiting'; }
    else { t.champion = null; t.status = 'running'; }
  }
  m.winner = null; m.score = [0, 0]; m.via = undefined; m.local = undefined; m.startedAt = undefined; m.endedAt = undefined;
  m.status = m.a && m.b ? 'ready' : 'waiting';
  m.updatedAt = Date.now();
  return null;
}

// what the public sees: no token or admin hashes
export function publicView(t: Tournament) {
  return {
    code: t.code, name: t.name, status: t.status, rules: { ...DEFAULT_RULES, ...t.rules }, rounds: t.rounds, champion: t.champion,
    startedAt: t.startedAt || null, finishedAt: t.finishedAt || null,
    players: t.players.map(p => ({ id: p.id, name: p.name, flag: p.flag, color: p.color })),
    matches: t.matches.map(m => ({ ...m, label: roundName(m.round, t.rounds), ...{ rules: rulesFor(t, m.round) } }))
  };
}
export type PublicTournament = ReturnType<typeof publicView>;
export type PublicMatch = PublicTournament['matches'][number];
export type PublicPlayer = PublicTournament['players'][number];

export function cleanName(s: unknown): string {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
}
