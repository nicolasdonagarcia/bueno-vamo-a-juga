// Types for the JavaScript match engine and the peer-to-peer link.
import type { createGame } from './game.js';
import type { createLink } from '../net/link.js';

export type GameMode = 'practice' | 'local2p' | 'demo' | 'host' | 'guest' | 'spectator';
export type GamePlayer = { name: string; color: string; flag?: string | null };
export type GameRules = { goals: number; capSec: number; modifiers: boolean };
export type EndEvent = { k: 'end'; winner: number; score: [number, number]; reason: string; t?: number };
export type GameHooks = {
  onSnapshot?: (buf: ArrayBuffer) => void;
  onEvent?: (ev: Record<string, unknown>) => void;
  onPress?: (slots: number[]) => void;
  onScore?: (score: [number, number], info: { team: number; own: boolean; over: boolean }) => void;
  onEnd?: (e: { winner: number; score: [number, number]; reason: string }) => void;
  onEndShown?: (e: EndEvent) => void;
  onDisplayEvent?: (e: Record<string, unknown>) => void;
  onPauseKey?: () => void;
};
export type GameOpts = {
  mode: GameMode;
  players?: GamePlayer[];
  rules?: Partial<GameRules>;
  cpuSkill?: number;
  bot?: { skill: number };
  seed?: number;
  hooks?: GameHooks;
  renderEvery?: number;
  maxDpr?: number;
  sound?: boolean;
  demoSound?: boolean;
  input?: boolean;
};
export type GameApi = ReturnType<typeof createGame>;
export type LinkApi = ReturnType<typeof createLink>;
export type Route = { relay: boolean; rtt: number | null } | null;
