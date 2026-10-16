// Types for the JavaScript match engine and the links.
import type { createGame } from './game.js';
import type { createLink } from '../net/link.js';
import type { createServerLink } from '../net/serverLink.js';

export type GameMode = 'practice' | 'local2p' | 'demo' | 'host' | 'guest' | 'player' | 'spectator';
export type GamePlayer = { name: string; color: string; flag?: string | null };
export type GameRules = { goals: number; capSec: number; modifiers: boolean };
export type EndEvent = { k: 'end'; winner: number; score: [number, number]; reason: string; t?: number };
export type GameHooks = {
  onSnapshot?: (buf: ArrayBuffer) => void;
  onEvent?: (ev: Record<string, unknown>) => void;
  // a player's press: viewTime = the authority-clock moment it was looking at; a predicting
  // player also sends the tick its copy applies the press on, a sequence number the authority
  // acknowledges, the lean of each man and the tick it was looking at
  onPress?: (slots: number[], viewTime?: number, tick?: number, seq?: number, leans?: number[], view?: number) => void;
  onFullState?: (buf: ArrayBuffer) => void;                   // peer-to-peer host: the full state for a predicting guest
  onPressAck?: (seq: number, slack: number) => void;          // peer-to-peer host: a guest press arrived with `slack` ticks to spare
  onHostPress?: (slot: number, tick: number, lean: number, round: number) => void;   // peer-to-peer host: its own press, for the guest's copy
  onScore?: (score: [number, number], info: { team: number; own: boolean; over: boolean }) => void;
  onEnd?: (e: { winner: number; score: [number, number]; reason: string }) => void;
  onEndShown?: (e: EndEvent) => void;
  onDisplayEvent?: (e: Record<string, unknown>) => void;
  onPauseKey?: () => void;
};
export type GameOpts = {
  mode: GameMode;
  team?: number;                   // player: 0 (left) or 1 (right)
  players?: GamePlayer[];
  rules?: Partial<GameRules>;
  cpuSkill?: number;
  bot?: { skill: number };
  seed?: number;
  hooks?: GameHooks;
  renderEvery?: number;
  snapEvery?: number;
  predict?: boolean;               // guest: run a copy ahead of the host (default true)
  inputDelay?: number;             // ticks a press waits, on every screen (a cup setting)
  maxDpr?: number;
  sound?: boolean;
  demoSound?: boolean;
  input?: boolean;
  forceRound?: Record<string, unknown>;
};
export type GameApi = ReturnType<typeof createGame>;
export type LinkApi = ReturnType<typeof createLink>;
export type ServerLinkApi = ReturnType<typeof createServerLink>;
export type Route = { relay: boolean; rtt: number | null } | null;
export type NetStats = ReturnType<GameApi['netStats']>;
