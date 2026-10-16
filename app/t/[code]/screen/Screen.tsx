'use client';
// The organiser's big screen, made to be shared in the meeting's video call: the QR
// code and arrivals, then the live match (the cup plays one match at a time), who's up
// next, the bracket, and the champion. Watching needs the admin key, so only the
// organiser can open it.
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bracket } from '@/components/Bracket';
import GameView from '@/components/GameView';
import MatchStage from '@/components/MatchStage';
import { Brand, Loading, PlayerChip, QR, RemovePlayer } from '@/components/bits';
import { ChampionBanner } from '@/components/Champion';
import { ApiError, api, matchOf, playerOf, rulesLine, useIdentity, useTournament, type View } from '@/lib/client';
import { roundName, type PublicMatch } from '@/lib/tournament';
import { Snd } from '@/lib/engine/sound';

const KEEP_MS = 10000;            // a match that just finished stays up this long, so its result can be seen

export default function Screen({ code }: { code: string }) {
  const idn = useIdentity(code);
  const { setAdmin } = idn;
  const key = idn.admin;
  const [keyState, setKeyState] = useState<'unknown' | 'ok' | 'bad'>('unknown');
  const { t, error, refresh } = useTournament(code, null, { enabled: idn.ready && !!key && keyState !== 'bad', every: 1500 });
  const [tab, setTab] = useState<'live' | 'bracket'>('live');
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

  // the server's clock: this device's, set by how far apart they were at the last answer, and
  // a redraw every second (a finished match leaves the screen after KEEP_MS)
  const offset = useMemo(() => (t ? t.now - Date.now() : 0), [t]);
  const [, setTick] = useState(0);
  useEffect(() => { const iv = setInterval(() => setTick(x => x + 1), 1000); return () => clearInterval(iv); }, []);
  const serverNow = t ? Date.now() + offset : 0;

  // what is on screen: the match on now; one that just finished stays up a few seconds,
  // unless the next one has already kicked off. Once a finished match has gone it stays gone,
  // so a clock that wobbles at the last moment can't bring it back.
  const gone = useRef(new Set<string>());
  const shown = (() => {
    if (!t || t.status === 'lobby') return null;
    const cur = t.current ? matchOf(t, t.current) : null;
    const recent = t.matches.filter(m => m.status === 'done' && m.via !== 'bye' && !!m.endedAt && !gone.current.has(m.id + ':' + m.endedAt))
      .filter(m => { if (serverNow - (m.endedAt || 0) < KEEP_MS) return true; gone.current.add(m.id + ':' + m.endedAt); return false; })
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0];
    if (recent && !(cur && cur.status === 'live')) return recent;
    return cur;
  })();
  const showLive = tab === 'live' && !!shown;

  if (!idn.ready) return <main className="screen"><div className="screen-center"><Loading /></div></main>;
  if (!key || keyState === 'bad') {
    return (
      <main className="screen">
        <div className="screen-center">
          <div className="card stack narrow-card">
            <h1 className="h2">This screen is for the organiser</h1>
            <p className="note">{keyState === 'bad' ? 'The admin key saved in this browser doesn’t match this cup. ' : ''}It shows the live match, so it opens from the admin page: use your admin link, then press <b>Open the big screen</b>.</p>
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
  // a second entry left behind by a frozen browser, say
  async function remove(playerId: string) {
    if (!key) return;
    setActionError('');
    try { await api('/api/t/' + code + '/admin', { key, action: 'remove', playerId }); await refresh(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
  }

  if (t.status === 'lobby') {
    return (
      <main className="screen">
        <header className="screen-head"><Brand name={t.name} href={'/t/' + code} /><span className="pill">Entries open</span></header>
        <section className="lobby-top">
          <div className="stack tight-stack">
            <h1 className="title">{t.name}</h1>
            <p className="lead">1v1 knockout, one match at a time · {rulesLine(t.rules)} · final: first to {t.rules.finalGoals}</p>
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
          {t.players.map(p => (
            <li key={p.id} className="p arrive">
              <PlayerChip p={p} />
              <span className={'online' + (t.online[p.id] ? ' on' : '')} title={t.online[p.id] ? 'Online' : 'Not seen recently'} />
              <RemovePlayer name={p.name} onRemove={() => remove(p.id)} />
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const next = t.next ? matchOf(t, t.next) : null;
  const head = (
    <header className="screen-head">
      <Brand name={t.name} href={'/t/' + code} />
      <ProgressLine t={t} />
      <div className="row">
        {shown ? (
          <div className="seg" role="radiogroup" aria-label="Show">
            <button type="button" role="radio" aria-checked={showLive} onClick={() => { Snd.unlock(); setTab('live'); }}>Live match</button>
            <button type="button" role="radio" aria-checked={!showLive} onClick={() => setTab('bracket')}>Bracket</button>
          </div>
        ) : null}
        <span className="pill code-pill">Code {code}</span>
      </div>
    </header>
  );

  return (
    <main className={'screen' + (showLive ? ' live-mode' : '')}>
      {head}
      {showLive && shown ? (
        <>
          <LiveMatch key={shown.id} t={t} m={shown} code={code} adminKey={key} />
          <p className="tiny muted center up-next">{next ? <>Up next: <PlayerChip p={playerOf(t, next.a)} fallback="To be decided" /> vs <PlayerChip p={playerOf(t, next.b)} fallback="To be decided" /> · {next.label}</> : t.status === 'finished' || shown.round === t.rounds ? ' ' : 'Then the next round'}</p>
        </>
      ) : (
        <>
          {t.status === 'finished' ? <ChampionBanner t={t} /> : null}
          <Bracket t={t} big fill={t.status === 'running'} onWatch={() => { setTab('live'); Snd.unlock(); }} showOnline
            localHref={m => m.id === t.current && (m.status === 'ready' || (m.status === 'live' && m.local === 'admin')) ? '/t/' + code + '/m/' + m.id + '?local=1&from=screen' : null} />
          {t.status === 'running' ? <p className="tiny muted center">{shown ? 'Live match shows the match on now.' : 'The live match shows up here when it starts.'}</p> : null}
        </>
      )}
    </main>
  );
}

// the match on now (or just finished), filling the screen, with sound
function LiveMatch({ t, m, code, adminKey }: { t: View; m: PublicMatch; code: string; adminKey: string }) {
  const pa = playerOf(t, m.a), pb = playerOf(t, m.b);
  if (!pa || !pb) return null;
  return (
    <section className="live-match" aria-label={m.label + ': ' + pa.name + ' vs ' + pb.name}>
      <header className="live-head">
        <span className={'pill' + (m.status === 'live' ? ' live' : m.status === 'done' ? ' ok' : '')}>{m.status === 'done' ? 'Full time' : m.status === 'live' ? 'Live' : 'Up now'}</span>
        <span className="live-label">{m.label}</span>
        <span className="tile-names"><PlayerChip p={pa} /><span className="vs-x">vs</span><PlayerChip p={pb} /></span>
      </header>
      <div className="live-body">
        {m.local ? (
          <div className="tile-static">
            <p className="final-score"><b>{m.score[0]} – {m.score[1]}</b></p>
            <p className="note">{m.local === 'admin' ? 'Being played on the organiser’s screen' : 'Being played side by side on ' + pa.name + '’s device'}, so it can’t be shown here.</p>
          </div>
        ) : m.status === 'done' && m.via !== 'played' ? (
          <div className="tile-static">
            <p className="final-score"><PlayerChip p={pa} /><b>{m.via === 'walkover' ? 'W/O' : m.score[0] + ' – ' + m.score[1]}</b><PlayerChip p={pb} /></p>
            <p className="note">{m.via === 'walkover' ? 'Walkover' : 'Decided by the organiser'}: <PlayerChip p={playerOf(t, m.winner)} /> goes through.</p>
          </div>
        ) : (
          <MatchStage role="spectator" transport={m.rules.net === 'server' ? 'server' : 'p2p'} code={code} m={m} pa={pa} pb={pb} token={null} adminKey={adminKey}
            nextLabel={m.round < t.rounds ? roundName(m.round + 1, t.rounds) : null}
            serverResult={m.status === 'done' ? { winner: m.winner, score: m.score, via: m.via } : null}
            onExit={() => { }} />
        )}
      </div>
    </section>
  );
}

function ProgressLine({ t }: { t: View }) {
  if (t.status === 'finished') return <span className="pill gold">Full time</span>;
  const real = t.matches.filter(m => m.via !== 'bye');
  const done = real.filter(m => m.status === 'done').length;
  const cur = t.current ? matchOf(t, t.current) : null;
  const open = t.matches.filter(m => m.status !== 'done');
  return (
    <p className="progress-line">
      <b>{cur ? cur.label : roundName(open.length ? Math.min(...open.map(m => m.round)) : t.rounds, t.rounds)}</b>
      <span className="muted">match {Math.min(real.length, done + 1)} of {real.length}</span>
      {cur && cur.status === 'live' ? <span className="pill live">Live {cur.score[0]}–{cur.score[1]}</span> : null}
    </p>
  );
}
