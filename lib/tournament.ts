// The knockout bracket: pure functions over a plain JSON document, so the same
// code runs in API routes and in tests. The cup plays one match at a time, in
// bracket order (see currentMatch).

export type Player = { id: string; name: string; flag: string; color: string; tokenHash: string; joinedAt: number };
export type MatchStatus = 'waiting' | 'ready' | 'live' | 'done';
export type Match = {
  id: string; round: number; index: number;
  a: string | null; b: string | null;
  status: MatchStatus; score: [number, number]; winner: string | null;
  via?: 'played' | 'walkover' | 'admin' | 'bye' | 'local';
  local?: 'admin' | 'host';       // being played on one device instead of online: the organiser's, or the host's
  net?: Net;                      // how it was played once it kicked off (the rule may change later)
  gen?: number;                   // goes up when the organiser resets it: a match server room from before is dropped
  startedAt?: number; endedAt?: number; updatedAt?: number;
};
// how online matches run: on the match server (default), or peer to peer between the two browsers
export type Net = 'server' | 'p2p';
// equalDelay: peer to peer without prediction: both players see the match equally late (the round trip)
// inputDelay: ticks (1/60 s) every press waits on every screen, 0-4: shorter catch-ups for a later press
export type Rules = { goals: number; capSec: number; finalGoals: number; finalCapSec: number; modifiers: boolean; equalDelay?: boolean; net?: Net; inputDelay?: number };
export type Tournament = {
  code: string; name: string; createdAt: number; adminKeyHash: string;
  status: 'lobby' | 'running' | 'finished';
  rules: Rules; players: Player[]; matches: Match[]; rounds: number;
  champion: string | null; startedAt?: number; finishedAt?: number;
  upNext?: string | null;         // the organiser picked this match to be played next
  genBase?: number;               // a new draw's matches start their generation here, above every earlier draw's
};

// one match at a time: about 90 seconds a match fits 15 matches (16 players) into a 30-minute slot
export const DEFAULT_RULES: Rules = { goals: 3, capSec: 90, finalGoals: 5, finalCapSec: 150, modifiers: true, equalDelay: false, net: 'server', inputDelay: 2 };
export const MAX_PLAYERS = 64;

export function roundName(round: number, rounds: number): string {
  const left = rounds - round;
  if (left === 0) return 'Final';
  if (left === 1) return 'Semi-finals';
  if (left === 2) return 'Quarter-finals';
  return 'Round of ' + (2 ** (left + 1));
}

// a match's rules; serverOn: whether this site has a match server (without one, matches run peer to peer)
export function rulesFor(t: Pick<Tournament, 'rules' | 'rounds'>, round: number, serverOn = false, m?: Pick<Match, 'net'>) {
  const final = round === t.rounds;
  return {
    goals: final ? t.rules.finalGoals : t.rules.goals,
    capSec: final ? t.rules.finalCapSec : t.rules.capSec,
    modifiers: t.rules.modifiers,
    equalDelay: !!t.rules.equalDelay,
    net: (m && m.net) || netRule(t.rules, serverOn),
    inputDelay: inputDelayOf(t.rules),
    label: roundName(round, t.rounds)
  };
}
export function netRule(r: Pick<Rules, 'net'>, serverOn: boolean): Net {
  return serverOn && r.net !== 'p2p' ? 'server' : 'p2p';
}
export function inputDelayOf(r: Pick<Rules, 'inputDelay'>) {
  const n = Math.round(Number(r.inputDelay ?? DEFAULT_RULES.inputDelay));
  return Number.isFinite(n) ? Math.min(4, Math.max(0, n)) : 2;
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

// Match ids repeat from one draw to the next (r1m1...), so a new draw's matches carry on
// counting generations above the old ones: a match server room still open from the old
// draw is then closed when the new match opens, and its late reports are refused.
function keepGens(t: Tournament): number {
  let base = t.genBase || 0;
  for (const m of t.matches || []) base = Math.max(base, (m.gen || 0) + 1);
  t.genBase = base;
  return base;
}

// back to the lobby: the players stay, the bracket goes
export function restartCup(t: Tournament) {
  keepGens(t);
  t.status = 'lobby'; t.matches = []; t.rounds = 0; t.champion = null; t.startedAt = undefined; t.finishedAt = undefined; t.upNext = null;
}

export function buildBracket(t: Tournament, rand: () => number = Math.random) {
  const ps = t.players.slice();
  for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; }
  const n = ps.length;
  let size = 2;
  while (size < n) size *= 2;
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const base = keepGens(t);
  const matches: Match[] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let i = 0; i < count; i++) {
      const m: Match = { id: matchId(r, i), round: r, index: i, a: null, b: null, status: 'waiting', score: [0, 0], winner: null };
      if (base) m.gen = base;
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
  t.upNext = null;
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
  if (t.upNext === m.id) t.upNext = null;
  const nx = nextOf(t, m);
  if (!nx) { t.champion = winner; t.status = 'finished'; t.finishedAt = Date.now(); return; }
  nx.match[nx.slot] = winner;
  if (nx.match.a && nx.match.b && nx.match.status === 'waiting') nx.match.status = 'ready';
}

export type ResultError = 'no-match' | 'not-ready' | 'already-done' | 'bad-winner' | 'next-started';

// a match kicking off (online, or on one device when local)
export function markLive(m: Match, local?: 'admin' | 'host', net?: Net, t?: Tournament) {
  if (m.status !== 'ready' && m.status !== 'live') return false;
  if (m.status === 'ready') { m.startedAt = Date.now(); m.score = [0, 0]; }
  m.status = 'live';
  if (local) m.local = local;
  if (net && !m.net) m.net = net;
  if (t && t.upNext === m.id) t.upNext = null;           // the organiser's pick has started
  m.updatedAt = Date.now();
  return true;
}

/* ---------------- one match at a time ---------------- */
// the order the matches are played in: round by round, top to bottom of the bracket
export function playingOrder(t: Pick<Tournament, 'matches'>): Match[] {
  return t.matches.slice().sort((a, b) => a.round - b.round || a.index - b.index);
}
// The match on now, or called next: one that is live; else the one the organiser picked;
// else the first ready one in playing order. Byes and finished matches are skipped.
export function currentMatch(t: Pick<Tournament, 'matches' | 'status' | 'upNext'>): Match | null {
  if (t.status !== 'running') return null;
  const order = playingOrder(t);
  const live = order.find(m => m.status === 'live');
  if (live) return live;
  const pick = t.upNext ? order.find(m => m.id === t.upNext && m.status === 'ready') : null;
  return pick || order.find(m => m.status === 'ready') || null;
}
// After the organiser moves the turn (calling another match next, or playing one on their own
// device), `before` being the match that was on: if it lost the turn before kicking off, it gets
// a new generation. Its players may already be waiting in its room on the match server, on
// tickets they got while it was on, and that room must not kick off alongside the match on now.
// With the new generation the match server drops the room, the old tickets' kick-off and results
// are refused, and the players' pages leave it; they get new tickets when it is on again. A
// match already live keeps the turn, so it is never moved.
export function dropSkipped(t: Tournament, before: Match | null) {
  if (before && before !== currentMatch(t) && before.status === 'ready') {
    before.gen = (before.gen || 0) + 1;
    before.updatedAt = Date.now();
  }
}
// The organiser calls a ready match to be played next (someone in the match on now is late,
// say), or takes the call back (null).
export function callNext(t: Tournament, id: string | null): 'no-match' | 'not-ready' | null {
  const before = currentMatch(t);
  if (id === null) t.upNext = null;
  else {
    const m = getMatch(t, id);
    if (!m) return 'no-match';
    if (m.status !== 'ready') return 'not-ready';
    t.upNext = m.id;
  }
  dropSkipped(t, before);
  return null;
}
// the matches still to play, in the order they come up: the current one first
export function matchQueue(t: Pick<Tournament, 'matches' | 'status' | 'upNext'>): Match[] {
  const cur = currentMatch(t);
  if (!cur) return [];
  const rest = playingOrder(t).filter(m => m !== cur && m.status !== 'done');
  const pick = t.upNext ? rest.find(m => m.id === t.upNext && m.status === 'ready') : null;
  return [cur, ...(pick ? [pick] : []), ...rest.filter(m => m !== pick)];
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
  m.winner = null; m.score = [0, 0]; m.via = undefined; m.local = undefined; m.net = undefined; m.startedAt = undefined; m.endedAt = undefined;
  m.status = m.a && m.b ? 'ready' : 'waiting';
  m.gen = (m.gen || 0) + 1;
  m.updatedAt = Date.now();
  return null;
}

// what the public sees: no token or admin hashes. serverOn: this site has a match server
export function publicView(t: Tournament, serverOn = false) {
  const queue = matchQueue(t).map(m => m.id);
  return {
    code: t.code, name: t.name, status: t.status, rules: { ...DEFAULT_RULES, ...t.rules }, rounds: t.rounds, champion: t.champion,
    startedAt: t.startedAt || null, finishedAt: t.finishedAt || null,
    matchServer: serverOn,
    // one match at a time: the match on now, the one after it, and everything still to play in order
    current: queue[0] || null, next: queue[1] || null, queue, upNext: t.upNext || null,
    players: t.players.map(p => ({ id: p.id, name: p.name, flag: p.flag, color: p.color })),
    matches: t.matches.map(m => ({ ...m, label: roundName(m.round, t.rounds), ...{ rules: rulesFor(t, m.round, serverOn, m) } }))
  };
}
export type PublicTournament = ReturnType<typeof publicView>;
export type PublicMatch = PublicTournament['matches'][number];
export type PublicPlayer = PublicTournament['players'][number];

export function cleanName(s: unknown): string {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
}

// The organiser takes a player out of the lobby, usually a second entry: someone whose
// browser froze joined again from another one, and the join gave them a numbered name
// ("Ana 2"). With the old "Ana" gone, the lowest-numbered copy gets the plain name back.
// False when there is no such player.
export function removePlayer(t: Tournament, playerId: string): boolean {
  const gone = t.players.find(p => p.id === playerId);
  if (!gone) return false;
  t.players = t.players.filter(p => p.id !== playerId);
  const base = gone.name.slice(0, 15).toLowerCase();       // as the join numbers names
  let copy: Player | null = null, lowest = Infinity;
  for (const p of t.players) {
    const m = /^(.*) (\d+)$/.exec(p.name);
    const n = m ? Number(m[2]) : 0;
    if (m && n >= 2 && m[1].toLowerCase() === base && n < lowest) { copy = p; lowest = n; }
  }
  if (copy) {
    const own = copy.name.replace(/ \d+$/, '');
    const plain = own.toLowerCase() === gone.name.toLowerCase() ? own : gone.name;      // a long name was cut short to fit the number
    if (!t.players.some(p => p !== copy && p.name.toLowerCase() === plain.toLowerCase())) copy.name = plain;
  }
  return true;
}
