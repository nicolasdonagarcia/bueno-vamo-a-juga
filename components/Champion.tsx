'use client';
// The end of the cup: trophy, confetti and the winner, on every player's page
// and on the big screen.
import type { PublicTournament } from '@/lib/tournament';
import { Flag } from './bits';
import { Trophy } from './Trophy';

export function ChampionBanner({ t, me }: { t: PublicTournament; me?: string | null }) {
  const c = t.players.find(p => p.id === t.champion);
  const final = t.matches.find(m => m.round === t.rounds);
  if (!c) return null;
  const otherId = final ? (final.a === c.id ? final.b : final.a) : null;
  const other = t.players.find(p => p.id === otherId) || null;
  const sc = final ? (final.a === c.id ? final.score : [final.score[1], final.score[0]]) : null;
  const mine = !!me && me === c.id;
  const beat = other && sc ? (final?.via === 'walkover' ? 'Won the final against ' + other.name + ' by walkover' : 'Beat ' + other.name + ' ' + sc[0] + '–' + sc[1] + ' in the final') : '';
  return (
    <section className="champion-screen" aria-label="Champion">
      <Confetti />
      <Trophy className="trophy big" title={t.name} />
      <div className="stack tight-stack center">
        <p className="kicker">{mine ? 'You won' : 'Winner of'} {t.name}</p>
        <h1 className="title champ-name"><Flag code={c.flag} /> {c.name}</h1>
        {beat ? <p className="lead">{beat}</p> : null}
      </div>
    </section>
  );
}

export function Confetti() {
  const colours = ['#ffd43b', '#ff7a1a', '#14b8cc', '#ff5ca8', '#59e08f', '#8e5cf7'];
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: 36 }, (_, i) => (
        <i key={i} style={{
          left: ((i * 37) % 100) + '%', background: colours[i % colours.length],
          animationDelay: ((i * 0.23) % 4).toFixed(2) + 's', animationDuration: (3.2 + ((i * 7) % 10) / 6).toFixed(2) + 's',
          transform: 'rotate(' + (i * 47) + 'deg)'
        }} />
      ))}
    </div>
  );
}
