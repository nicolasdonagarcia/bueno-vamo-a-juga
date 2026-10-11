'use client';
// The big screen for the meeting: QR code and arrivals, then the live bracket,
// live matches to watch, and the champion.
import { useEffect, useState } from 'react';
import { Bracket } from '@/components/Bracket';
import GameView from '@/components/GameView';
import MatchStage from '@/components/MatchStage';
import { Brand, Flag, Loading, PlayerChip, QR } from '@/components/bits';
import { Trophy } from '@/components/Trophy';
import { api, playerOf, rulesLine, useIdentity, useTournament, type View } from '@/lib/client';
import { roundName } from '@/lib/tournament';
import { Snd } from '@/lib/engine/shared';

export default function Screen({ code }: { code: string }) {
  const idn = useIdentity(code);
  const { t, error, refresh } = useTournament(code, null, { enabled: idn.ready, every: 1500 });
  const [watch, setWatch] = useState<string | null>(null);
  const [finalDismissed, setFinalDismissed] = useState(false);
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => { setOrigin(window.location.origin); }, []);
  // the final goes on screen by itself
  useEffect(() => {
    if (!t || watch || finalDismissed || t.status !== 'running') return;
    const f = t.matches.find(m => m.round === t.rounds);
    if (f && f.status === 'live' && !f.local) setWatch(f.id);
  }, [t, watch, finalDismissed]);

  if (!t) {
    return <main className="screen"><div className="screen-center">{error ? <p className="lead">{error.status === 404 ? 'No cup with the code ' + code : error.message}</p> : <Loading text="Loading the cup…" />}</div></main>;
  }

  const joinUrl = (origin || '') + '/t/' + code;
  const watched = watch ? t.matches.find(m => m.id === watch) : null;
  const closeWatch = () => {
    if (watched && watched.round === t.rounds) setFinalDismissed(true);
    setWatch(null);
  };
  async function start() {
    if (!idn.admin) return;
    setBusy(true); setActionError('');
    try { await api('/api/t/' + code + '/admin', { key: idn.admin, action: 'start' }); await refresh(); }
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
            {idn.admin ? <button type="button" className="btn big" onClick={start} disabled={busy || t.players.length < 2}>{busy ? 'Drawing…' : 'Make the draw'}</button> : null}
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

  if (watched && !watched.local) {
    const pa = playerOf(t, watched.a), pb = playerOf(t, watched.b);
    if (pa && pb) {
      return (
        <main className="screen watching">
          <header className="screen-head">
            <Brand name={t.name} href={'/t/' + code} />
            <p className="watch-title"><span className="pill live">{watched.label}</span> <PlayerChip p={pa} /> <span className="vs-x">vs</span> <PlayerChip p={pb} /></p>
            <button type="button" className="btn ghost small" onClick={closeWatch}>Back to the bracket</button>
          </header>
          <MatchStage key={watched.id} role="spectator" code={code} m={watched} pa={pa} pb={pb} token={null}
            nextLabel={watched.round < t.rounds ? roundName(watched.round + 1, t.rounds) : null}
            serverResult={watched.status === 'done' ? { winner: watched.winner, score: watched.score, via: watched.via } : null}
            onExit={closeWatch} onEnded={closeWatch} full />
        </main>
      );
    }
  }

  return (
    <main className="screen">
      <header className="screen-head">
        <Brand name={t.name} href={'/t/' + code} />
        <ProgressLine t={t} />
        <span className="pill code-pill">Code {code}</span>
      </header>
      {t.status === 'finished' ? <Champion t={t} /> : null}
      <Bracket t={t} big fill={t.status === 'running'} onWatch={m => { Snd.unlock(); setWatch(m.id); }} showOnline
        localHref={idn.admin ? m => (m.status === 'ready' || (m.status === 'live' && m.local === 'admin')) ? '/t/' + code + '/m/' + m.id + '?local=1&from=screen' : null : undefined} />
      {t.status === 'running' ? <p className="tiny muted center">Live matches show a Watch button. The final appears here on its own.</p> : null}
    </main>
  );
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

function Champion({ t }: { t: View }) {
  const c = playerOf(t, t.champion);
  const final = t.matches.find(m => m.round === t.rounds);
  const other = final ? playerOf(t, final.a === t.champion ? final.b : final.a) : null;
  const sc = final ? (final.a === t.champion ? final.score : [final.score[1], final.score[0]]) : null;
  if (!c) return null;
  return (
    <section className="champion-screen" aria-label="Champion">
      <Confetti />
      <Trophy className="trophy big" title={t.name} />
      <div className="stack tight-stack center">
        <p className="kicker">Winner of {t.name}</p>
        <h1 className="title champ-name"><Flag code={c.flag} /> {c.name}</h1>
        {other && sc ? <p className="lead">Beat {other.name} {sc[0]}–{sc[1]} in the final</p> : null}
      </div>
    </section>
  );
}

function Confetti() {
  const colours = ['#ffd43b', '#ff7a1a', '#14b8cc', '#ff5ca8', '#59e08f', '#8e5cf7'];
  const bits = Array.from({ length: 36 }, (_, i) => i);
  return (
    <div className="confetti" aria-hidden="true">
      {bits.map(i => (
        <i key={i} style={{
          left: ((i * 37) % 100) + '%', background: colours[i % colours.length],
          animationDelay: ((i * 0.23) % 4).toFixed(2) + 's', animationDuration: (3.2 + ((i * 7) % 10) / 6).toFixed(2) + 's',
          transform: 'rotate(' + (i * 47) + 'deg)'
        }} />
      ))}
    </div>
  );
}
