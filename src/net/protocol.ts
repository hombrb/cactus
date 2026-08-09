// The wire protocol — docs/10 §3, §4.
//
// Shared verbatim by the browser client and the Durable Object, so a change on
// one side fails to compile on the other. Nothing here may import the DOM, node
// or workerd: it has to typecheck in all three.

import type { PlayerView } from "../engine/project";
import type { Action, Event, PlayerId } from "../engine/types";

/**
 * Six characters, no `O`/`0` and no `I`/`1` — a code gets read aloud across a
 * table (docs/10 §2).
 */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

export function makeRoomCode(bytes: Uint8Array): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/** Codes are case-insensitive; this is the only form the server stores. */
export function normaliseRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export type ClientMessage =
  /** Answer to a `ping`; carries the token back so the server can time it. */
  | { readonly t: "pong"; readonly token: number }
  | { readonly t: "action"; readonly action: Action };

export type ServerMessage =
  | {
      readonly t: "welcome";
      readonly code: string;
      readonly seat: PlayerId;
      readonly view: PlayerView;
    }
  | {
      readonly t: "update";
      readonly view: PlayerView;
      /** Already redacted for the recipient — see projectEvent. */
      readonly events: readonly Event[];
    }
  | { readonly t: "ping"; readonly token: number }
  | { readonly t: "error"; readonly message: string };

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

/** Never throws: a malformed frame is a dropped frame, not a crashed room. */
export function decodeClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const t = (parsed as { t?: unknown }).t;
  if (t === "pong") {
    const token = (parsed as { token?: unknown }).token;
    return typeof token === "number" ? { t: "pong", token } : null;
  }
  if (t === "action") {
    const action = (parsed as { action?: unknown }).action;
    if (action === null || typeof action !== "object") return null;
    if (typeof (action as { type?: unknown }).type !== "string") return null;
    return { t: "action", action: action as Action };
  }
  return null;
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(raw) as ServerMessage;
    return typeof parsed?.t === "string" ? parsed : null;
  } catch {
    return null;
  }
}
