'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import LocalStage, { type Reporter } from '@/components/LocalStage';
import MatchStage from '@/components/MatchStage';
import { Brand, Loading, PlayerChip } from '@/components/bits';
import { ApiError, BOTS_ALLOWED, api, matchOf, playerOf, rulesLine, sleep, useIdentity, useTournament } from '@/lib/client';
import { roundName } from '@/lib/tournament';

type Role = 'host' | 'guest' | 'spectator' | 'host-local' | 'admin-local';

async function finalWithRetry(send: () => Promise<unknown>, fallback: string): Promise<string | null> {
  for (let i = 0; i < 30; i++) {
    try { await send(); return null; } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) return e.message;
      await sleep(1500);
    }
  }
  return fallback;
}
function hostReporter(code: string, id: string, token: string): Reporter {
  const url = '/api/t/' + code + '/m/' + id + '/report';
  return {
    start: async () => { try { await api(url, { token, kind: 'start', local: true }); } catch { /* the result still counts */ } },
    score: sc => { api(url, { token, kind: 'score', score: sc }).catch(() => { }); },
    final: sc => finalWithRetry(() => api(url, { token, kind: 'final', score: sc, winner: sc[0] > sc[1] ? 'a' : 'b' }), 'Could not save the result. Tell the organiser the score.')
  };
}
function adminReporter(code: string, id: string, key: string): Reporter {
  const url = '/api/t/' + code + '/admin';
  return {
    start: async () => { try { await api(url, { key, action: 'live', matchId: id }); } catch { /* shown on the admin page */ } },
    score: sc => { api(url, { key, action: 'score', matchId: id, score: sc }).catch(() => { }); },
    final: sc => finalWithRetry(() => api(url, { key, action: 'result', matchId: id, winner: sc[0] > sc[1] ? 'a' : 'b', score: sc, via: 'local' }), 'Could not save the result. Enter it on the admin page.')
  };
}

export default function MatchClient({ code, id, local, bot, from }: { code: string; id: string; local: boolean; bot: string; from: string }) {
  const router = useRouter();
  const idn = useIdentity(code);
  const token = idn.player?.token || null;
  const { t, error } = useTournament(code, token, { enabled: idn.ready, every: 3000 });
  const m = matchOf(t, id);
  const [role, setRole] = useState<Role | null>(null);
  const [resume, setResume] = useState<[number, number] | null>(null);
  const [touch, setTouch] = useState(false);
  const botSkill = BOTS_ALLOWED && bot ? Math.min(1, Math.max(0.1, Number(bot) || 0.7)) : 0;
  const hubHref = local ? '/t/' + code + (from === 'screen' ? '/screen' : '/admin') : '/t/' + code + (botSkill ? '?bot=' + botSkill : '');

  useEffect(() => { setTouch(matchMedia('(hover: none) and (pointer: coarse)').matches); }, []);

  // decide once what this device is in the match
  useEffect(() => {
    if (role || !t || !m || t.forToken !== token) return;
    if (m.status !== 'ready' && m.status !== 'live') return;
    if (local) { if (idn.admin) { setResume(m.status === 'live' ? m.score : null); setRole('admin-local'); } return; }
    const r: Role = t.you && t.you === m.a ? (m.local ? 'host-local' : 'host') : t.you && t.you === m.b ? 'guest' : 'spectator';
    if (r === 'host' || r === 'host-local') setResume(m.status === 'live' ? m.score : null);
    setRole(r);
  }, [role, t, m, token, local, idn.admin]);

  const reporter = useMemo(() => {
    if (role === 'admin-local' && idn.admin) return adminReporter(code, id, idn.admin);
    if (role === 'host-local' && token) return hostReporter(code, id, token);
    return null;
  }, [role, idn.admin, token, code, id]);

  const pa = playerOf(t, m?.a), pb = playerOf(t, m?.b);
  const back = () => router.push(hubHref);
  const nextLabel = t && m ? (m.round < t.rounds ? roundName(m.round + 1, t.rounds) : null) : null;
  const serverResult = m && m.status === 'done' ? { winner: m.winner, score: m.score, via: m.via } : null;

  let body: React.ReactNode;
  if (!idn.ready || (!t && !error)) body = <Loading text="Loading the match…" />;
  else if (!t || !m) {
    body = <Notice title={!t ? (error?.status === 404 ? 'No cup with the code ' + code : 'Could not load the match') : 'No such match'} text={error && !t ? error.message : 'Check the link and try again.'} href={'/t/' + code} />;
  } else if (!role) {
    if (local && !idn.admin) body = <Notice title="Organisers only" text="Running a match on this device needs the admin link of this cup." href={'/t/' + code} />;
    else if (m.status === 'waiting') {
      body = <Notice title="Not ready yet" text="This match starts once both matches before it are finished." href={hubHref}>
        <p className="vs-line"><PlayerChip p={pa} fallback="To be decided" /> <span className="vs-x">vs</span> <PlayerChip p={pb} fallback="To be decided" /></p>
      </Notice>;
    } else if (m.status === 'done') {
      const w = playerOf(t, m.winner);
      body = <Notice title={w ? w.name + ' went through' : 'Finished'} text={m.via === 'walkover' ? 'Decided by the organiser (walkover).' : m.via === 'bye' ? 'A bye: no opponent in this slot.' : ''} href={hubHref}>
        {m.via !== 'bye' ? <p className="final-score"><PlayerChip p={pa} /><b>{m.via === 'walkover' ? 'W/O' : m.score[0] + ' – ' + m.score[1]}</b><PlayerChip p={pb} /></p> : null}
      </Notice>;
    } else body = <Loading />;
  } else if (!pa || !pb) {
    body = <Loading />;
  } else if (m.local && m.status !== 'done' && role !== 'host-local' && role !== 'admin-local') {
    const player = role === 'host' || role === 'guest';
    body = <Notice
      title={!player ? 'Played on one device' : m.local === 'admin' ? 'Play it on the big screen' : 'Play on ' + pa.name + '’s device'}
      text={!player ? 'This match is being played on one device, so it can’t be watched online.'
        : m.local === 'admin' ? 'The organiser is running this match on their screen. Go over there and play it side by side.'
          : pa.name + ' moved this match onto their device, so you two play side by side there.'}
      href={hubHref} />;
  } else if (role === 'host-local' || role === 'admin-local') {
    body = reporter ? <LocalStage key={role} m={m} pa={pa} pb={pb} reporter={reporter} resumeScore={resume} nextLabel={nextLabel} onExit={back} full /> : <Loading />;
  } else {
    body = (
      <MatchStage key={role} role={role} code={code} m={m} pa={pa} pb={pb} token={token} bot={botSkill || undefined}
        resumeScore={resume} nextLabel={nextLabel} serverResult={serverResult} full
        onExit={back} onEnded={botSkill ? back : undefined}
        onLocal={role === 'host' ? () => { setResume(m.status === 'live' ? m.score : null); setRole('host-local'); } : undefined} />
    );
  }

  const hint = role === 'spectator' ? 'You’re watching · M toggles sound'
    : role === 'host-local' || role === 'admin-local' ? (touch ? 'Each player taps their half of the pitch' : 'Esc pauses · M toggles sound')
      : role ? (touch ? 'Tap anywhere to jump and kick' : 'Space, W or ↑ jumps and kicks · A or D moves one player · M toggles sound') : '';

  return (
    <main className="page wide play-page">
      <header className="topbar">
        <Brand name={t?.name} href={'/t/' + code} />
        <div className="row">
          {m ? <span className="pill hide-small">{m.label} · {rulesLine(m.rules)}</span> : null}
          <a className="btn ghost small" href={hubHref}>{local ? (from === 'screen' ? 'Big screen' : 'Admin') : 'Bracket'}</a>
        </div>
      </header>
      {body}
      {hint ? <p className="tiny muted center controls">{hint}{touch ? <span className="portrait-only"> · Turn your phone sideways for a bigger pitch</span> : null}</p> : null}
    </main>
  );
}

function Notice({ title, text, href, children }: { title: string; text?: string; href: string; children?: React.ReactNode }) {
  return (
    <div className="card stack notice">
      <h1 className="h2">{title}</h1>
      {children}
      {text ? <p className="note">{text}</p> : null}
      <div className="row"><a className="btn" href={href}>Back to the bracket</a></div>
    </div>
  );
}
