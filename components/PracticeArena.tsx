'use client';
// Practice: you against the CPU, or two people on one keyboard. Used on its own
// page and in the lobby while players wait for the draw.
import { useEffect, useRef, useState } from 'react';
import GameView from './GameView';
import { Snd } from '@/lib/engine/shared';
import { saved } from '@/lib/client';
import type { GameApi } from '@/lib/engine/types';

const LEVELS = [
  { id: 'easy', label: 'Easy', skill: 0.45 },
  { id: 'normal', label: 'Normal', skill: 0.74 },
  { id: 'hard', label: 'Hard', skill: 0.93 }
];

export default function PracticeArena({ full, me }: { full?: boolean; me?: { name: string; color: string; flag?: string | null } | null }) {
  const [mode, setMode] = useState<'practice' | 'local2p'>('practice');
  const [level, setLevel] = useState('normal');
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<'pre' | 'play' | 'paused' | 'end'>('pre');
  const [result, setResult] = useState<{ winner: number; score: [number, number] } | null>(null);
  const [touch, setTouch] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const game = useRef<GameApi | null>(null);
  const profile = useRef(me || null);

  useEffect(() => {
    setTouch(matchMedia('(hover: none) and (pointer: coarse)').matches);
    // wear your own name and kit: restart the pitch once the saved profile is known
    if (!profile.current) { const p = saved.profile(); if (p) { profile.current = p; setLoaded(false); setRun(r => r + 1); } }
  }, []);
  useEffect(() => { game.current?.setCpuSkill(LEVELS.find(l => l.id === level)!.skill); }, [level]);

  const you = profile.current;
  const players = mode === 'local2p'
    ? [{ name: 'Left', color: 'orange' }, { name: 'Right', color: 'teal' }]
    : [{ name: you?.name || 'You', color: you?.color || 'orange', flag: you?.flag || null }, { name: 'CPU', color: you?.color === 'teal' ? 'red' : 'teal', flag: null }];

  function restart(nextMode = mode) {
    setMode(nextMode);
    setPhase('pre'); setResult(null); setLoaded(false);
    setRun(r => r + 1);
  }
  function kickOff(e: React.MouseEvent<HTMLButtonElement>) {
    e.currentTarget.blur();
    Snd.unlock();
    if (!game.current) return;
    game.current.startMatch();
    setPhase('play');
  }
  function togglePause() {
    const g = game.current;
    if (!g || g.phase === 'warmup' || g.phase === 'end') return;
    g.setPaused(!g.paused);
    setPhase(g.paused ? 'paused' : 'play');
  }

  return (
    <div className="stack practice">
      <div className="spread practice-bar">
        <div className="seg" role="radiogroup" aria-label="Opponent">
          <button type="button" role="radio" aria-checked={mode === 'practice'} onClick={() => restart('practice')}>vs CPU</button>
          <button type="button" role="radio" aria-checked={mode === 'local2p'} onClick={() => restart('local2p')}>2 players, 1 device</button>
        </div>
        {mode === 'practice' ? (
          <div className="seg" role="radiogroup" aria-label="CPU level">
            {LEVELS.map(l => <button key={l.id} type="button" role="radio" aria-checked={level === l.id} onClick={() => setLevel(l.id)}>{l.label}</button>)}
          </div>
        ) : null}
      </div>
      <div className={'arena' + (full ? ' full' : '')}>
        <GameView key={run + mode} opts={{
          mode, players, rules: { goals: 3, capSec: 180, modifiers: true },
          cpuSkill: LEVELS.find(l => l.id === level)!.skill,
          hooks: {
            onEndShown: (e) => { setTimeout(() => { setResult({ winner: e.winner, score: e.score }); setPhase('end'); }, 2200); },
            onPauseKey: () => togglePause()
          }
        }} onGame={g => { game.current = g; setLoaded(true); return () => { if (game.current === g) game.current = null; }; }} />
        {phase === 'pre' ? (
          <div className="ovl"><div className="card">
            <p className="kicker">{mode === 'local2p' ? 'Two players, one device' : 'Practice match'} · first to 3</p>
            {mode === 'local2p'
              ? <div className="keys-two">
                <p><b>Left</b>: {touch ? 'tap the left half' : <><kbd>W</kbd> both players · <kbd>A</kbd> <kbd>D</kbd> one</>}</p>
                <p><b>Right</b>: {touch ? 'tap the right half' : <><kbd>↑</kbd> both players · <kbd>←</kbd> <kbd>→</kbd> one</>}</p>
              </div>
              : <p className="note">{touch ? 'Tap anywhere to jump and kick.' : <><kbd>Space</kbd>, <kbd>W</kbd> or <kbd>↑</kbd> jumps and kicks with both players. <kbd>A</kbd> or <kbd>D</kbd> moves just one.</>} Your players lean back and forth: press when they lean toward the ball.</p>}
            <button type="button" className="btn" onClick={kickOff} disabled={!loaded}>Kick off</button>
          </div></div>
        ) : phase === 'paused' ? (
          <div className="ovl"><div className="card">
            <h2 className="h2">Paused</h2>
            <button type="button" className="btn" onClick={e => { e.currentTarget.blur(); togglePause(); }}>Resume</button>
          </div></div>
        ) : phase === 'end' && result ? (
          <div className="ovl"><div className="card">
            <h2 className="h2">{mode === 'local2p' ? (result.winner === 0 ? 'Left' : 'Right') + ' wins' : result.winner === 0 ? 'You won!' : 'The CPU won'}</h2>
            <p className="final-score"><b>{result.score[0]} – {result.score[1]}</b></p>
            <button type="button" className="btn" onClick={() => restart()}>Play again</button>
          </div></div>
        ) : null}
      </div>
      <p className="tiny muted center">{touch ? 'Tap to jump and kick.' : 'Esc pauses · M mutes'}</p>
    </div>
  );
}
