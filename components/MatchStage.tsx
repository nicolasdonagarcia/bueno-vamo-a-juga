'use client';
/* One online match on this device.
   On the match server (transport 'server'), the server runs the match: both players
   run their own copy a little ahead (prediction) and viewers draw the server's
   snapshots. Peer to peer (transport 'p2p'), the left-hand player's browser runs it
   instead.
     host       player A, the left team (peer to peer: runs the physics, connects to the guest and viewers)
     guest      player B, the right team
     spectator  a viewer: anyone with the cup's link on the match server (the match on now),
                the organiser with the admin key (any match; peer to peer, only the organiser) */
import { useEffect, useRef, useState } from 'react';
import { resolveKits } from '@/lib/engine/shared';
import { Snd } from '@/lib/engine/sound';
import { ApiError, BOTS_ALLOWED, api, getIce, rulesLine, sleep, wsUrl } from '@/lib/client';
import type { PublicMatch, PublicPlayer } from '@/lib/tournament';
import type { GameApi, LinkApi, ServerLinkApi } from '@/lib/engine/types';
import { PlayerChip } from './bits';
import { Trophy } from './Trophy';

export type StageRole = 'host' | 'guest' | 'spectator';
export type Transport = 'server' | 'p2p';

type Ui = {
  conn: 'connecting' | 'open' | 'lost';
  peer: [boolean, boolean];        // on the match server: who is connected
  rtt: number | null;
  relay: boolean | null;
  ready: [boolean, boolean];
  iAmReady: boolean;
  started: boolean;
  paused: boolean;
  resumeAt: number | null;
  ended: { winner: number; score: [number, number] } | null;
  stale: boolean;
  save: 'idle' | 'saving' | 'saved' | 'error';
  saveMsg: string;
  waitedLong: boolean;
  denied: string | null;
  elsewhere: boolean;
  carryOn: [number, number] | null;  // on the match server: it had kicked off (before a restart, say), so it carries on as soon as both are in
};

const INITIAL: Ui = {
  conn: 'connecting', peer: [false, false], rtt: null, relay: null, ready: [false, false], iAmReady: false, started: false, paused: false,
  resumeAt: null, ended: null, stale: false, save: 'idle', saveMsg: '', waitedLong: false, denied: null, elsewhere: false, carryOn: null
};

type Props = {
  role: StageRole;
  transport: Transport;
  code: string;
  m: PublicMatch;
  pa: PublicPlayer;
  pb: PublicPlayer;
  token: string | null;
  bot?: number;
  resumeScore?: [number, number] | null;
  nextLabel?: string | null;       // where the winner goes next ('Final', ...), null after the final
  serverResult?: { winner: string | null; score: [number, number]; via?: string } | null;  // what the bracket has, once done
  onExit: () => void;
  onLocal?: () => void;            // player A: move the match to this device
  onEnded?: () => void;            // called a few seconds after the result is on screen
  full?: boolean;
  adminKey?: string | null;        // spectator: the organiser's key (any match); without it, anyone watches the match on now (peer to peer: only the organiser)
  netLine?: boolean;               // show the network line under the pitch
};

export default function MatchStage(p: Props) {
  const { role, m, pa, pb } = p;
  const rootRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameApi | null>(null);
  const statsRef = useRef<() => Record<string, unknown>>(() => ({}));
  const [ui, setUi] = useState<Ui>(INITIAL);
  const act = useRef<{ ready: () => void }>({ ready: () => { } });
  const first = useRef(p);
  const me = role === 'host' ? 0 : role === 'guest' ? 1 : -1;
  const rules = m.rules;
  const server = p.transport === 'server';

  useEffect(() => {
    const P = first.current;
    const SERVER = P.transport === 'server';
    const set = (x: Partial<Ui>) => setUi(u => ({ ...u, ...x }));
    let dead = false, game: GameApi | null = null, link: LinkApi | null = null, slink: ServerLinkApi | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => { timers.push(setTimeout(() => { if (!dead) fn(); }, ms)); };
    // guestBuf (peer to peer without prediction): how long the guest's picture waits for frames
    // (it says so every second); the host waits the trip plus that
    const S = { ready: [false, false] as [boolean, boolean], started: false, over: false, shown: false, paused: false, iAmReady: false, guestBuf: 45, rtt: null as number | null,
      resumeTimer: 0 as unknown as ReturnType<typeof setTimeout>, finalBody: null as null | Record<string, unknown>, finalDone: false };
    const base = '/api/t/' + encodeURIComponent(P.code) + '/m/' + encodeURIComponent(P.m.id);

    // ---- peer-to-peer host: results go to the app (on the match server, the server reports) ----
    async function report(kind: 'start' | 'score', score?: [number, number]) {
      for (let i = 0; i < 3 && !dead; i++) {
        try { await api(base + '/report', { token: P.token, kind, score }); return; }
        catch (e) { if (e instanceof ApiError && e.status >= 400 && e.status < 500) return; await sleep(1200); }
      }
    }
    async function reportFinal(score: [number, number]) {
      if (S.finalBody) return;
      S.finalBody = { token: P.token, kind: 'final', score, winner: score[0] > score[1] ? 'a' : 'b' };
      set({ save: 'saving' });
      for (let i = 0; i < 40; i++) {            // keeps going even if the page moves on
        try {
          await api(base + '/report', S.finalBody);
          S.finalDone = true;
          if (!dead) set({ save: 'saved' });
          return;
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
            S.finalDone = true;
            if (!dead) set({ save: 'error', saveMsg: e.message });
            return;
          }
          await sleep(1500 + i * 250);
        }
      }
      if (!dead) set({ save: 'error', saveMsg: 'Could not save the result. Tell the organiser the score.' });
    }
    const onPageHide = () => {
      if (S.finalBody && !S.finalDone && navigator.sendBeacon) navigator.sendBeacon(base + '/report', JSON.stringify(S.finalBody));
    };
    window.addEventListener('pagehide', onPageHide);

    const lobbyMsg = () => ({ k: 'lobby', ready: S.ready, started: S.started, paused: S.paused });
    const pushLobby = () => { if (link) link.send(lobbyMsg()); set({ ready: [S.ready[0], S.ready[1]] }); };

    function maybeStart() {
      if (role !== 'host' || SERVER || S.started || !S.ready[0] || !S.ready[1] || !link || !link.isOpen('guest') || !game) return;
      S.started = true;
      link.send({ k: 'start' });
      game.startMatch({ score: P.resumeScore || undefined });
      pushLobby();
      set({ started: true });
      report('start');
    }
    function resumeSoon() {
      const ms = 3000;
      clearTimeout(S.resumeTimer);
      link?.send({ k: 'resume', ms });
      set({ resumeAt: Date.now() + ms });
      S.resumeTimer = setTimeout(() => {
        if (dead || !link || !link.isOpen('guest') || !game) return;
        S.paused = false; game.setPaused(false);
        link.send({ k: 'resumed' });
        set({ paused: false, resumeAt: null });
      }, ms);
    }
    function showEnd(score: [number, number], winner: number) {
      if (S.shown) return;
      S.shown = true; S.over = true;
      later(2400, () => {
        set({ ended: { winner, score } });
        later(P.bot ? 2500 : 7000, () => P.onEnded?.());
        later(15000, () => { link?.close(); link = null; slink?.close(); slink = null; });    // nothing left to send
      });
    }

    // viewers never press a button, so sound starts with the first tap anywhere
    const unlock = () => Snd.unlock();
    if (role === 'spectator') { Snd.unlock(); window.addEventListener('pointerdown', unlock); }

    act.current.ready = () => {
      Snd.unlock();
      if (S.iAmReady) return;
      S.iAmReady = true;
      set({ iAmReady: true });
      if (SERVER) slink?.send({ k: 'ready' });
      else if (role === 'host') { S.ready[0] = true; pushLobby(); maybeStart(); }
      else if (role === 'guest') link?.send({ k: 'ready' });
    };

    // the messages both kinds of authority send to players and viewers
    function mirror(g: GameApi, msg: Record<string, unknown>) {
      switch (msg.k) {
        case 'sync': g.applySync(msg as never); break;
        case 'ev': g.applyRemoteEvent(msg.ev as never); break;
        case 'lobby': {
          const r = (msg.ready || [false, false]) as [boolean, boolean];
          const c = (msg.conn || [true, true]) as [boolean, boolean];
          S.started = !!msg.started;
          const co = Array.isArray(msg.carryOn) ? msg.carryOn as [number, number] : null;
          const x: Partial<Ui> = { ready: [!!r[0], !!r[1]], started: !!msg.started, paused: !!msg.paused, peer: [!!c[0], !!c[1]], carryOn: co ? [Number(co[0]) || 0, Number(co[1]) || 0] : null };
          if (!msg.paused) x.resumeAt = null;
          else if (Number(msg.resumeMs) > 0) x.resumeAt = Date.now() + Number(msg.resumeMs);
          set(x);
          break;
        }
        case 'start': S.started = true; set({ started: true }); break;
        case 'resume': set({ paused: true, resumeAt: Date.now() + Number(msg.ms || 3000) }); break;
        case 'resumed': set({ paused: false, resumeAt: null }); break;
        case 'pa': g.pressAck(Number(msg.q), Number(msg.sl)); break;
        case 'hp': case 'op': g.otherPress(Number(msg.s), Number(msg.n), Number(msg.l), Number(msg.r)); break;
      }
    }

    (async () => {
      const [{ createGame }, mod, ice] = await Promise.all([
        import('@/lib/engine/game'),
        SERVER ? import('@/lib/net/serverLink') : import('@/lib/net/link'),
        SERVER ? Promise.resolve([] as RTCIceServer[]) : getIce()
      ]);
      if (dead || !rootRef.current) return;
      const players = [P.pa, P.pb].map(x => ({ name: x.name, color: x.color, flag: x.flag }));
      const gameRules = { goals: P.m.rules.goals, capSec: P.m.rules.capSec, modifiers: P.m.rules.modifiers };
      const lite = P.bot ? { renderEvery: 3, maxDpr: 1 } : {};
      // test builds: ?lag=75&jitter=10 adds that much delay to this side's connection (peer to
      // peer: to what it receives; on the match server: both ways); ?delay=2 overrides the input
      // delay (peer to peer has none, as before the match server); ?net=fair turns prediction
      // off peer to peer, like the "Equal delay" rule
      const q = BOTS_ALLOWED ? new URLSearchParams(window.location.search) : null;
      const fakeLag = q && q.get('lag') ? { ms: Number(q.get('lag')) || 0, jitter: Number(q.get('jitter')) || 0 } : undefined;
      const inputDelay = q && q.get('delay') != null ? Number(q.get('delay')) : SERVER ? P.m.rules.inputDelay : 0;

      if (SERVER) {
        const { createServerLink } = mod as typeof import('@/lib/net/serverLink');
        const g = createGame(rootRef.current, {
          mode: me >= 0 ? 'player' : 'spectator', team: me >= 0 ? me : undefined, players, rules: gameRules, inputDelay,
          bot: P.bot ? { skill: P.bot } : undefined, ...lite,
          hooks: {
            onPress: (s: number[], _vt?: number, n?: number, seq?: number, l?: number[], v?: number) => slink?.send({ k: 'press', s, n, q: seq, l, v }),
            onEndShown: (e: { winner: number; score: [number, number] }) => showEnd(e.score, e.winner)
          }
        });
        game = g; gameRef.current = g;
        g.setViewDelay(me < 0 ? 160 : 30);        // the organiser's screen prefers smooth
        const l = createServerLink({
          fakeLag,
          getTicket: async () => {
            try {
              // a player's seat; the organiser (admin key) watching; or anyone else watching the match on now
              const r = await api<{ ticket: string; url: string }>(base + '/ticket', me >= 0 ? { token: P.token } : P.adminKey ? { key: P.adminKey } : { watch: true });
              return { ticket: r.ticket, url: wsUrl(r.url) };
            } catch (e) {
              if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410)) {
                const x = new Error(e.message) as Error & { fatal?: boolean };
                x.fatal = true;
                throw x;
              }
              throw e;
            }
          },
          handlers: {
            log: BOTS_ALLOWED ? (s: string) => console.debug('[match server ' + role + '] ' + s) : undefined,
            onOpen: () => {
              set({ conn: 'open', stale: false, elsewhere: false });
              if (me >= 0 && S.iAmReady) l.send({ k: 'ready' });
              if (me >= 0 && P.bot) later(400, () => act.current.ready());
            },
            onClose: () => set({ conn: 'lost' }),
            onDenied: (why: string) => set({ denied: why || 'denied' }),
            onState: (buf: ArrayBuffer) => g.pushSnapshot(buf),
            onRtt: (rtt: number) => { S.rtt = rtt; g.setRtt(rtt); set({ rtt }); },
            onCtl: (msg: Record<string, unknown>) => {
              if (msg.k === 'result') set({ save: msg.saved ? 'saved' : 'error', saveMsg: msg.saved ? '' : 'The result did not reach the bracket (' + String(msg.msg || '') + '). Tell the organiser the score.' });
              else if (msg.k === 'bye') { if (msg.why === 'elsewhere') set({ elsewhere: true }); }
              else mirror(g, msg);
            }
          }
        });
        slink = l;
        statsRef.current = () => ({ ...g.netStats(), jitterMs: l.jitter != null ? Math.round(l.jitter) : null, rttMs: l.rtt != null ? Math.round(l.rtt) : null, pred: g.debug.pred, transport: 'server', seat: me });
        if (BOTS_ALLOWED) (window as unknown as { __cc: unknown }).__cc = { game: g, link: l, role, transport: 'server', match: P.m.id };
        return;
      }

      // ---------------- peer to peer ----------------
      const { createLink } = mod as typeof import('@/lib/net/link');
      const predict = !P.m.rules.equalDelay && !(q && q.get('net') === 'fair');
      // host: snapshots for the organiser's screen and the guest's fallback picture, 30 a second
      // with prediction (the guest draws its own copy), every tick without it
      const g = createGame(rootRef.current, {
        mode: role, players, rules: gameRules, bot: P.bot ? { skill: P.bot } : undefined, predict, snapEvery: predict ? 2 : 1, inputDelay: predict ? inputDelay : 0, ...lite,
        hooks: {
          onSnapshot: (buf: ArrayBuffer) => link?.sendState(buf),
          onFullState: (buf: ArrayBuffer) => link?.sendState(buf, 'guest'),
          onPressAck: (seq: number, slack: number) => link?.send({ k: 'pa', q: seq, sl: slack }, 'guest'),
          onHostPress: (s: number, n: number, l: number, r: number) => link?.send({ k: 'hp', s, n, l, r }, 'guest'),
          onEvent: (ev: unknown) => link?.send({ k: 'ev', ev }),
          onPress: (s: number[], vt?: number, n?: number, seq?: number, l?: number[], v?: number) => link?.send({ k: 'press', s, vt, n, q: seq, l, v }),
          onScore: (sc: [number, number], info: { over: boolean }) => {
            if (role !== 'host') return;
            if (info.over) { S.over = true; reportFinal(sc); } else report('score', sc);
          },
          onEnd: (e: { winner: number; score: [number, number] }) => { if (role === 'host') { S.over = true; reportFinal(e.score); } },
          onEndShown: (e: { winner: number; score: [number, number] }) => showEnd(e.score, e.winner)
        }
      });
      game = g;
      gameRef.current = g;
      // With prediction the guest's own men react at once and the host draws its match as it
      // happens. Without it the guest's picture waits only as long as its connection needs (at
      // least 30 ms) and the host waits the round trip plus that, so both react equally late.
      // The organiser's screen prefers smooth.
      g.setViewDelay(role === 'spectator' ? 160 : role === 'guest' ? 30 : predict ? 0 : 75);

      const l = createLink({
        code: P.code, matchId: P.m.id, role, token: P.token, adminKey: P.adminKey || undefined, iceServers: ice, fakeLag,
        handlers: {
          log: BOTS_ALLOWED ? (s: string) => console.debug('[link ' + role + '] ' + s) : undefined,     // test builds: what the link is doing
          onDenied: () => set({ denied: 'denied' }),
          onOpen: (key: string) => {
            if (role === 'host') {
              l.send(g.getSync(), key);
              l.send(lobbyMsg(), key);
              if (key === 'guest') {
                g.resetGuest();
                later(300, () => g.sendFullState());        // after the sync has landed
                set({ conn: 'open', peer: [true, true] });
                if (S.started && S.paused && !S.over) resumeSoon();
              }
            } else {
              set({ conn: 'open', stale: false, peer: [true, true] });
              if (role === 'guest' && S.iAmReady) l.send({ k: 'ready' });
              if (role === 'guest' && P.bot) later(400, () => act.current.ready());
            }
          },
          onClose: (key: string) => {
            if (role === 'host') {
              if (key !== 'guest') return;
              set({ conn: 'lost', relay: null, peer: [true, false] });
              if (!S.started) { S.ready[1] = false; pushLobby(); }
              else if (!S.over) {
                clearTimeout(S.resumeTimer);
                S.paused = true; g.setPaused(true);
                set({ paused: true, resumeAt: null });
                pushLobby();                       // the organiser's screen shows the pause too
              }
            } else set({ conn: 'lost' });
          },
          onState: (buf: ArrayBuffer) => g.pushSnapshot(buf),
          onCtl: (msg: Record<string, unknown>, key: string) => {
            if (role === 'host') {
              if (key !== 'guest') return;
              if (msg.k === 'press' && Array.isArray(msg.s)) {
                g.remotePress(msg.s as number[], typeof msg.vt === 'number' ? msg.vt : undefined,
                  typeof msg.n === 'number' ? msg.n : undefined, typeof msg.q === 'number' ? msg.q : undefined,
                  Array.isArray(msg.l) ? msg.l as number[] : undefined, typeof msg.v === 'number' ? msg.v : undefined);
              } else if (msg.k === 'buf') {
                S.guestBuf = Math.min(250, Math.max(20, Number(msg.ms) || 45));
                if (S.rtt != null && !predict) g.setViewDelay(S.rtt + S.guestBuf);
              }
              else if (msg.k === 'ready') { S.ready[1] = true; pushLobby(); maybeStart(); }
              return;
            }
            mirror(g, { ...msg, conn: undefined });
          },
          onRtt: (rtt: number) => {
            S.rtt = rtt;
            if (role === 'host' && !predict) g.setViewDelay(rtt + S.guestBuf);
            g.setRtt(rtt);
            set({ rtt });
          },
          onRoute: (key: string, r: { relay: boolean } | null) => { if (r && (role !== 'host' || key === 'guest')) set({ relay: r.relay }); }
        }
      });
      link = l;
      statsRef.current = () => ({ ...g.netStats(), rttMs: l.rtt != null ? Math.round(l.rtt) : null, pred: g.debug.pred, transport: 'p2p', role, relay: l.route('guest') || l.route('host') });
      if (BOTS_ALLOWED) (window as unknown as { __cc: unknown }).__cc = { game: g, link: l, role, transport: 'p2p', match: P.m.id };
      if (role === 'host' && P.bot) later(600, () => act.current.ready());
    })();

    // peer to peer: the guest tells the host how long its picture waits, so the host can wait as long
    const bufTimer = setInterval(() => {
      if (!SERVER && role === 'guest' && game && link && link.isOpen()) link.send({ k: 'buf', ms: Math.round(game.viewDelay) });
    }, 1000);
    // notice when the pictures stop coming
    const staleTimer = setInterval(() => {
      if (!game || (!SERVER && role === 'host')) return;
      const stale = S.started && !S.over && !S.paused && game.lastFrameAge > 2000;
      setUi(u => u.stale === stale ? u : { ...u, stale });
    }, 500);
    later(15000, () => set({ waitedLong: true }));

    return () => {
      dead = true;
      clearInterval(staleTimer); clearInterval(bufTimer);
      timers.forEach(clearTimeout);
      clearTimeout(S.resumeTimer);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pointerdown', unlock);
      link?.close();
      slink?.close();
      game?.destroy();
      gameRef.current = null;
    };
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  // the bracket has a result this device never saw played out (the organiser decided it, or
  // the match ended while this page was away): show it after a grace period
  const sr = p.serverResult;
  const [serverEnd, setServerEnd] = useState(false);
  const srWinner = sr?.winner || null, srVia = sr?.via || '';
  useEffect(() => {
    if (!srWinner || ui.ended) return;
    const t = setTimeout(() => setServerEnd(true), srVia === 'played' ? 9000 : 0);
    return () => clearTimeout(t);
  }, [srWinner, srVia, ui.ended]);

  // a match in progress: confirm before closing the tab
  useEffect(() => {
    if (role === 'spectator' || !ui.started || ui.ended) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [role, ui.started, ui.ended]);

  const opp = me === 0 ? pb : me === 1 ? pa : null;
  const kits = resolveKits(pa.color, pb.color);
  const myHex = me === 0 ? kits.hexA : kits.hexB;
  // who the match waits for: peer to peer the guest's link; on the match server whoever is missing
  const missing = server ? (!ui.peer[0] ? pa : !ui.peer[1] ? pb : null) : role === 'host' ? pb : pa;

  let overlay: React.ReactNode = null;
  if (ui.denied && role !== 'spectator') {
    overlay = <DeniedCard why={ui.denied} onExit={p.onExit} />;
  } else if (ui.elsewhere) {
    overlay = (
      <div className="ovl"><div className="card tight">
        <p className="lead">This match is open in another window.</p>
        <p className="note small">Play it there, or reload this page to play it here.</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>Play here</button>
      </div></div>
    );
  } else if (role === 'spectator') {
    // a match that is over: the bracket's result once the end has had time to show here, or at
    // once when the match server no longer lets this page in (it only does that for a match over)
    overlay = <ViewerOverlay ui={ui} m={m} pa={pa} pb={pb} server={server} result={ui.ended ? null : (serverEnd || ui.denied) && sr && sr.winner ? sr : null}
      nextLabel={p.nextLabel} onExit={p.onExit} />;
  } else if (ui.ended) {
    overlay = <EndCard ui={ui} role={role} server={server} me={me} pa={pa} pb={pb} nextLabel={p.nextLabel} onExit={p.onExit} />;
  } else if (serverEnd && sr && sr.winner) {
    const w = sr.winner === pa.id ? pa : pb;
    overlay = (
      <div className="ovl"><div className="card">
        <p className="kicker">{m.label}</p>
        <h2 className="h2">{sr.via === 'played' ? 'Full time' : 'The organiser decided this match'}</h2>
        <div className="final-score">
          <PlayerChip p={pa} me={me === 0} />
          <b>{sr.via === 'walkover' ? 'W/O' : sr.score[0] + ' – ' + sr.score[1]}</b>
          <PlayerChip p={pb} me={me === 1} />
        </div>
        <p className="lead"><PlayerChip p={w} me={w.id === (me === 0 ? pa.id : me === 1 ? pb.id : '')} /> goes through.</p>
        <button type="button" className="btn" onClick={p.onExit}>Back to the bracket</button>
      </div></div>
    );
  } else if (!ui.started) {
    const myReady = ui.iAmReady;
    const linked = server ? ui.conn === 'open' && ui.peer[0] && ui.peer[1] : ui.conn === 'open';
    overlay = (
      <div className="ovl"><div className="card">
        <p className="kicker">{m.label} · {rulesLine(rules)}</p>
        <div className="vs"><PlayerChip p={pa} me={me === 0} /><span className="vs-x">vs</span><PlayerChip p={pb} me={me === 1} /></div>
        <p className="note side-note"><span className="dot" style={{ background: myHex, color: myHex }} />You play the {me === 0 ? 'left' : 'right'} team, in {colourName(myHex)}{p.resumeScore && (p.resumeScore[0] || p.resumeScore[1]) ? <> · resuming at {p.resumeScore[0]}–{p.resumeScore[1]}</> : null}</p>
        {server && ui.carryOn && ui.conn === 'open' ? (
          <>
            <p className="status-line"><span className="spinner" aria-hidden="true" />{linked ? 'Carrying on…' : 'Waiting for ' + opp?.name + ' to come back…'}</p>
            <p className="note small">This match had already kicked off, so it carries on from {ui.carryOn[0]}–{ui.carryOn[1]} as soon as you&apos;re both back.</p>
          </>
        ) : !linked ? (
          <>
            <p className="status-line"><span className="spinner" aria-hidden="true" />{
              server ? (ui.conn !== 'open' ? (ui.conn === 'lost' ? 'Lost the match server. Reconnecting…' : 'Connecting to the match server…') : 'Waiting for ' + opp?.name + ' to open the match…')
                : ui.conn === 'lost' ? 'Lost ' + opp?.name + '. Reconnecting…' : 'Connecting to ' + opp?.name + '…'}</p>
            {ui.waitedLong ? (
              <p className="note small">Make sure {opp?.name} has opened this match.
                {role === 'host' && p.onLocal ? <> Sitting next to each other? <button type="button" className="link" onClick={p.onLocal}>Play on this device</button></> : null}
              </p>
            ) : null}
            {!myReady ? <button type="button" className="btn ghost" onClick={e => { e.currentTarget.blur(); act.current.ready(); }}>I&apos;m ready</button> : <p className="note">You&apos;re ready.</p>}
          </>
        ) : (
          <>
            <div className="ready-row">
              <ReadyTag on={ui.ready[0]} name={pa.name} />
              <ReadyTag on={ui.ready[1]} name={pb.name} />
            </div>
            {!myReady
              ? <button type="button" className="btn" onClick={e => { e.currentTarget.blur(); act.current.ready(); }}>I&apos;m ready</button>
              : <p className="note">Waiting for {opp?.name}…</p>}
            <ConnLine ui={ui} server={server} />
          </>
        )}
      </div></div>
    );
  } else if (ui.paused || ui.resumeAt) {
    overlay = (
      <div className="ovl"><div className="card">
        {ui.resumeAt ? <><p className="kicker">Back on</p><Countdown at={ui.resumeAt} /></>
          : <>
            <h2 className="h2">Paused</h2>
            <p className="status-line"><span className="spinner" aria-hidden="true" />{missing ? missing.name + ' lost the connection. Waiting for them to come back…' : 'Waiting…'}</p>
            <p className="note small">The organiser can decide the match if they don&apos;t return.</p>
          </>}
      </div></div>
    );
  } else if ((server || role !== 'host') && (ui.conn !== 'open' || ui.stale)) {
    overlay = (
      <div className="ovl soft"><div className="card tight">
        <p className="status-line"><span className="spinner" aria-hidden="true" />{ui.conn !== 'open' ? (server ? 'Reconnecting to the match server…' : 'Reconnecting to ' + pa.name + '…') : 'Waiting for the match…'}</p>
      </div></div>
    );
  }

  return (
    <div className="stage-wrap">
      <div className={'arena' + (p.full ? ' full' : '')}>
        <div ref={rootRef} className="wc-root" />
        {overlay}
      </div>
      {p.netLine && role !== 'spectator' ? <NetLine stats={statsRef} server={server} started={ui.started} /> : null}
    </div>
  );
}

// The network line: the round trip to the server (or the other player), how much it wobbles,
// pictures that came late, catch-ups a minute and this device's frame time; "Copy the numbers"
// puts the match's numbers on the clipboard, to paste to whoever looks into a laggy match.
function NetLine({ stats, server, started }: { stats: React.RefObject<() => Record<string, unknown>>; server: boolean; started: boolean }) {
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setS(stats.current ? stats.current() : null), 1000);
    return () => clearInterval(t);
  }, [stats]);
  if (!s) return <p className="net-line tiny muted">&nbsp;</p>;
  const n = (k: string) => (typeof s[k] === 'number' ? s[k] as number : null);
  const bits: string[] = [];
  const rtt = n('rttMs');
  bits.push((server ? 'Server ' : 'Other player ') + (rtt != null ? rtt + ' ms' : '…'));
  if (n('jitterMs') != null) bits.push('±' + n('jitterMs') + ' ms');
  if (started) {
    bits.push((n('stallsPerMin') || 0) + ' late pictures');
    bits.push((n('catchupsPerMin') || 0) + ' catch-ups a minute');
  }
  bits.push('frame ' + (n('frameMs') ?? 0) + ' ms');
  async function copy() {
    const all = { at: new Date().toISOString(), page: location.pathname, agent: navigator.userAgent, ...stats.current?.() };
    const text = JSON.stringify(all, null, 1);
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { window.prompt('Copy these numbers:', text); }
  }
  return (
    <p className="net-line tiny muted" aria-live="off">
      <span>{bits.join(' · ')}</span>
      <button type="button" className="link" onClick={copy}>{copied ? 'Copied' : 'Copy the numbers'}</button>
    </p>
  );
}

function DeniedCard({ why, onExit }: { why: string; onExit: () => void }) {
  const version = why === 'version';
  return (
    <div className="ovl"><div className="card tight">
      <p className="lead">{version ? 'The cup was updated. Reload this page to carry on.' : why === 'ticket' ? 'The match server did not accept this page.' : why === 'busy' ? 'The match server is full right now.' : why}</p>
      {version ? <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
        : <button type="button" className="btn" onClick={onExit}>Back to the bracket</button>}
    </div></div>
  );
}

// what a viewer sees over a match they watch (the organiser, or anyone with the cup's link)
function ViewerOverlay({ ui, m, pa, pb, result, nextLabel, server, onExit }: {
  ui: Ui; m: PublicMatch; pa: PublicPlayer; pb: PublicPlayer; nextLabel?: string | null; server: boolean; onExit: () => void;
  result: { winner: string | null; score: [number, number]; via?: string } | null;
}) {
  const spin = <span className="spinner" aria-hidden="true" />;
  const end = ui.ended ? { winner: ui.ended.winner === 0 ? pa : pb, score: ui.ended.score, via: 'played' }
    : result && result.winner ? { winner: result.winner === pa.id ? pa : pb, score: result.score, via: result.via || 'played' } : null;
  if (ui.denied && !end) {
    return (
      <div className="ovl"><div className="card tight">
        <p className="lead">{ui.denied === 'version' ? 'The cup was updated: reload this page.'
          : ui.denied === 'full' ? 'A lot of people are watching this match.' : 'Can’t watch this match right now.'}</p>
        {ui.denied !== 'version' ? <p className="note small">{server ? 'Reload the page in a moment to try again.' : 'Only the organiser can watch peer-to-peer matches.'}</p> : null}
      </div></div>
    );
  }
  if (end) {
    const how = end.via === 'played' || end.via === 'local' ? 'Full time' : end.via === 'walkover' ? 'Walkover' : 'Decided by the organiser';
    return (
      <div className="ovl"><div className="card end-card">
        <p className="kicker">{m.label} · {how}</p>
        <div className="final-score">
          <PlayerChip p={pa} /><b>{end.via === 'walkover' ? 'W/O' : end.score[0] + ' – ' + end.score[1]}</b><PlayerChip p={pb} />
        </div>
        <p className="lead"><PlayerChip p={end.winner} /> {nextLabel === null ? 'wins the cup!' : 'goes through'}</p>
        <button type="button" className="btn ghost small" onClick={onExit}>Back</button>
      </div></div>
    );
  }
  if (!ui.started) {
    const waitingFor = server && ui.conn === 'open' ? [!ui.peer[0] ? pa.name : null, !ui.peer[1] ? pb.name : null].filter(Boolean) : [];
    return (
      <div className="ovl soft"><div className="card tight viewer-wait">
        {ui.conn === 'open' ? (
          <>
            <span className="pill">{ui.carryOn ? 'Carrying on from ' + ui.carryOn[0] + '–' + ui.carryOn[1] + (waitingFor.length ? ' when ' + waitingFor.join(' and ') + (waitingFor.length > 1 ? ' are' : ' is') + ' back' : '')
              : waitingFor.length ? 'Waiting for ' + waitingFor.join(' and ') + ' to open the match' : 'Waiting for kick-off'}</span>
            <div className="ready-row"><ReadyTag on={ui.ready[0]} name={pa.name} /><ReadyTag on={ui.ready[1]} name={pb.name} /></div>
          </>
        ) : <p className="status-line">{spin}{ui.waitedLong ? (server ? 'Waiting for the match server…' : 'Waiting for ' + pa.name + ' to open the match') : 'Connecting…'}</p>}
      </div></div>
    );
  }
  if (ui.resumeAt) return <div className="ovl"><div className="card tight"><p className="kicker">Back on</p><Countdown at={ui.resumeAt} /></div></div>;
  if (ui.paused) {
    const who = server ? (!ui.peer[0] ? pa.name : !ui.peer[1] ? pb.name : '') : pb.name;
    return <div className="ovl soft"><div className="card tight"><p className="status-line">{spin}Paused{who ? ': ' + who + ' lost the connection' : ''}</p></div></div>;
  }
  if (ui.conn !== 'open' || ui.stale) {
    return <div className="ovl soft"><div className="card tight"><p className="status-line">{spin}{ui.conn !== 'open' ? (server ? 'Reconnecting to the match server…' : 'Reconnecting to ' + pa.name + '…') : 'Waiting for the match…'}</p></div></div>;
  }
  return null;
}

function colourName(hex: string) {
  const names: Record<string, string> = {
    '#ff7a1a': 'orange', '#14b8cc': 'teal', '#e5383b': 'red', '#3a5bd9': 'blue', '#2fbf71': 'green',
    '#8e5cf7': 'purple', '#ffd43b': 'yellow', '#ff5ca8': 'pink', '#eef1f7': 'white', '#2b2f4a': 'black'
  };
  return names[hex] || 'your colour';
}

function ReadyTag({ on, name }: { on: boolean; name: string }) {
  return <span className={'ready-tag' + (on ? ' on' : '')}><span aria-hidden="true">{on ? '✓' : '…'}</span> {name} {on ? 'is ready' : 'not ready yet'}</span>;
}

function ConnLine({ ui, server }: { ui: Ui; server: boolean }) {
  if (ui.conn !== 'open') return null;
  const ms = ui.rtt != null ? Math.round(ui.rtt) + ' ms' : '';
  const how = server ? 'On the match server' : ui.relay ? 'Connected through a relay' : 'Connected directly';
  return <p className="tiny muted conn-line">{how}{ms ? ' · ' + ms : ''}</p>;
}

function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  return <b className="count-big">{Math.max(1, Math.ceil((at - now) / 1000))}</b>;
}

function EndCard({ ui, role, server, me, pa, pb, nextLabel, onExit }: {
  ui: Ui; role: StageRole; server: boolean; me: number; pa: PublicPlayer; pb: PublicPlayer; nextLabel?: string | null; onExit: () => void;
}) {
  const e = ui.ended!;
  const winner = e.winner === 0 ? pa : pb;
  const won = me >= 0 && e.winner === me;
  const final = nextLabel === null;
  let title = winner.name + ' wins';
  if (me >= 0) title = won ? (final ? 'Champion!' : 'You won!') : 'Knocked out';
  const showSave = server ? me >= 0 : role === 'host';
  return (
    <div className="ovl"><div className="card end-card">
      {won && final ? <Trophy className="trophy-sm" /> : null}
      <h2 className="h2">{title}</h2>
      <div className="final-score">
        <PlayerChip p={pa} me={me === 0} />
        <b>{e.score[0]} – {e.score[1]}</b>
        <PlayerChip p={pb} me={me === 1} />
      </div>
      {won && !final && nextLabel ? <p className="lead">You&apos;re through to the {nextLabel.toLowerCase().startsWith('round') ? nextLabel : nextLabel.toLowerCase()}.</p> : null}
      {me >= 0 && !won ? <p className="note">Good game. Stick around and cheer on the rest.</p> : null}
      {showSave ? <p className={'tiny ' + (ui.save === 'error' ? 'error' : 'muted')}>{ui.save === 'saving' ? 'Saving the result…' : ui.save === 'saved' ? 'Result saved' : ui.save === 'error' ? ui.saveMsg : server ? 'Saving the result…' : ''}</p> : null}
      <button type="button" className="btn" onClick={onExit}>Back to the bracket</button>
    </div></div>
  );
}
