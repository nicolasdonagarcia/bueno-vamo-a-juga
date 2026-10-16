// One match on the match server: its simulation, the two players' seats, the
// organiser's screen, the ready check, pauses, and the result.
//
// The server's match is the only real one. Each player's page runs its own copy a
// little ahead (prediction) and sends every press stamped with the tick it goes in on;
// the room applies it on that tick, answers how many ticks it had to spare, and passes
// it on to the other player at once. Players get the full state 20 times a second, the
// organiser's screen small snapshots 30 times a second.
import { createSim } from '../lib/engine/sim.js';
import { encodeFrame, TICK } from '../lib/engine/shared.js';
import type { Ticket } from '../lib/ticket.ts';
import type { Reporter } from './report.ts';

export type Conn = {
  id: number;
  seat: number;                 // 0 left, 1 right, -1 a viewer (the organiser, or anyone with the cup's link), -2 before it said hello
  inst: string;                 // the page load it comes from
  room: Room | null;
  sendText(s: string): void;
  sendBin(buf: ArrayBuffer): void;      // skipped while the connection is backed up
  close(code?: number, why?: string): void;
  pressTimes: number[];         // for the press limit
  lastSeen: number;             // the last message from it (pages ping once a second)
};
type Fx = { type: number; x: number; y: number; v: number };
export type RoomDeps = {
  log: (s: string) => void;
  reporter: (code: string, match: string, gen: number, onFinal: (ok: boolean, msg: string) => void) => Reporter;
};

const RESUME_MS = 3000;
const MAX_PRESSES_PER_SEC = 25;
// Anyone who has the cup's link can watch the match on now, so a room takes only so many
// viewers (the cup holds up to 64 players); the next one is told "full" and can try again.
const MAX_VIEWERS = Math.max(1, Number(process.env.MAX_VIEWERS) || 120);

export type Room = ReturnType<typeof createRoom>;

export function createRoom(t: Ticket, deps: RoomDeps) {
  const key = t.c + ':' + t.m;
  const gen = t.g;
  let players = [t.a, t.b];
  let rules = { ...t.r };
  let resumeScore: [number, number] | null = t.st === 'live' ? t.sc : null;   // the server restarted mid-match: carry on from the saved score
  let autoStart = t.st === 'live';
  const seats: (Conn | null)[] = [null, null];
  const spectators = new Set<Conn>();
  const ready = [false, false];
  let started = false, paused = false, over = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null, resumeAt = 0;
  let tickN = 0, tickFx: Fx[] = [], netFx: Fx[] = [];
  let lastActive = Date.now(), endedAt = 0, result: { saved: boolean; msg: string } | null = null;
  const log = (s: string) => deps.log(key + ' ' + s);
  const report = deps.reporter(t.c, t.m, gen, (ok, msg) => {
    result = { saved: ok, msg };
    log(ok ? 'result saved' : 'result not saved: ' + msg);
    broadcast({ k: 'result', saved: ok, msg });
  });

  const sim = createSim({
    mode: 'server', authority: true, rules: { goals: rules.goals, capSec: rules.capSec, modifiers: rules.modifiers },
    forceRound: process.env.MATCH_TEST === '1' && t.fr ? t.fr : undefined,
    players: players.map(p => ({ color: p.color })),
    onEvent: (ev: Record<string, unknown>) => broadcast({ k: 'ev', ev }),
    onFx: (type: number, x: number, y: number, v: number) => { tickFx.push({ type, x, y, v }); },
    onScore: (sc: [number, number], info: { over: boolean }) => {
      if (info.over) report({ kind: 'final', score: sc, winner: sc[0] > sc[1] ? 'a' : 'b' });
      else report({ kind: 'score', score: sc });
    },
    onEnd: (e: { winner: number; score: [number, number] }) => {
      over = true; endedAt = Date.now();
      report({ kind: 'final', score: e.score, winner: e.winner === 0 ? 'a' : 'b' });
      log('full time ' + e.score.join('-'));
      broadcastLobby();
    }
  });
  sim.resetRound({ roll: true, normal: true });          // the men on their spots for the warm-up

  function json(msg: unknown) { return JSON.stringify(msg); }
  function send(c: Conn | null, msg: unknown) { if (c) c.sendText(json(msg)); }
  function broadcast(msg: unknown) {
    const s = json(msg);
    for (const c of seats) if (c) c.sendText(s);
    for (const c of spectators) c.sendText(s);
  }
  function both() { return !!(seats[0] && seats[1]); }
  function lobbyMsg() {
    return { k: 'lobby', ready: ready.slice(), conn: [!!seats[0], !!seats[1]], started, paused, over, viewers: spectators.size,
      resumeMs: resumeAt ? Math.max(0, resumeAt - Date.now()) : 0,
      carryOn: !started && autoStart ? resumeScore || [0, 0] : null };     // it kicked off before: it starts again as soon as both are in
  }
  function broadcastLobby() { broadcast(lobbyMsg()); }
  function syncMsg() {
    return {
      k: 'sync', players: players.map(p => ({ name: p.name, color: p.color, flag: p.flag || null })),
      rules: { goals: rules.goals, capSec: rules.capSec, modifiers: rules.modifiers },
      round: Object.assign(sim.roundEvent(), { t: sim.hostClock }), score: sim.score.slice(), phase: sim.phase, t: sim.hostClock
    };
  }

  function start() {
    if (started) return;
    started = true; autoStart = false;
    sim.startCountdown(resumeScore);
    paused = false; sim.setPaused(false);
    report({ kind: 'start' });
    log('kick-off' + (resumeScore ? ' from ' + resumeScore.join('-') : ''));
    broadcast({ k: 'start' });
    broadcastLobby();
  }
  function resumeSoon() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeAt = Date.now() + RESUME_MS;
    broadcast({ k: 'resume', ms: RESUME_MS });
    broadcastLobby();
    resumeTimer = setTimeout(() => {
      resumeTimer = null; resumeAt = 0;
      if (!both() || over) { broadcastLobby(); return; }
      paused = false; sim.setPaused(false);
      log('resumed');
      broadcast({ k: 'resumed' });
      broadcastLobby();
    }, RESUME_MS);
  }

  const room = {
    key, gen,
    get started() { return started; },
    get over() { return over; },
    // a newer ticket for the same match (the organiser may have changed the rules before kick-off)
    update(tk: Ticket) {
      if (started) return;
      players = [tk.a, tk.b];
      rules = { ...tk.r };
      sim.rules = { goals: rules.goals, capSec: rules.capSec, modifiers: rules.modifiers };
      if (tk.st === 'live' && !resumeScore) { resumeScore = tk.sc; autoStart = true; }
    },
    join(c: Conn, seat: number, inst: string) {
      lastActive = Date.now();
      c.room = room; c.seat = seat; c.inst = inst;
      if (seat === 0 || seat === 1) {
        const old = seats[seat];
        if (old && old !== c) {             // the same player from another page (or this page after a reload)
          old.room = null;
          send(old, { k: 'bye', why: 'elsewhere' });
          old.close(4001, 'elsewhere');
        }
        seats[seat] = c;
        sim.resetSeq(seat);                 // a (re)connected page numbers its presses from its own start
        log('player ' + seat + ' in' + (old && old !== c ? ' (replacing a connection)' : ''));
      } else {
        if (spectators.size >= MAX_VIEWERS) {
          c.room = null;
          send(c, { k: 'denied', why: 'full' });
          setTimeout(() => c.close(4003, 'full'), 50);
          log('viewer turned away: ' + MAX_VIEWERS + ' already watching');
          return;
        }
        spectators.add(c);
        log('viewer watching (' + spectators.size + ')');
      }
      send(c, { k: 'welcome', seat, match: { id: t.m, label: t.lb }, inputDelay: rules.inputDelay, players: players.map(p => ({ id: p.id, name: p.name })) });
      send(c, syncMsg());
      if (seat >= 0) c.sendBin(sim.captureState());      // something to draw straight away, even while paused
      if (result) send(c, { k: 'result', ...result });
      if (seat >= 0 && started && paused && !over && both()) resumeSoon();
      else if (seat >= 0 && !started && autoStart && both()) start();
      else broadcastLobby();
      if (seat < 0) send(c, lobbyMsg());
    },
    leave(c: Conn) {
      lastActive = Date.now();
      if (c.room !== room) return;
      c.room = null;
      if ((c.seat === 0 || c.seat === 1) && seats[c.seat] === c) {
        seats[c.seat] = null;
        log('player ' + c.seat + ' left');
        if (started && !over) {
          paused = true; sim.setPaused(true);
          if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; resumeAt = 0; }
        } else if (!started) ready[c.seat] = false;
        broadcastLobby();
      } else if (spectators.delete(c)) broadcastLobby();
    },
    ready(c: Conn) {
      if (c.room !== room || (c.seat !== 0 && c.seat !== 1) || started) return;
      ready[c.seat] = true;
      broadcastLobby();
      if (ready[0] && ready[1] && both()) start();
    },
    press(c: Conn, msg: Record<string, unknown>) {
      if (c.room !== room || (c.seat !== 0 && c.seat !== 1)) return;
      const now = Date.now();
      c.pressTimes.push(now);
      while (c.pressTimes.length && c.pressTimes[0] < now - 1000) c.pressTimes.shift();
      const q = Number(msg.q) >>> 0;
      if (c.pressTimes.length > MAX_PRESSES_PER_SEC) { send(c, { k: 'pa', q, sl: 0 }); return; }
      const slots = Array.isArray(msg.s) ? (msg.s as unknown[]).slice(0, 2).map(Number) : [];
      const leans = Array.isArray(msg.l) ? (msg.l as unknown[]).slice(0, 2).map(Number) : null;
      const r = sim.queuePress(c.seat, slots, Number(msg.n), q, leans, typeof msg.v === 'number' ? msg.v : undefined);
      send(c, { k: 'pa', q, sl: r.slack });
      const other = seats[1 - c.seat];
      if (!r.dropped && other) {
        r.slots.forEach((s: number, i: number) => {
          const man = sim.bySlot[s];
          const l = r.leans[i] != null ? r.leans[i] : man ? Math.atan2(Math.sin(man.torso.getAngle()), Math.cos(man.torso.getAngle())) : 0;
          send(other, { k: 'op', s, n: r.at, l, r: sim.round });
        });
      }
    },
    // once per tick (60 a second) from the server's loop
    tick() {
      const anyone = !!(seats[0] || seats[1]);
      if (paused || (!started && !anyone) || (over && !anyone && !spectators.size)) return;
      sim.tick(TICK);
      tickN++;
      if (spectators.size) {
        for (const e of tickFx) netFx.push(e);
        if (tickN % 2 === 0) {
          const buf = encodeFrame(sim.captureFrame(netFx));
          netFx = [];
          for (const c of spectators) c.sendBin(buf);
        }
      }
      tickFx = [];
      if (tickN % 3 === 0 && anyone) {
        const buf = sim.captureState();
        for (const c of seats) if (c) c.sendBin(buf);
      }
    },
    // whether the room can go: nobody left, and nothing left to wait for
    idle(now: number) {
      if (seats[0] || seats[1] || spectators.size) return false;
      const quiet = now - lastActive;
      if (over) return quiet > 30000;
      if (!started) return quiet > 10 * 60000;
      return quiet > 30 * 60000;
    },
    close(why: string) {
      if (resumeTimer) clearTimeout(resumeTimer);
      for (const c of [...seats, ...spectators]) {
        if (!c) continue;
        c.room = null;
        send(c, { k: 'bye', why });
        c.close(4002, why);
      }
      seats[0] = seats[1] = null;
      spectators.clear();
    },
    info() {
      return { key, gen, players: players.map(p => p.name), seats: [!!seats[0], !!seats[1]], viewers: spectators.size, ready: ready.slice(),
        started, paused, over, phase: sim.phase, score: sim.score.slice(), round: sim.round, ticks: sim.ticks, leans: { ...sim.leanStats }, result,
        endedAgoS: endedAt ? Math.round((Date.now() - endedAt) / 1000) : null };
    }
  };
  log('room for ' + players[0].name + ' v ' + players[1].name + (resumeScore ? ', carrying on from ' + resumeScore.join('-') : ''));
  return room;
}
