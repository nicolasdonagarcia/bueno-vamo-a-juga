'use client';
// The organiser's big screen, made to be shared in the meeting's video call:
// the QR code and arrivals, then every match live in a grid (click one to fill
// the screen, Esc to go back), the bracket, and the champion. Watching matches
// needs the admin key, so only the organiser can open it.
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bracket } from '@/components/Bracket';
import GameView from '@/components/GameView';
import MatchStage from '@/components/MatchStage';
import { Brand, Loading, PlayerChip, QR } from '@/components/bits';
import { ChampionBanner } from '@/components/Champion';
import { ApiError, api, playerOf, rulesLine, useIdentity, useTournament, type View } from '@/lib/client';
import { roundName, type PublicMatch } from '@/lib/tournament';
import { Snd } from '@/lib/engine/shared';

const KEEP_MS = 20000;            // a finished match stays in the grid this long, so its result can be seen
const GAP = 12, TILE_HEAD = 46;   // px, as in the CSS below the grid

export default function Screen({ code }: { code: string }) {
  const idn = useIdentity(code);
  const { setAdmin } = idn;
  const key = idn.admin;
  const [keyState, setKeyState] = useState<'unknown' | 'ok' | 'bad'>('unknown');
  const { t, error, refresh } = useTournament(code, null, { enabled: idn.ready && !!key && keyState !== 'bad', every: 1500 });
  const [tab, setTab] = useState<'matches' | 'bracket'>('matches');
  const [maxId, setMaxId] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  // an admin link (#k=…) opened here works too
  useEffect(() => {
    setOrigin(window.location.origin);
    const mk = /[#&]k=([^&]+)/.exec(window.location.hash);
    if (mk) {
      setAdmin(decodeURIComponent(mk[1]));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [setAdmin]);
  useEffect(() => {
    if (!key) return;
    let live = true;
    api('/api/t/' + code + '/admin', { key, action: 'check' })
      .then(() => { if (live) setKeyState('ok'); })
      .catch(e => { if (live) setKeyState(e instanceof ApiError && e.status === 403 ? 'bad' : 'ok'); });
    return () => { live = false; };
  }, [key, code]);

  // the server's clock, ticking between answers (finished matches leave the grid after KEEP_MS)
  const [since, setSince] = useState(0);
  useEffect(() => {
    const at = Date.now();
    const iv = setInterval(() => setSince(Date.now() - at), 1000);
    return () => { clearInterval(iv); setSince(0); };
  }, [t]);
  const serverNow = t ? t.now + since : 0;

  const tiles = useMemo(() => !t || t.status === 'lobby' ? [] : t.matches.filter(m => !!m.a && !!m.b && (
    m.status === 'ready' || m.status === 'live' || (m.status === 'done' && m.via !== 'bye' && !!m.endedAt && serverNow - m.endedAt < KEEP_MS))),
  [t, serverNow]);
  const tileIds = tiles.map(m => m.id).join(',');
  const maxed = maxId && tiles.some(m => m.id === maxId) ? maxId : null;
  const showGrid = tab === 'matches' && tiles.length > 0;

  // Esc goes back to the grid, ← → move between matches, 1-9 open one
  useEffect(() => {
    if (!showGrid) return;
    const ids = tileIds.split(',');
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Escape' && maxed) { setMaxId(null); return; }
      if (maxed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const i = ids.indexOf(maxed), n = ids.length;
        setMaxId(ids[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]);
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const id = ids[Number(e.key) - 1];
        if (id) setMaxId(id);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [showGrid, maxed, tileIds]);

  if (!idn.ready) return <main className="screen"><div className="screen-center"><Loading /></div></main>;
  if (!key || keyState === 'bad') {
    return (
      <main className="screen">
        <div className="screen-center">
          <div className="card stack narrow-card">
            <h1 className="h2">This screen is for the organiser</h1>
            <p className="note">{keyState === 'bad' ? 'The admin key saved in this browser doesn’t match this cup. ' : ''}It shows every match live, so it opens from the admin page: use your admin link, then press <b>Open the big screen</b>.</p>
            <div className="row"><Link className="btn" href={'/t/' + code + '/admin'}>Admin page</Link><Link className="btn ghost" href={'/t/' + code}>Player page</Link></div>
          </div>
        </div>
      </main>
    );
  }
  if (!t) {
    return <main className="screen"><div className="screen-center">{error ? <p className="lead">{error.status === 404 ? 'No cup with the code ' + code : error.message}</p> : <Loading text="Loading the cup…" />}</div></main>;
  }

  const joinUrl = (origin || '') + '/t/' + code;
  async function start() {
    if (!key) return;
    setBusy(true); setActionError('');
    try { await api('/api/t/' + code + '/admin', { key, action: 'start' }); await refresh(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (t.status === 'lobby') {
    return (
      <main className="screen">
        <header className="screen-head"><Brand name={t.name} href={'/t/' + code} /><span className="pill">Entries open</span></header>
        <section className="lobby-top">
          <div className="stack tight-stack">
            <h1 className="title">{t.name}</h1>
            <p className="lead">1v1 knockout · {rulesLine(t.rules)} · final: first to {t.rules.finalGoals}</p>
          </div>
          <div className="lobby-count">
            <p className="arrivals"><b>{t.players.length}</b> {t.players.length === 1 ? 'player' : 'players'} in</p>
            <button type="button" className="btn big" onClick={start} disabled={busy || t.players.length < 2}>{busy ? 'Drawing…' : 'Make the draw'}</button>
            {actionError ? <p className="error">{actionError}</p> : null}
          </div>
        </section>
        <section className="screen-lobby">
          <div className="card join-panel">
            <QR text={joinUrl} label="QR code to join the cup" />
            <div className="stack tight-stack">
              <p className="kicker">Scan to join</p>
              <p className="screen-url">{origin.replace(/^https?:\/\//, '')}/t/{code}</p>
              <p className="muted">or enter the code</p>
              <p className="screen-code">{code}</p>
            </div>
          </div>
          <div className="card hero lobby-demo" aria-hidden="true">
            <div className="arena">
              <GameView opts={{ mode: 'demo', players: [{ name: 'Warm-up', color: 'orange' }, { name: 'Match', color: 'teal' }], maxDpr: 1.25 }} />
            </div>
          </div>
        </section>
        <ul className="roster big-roster">
          {t.players.map(p => <li key={p.id} className="p arrive"><PlayerChip p={p} /><span className={'online' + (t.online[p.id] ? ' on' : '')} /></li>)}
        </ul>
      </main>
    );
  }

  const head = (
    <header className="screen-head">
      <Brand name={t.name} href={'/t/' + code} />
      <ProgressLine t={t} />
      <div className="row">
        {tiles.length ? (
          <div className="seg" role="radiogroup" aria-label="Show">
            <button type="button" role="radio" aria-checked={showGrid} onClick={() => setTab('matches')}>Matches · {tiles.length}</button>
            <button type="button" role="radio" aria-checked={!showGrid} onClick={() => setTab('bracket')}>Bracket</button>
          </div>
        ) : null}
        <span className="pill code-pill">Code {code}</span>
      </div>
    </header>
  );

  // the grid stays mounted behind the bracket, so its matches stay connected
  return (
    <main className={'screen' + (showGrid ? ' grid-mode' : '')}>
      {head}
      {tiles.length ? <MatchGrid t={t} code={code} adminKey={key} tiles={tiles} shown={showGrid} maxed={maxed} setMax={id => { Snd.unlock(); setMaxId(id); }} /> : null}
      {showGrid ? <p className="tiny muted center grid-hint">{tiles.length < 2 ? ' ' : maxed ? 'Esc or the button goes back to all matches · ← → switch match' : 'Click a match to fill the screen · or press its number'}</p> : (
        <>
          {t.status === 'finished' ? <ChampionBanner t={t} /> : null}
          <Bracket t={t} big fill={t.status === 'running'} onWatch={m => { setTab('matches'); setMaxId(m.id); Snd.unlock(); }} showOnline
            localHref={m => (m.status === 'ready' || (m.status === 'live' && m.local === 'admin')) ? '/t/' + code + '/m/' + m.id + '?local=1&from=screen' : null} />
          {t.status === 'running' ? <p className="tiny muted center">{tiles.length ? 'Matches shows every match being played.' : 'Matches show up here as soon as both players are known.'}</p> : null}
        </>
      )}
    </main>
  );
}

// every match being played, as tiles that share the screen; one can fill it
function MatchGrid({ t, code, adminKey, tiles, shown, maxed, setMax }: {
  t: View; code: string; adminKey: string; tiles: PublicMatch[]; shown: boolean; maxed: string | null; setMax: (id: string | null) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = tiles.length;
  const cols = maxed ? 1 : bestCols(n, box.w, box.h);
  const every = n <= 1 ? 1 : n <= 9 ? 2 : 3;    // draw less often when many pitches share the screen
  const mixed = new Set(tiles.map(m => m.round)).size > 1;   // the header already names the round otherwise
  return (
    <section ref={ref} className={'match-grid' + (maxed ? ' has-max' : '')} hidden={!shown} style={{ gridTemplateColumns: 'repeat(' + cols + ', minmax(0, 1fr))' }} aria-label="Matches">
      {tiles.map((m, i) => {
        const pa = playerOf(t, m.a), pb = playerOf(t, m.b);
        if (!pa || !pb) return null;
        const isMax = maxed === m.id, hidden = !!maxed && !isMax;
        const big = shown && (isMax || n === 1);
        return (
          <article key={m.id} className={'tile' + (m.status === 'live' ? ' live' : '') + (isMax ? ' max' : '')} hidden={hidden} aria-label={m.label + ': ' + pa.name + ' vs ' + pb.name}>
            <header className="tile-head">
              {!maxed && n > 1 ? <span className="tile-num" aria-hidden="true">{i + 1}</span> : null}
              <span className={'pill' + (m.status === 'live' ? ' live' : m.status === 'done' ? ' ok' : '')}>
                {m.status === 'done' ? 'Full time' : mixed || n === 1 ? m.label : m.status === 'live' ? 'Live' : 'Ready'}
              </span>
              <span className="tile-names"><PlayerChip p={pa} /><span className="vs-x">vs</span><PlayerChip p={pb} /></span>
              {n > 1 ? (
                <button type="button" className={'tile-btn' + (isMax ? ' on' : '')} onClick={() => setMax(isMax ? null : m.id)}
                  aria-label={isMax ? 'Back to all matches' : 'Fill the screen with this match'} title={isMax ? 'Back to all matches (Esc)' : 'Fill the screen'}>
                  {isMax ? <><ShrinkIcon /><span>All matches</span></> : <GrowIcon />}
                </button>
              ) : null}
            </header>
            <div className={'tile-body' + (!isMax && n > 1 ? ' can-grow' : '')} onClick={!isMax && n > 1 ? () => setMax(m.id) : undefined}>
              {m.local ? <LocalTile m={m} pa={pa.name} /> : (
                <MatchStage key={m.id} role="spectator" code={code} m={m} pa={pa} pb={pb} token={null} adminKey={adminKey}
                  nextLabel={m.round < t.rounds ? roundName(m.round + 1, t.rounds) : null}
                  serverResult={m.status === 'done' ? { winner: m.winner, score: m.score, via: m.via } : null}
                  tile={{ every: big ? 1 : every, sound: big, hidden: hidden || !shown, hd: big }} onExit={() => setMax(null)} />
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}

// the column count that gives each pitch (1060×720) the most room
function bestCols(n: number, w: number, h: number) {
  if (n <= 1) return 1;
  if (!w || !h) return Math.ceil(Math.sqrt(n));
  let best = 1, bestScale = 0;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const cw = (w - (c - 1) * GAP) / c, ch = (h - (r - 1) * GAP) / r - TILE_HEAD;
    const s = Math.min(cw / 1060, ch / 720);
    if (s > bestScale + 1e-6) { bestScale = s; best = c; }
  }
  return best;
}

function LocalTile({ m, pa }: { m: PublicMatch; pa: string }) {
  return (
    <div className="tile-static">
      <p className="final-score"><b>{m.score[0]} – {m.score[1]}</b></p>
      <p className="note">{m.local === 'admin' ? 'Being played on the organiser’s screen' : 'Being played side by side on ' + pa + '’s device'}, so it can’t be shown here.</p>
    </div>
  );
}

function GrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
}
function ShrinkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>;
}

function ProgressLine({ t }: { t: View }) {
  if (t.status === 'finished') return <span className="pill gold">Full time</span>;
  const open = t.matches.filter(m => m.status !== 'done');
  const round = open.length ? Math.min(...open.map(m => m.round)) : t.rounds;
  const inRound = t.matches.filter(m => m.round === round);
  const done = inRound.filter(m => m.status === 'done').length;
  const live = t.matches.filter(m => m.status === 'live').length;
  return (
    <p className="progress-line">
      <b>{roundName(round, t.rounds)}</b>
      <span className="muted">{done} of {inRound.length} played</span>
      {live ? <span className="pill live">{live} live</span> : null}
    </p>
  );
}
