'use client';
// Mounts the match engine in a div. Options are read once: give the component a
// new `key` to start over with different ones.
import { useEffect, useRef } from 'react';
import type { GameApi, GameOpts } from '@/lib/engine/types';
import { BOTS_ALLOWED } from '@/lib/client';

export default function GameView({ opts, onGame, className }: {
  opts: GameOpts;
  onGame?: (g: GameApi) => void | (() => void);
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef({ opts, onGame });
  useEffect(() => {
    let g: GameApi | null = null, off: void | (() => void), dead = false;
    import('@/lib/engine/game').then(({ createGame }) => {
      if (BOTS_ALLOWED) (window as unknown as { __createGame: unknown }).__createGame = createGame;   // test builds: physics harness
      if (dead || !ref.current) return;
      g = createGame(ref.current, first.current.opts);
      off = first.current.onGame?.(g);
    });
    return () => {
      dead = true;
      if (typeof off === 'function') off();
      g?.destroy();
    };
  }, []);
  return <div ref={ref} className={'wc-root' + (className ? ' ' + className : '')} />;
}
