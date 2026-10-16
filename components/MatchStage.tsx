'use client';
/* One online match on this device.
   host       player A: runs the physics, connects to the guest and up to four viewers
   guest      player B: runs its own copy of the match a little ahead of the host, so
              its presses show at once, and sends them to the host (see the engine)
   spectator  the organiser (needs the admin key): draws the host's snapshots,
              usually as one tile of the big screen's grid                        */
import { useEffect, useRef, useState } from 'react';
import { Snd, resolveKits } from '@/lib/engine/shared';
import { ApiError, BOTS_ALLOWED, api, getIce, rulesLine, sleep } from '@/lib/client';
import type { PublicMatch, PublicPlayer } from '@/lib/tournament';
import type { GameApi, LinkApi } from '@/lib/engine/types';
import { PlayerChip } from './bits';
import { Trophy } from './Trophy';

export type StageRole = 'host' | 'guest' | 'spectator';

type Ui = {
  conn: 'connecting' | 'open' | 'lost';
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
  denied: boolean;
};

const INITIAL: Ui = {
  conn: 'connecting', rtt: null, relay: null, ready: [false, false], iAmReady: false, started: false, paused: false,
  resumeAt: null, ended: null, stale: false, save: 'idle', saveMsg: '', waitedLong: false, denied: false
};

// one pitch in a grid: draw every `every` frames (hidden: not at all), sound on or off, full resolution or not
export type Tile = { every: number; sound: boolean; hidden: boolean; hd: boolean };

type Props = {
  role: StageRole;
  code: string;
  m: PublicMatch;
  pa: PublicPlayer;
  pb: PublicPlayer;
  token: string | null;
  bot?: number;
  resumeScore?: [number, number] | null;
  nextLabel?: string | null;       // where the winner goes next ('Final', ...), null after the final
  serverResult?: { winner: string | null; score: [number, number]; via?: string } | null;  // what the server has, once done
  onExit: () => void;
  onLocal?: () => void;            // host: move the match to this device
  onEnded?: () => void;            // called a few seconds after the result is on screen
  full?: boolean;
  adminKey?: string | null;        // spectator: only the organiser can watch
  tile?: Tile | null;              // one of the big screen's grid of matches
};

export default function MatchStage(p: Props) {
  const { role, m, pa, pb } = p;
  const rootRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameApi | null>(null);
  const [gameOn, setGameOn] = useState(false);
  const [ui, setUi] = useState<Ui>(INITIAL);
  const act = useRef<{ ready: () => void }>({ ready: () => { } });
  const first = useRef(p);
  const me = role === 'host' ? 0 : role === 'guest' ? 1 : -1;
  const rules = m.rules;
  const tile = p.tile || null;

  useEffect(() => {
    const P = first.current;
    const set = (x: Partial<Ui>) => setUi(u => ({ ...u, ...x }));
    let dead = false, game: GameApi | null = null, link: LinkApi | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => { timers.push(setTimeout(() => { if (!dead) fn(); }, ms)); };
    // guestBuf: how long the guest's picture waits for frames (it says so every second); the host waits the trip plus that
    const S = { ready: [false, false] as [boolean, boolean], started: false, over: false, shown: false, paused: false, iAmReady: false, guestBuf: 45, rtt: null as number | null,
      resumeTimer: 0 as unknown as ReturnType<typeof setTimeout>, finalBody: null as null | Record<string, unknown>, finalDone: false };
    const base = '/api/t/' + encodeURIComponent(P.code) + '/m/' + encodeURIComponent(P.m.id);

    // ---- host: results go to the server ----
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
      if (role !== 'host' || S.started || !S.ready[0] || !S.ready[1] || !link || !link.isOpen('guest') || !game) return;
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
        later(15000, () => { link?.close(); link = null; });    // nothing left to send: stop polling the mailbox
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
      if (role === 'host') { S.ready[0] = true; pushLobby(); maybeStart(); }
      else if (role === 'guest') link?.send({ k: 'ready' });
    };

    (async () => {
      const [{ createGame }, { createLink }, ice] = await Promise.all([import('@/lib/engine/game'), import('@/lib/net/link'), getIce()]);
      if (dead || !rootRef.current) return;
      const players = [P.pa, P.pb].map(x => ({ name: x.name, color: x.color, flag: x.flag }));
      const gameRules = { goals: P.m.rules.goals, capSec: P.m.rules.capSec, modifiers: P.m.rules.modifiers };
      const lite = P.tile ? { renderEvery: P.tile.hidden ? 1e9 : P.tile.every, maxDpr: P.tile.hd ? 2 : 1, sound: P.tile.sound }
        : P.bot ? { renderEvery: 3, maxDpr: 1 } : {};
      // test builds: ?lag=75&jitter=10 adds that much one-way delay to what this side receives;
      // ?net=fair turns prediction off like the organiser's "Equal delay" rule does (the guest
      // draws the host's frames, the host waits as long)
      const q = BOTS_ALLOWED ? new URLSearchParams(window.location.search) : null;
      const fakeLag = q && q.get('lag') ? { ms: Number(q.get('lag')) || 0, jitter: Number(q.get('jitter')) || 0 } : undefined;
      const predict = !P.m.rules.equalDelay && !(q && q.get('net') === 'fair');
      // host: snapshots for the organiser's screen and the guest's fallback picture, 30 a second
      // with prediction (the guest draws its own copy), every tick without it
      const g = createGame(rootRef.current, {
        mode: role, players, rules: gameRules, bot: P.bot ? { skill: P.bot } : undefined, predict, snapEvery: predict ? 2 : 1, ...lite,
        hooks: {
          onSnapshot: (buf: ArrayBuffer) => link?.sendState(buf),
          onFullState: (buf: ArrayBuffer) => link?.sendState(buf, 'guest'),
          onPressAck: (seq: number, slack: number) => link?.send({ k: 'pa', q: seq, sl: slack }, 'guest'),
          onHostPress: (s: number, n: number, l: number, r: number) => link?.send({ k: 'hp', s, n, l, r }, 'guest'),
          onEvent: (ev: unknown) => link?.send({ k: 'ev', ev }),
          onPress: (s: number[], vt?: number, n?: number, seq?: number) => link?.send({ k: 'press', s, vt, n, q: seq }),
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
      setGameOn(true);
      // With prediction the guest's own men react at once and the host draws its match as it
      // happens. Without it the guest's picture waits only as long as its connection needs (at
      // least 30 ms) and the host waits the round trip plus that, so both react equally late.
      // The organiser's screen prefers smooth.
      g.setViewDelay(role === 'spectator' ? 160 : role === 'guest' ? 30 : predict ? 0 : 75);

      const l = createLink({
        code: P.code, matchId: P.m.id, role, token: P.token, adminKey: P.adminKey || undefined, iceServers: ice, fakeLag,
        handlers: {
          log: BOTS_ALLOWED ? (s: string) => console.debug('[link ' + role + '] ' + s) : undefined,     // test builds: what the link is doing
          onDenied: () => set({ denied: true }),
          onOpen: (key: string) => {
            if (role === 'host') {
              l.send(g.getSync(), key);
              l.send(lobbyMsg(), key);
              if (key === 'guest') {
                g.resetGuest();
                set({ conn: 'open' });
                if (S.started && S.paused && !S.over) resumeSoon();
              }
            } else {
              set({ conn: 'open', stale: false });
              if (role === 'guest' && S.iAmReady) l.send({ k: 'ready' });
              if (role === 'guest' && P.bot) later(400, () => act.current.ready());
            }
          },
          onClose: (key: string) => {
            if (role === 'host') {
              if (key !== 'guest') return;
              set({ conn: 'lost', relay: null });
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
                  typeof msg.n === 'number' ? msg.n : undefined, typeof msg.q === 'number' ? msg.q : undefined);
              } else if (msg.k === 'buf') {
                S.guestBuf = Math.min(250, Math.max(20, Number(msg.ms) || 45));
                if (S.rtt != null && !predict) g.setViewDelay(S.rtt + S.guestBuf);
              }
              else if (msg.k === 'ready') { S.ready[1] = true; pushLobby(); maybeStart(); }
              return;
            }
            switch (msg.k) {
              case 'sync': g.applySync(msg); break;
              case 'ev': g.applyRemoteEvent(msg.ev); break;
              case 'lobby': {
                const r = msg.ready as [boolean, boolean];
                S.started = !!msg.started;
                set({ ready: [!!r[0], !!r[1]], started: !!msg.started, paused: !!msg.paused });
                break;
              }
              case 'start': S.started = true; set({ started: true }); break;
              case 'resume': set({ paused: true, resumeAt: Date.now() + Number(msg.ms || 3000) }); break;
              case 'resumed': set({ paused: false, resumeAt: null }); break;
              case 'pa': g.pressAck(Number(msg.q), Number(msg.sl)); break;
              case 'hp': g.hostPress(Number(msg.s), Number(msg.n), Number(msg.l), Number(msg.r)); break;
            }
          },
          onRtt: (rtt: number) => {
            S.rtt = rtt;
            if (role === 'host' && !predict) g.setViewDelay(rtt + S.guestBuf);
            if (role === 'guest') g.setRtt(rtt);
            set({ rtt });
          },
          onRoute: (key: string, r: { relay: boolean } | null) => { if (r && (role !== 'host' || key === 'guest')) set({ relay: r.relay }); }
        }
      });
      link = l;
      if (BOTS_ALLOWED) {                 // test builds: let tests look inside
        const w = window as unknown as { __cc: unknown; __ccs?: Record<string, unknown> };
        if (P.tile) (w.__ccs = w.__ccs || {})[P.m.id] = { game: g, link: l, role };
        else w.__cc = { game: g, link: l, role };
      }
      if (role === 'host' && P.bot) later(600, () => act.current.ready());
    })();

    // viewers: notice when the host's pictures stop coming
    // the guest tells the host how long its picture waits, so the host can wait as long
    const bufTimer = setInterval(() => {
      if (role === 'guest' && game && link && link.isOpen()) link.send({ k: 'buf', ms: Math.round(game.viewDelay) });
    }, 1000);
    const staleTimer = setInterval(() => {
      if (!game || role === 'host') return;
      const stale = S.started && !S.over && game.lastFrameAge > 2000;
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
      game?.destroy();
      gameRef.current = null;
      if (BOTS_ALLOWED && P.tile) { const w = window as unknown as { __ccs?: Record<string, unknown> }; if (w.__ccs) delete w.__ccs[P.m.id]; }
    };
  }, [role]);

  // a tile of the grid: how often to draw, sound, resolution
  const tEvery = tile ? (tile.hidden ? 1e9 : tile.every) : 0, tSound = !!tile?.sound, tHd = !!tile?.hd;
  useEffect(() => {
    const g = gameRef.current;
    if (!g || !tEvery) return;
    g.setRenderEvery(tEvery);
    g.setSound(tSound);
    g.setMaxDpr(tHd ? 2 : 1);
  }, [gameOn, tEvery, tSound, tHd]);

  // the server has a result this device never saw played out (the organiser decided it,
  // or the host finished and vanished): show it after a grace period
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

  let overlay: React.ReactNode = null;
  if (role === 'spectator') {
    overlay = <ViewerOverlay ui={ui} m={m} pa={pa} pb={pb} result={ui.ended ? null : serverEnd && sr && sr.winner ? sr : null}
      nextLabel={p.nextLabel} tile={!!tile} onExit={p.onExit} />;
  } else if (ui.ended) {
    overlay = <EndCard ui={ui} role={role} me={me} pa={pa} pb={pb} nextLabel={p.nextLabel} onExit={p.onExit} />;
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
    overlay = (
      <div className="ovl"><div className="card">
        <p className="kicker">{m.label} · {rulesLine(rules)}</p>
        <div className="vs"><PlayerChip p={pa} me={me === 0} /><span className="vs-x">vs</span><PlayerChip p={pb} me={me === 1} /></div>
        <p className="note side-note"><span className="dot" style={{ background: myHex, color: myHex }} />You play the {me === 0 ? 'left' : 'right'} team, in {colourName(myHex)}{p.resumeScore && (p.resumeScore[0] || p.resumeScore[1]) ? <> · resuming at {p.resumeScore[0]}–{p.resumeScore[1]}</> : null}</p>
        {ui.conn !== 'open' ? (
          <>
            <p className="status-line"><span className="spinner" aria-hidden="true" />{ui.conn === 'lost' ? 'Lost ' + opp?.name + '. Reconnecting…' : 'Connecting to ' + opp?.name + '…'}</p>
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
            <ConnLine ui={ui} />
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
            <p className="status-line"><span className="spinner" aria-hidden="true" />{role === 'host' ? pb.name + ' lost the connection. Waiting for them to come back…' : 'Waiting for ' + pa.name + '…'}</p>
            <p className="note small">The organiser can decide the match if they don&apos;t return.</p>
          </>}
      </div></div>
    );
  } else if (role !== 'host' && (ui.conn !== 'open' || ui.stale)) {
    overlay = (
      <div className="ovl soft"><div className="card tight">
        <p className="status-line"><span className="spinner" aria-hidden="true" />{ui.conn !== 'open' ? 'Reconnecting to ' + pa.name + '…' : 'Waiting for ' + pa.name + '…'}</p>
      </div></div>
    );
  }

  return (
    <div className={'arena' + (p.full ? ' full' : '') + (tile ? ' in-tile' + (tile.sound ? ' with-sound' : '') : '')}>
      <div ref={rootRef} className="wc-root" />
      {overlay}
    </div>
  );
}

// what the organiser sees over a match they watch (full page, or one tile of the grid)
function ViewerOverlay({ ui, m, pa, pb, result, nextLabel, tile, onExit }: {
  ui: Ui; m: PublicMatch; pa: PublicPlayer; pb: PublicPlayer; nextLabel?: string | null; tile: boolean; onExit: () => void;
  result: { winner: string | null; score: [number, number]; via?: string } | null;
}) {
  const spin = <span className="spinner" aria-hidden="true" />;
  if (ui.denied) {
    return (
      <div className="ovl"><div className="card tight">
        <p className="lead">Only the organiser can watch matches.</p>
        <p className="note small">Open the big screen from the admin page.</p>
      </div></div>
    );
  }
  const end = ui.ended ? { winner: ui.ended.winner === 0 ? pa : pb, score: ui.ended.score, via: 'played' }
    : result && result.winner ? { winner: result.winner === pa.id ? pa : pb, score: result.score, via: result.via || 'played' } : null;
  if (end) {
    const how = end.via === 'played' || end.via === 'local' ? 'Full time' : end.via === 'walkover' ? 'Walkover' : 'Decided by the organiser';
    return (
      <div className="ovl"><div className={'card' + (tile ? ' tight tile-end' : ' end-card')}>
        <p className="kicker">{m.label} · {how}</p>
        <div className="final-score">
          <PlayerChip p={pa} /><b>{end.via === 'walkover' ? 'W/O' : end.score[0] + ' – ' + end.score[1]}</b><PlayerChip p={pb} />
        </div>
        <p className="lead"><PlayerChip p={end.winner} /> {nextLabel === null ? 'wins the cup!' : 'goes through'}</p>
        {!tile ? <button type="button" className="btn" onClick={onExit}>Back to the bracket</button> : null}
      </div></div>
    );
  }
  if (!ui.started) {
    return (
      <div className="ovl soft"><div className="card tight viewer-wait">
        {ui.conn === 'open' ? (
          <>
            <span className="pill">Waiting for kick-off</span>
            <div className="ready-row"><ReadyTag on={ui.ready[0]} name={pa.name} /><ReadyTag on={ui.ready[1]} name={pb.name} /></div>
          </>
        ) : <p className="status-line">{spin}{ui.waitedLong ? 'Waiting for ' + pa.name + ' to open the match' : 'Connecting…'}</p>}
      </div></div>
    );
  }
  if (ui.resumeAt) return <div className="ovl"><div className="card tight"><p className="kicker">Back on</p><Countdown at={ui.resumeAt} /></div></div>;
  if (ui.paused) return <div className="ovl soft"><div className="card tight"><p className="status-line">{spin}Paused: {pb.name} lost the connection</p></div></div>;
  if (ui.conn !== 'open' || ui.stale) {
    return <div className="ovl soft"><div className="card tight"><p className="status-line">{spin}{ui.conn !== 'open' ? 'Reconnecting to ' + pa.name + '…' : 'Waiting for ' + pa.name + '…'}</p></div></div>;
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

function ConnLine({ ui }: { ui: Ui }) {
  if (ui.conn !== 'open') return null;
  const ms = ui.rtt != null ? Math.round(ui.rtt) + ' ms' : '';
  return <p className="tiny muted conn-line">{ui.relay ? 'Connected through a relay' : 'Connected directly'}{ms ? ' · ' + ms : ''}</p>;
}

function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  return <b className="count-big">{Math.max(1, Math.ceil((at - now) / 1000))}</b>;
}

function EndCard({ ui, role, me, pa, pb, nextLabel, onExit }: {
  ui: Ui; role: StageRole; me: number; pa: PublicPlayer; pb: PublicPlayer; nextLabel?: string | null; onExit: () => void;
}) {
  const e = ui.ended!;
  const winner = e.winner === 0 ? pa : pb;
  const won = me >= 0 && e.winner === me;
  const final = nextLabel === null;
  let title = winner.name + ' wins';
  if (me >= 0) title = won ? (final ? 'Champion!' : 'You won!') : 'Knocked out';
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
      {role === 'host' ? <p className={'tiny ' + (ui.save === 'error' ? 'error' : 'muted')}>{ui.save === 'saving' ? 'Saving the result…' : ui.save === 'saved' ? 'Result saved' : ui.save === 'error' ? ui.saveMsg : ''}</p> : null}
      <button type="button" className="btn" onClick={onExit}>Back to the bracket</button>
    </div></div>
  );
}
