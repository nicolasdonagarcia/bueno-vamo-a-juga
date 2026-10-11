'use client';
import Link from 'next/link';
import type { PublicMatch, PublicTournament } from '@/lib/tournament';
import { PlayerChip } from './bits';
import { Trophy } from './Trophy';

type Props = {
  t: PublicTournament & { online?: Record<string, boolean> };
  me?: string | null;
  big?: boolean;
  fill?: boolean;                                    // stretch to the height of the screen
  hrefFor?: (m: PublicMatch) => string | null;      // where a card links to (play / watch)
  onWatch?: (m: PublicMatch) => void;               // big screen: watch a live match here
  localHref?: (m: PublicMatch) => string | null;    // organiser: play a match on this screen
  showOnline?: boolean;
};

const VIA: Record<string, string> = { walkover: 'Walkover', admin: 'Set by the organiser', bye: 'Bye', local: 'Played on one device' };

export function Bracket({ t, me, big, fill, hrefFor, onWatch, localHref, showOnline }: Props) {
  const rounds = Array.from({ length: t.rounds }, (_, i) => i + 1);
  const champ = t.champion ? t.players.find(p => p.id === t.champion) : null;
  return (
    <div className={'bracket' + (big ? ' big' : '') + (fill ? ' fill' : '')}>
      {rounds.map(r => {
        const ms = t.matches.filter(m => m.round === r).sort((a, b) => a.index - b.index);
        return (
          <section className="col" key={r} aria-label={ms[0]?.label}>
            <h3>{ms[0]?.label}</h3>
            <div className="slots">
              {ms.map(m => <MatchCard key={m.id} t={t} m={m} me={me} href={hrefFor ? hrefFor(m) : null} onWatch={onWatch} local={localHref ? localHref(m) : null} showOnline={showOnline} />)}
            </div>
          </section>
        );
      })}
      <section className="col champ-col" aria-label="Champion">
        <h3>Champion</h3>
        <div className="slots">
          <div className={'champ-slot' + (champ ? ' won' : '')}>
            <Trophy className="trophy" />
            {champ ? <PlayerChip p={champ} me={champ.id === me} /> : <span className="muted small">Who lifts it?</span>}
          </div>
        </div>
      </section>
    </div>
  );
}

function MatchCard({ t, m, me, href, onWatch, local, showOnline }: {
  t: Props['t']; m: PublicMatch; me?: string | null; href: string | null; onWatch?: (m: PublicMatch) => void; local?: string | null; showOnline?: boolean;
}) {
  const pa = t.players.find(p => p.id === m.a) || null, pb = t.players.find(p => p.id === m.b) || null;
  const mine = !!me && (m.a === me || m.b === me);
  const done = m.status === 'done';
  const bye = m.via === 'bye';
  const cls = 'mcard' + (m.status === 'live' ? ' live' : '') + (mine ? ' mine' : '') + (done ? ' done' : '');
  const line = (side: 'a' | 'b') => {
    const id = side === 'a' ? m.a : m.b, p = side === 'a' ? pa : pb;
    const won = done && m.winner && m.winner === id, lost = done && m.winner && m.winner !== id && !!id;
    const sc = m.score[side === 'a' ? 0 : 1];
    const showSc = !bye && (m.status === 'live' || (done && m.via !== 'walkover'));
    return (
      <div className={'line' + (won ? ' won' : '') + (lost ? ' lost' : '') + (!p ? ' tbd' : '')}>
        <PlayerChip p={p} me={!!me && id === me} fallback={bye && !p ? 'Bye' : undefined} />
        {showOnline && p && (m.status === 'ready' || m.status === 'live') && !m.local ? <span className={'online' + (t.online?.[p.id] ? ' on' : '')} title={t.online?.[p.id] ? 'Online' : 'Not seen recently'} /> : null}
        <span className="sc">{showSc ? sc : ''}</span>
      </div>
    );
  };
  const meta = (
    <div className="meta">
      {m.status === 'live' ? <span className="pill live">{m.local ? 'Live · one device' : 'Live'}</span>
        : m.status === 'ready' ? <span className="pill">Ready</span>
          : done ? <span className="tiny muted">{bye ? 'Straight through' : VIA[m.via || ''] || 'Full time'}</span>
            : <span className="tiny muted">Waiting</span>}
      {onWatch && m.status === 'live' && !m.local ? <button type="button" className="btn small" onClick={() => onWatch(m)}>Watch</button> : null}
      {local ? <Link className="btn ghost small" href={local}>{m.status === 'live' ? 'Resume here' : 'Play here'}</Link> : null}
    </div>
  );
  const body = <>{line('a')}{line('b')}{meta}</>;
  if (href) return <Link className={cls + ' link-card'} href={href}>{body}</Link>;
  return <div className={cls}>{body}</div>;
}
