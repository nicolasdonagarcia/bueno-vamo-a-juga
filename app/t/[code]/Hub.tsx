'use client';
// A player's home for one cup: join, wait in the lobby, then follow the bracket
// and jump into each match as it comes up.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bracket } from '@/components/Bracket';
import JoinForm from '@/components/JoinForm';
import PracticeArena from '@/components/PracticeArena';
import { Brand, Loading, PlayerChip } from '@/components/bits';
import { ChampionBanner } from '@/components/Champion';
import { BOTS_ALLOWED, api, matchOf, myStatus, playerOf, rulesLine, useIdentity, useTournament, type MyStatus, type View } from '@/lib/client';
import { COLORS } from '@/lib/engine/shared';
import { Snd } from '@/lib/engine/sound';
import { FLAG_LIST } from '@/lib/flags';
import type { PublicMatch } from '@/lib/tournament';

export default function Hub({ code, bot, botName }: { code: string; bot: string; botName: string }) {
  const router = useRouter();
  const idn = useIdentity(code);
  const token = idn.player?.token || null;
  const { t, error } = useTournament(code, token, { enabled: idn.ready });
  const [editing, setEditing] = useState(false);
  const [removed, setRemoved] = useState(false);
  const botSkill = BOTS_ALLOWED && bot ? Math.min(1, Math.max(0.1, Number(bot) || 0.7)) : 0;
  const botQ = botSkill ? '?bot=' + botSkill : '';

  // a saved entry the server no longer knows (removed by the organiser)
  const { setPlayer } = idn;
  useEffect(() => {
    if (t && token && t.forToken === token && !t.you) { setPlayer(null); setRemoved(true); }
  }, [t, token, setPlayer]);

  const me = t?.you || null;
  const status: MyStatus = t ? myStatus(t, me) : { kind: 'none' };

  // tell the player when their match comes up (not when they open the page to it)
  const alerted = useRef('');
  const sawWaiting = useRef(false);
  const playId = status.kind === 'play' ? status.m.id : '';
  useEffect(() => { if (t && t.forToken === token && status.kind !== 'play') sawWaiting.current = true; });
  useEffect(() => {
    if (!playId || alerted.current === playId) return;
    alerted.current = playId;
    if (botSkill) { router.push('/t/' + code + '/m/' + playId + botQ); return; }
    if (sawWaiting.current) {
      try { Snd.beep(true); setTimeout(() => Snd.beep(true), 260); } catch { /* no sound yet */ }
      try { navigator.vibrate?.([120, 60, 120]); } catch { /* not supported */ }
    }
  }, [playId, botSkill, botQ, code, router]);
  // sound needs one tap on the page first
  useEffect(() => {
    const unlock = () => Snd.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);
  useEffect(() => {
    const base = t ? t.name : 'The Coterie Cup';
    document.title = (status.kind === 'play' ? '▶ Your match · ' : '') + base;
  }, [t, status.kind]);

  // test bots join by themselves
  const botJoining = useRef(false);
  useEffect(() => {
    if (!botSkill || !idn.ready || idn.player || !t || t.status !== 'lobby' || botJoining.current) return;
    botJoining.current = true;
    const flag = FLAG_LIST[Math.floor(Math.random() * FLAG_LIST.length)][0];
    const color = COLORS[Math.floor(Math.random() * COLORS.length)].id;
    api<{ playerId: string; token: string }>('/api/t/' + code + '/join', { name: botName || 'Bot ' + Math.floor(Math.random() * 900 + 100), flag, color })
      .then(r => { setPlayer(r); })
      .catch(() => { botJoining.current = false; });
  }, [botSkill, botName, idn.ready, idn.player, t, code, setPlayer]);

  const takenColors = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of t?.players || []) if (p.id !== me) c[p.color] = (c[p.color] || 0) + 1;
    return c;
  }, [t, me]);

  if (!idn.ready || (!t && !error)) return <Shell code={code}><Loading text="Loading the cup…" /></Shell>;
  if (!t) {
    return (
      <Shell code={code}>
        <div className="card stack">
          <h1 className="h2">{error?.status === 404 ? 'No cup with the code ' + code : 'Could not load the cup'}</h1>
          <p className="note">{error?.status === 404 ? 'Check the code on the big screen and try again.' : error?.message}</p>
          <div className="row"><Link className="btn" href="/">Back</Link></div>
        </div>
      </Shell>
    );
  }

  const mine = playerOf(t, me);
  // only your own match opens from here, once it is on: the organiser shows the live match on the big screen
  const hrefFor = (m: PublicMatch) => {
    if (m.status !== 'ready' && m.status !== 'live') return null;
    if (!me || (m.a !== me && m.b !== me)) return null;
    if (m.status !== 'live' && t.current !== m.id) return null;
    return '/t/' + code + '/m/' + m.id + botQ;
  };

  return (
    <Shell code={code} name={t.name}>
      {error ? <p className="banner-warn" role="status">Connection trouble: {error.message} Retrying…</p> : null}

      {t.status === 'lobby' ? (
        !mine || editing ? (
          <div className="grid2">
            <div className="stack">
              {removed && !mine ? <p className="banner-warn">The organiser removed your entry. You can join again.</p> : null}
              <JoinForm code={code} token={token} takenColors={takenColors}
                current={mine && editing ? { name: mine.name, flag: mine.flag, color: mine.color } : null}
                onJoined={p => { setPlayer(p); setEditing(false); setRemoved(false); }}
                onCancel={editing ? () => setEditing(false) : undefined} />
            </div>
            <LobbyList t={t} me={me} />
          </div>
        ) : (
          <div className="stack">
            <div className="card you-card">
              <div className="spread">
                <div className="stack tight-stack">
                  <p className="kicker">You&apos;re in</p>
                  <p className="big-chip"><PlayerChip p={mine} /></p>
                </div>
                <button type="button" className="btn ghost small" onClick={() => setEditing(true)}>Edit</button>
              </div>
              <p className="note">Waiting for the organiser to make the draw. Keep this page open: your first match will show up here.</p>
            </div>
            <div className="grid2 lobby-grid">
              <details className="card warmup" open>
                <summary className="h3">Warm up against the CPU</summary>
                <PracticeArena me={{ name: mine.name, color: mine.color, flag: mine.flag }} />
              </details>
              <LobbyList t={t} me={me} />
            </div>
          </div>
        )
      ) : (
        <div className="stack">
          {t.status === 'finished' ? <ChampionBanner t={t} me={me} />
            : mine ? <StatusCard t={t} code={code} status={status} botQ={botQ} /> : (
              <div className="card"><p className="note">{t.matchServer && t.rules.net !== 'p2p'
                ? 'The draw has been made, so entries are closed. You can follow the bracket here and watch the matches live.'
                : 'The draw has been made, so entries are closed. You can follow the bracket here; the organiser shows the matches on the big screen.'}</p></div>
            )}
          {/* everybody can watch the match on now (your own match opens above; waiting in the queue, the button is in your card) */}
          {t.status === 'running' && status.kind !== 'play' && status.kind !== 'queued' ? <WatchLive t={t} code={code} /> : null}
          <section className="stack" aria-label="Bracket">
            <div className="spread"><h2 className="h3">The bracket</h2><span className="tiny muted">{rulesLine(t.rules)} · final: first to {t.rules.finalGoals}</span></div>
            <Bracket t={t} me={me} hrefFor={hrefFor} />
          </section>
        </div>
      )}
    </Shell>
  );
}

function Shell({ code, name, children }: { code: string; name?: string; children: React.ReactNode }) {
  return (
    <main className="page">
      <header className="topbar">
        <Brand name={name} href={'/t/' + code} />
        <span className="pill code-pill">Code {code}</span>
      </header>
      {children}
    </main>
  );
}

function LobbyList({ t, me }: { t: View; me: string | null }) {
  return (
    <section className="card stack" aria-label="Players">
      <div className="spread"><h2 className="h3">Players</h2><span className="pill">{t.players.length}</span></div>
      {t.players.length ? (
        <ul className="roster">
          {t.players.map(p => (
            <li key={p.id} className={'p' + (p.id === me ? ' me' : '')}><PlayerChip p={p} me={p.id === me} /></li>
          ))}
        </ul>
      ) : <p className="note">Nobody yet. Be the first.</p>}
    </section>
  );
}

// the match on now, for anyone to watch from the live view (/watch)
function WatchLive({ t, code }: { t: View; code: string }) {
  const now = t.current ? matchOf(t, t.current) : null;
  if (!now || now.rules.net !== 'server' || now.local) return null;
  return (
    <div className="card status-card" aria-label="Watch live">
      <p className="kicker">On now · {now.label}</p>
      <p className="lead vs-line">
        <PlayerChip p={playerOf(t, now.a)} /> <span className="vs-x">vs</span> <PlayerChip p={playerOf(t, now.b)} />
        {now.status === 'live' ? <> · <span className="pill live">{now.score[0]}–{now.score[1]}</span></> : ' · about to start'}
      </p>
      <div className="row"><Link className="btn" href={'/t/' + code + '/watch'}>Watch live</Link></div>
    </div>
  );
}

function StatusCard({ t, code, status, botQ }: { t: View; code: string; status: MyStatus; botQ: string }) {
  const me = t.you;
  if (status.kind === 'play') {
    const m = status.m;
    const opp = playerOf(t, m.a === me ? m.b : m.a);
    const where = m.local ? (m.a === me ? 'on your device' : 'on ' + playerOf(t, m.a)?.name + '’s device') : '';
    return (
      <div className="card status-card go">
        <p className="kicker">{m.label} · {rulesLine(m.rules)}</p>
        <h1 className="h2">{m.status === 'live' ? 'Your match is on' : 'Your match is ready'}</h1>
        <p className="lead vs-line"><PlayerChip p={playerOf(t, me)} me /> <span className="vs-x">vs</span> <PlayerChip p={opp} /></p>
        {where ? <p className="note">Being played {where}.</p> : null}
        <div className="row"><Link className="btn big" href={'/t/' + code + '/m/' + m.id + botQ}>{m.status === 'live' ? 'Back to the match' : 'Play'}</Link></div>
      </div>
    );
  }
  if (status.kind === 'queued') {
    const m = status.m, now = status.now;
    const opp = playerOf(t, m.a === me ? m.b : m.a);
    return (
      <div className="card status-card">
        <p className="kicker">{m.label} · {rulesLine(m.rules)}</p>
        <h1 className="h2">{status.before <= 1 ? 'You’re up next' : status.before + ' matches before yours'}</h1>
        <p className="lead vs-line"><PlayerChip p={playerOf(t, me)} me /> <span className="vs-x">vs</span> <PlayerChip p={opp} /></p>
        {now ? (
          <p className="note">Now playing: <PlayerChip p={playerOf(t, now.a)} /> vs <PlayerChip p={playerOf(t, now.b)} />
            {now.status === 'live' ? <> · <span className="pill live">{now.score[0]}–{now.score[1]}</span></> : ' · about to start'}</p>
        ) : null}
        <p className="note small">One match at a time. Keep this page open: it tells you when it’s your turn.</p>
        {now && now.rules.net === 'server' && !now.local ? <div className="row"><Link className="btn" href={'/t/' + code + '/watch'}>Watch live</Link></div> : null}
      </div>
    );
  }
  if (status.kind === 'waiting') {
    const f = status.feeder;
    const fa = f ? playerOf(t, f.a) : null, fb = f ? playerOf(t, f.b) : null;
    return (
      <div className="card status-card">
        <p className="kicker">Next up · {status.m.label}</p>
        <h1 className="h2">{status.m.round > 1 ? 'You’re through!' : 'Waiting for your opponent'}</h1>
        {f ? (
          <p className="lead">You’ll play the winner of <PlayerChip p={fa} /> vs <PlayerChip p={fb} />
            {f.status === 'live' ? <> · <span className="pill live">{f.score[0]}–{f.score[1]}</span></> : f.status === 'ready' ? ' · about to start' : ''}
          </p>
        ) : <p className="note">Waiting for the other match to finish.</p>}
      </div>
    );
  }
  if (status.kind === 'out') {
    const m = status.m;
    const by = playerOf(t, m.winner);
    const mineA = m.a === me;
    const sc = mineA ? m.score : [m.score[1], m.score[0]];
    return (
      <div className="card status-card">
        <p className="kicker">{m.label}</p>
        <h1 className="h2">Knocked out</h1>
        <p className="lead">{m.via === 'walkover' ? <>The match went to <PlayerChip p={by} /></> : <>Beaten by <PlayerChip p={by} /> {sc[0]}–{sc[1]}</>}. Stick around and watch who lifts the cup.</p>
      </div>
    );
  }
  return null;     // the champion and everyone else see the champion banner once the cup is over
}
