// Shared test driving: enumerate every action a state legally invites, so a
// seeded walk can play whole games without knowing the rules.

import { nearestSlots } from "../src/engine/turn";
import { currentPlayerId } from "../src/engine/state";
import type { Action, GameState, SlotRef } from "../src/engine/types";

export function candidates(s: GameState): Action[] {
  const me = currentPlayerId(s);
  const out: Action[] = [];
  const everySlot = (): SlotRef[] =>
    s.players.flatMap((p) => p.layout.map((_, i) => ({ playerId: p.id, slot: i })));

  switch (s.phase) {
    case "LOBBY":
      out.push({ type: "StartMatch", playerId: s.hostId });
      break;
    case "INITIAL_PEEK":
      for (const p of s.players) {
        if (!p.hasPeeked) out.push({ type: "PeekInitial", playerId: p.id, slots: nearestSlots(s.config) });
      }
      break;
    case "TURN_START":
      out.push({ type: "DrawStock", playerId: me });
      out.push({ type: "TakeDiscard", playerId: me });
      break;
    case "AWAIT_HELD_DECISION":
      out.push({ type: "DiscardHeld", playerId: me });
      for (let i = 0; i < s.players.find((p) => p.id === me)!.layout.length; i++) {
        out.push({ type: "PlaceInSlot", playerId: me, slot: i });
      }
      break;
    case "AWAIT_SLOT_FOR_DISCARD":
      for (let i = 0; i < s.players.find((p) => p.id === me)!.layout.length; i++) {
        out.push({ type: "PlaceInSlot", playerId: me, slot: i });
      }
      break;
    case "POWER_AWAIT_SWAP_CONFIRM":
      out.push({ type: "PowerConfirmSwap", playerId: me, swap: true });
      out.push({ type: "PowerConfirmSwap", playerId: me, swap: false });
      break;
    case "POWER_AWAIT_OWN_SLOT":
    case "POWER_AWAIT_OPPONENT_SLOT":
    case "POWER_AWAIT_TWO_SLOTS":
    case "POWER_AWAIT_GIVE_TARGET":
      out.push({ type: "PowerSkip", playerId: me });
      // Deliberately includes illegal targets so the misuse path gets exercised.
      for (const target of everySlot()) out.push({ type: "PowerTarget", playerId: me, target });
      break;
    case "AWAIT_SNAP_GIVE": {
      const snapper = s.pendingSnapGive!.snapperId;
      const layout = s.players.find((p) => p.id === snapper)!.layout;
      for (let i = 0; i < layout.length; i++) {
        if (layout[i]!.cardId !== null) out.push({ type: "SnapGive", playerId: snapper, slot: i });
      }
      break;
    }
    case "TURN_END":
      out.push({ type: "EndTurn", playerId: me });
      if (s.announcerId === null) out.push({ type: "AnnounceCactus", playerId: me });
      break;
    case "ROUND_END":
      out.push({ type: "StartNextRound", playerId: s.hostId });
      break;
    default:
      break;
  }

  // Snaps can fire from anyone, at any in-round moment — including wrong ones.
  if (s.config.snap.enabled && s.discard.length > 0) {
    for (const p of s.players) {
      p.layout.forEach((slot, i) => {
        if (slot.cardId !== null) {
          out.push({
            type: "Snap",
            playerId: p.id,
            target: { playerId: p.id, slot: i },
            forVersion: s.discardVersion,
          });
        }
      });
    }
  }

  return out;
}

/** Every card id the engine could ever mint looks like this. */
export const CARD_ID = /^d\d+-/;

/** All string leaves of a JSON-serialisable value. */
export function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringLeaves(v, out);
    }
  }
  return out;
}
