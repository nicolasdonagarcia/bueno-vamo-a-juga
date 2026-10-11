'use client';
/* One online match on this device.
   host       player A: runs the physics, connects to the guest and up to four viewers
   guest      player B: draws the host's snapshots and sends button presses
   spectator  anyone else: draws the host's snapshots                              */
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
};

const INITIAL: Ui = {
  conn: 'connecting', rtt: null, relay: null, ready: [false, false], iAmReady: false, started: false, paused: false,
  resumeAt: null, ended: null, stale: false, save: 'idle', saveMsg: '', waitedLong: false
};

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
};

export default function MatchStage(p: Props) {
  const { role, code, m, pa, pb } = p;
  const rootRef = useRef<HTMLDivElement>(null);
  const [ui, setUi] = useState<Ui>(INITIAL);
  const act = useRef<{ ready: () => void }>({ ready: () => { } });
  const first = useRef(p);
  const me = role === 'host' ? 0 : role === 'guest' ? 1 : -1;
  const rules = m.rules;

  useEffect(() => {
    const P = first.current;
    const set = (x: Partial<Ui>) => setUi(u => ({ ...u, ...x }));
    let dead = false, game: GameApi | null = null, link: LinkApi | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => { timers.push(setTimeout(() => { if (!dead) fn(); }, ms)); };
    const S = { ready: [false, false] as [boolean, boolean], started: false, over: false, shown: false, paused: false, iAmReady: false,
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
      const lite = P.bot ? { renderEvery: 3, maxDpr: 1 } : {};
      const g = createGame(rootRef.current, {
        mode: role, players, rules: gameRules, bot: P.bot ? { skill: P.bot } : undefined, ...lite,
        hooks: {
          onSnapshot: (buf: ArrayBuffer) => link?.sendState(buf),
          onEvent: (ev: unknown) => link?.send({ k: 'ev', ev }),
          onPress: (s: number[]) => link?.send({ k: 'press', s }),
          onScore: (sc: [number, number], info: { over: boolean }) => {
            if (role !== 'host') return;
            if (info.over) { S.over = true; reportFinal(sc); } else report('score', sc);
          },
          onEnd: (e: { winner: number; score: [number, number] }) => { if (role === 'host') { S.over = true; reportFinal(e.score); } },
          onEndShown: (e: { winner: number; score: [number, number] }) => showEnd(e.score, e.winner)
        }
      });
      game = g;
      g.setViewDelay(role === 'spectator' ? 160 : 70);

      const l = createLink({
        code: P.code, matchId: P.m.id, role, token: P.token, iceServers: ice,
        handlers: {
          onOpen: (key: string) => {
            if (role === 'host') {
              l.send(g.getSync(), key);
              l.send(lobbyMsg(), key);
              if (key === 'guest') {
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
              }
            } else set({ conn: 'lost' });
          },
          onState: (buf: ArrayBuffer) => g.pushSnapshot(buf),
          onCtl: (msg: Record<string, unknown>, key: string) => {
            if (role === 'host') {
              if (key !== 'guest') return;
              if (msg.k === 'press' && Array.isArray(msg.s)) g.remotePress(msg.s as number[]);
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
            }
          },
          onRtt: (rtt: number) => { if (role === 'host') g.setViewDelay(rtt + 70); set({ rtt }); },
          onRoute: (key: string, r: { relay: boolean } | null) => { if (r && (role !== 'host' || key === 'guest')) set({ relay: r.relay }); }
        }
      });
      link = l;
      if (BOTS_ALLOWED) (window as unknown as { __cc: unknown }).__cc = { game: g, link: l, role };   // test builds: let tests look inside
      if (role === 'host' && P.bot) later(600, () => act.current.ready());
    })();

    // viewers: notice when the host's pictures stop coming
    const staleTimer = setInterval(() => {
      if (!game || role === 'host') return;
      const stale = S.started && !S.over && game.lastFrameAge > 2000;
      setUi(u => u.stale === stale ? u : { ...u, stale });
    }, 500);
    later(15000, () => set({ waitedLong: true }));

    return () => {
      dead = true;
      clearInterval(staleTimer);
      timers.forEach(clearTimeout);
      clearTimeout(S.resumeTimer);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pointerdown', unlock);
      link?.close();
      game?.destroy();
    };
  }, [role]);

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
  if (ui.ended) {
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
  } else if (!ui.started && role !== 'spectator') {
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
  } else if (!ui.started && role === 'spectator') {
    overlay = (
      <div className="ovl soft"><div className="card tight">
        {ui.conn === 'open' ? <span className="pill">Waiting for kick-off</span>
          : <p className="status-line"><span className="spinner" aria-hidden="true" />{ui.waitedLong ? 'Still connecting. This match may already have four viewers.' : 'Connecting to the match…'}</p>}
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
    <div className={'arena' + (p.full ? ' full' : '')}>
      <div ref={rootRef} className="wc-root" />
      {overlay}
    </div>
  );
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
