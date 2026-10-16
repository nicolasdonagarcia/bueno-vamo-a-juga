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
  // guest: viewTime = the host-clock moment it was looking at; a predicting guest also sends
  // the tick its copy applies the press on, and a sequence number the host acknowledges
  onPress?: (slots: number[], viewTime?: number, tick?: number, seq?: number) => void;
  onFullState?: (buf: ArrayBuffer) => void;                   // host: the full state for a predicting guest
  onPressAck?: (seq: number, slack: number) => void;          // host: a guest press arrived with `slack` ticks to spare
  onHostPress?: (slot: number, tick: number, lean: number, round: number) => void;   // host: its own press, for the guest's copy
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
  snapEvery?: number;
  predict?: boolean;               // guest: run a copy ahead of the host (default true)
  maxDpr?: number;
  sound?: boolean;
  demoSound?: boolean;
  input?: boolean;
};
export type GameApi = ReturnType<typeof createGame>;
export type LinkApi = ReturnType<typeof createLink>;
export type Route = { relay: boolean; rtt: number | null } | null;
