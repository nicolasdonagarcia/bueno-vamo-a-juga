// Tickets to the match server. The app checks who someone is (a player's token, the
// organiser's key) against the bracket and hands their page a short-lived ticket,
// signed with the secret the app and the match server share (MATCH_SECRET). The match
// server only checks the signature, so it never needs the bracket or the store, and a
// page coming back after a restart just asks the app for a new ticket. The ticket
// carries what the match server needs to run the match.
import { createHmac, timingSafeEqual } from 'crypto';

export type TicketPlayer = { id: string; name: string; color: string; flag: string };
export type Ticket = {
  c: string;                       // the cup's code
  m: string;                       // the match
  s: 0 | 1 | -1;                   // seat: 0 left, 1 right, -1 the organiser watching
  x: number;                       // expires (ms since 1970)
  g: number;                       // the match's generation (it goes up when the organiser resets it)
  a: TicketPlayer; b: TicketPlayer;
  r: { goals: number; capSec: number; modifiers: boolean; inputDelay: number };
  sc: [number, number];            // the score saved in the bracket
  st: string;                      // the match's status in the bracket: ready, or live (it had kicked off)
  lb: string;                      // its label (Final, Semi-finals...)
  fr?: Record<string, unknown>;    // tests only (a match server started with MATCH_TEST=1): every round like this
};

export const TICKET_MS = 10 * 60 * 1000;

const b64 = (b: Buffer) => b.toString('base64url');
function mac(body: string, secret: string) { return createHmac('sha256', secret).update(body).digest(); }

export function signTicket(t: Ticket, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(t), 'utf8'));
  return body + '.' + b64(mac(body, secret));
}

// the ticket, or null when it is forged, damaged or out of date
export function verifyTicket(s: unknown, secret: string, now = Date.now()): Ticket | null {
  if (typeof s !== 'string' || s.length > 6000 || !secret) return null;
  const dot = s.indexOf('.');
  if (dot < 1) return null;
  const body = s.slice(0, dot), sig = Buffer.from(s.slice(dot + 1), 'base64url'), want = mac(body, secret);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  let t: Ticket;
  try { t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Ticket; } catch { return null; }
  if (!t || typeof t !== 'object' || typeof t.x !== 'number' || t.x < now) return null;
  if (typeof t.c !== 'string' || typeof t.m !== 'string' || (t.s !== 0 && t.s !== 1 && t.s !== -1)) return null;
  return t;
}

// the same secret in a header, compared in constant time (the match server's reports to the app)
export function sameSecret(a: unknown, b: string) {
  if (typeof a !== 'string' || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
