'use client';
// A tournament match with both players on one device (the big screen, or the
// host's laptop when the online link will not connect). Results go through `reporter`.
import { useEffect, useRef, useState } from 'react';
import { Snd } from '@/lib/engine/sound';
import { BOTS_ALLOWED, rulesLine } from '@/lib/client';
import type { PublicMatch, PublicPlayer } from '@/lib/tournament';
import type { GameApi } from '@/lib/engine/types';
import { PlayerChip } from './bits';
import { Trophy } from './Trophy';

export type Reporter = {
  start: () => Promise<void>;
  score: (sc: [number, number]) => void;
  final: (sc: [number, number]) => Promise<string | null>;     // null when saved, else the problem
};

type Props = {
  m: PublicMatch; pa: PublicPlayer; pb: PublicPlayer;
  reporter: Reporter;
  resumeScore?: [number, number] | null;
  nextLabel?: string | null;
  onExit: () => void;
  full?: boolean;
};

export default function LocalStage(p: Props) {
  const { m, pa, pb } = p;
  const rootRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameApi | null>(null);
  const first = useRef(p);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [ended, setEnded] = useState<{ winner: number; score: [number, number] } | null>(null);
  const [save, setSave] = useState<{ state: 'idle' | 'saving' | 'saved' | 'error'; msg: string }>({ state: 'idle', msg: '' });
  const [touch, setTouch] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const P = first.current;
    let dead = false, finalSent = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    setTouch(matchMedia('(hover: none) and (pointer: coarse)').matches);
    const final = async (sc: [number, number]) => {
      if (finalSent) return;
      finalSent = true;
      setSave({ state: 'saving', msg: '' });
      const err = await P.reporter.final(sc);
      if (!dead) setSave(err ? { state: 'error', msg: err } : { state: 'saved', msg: '' });
    };
    import('@/lib/engine/game').then(({ createGame }) => {
      if (dead || !rootRef.current) return;
      const g = gameRef.current = createGame(rootRef.current, {
        mode: 'local2p',
        players: [P.pa, P.pb].map(x => ({ name: x.name, color: x.color, flag: x.flag })),
        rules: { goals: P.m.rules.goals, capSec: P.m.rules.capSec, modifiers: P.m.rules.modifiers },
        hooks: {
          onScore: (sc: [number, number], info: { over: boolean }) => { if (info.over) final(sc); else P.reporter.score(sc); },
          onEnd: (e: { score: [number, number] }) => final(e.score),
          onEndShown: (e: { winner: number; score: [number, number] }) => {
            timers.push(setTimeout(() => { if (!dead) setEnded({ winner: e.winner, score: e.score }); }, 2400));
          },
          onPauseKey: () => {
            const g = gameRef.current;
            if (!g || g.phase === 'warmup' || g.phase === 'end') return;
            g.setPaused(!g.paused);
            setPaused(g.paused);
          }
        }
      });
      setLoaded(true);
      if (BOTS_ALLOWED) (window as unknown as { __cc: unknown }).__cc = { game: g, role: 'local' };
    });
    return () => { dead = true; timers.forEach(clearTimeout); gameRef.current?.destroy(); gameRef.current = null; };
  }, []);

  useEffect(() => {
    if (!started || ended) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [started, ended]);

  function kickOff(e: React.MouseEvent<HTMLButtonElement>) {
    e.currentTarget.blur();
    Snd.unlock();
    const g = gameRef.current;
    if (!g || started) return;
    setStarted(true);
    p.reporter.start();
    g.startMatch({ score: p.resumeScore || undefined });
  }
  function resume() {
    const g = gameRef.current;
    if (!g) return;
    g.setPaused(false);
    setPaused(false);
  }

  let overlay: React.ReactNode = null;
  if (ended) {
    const w = ended.winner === 0 ? pa : pb;
    const final = p.nextLabel === null;
    overlay = (
      <div className="ovl"><div className="card end-card">
        {final ? <Trophy className="trophy-sm" /> : null}
        <h2 className="h2">{final ? w.name + ' is the champion!' : w.name + ' wins'}</h2>
        <div className="final-score"><PlayerChip p={pa} /><b>{ended.score[0]} – {ended.score[1]}</b><PlayerChip p={pb} /></div>
        {!final && p.nextLabel ? <p className="lead">{w.name} goes through to the {p.nextLabel.toLowerCase().startsWith('round') ? p.nextLabel : p.nextLabel.toLowerCase()}.</p> : null}
        <p className={'tiny ' + (save.state === 'error' ? 'error' : 'muted')}>{save.state === 'saving' ? 'Saving the result…' : save.state === 'saved' ? 'Result saved' : save.state === 'error' ? save.msg : ''}</p>
        <button type="button" className="btn" onClick={p.onExit}>Back</button>
      </div></div>
    );
  } else if (!started) {
    overlay = (
      <div className="ovl"><div className="card">
        <p className="kicker">{m.label} · {rulesLine(m.rules)}</p>
        <div className="vs"><PlayerChip p={pa} /><span className="vs-x">vs</span><PlayerChip p={pb} /></div>
        <div className="keys-two">
          <p><PlayerChip p={pa} /> {touch ? <>taps the <b>left half</b></> : <><kbd>W</kbd> both players · <kbd>A</kbd> <kbd>D</kbd> one</>}</p>
          <p><PlayerChip p={pb} /> {touch ? <>taps the <b>right half</b></> : <><kbd>↑</kbd> both players · <kbd>←</kbd> <kbd>→</kbd> one</>}</p>
        </div>
        {p.resumeScore && (p.resumeScore[0] || p.resumeScore[1]) ? <p className="note">Carrying on at {p.resumeScore[0]}–{p.resumeScore[1]}.</p> : null}
        <button type="button" className="btn" onClick={kickOff} disabled={!loaded}>Kick off</button>
      </div></div>
    );
  } else if (paused) {
    overlay = (
      <div className="ovl"><div className="card">
        <h2 className="h2">Paused</h2>
        <button type="button" className="btn" onClick={e => { e.currentTarget.blur(); resume(); }}>Resume</button>
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
