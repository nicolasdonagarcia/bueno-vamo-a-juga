'use client';
// The organiser's page: share links, players, rules, the draw, and fixing results.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Brand, CopyButton, Loading, PlayerChip, QR } from '@/components/bits';
import { ApiError, api, fmtTime, playerOf, useIdentity, useTournament, type View } from '@/lib/client';
import type { PublicMatch, Rules } from '@/lib/tournament';

export default function Admin({ code }: { code: string }) {
  const idn = useIdentity(code);
  const { setAdmin } = idn;
  const [origin, setOrigin] = useState('');
  const [keyState, setKeyState] = useState<'unknown' | 'ok' | 'bad'>('unknown');
  const { t, error, refresh } = useTournament(code, null, { enabled: idn.ready, every: 2000 });

  // the creation link carries the key in its #hash: keep it here, then tidy the address bar
  useEffect(() => {
    setOrigin(window.location.origin);
    const m = /[#&]k=([^&]+)/.exec(window.location.hash);
    if (m) {
      setAdmin(decodeURIComponent(m[1]));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [setAdmin]);
  const key = idn.admin;
  useEffect(() => {
    if (!key) return;
    let live = true;
    setKeyState('unknown');
    api('/api/t/' + code + '/admin', { key, action: 'check' })
      .then(() => { if (live) setKeyState('ok'); })
      .catch(e => { if (live) setKeyState(e instanceof ApiError && e.status === 403 ? 'bad' : 'ok'); });
    return () => { live = false; };
  }, [key, code]);

  async function act(action: string, extra?: Record<string, unknown>) {
    await api('/api/t/' + code + '/admin', { key, action, ...extra });
    await refresh();
  }

  if (!idn.ready || (!t && !error)) return <Shell code={code}><Loading /></Shell>;
  if (!t) return <Shell code={code}><div className="card"><p className="lead">{error?.status === 404 ? 'No cup with the code ' + code + '.' : error?.message}</p></div></Shell>;
  if (!key || keyState === 'bad') return <Shell code={code} name={t.name}><KeyForm bad={keyState === 'bad'} onKey={k => setAdmin(k)} /></Shell>;

  const playerUrl = origin + '/t/' + code;
  const adminUrl = origin + '/t/' + code + '/admin#k=' + encodeURIComponent(key);

  return (
    <Shell code={code} name={t.name}>
      <div className="admin-grid">
        <div className="stack">
        <section className="card stack" aria-label="Share">
          <h2 className="h3">Share</h2>
          <div className="share-row">
            <QR text={playerUrl} label="QR code for players" />
            <div className="stack tight-stack share-links">
              <p className="field-label">Players join at</p>
              <p className="mono">{playerUrl.replace(/^https?:\/\//, '')}</p>
              <div className="row"><CopyButton text={playerUrl} label="Copy player link" /></div>
              <p className="field-label">Big screen for the meeting</p>
              <div className="row"><a className="btn small" href={'/t/' + code + '/screen'} target="_blank" rel="noreferrer">Open the big screen</a></div>
              <p className="field-label">This admin page</p>
              <div className="row"><CopyButton text={adminUrl} label="Copy admin link" /></div>
              <p className="note small">Keep the admin link to yourself: it starts the draw and changes results.</p>
            </div>
          </div>
        </section>
        <RulesCard t={t} act={act} />
        <DangerCard t={t} act={act} />
        </div>
        <div className="stack">
          {t.status === 'lobby' ? <LobbyAdmin t={t} act={act} /> : <MatchesAdmin t={t} code={code} act={act} />}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ code, name, children }: { code: string; name?: string; children: React.ReactNode }) {
  return (
    <main className="page">
      <header className="topbar">
        <Brand name={name} href={'/t/' + code} />
        <div className="row"><span className="pill gold">Admin</span><span className="pill code-pill">Code {code}</span></div>
      </header>
      {children}
    </main>
  );
}

function KeyForm({ bad, onKey }: { bad: boolean; onKey: (k: string) => void }) {
  const [v, setV] = useState('');
  return (
    <form className="card stack narrow-card" onSubmit={e => {
      e.preventDefault();
      const m = /k=([^&\s]+)/.exec(v);
      onKey(decodeURIComponent(m ? m[1] : v.trim()));
    }}>
      <h1 className="h2">Organisers only</h1>
      <p className="note">{bad ? 'That admin key does not match this cup.' : 'Open the admin link you got when you created the cup, or paste it here.'}</p>
      <label className="field"><span>Admin link or key</span><input className="input" value={v} onChange={e => setV(e.target.value)} required /></label>
      <div className="row"><button className="btn" type="submit">Continue</button></div>
    </form>
  );
}

type Act = (action: string, extra?: Record<string, unknown>) => Promise<void>;

function useAction(act: Act) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function run(id: string, action: string, extra?: Record<string, unknown>) {
    setBusy(id); setError('');
    try { await act(action, extra); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(''); }
  }
  return { busy, error, run, setError };
}

function estimate(n: number, r: Rules) {
  if (n < 2 || !r.capSec || !r.finalCapSec) return '';
  const rounds = Math.ceil(Math.log2(n));
  const min = (rounds - 1) * (r.capSec / 60 + 1.5) + r.finalCapSec / 60 + 1.5;
  return rounds + ' rounds · about ' + Math.round(min) + ' minutes if every match goes the distance (golden goals add a little)';
}

function LobbyAdmin({ t, act }: { t: View; act: Act }) {
  const a = useAction(act);
  return (
    <section className="card stack" aria-label="Players">
      <div className="spread"><h2 className="h3">Players</h2><span className="pill">{t.players.length}</span></div>
      {t.players.length ? (
        <ul className="roster">
          {t.players.map(p => (
            <li key={p.id} className="p">
              <PlayerChip p={p} />
              <span className={'online' + (t.online[p.id] ? ' on' : '')} title={t.online[p.id] ? 'Online' : 'Not seen recently'} />
              <button type="button" className="icon-btn" aria-label={'Remove ' + p.name} disabled={!!a.busy}
                onClick={() => a.run('rm' + p.id, 'remove', { playerId: p.id })}>×</button>
            </li>
          ))}
        </ul>
      ) : <p className="note">Nobody has joined yet. Put the big screen up so people can scan the code.</p>}
      <p className="note small">{estimate(t.players.length, t.rules) || 'You need at least two players.'}</p>
      {a.error ? <p className="error">{a.error}</p> : null}
      <div className="row">
        <button type="button" className="btn big" disabled={t.players.length < 2 || !!a.busy} onClick={() => a.run('start', 'start')}>
          {a.busy === 'start' ? 'Drawing…' : 'Make the draw and start'}
        </button>
      </div>
      <p className="note small">The draw is random. With a number of players that isn&apos;t 2, 4, 8, 16 or 32, a few people get a bye into the next round.</p>
    </section>
  );
}

function MatchesAdmin({ t, code, act }: { t: View; code: string; act: Act }) {
  const [open, setOpen] = useState('');
  const rounds = Array.from({ length: t.rounds }, (_, i) => i + 1);
  return (
    <section className="card stack matches-admin" aria-label="Matches">
      <div className="spread">
        <h2 className="h3">Matches</h2>
        {t.status === 'finished' ? <span className="pill gold">Champion: {playerOf(t, t.champion)?.name}</span> : null}
      </div>
      {rounds.map(r => {
        const ms = t.matches.filter(m => m.round === r);
        return (
          <div key={r} className="stack tight-stack">
            <h3 className="field-label">{ms[0]?.label}</h3>
            <ul className="match-rows">
              {ms.map(m => <MatchRow key={m.id} t={t} m={m} code={code} act={act} open={open === m.id} onToggle={() => setOpen(open === m.id ? '' : m.id)} />)}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function MatchRow({ t, m, code, act, open, onToggle }: { t: View; m: PublicMatch; code: string; act: Act; open: boolean; onToggle: () => void }) {
  const pa = playerOf(t, m.a), pb = playerOf(t, m.b);
  const a = useAction(act);
  const [sa, setSa] = useState(String(m.score[0]));
  const [sb, setSb] = useState(String(m.score[1]));
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (!open) { setSa(String(m.score[0])); setSb(String(m.score[1])); setConfirmReset(false); a.setError(''); } }, [open, m.score]); // eslint-disable-line react-hooks/exhaustive-deps
  const both = !!(pa && pb);
  const statusText = m.status === 'live' ? (m.local ? 'Live on one device' : 'Live') : m.status === 'ready' ? 'Ready' : m.status === 'done' ? (m.via === 'walkover' ? 'Walkover' : m.via === 'bye' ? 'Bye' : 'Done') : 'Waiting';
  const na = Number(sa), nb = Number(sb);
  const scoreOk = Number.isInteger(na) && Number.isInteger(nb) && na >= 0 && nb >= 0 && na !== nb;
  return (
    <li className={'match-row' + (m.status === 'live' ? ' live' : '')}>
      <div className="match-line">
        <PlayerChip p={pa} fallback={m.via === 'bye' ? 'Bye' : 'To be decided'} />
        {(m.status === 'ready' || m.status === 'live') && pa && !m.local ? <span className={'online' + (t.online[pa.id] ? ' on' : '')} /> : null}
        <b className="score">{m.via === 'bye' ? '' : m.status === 'done' && m.via === 'walkover' ? 'W/O' : m.status === 'live' || m.status === 'done' ? m.score[0] + '–' + m.score[1] : 'vs'}</b>
        <PlayerChip p={pb} fallback={m.via === 'bye' ? 'Bye' : 'To be decided'} />
        {(m.status === 'ready' || m.status === 'live') && pb && !m.local ? <span className={'online' + (t.online[pb.id] ? ' on' : '')} /> : null}
        <span className={'pill' + (m.status === 'live' ? ' live' : m.status === 'done' ? ' ok' : '')}>{statusText}</span>
        {both && m.via !== 'bye' ? <button type="button" className="btn ghost small" aria-expanded={open} onClick={onToggle}>{open ? 'Close' : 'Manage'}</button> : null}
      </div>
      {open && pa && pb ? (
        <div className="match-tools">
          {m.status === 'ready' || m.status === 'live' ? (
            <div className="row">
              <Link className="btn small" href={'/t/' + code + '/m/' + m.id + '?local=1'}>Play it on this device</Link>
              <span className="note small">For two people sharing one keyboard, or when their link won&apos;t connect.</span>
            </div>
          ) : null}
          <div className="row score-entry">
            <span className="note small">Result:</span>
            <label className="score-in"><span className="sr-only">{pa.name} goals</span><input className="input" inputMode="numeric" value={sa} onChange={e => setSa(e.target.value.replace(/\D/g, '').slice(0, 2))} /></label>
            <span>–</span>
            <label className="score-in"><span className="sr-only">{pb.name} goals</span><input className="input" inputMode="numeric" value={sb} onChange={e => setSb(e.target.value.replace(/\D/g, '').slice(0, 2))} /></label>
            <button type="button" className="btn small" disabled={!scoreOk || !!a.busy}
              onClick={() => a.run('res', 'result', { matchId: m.id, winner: na > nb ? 'a' : 'b', score: [na, nb], via: 'admin' })}>Save result</button>
          </div>
          <div className="row">
            <span className="note small">Or a walkover:</span>
            <button type="button" className="btn ghost small" disabled={!!a.busy} onClick={() => a.run('wa', 'result', { matchId: m.id, winner: 'a', score: [0, 0], via: 'walkover' })}>{pa.name} goes through</button>
            <button type="button" className="btn ghost small" disabled={!!a.busy} onClick={() => a.run('wb', 'result', { matchId: m.id, winner: 'b', score: [0, 0], via: 'walkover' })}>{pb.name} goes through</button>
          </div>
          {m.status === 'live' || m.status === 'done' ? (
            <div className="row">
              {!confirmReset
                ? <button type="button" className="btn ghost small" onClick={() => setConfirmReset(true)}>Reset this match</button>
                : <>
                  <span className="note small">Clear the score and play it again?</span>
                  <button type="button" className="btn danger small" disabled={!!a.busy} onClick={async () => { if (await a.run('reset', 'reset', { matchId: m.id })) setConfirmReset(false); }}>Reset</button>
                  <button type="button" className="btn ghost small" onClick={() => setConfirmReset(false)}>Keep it</button>
                </>}
            </div>
          ) : null}
          {a.error ? <p className="error">{a.error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

const GOALS = [1, 2, 3, 4, 5, 6, 7];
const CAPS = [0, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600];

function RulesCard({ t, act }: { t: View; act: Act }) {
  const [r, setR] = useState<Rules>(t.rules);
  const [name, setName] = useState(t.name);
  const a = useAction(act);
  const [savedMsg, setSavedMsg] = useState('');
  const dirty = JSON.stringify(r) !== JSON.stringify(t.rules) || name.trim() !== t.name;
  useEffect(() => { if (!savedMsg) return; const x = setTimeout(() => setSavedMsg(''), 2000); return () => clearTimeout(x); }, [savedMsg]);
  const sel = (label: string, value: number, opts: number[], fmt: (n: number) => string, on: (n: number) => void) => (
    <label className="field">
      <span>{label}</span>
      <select className="select" value={value} onChange={e => on(Number(e.target.value))}>
        {opts.map(o => <option key={o} value={o}>{fmt(o)}</option>)}
      </select>
    </label>
  );
  return (
    <section className="card stack" aria-label="Rules">
      <h2 className="h3">Rules</h2>
      <label className="field"><span>Name of the cup</span><input className="input" value={name} maxLength={18} onChange={e => setName(e.target.value)} /></label>
      <div className="rules-grid">
        {sel('Matches: first to', r.goals, GOALS, n => n + (n === 1 ? ' goal' : ' goals'), n => setR({ ...r, goals: n }))}
        {sel('Matches: time limit', r.capSec, CAPS, n => n ? fmtTime(n) + ', then golden goal' : 'No limit', n => setR({ ...r, capSec: n }))}
        {sel('Final: first to', r.finalGoals, GOALS, n => n + (n === 1 ? ' goal' : ' goals'), n => setR({ ...r, finalGoals: n }))}
        {sel('Final: time limit', r.finalCapSec, CAPS, n => n ? fmtTime(n) + ', then golden goal' : 'No limit', n => setR({ ...r, finalCapSec: n }))}
      </div>
      <label className="check"><input type="checkbox" checked={r.modifiers} onChange={e => setR({ ...r, modifiers: e.target.checked })} /> Crazy rounds: after each goal the pitch may change (moon gravity, ice, big heads, a baseball, an American football…)</label>
      <p className="note small">Changes apply to matches that haven&apos;t kicked off yet.</p>
      {a.error ? <p className="error">{a.error}</p> : null}
      <div className="row">
        <button type="button" className="btn small" disabled={!dirty || !!a.busy} onClick={async () => {
          const ok = await a.run('rules', 'rules', { rules: r });
          if (ok && name.trim() !== t.name) await a.run('rename', 'rename', { name: name.trim() });
          if (ok) setSavedMsg('Saved');
        }}>Save rules</button>
        {savedMsg ? <span className="note small">{savedMsg}</span> : null}
      </div>
    </section>
  );
}

function DangerCard({ t, act }: { t: View; act: Act }) {
  const a = useAction(act);
  const [sure, setSure] = useState(false);
  if (t.status === 'lobby') return null;
  return (
    <section className="card stack" aria-label="Start over">
      <h2 className="h3">Start over</h2>
      <p className="note small">Back to the lobby with the same players. The bracket and every result are cleared, and people can join again.</p>
      {a.error ? <p className="error">{a.error}</p> : null}
      <div className="row">
        {!sure ? <button type="button" className="btn ghost small" onClick={() => setSure(true)}>Back to the lobby</button>
          : <>
            <button type="button" className="btn danger small" disabled={!!a.busy} onClick={async () => { if (await a.run('restart', 'restart')) setSure(false); }}>Yes, clear the bracket</button>
            <button type="button" className="btn ghost small" onClick={() => setSure(false)}>Cancel</button>
          </>}
      </div>
    </section>
  );
}
