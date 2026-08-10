// Who, on this device, may act — and on which slot.
//
// The board used to answer this with one flag per half: `live`, meaning "this
// device owns the seat whose cards these are". That conflates two different
// questions, and the confusion cost the online game every power that targets an
// opponent. A player holding one seat could not tap the opposite half at all, so
// PEEK_OPPONENT and the second half of both swaps were unreachable and expired
// on the turn clock (docs/06 §4, §5, §6).
//
// The two questions, kept apart here:
//
//   `live`         — may this half show a tray, a prompt, a private card?
//                    A property of the seat, and it stays in the board.
//   acting seat    — which seat that this device owns is entitled to act now?
//                    Independent of which half the target lives in.
//
// Both functions read only a `PlayerView`, so they are as true online as on the
// flat table, and they are pure so the rule can be tested without a DOM.

import type { PlayerView } from "../../engine/project";
import { nearestSlots } from "../../engine/turn";
import type { PlayerId, SlotRef } from "../../engine/types";

/**
 * The seat this device owns that may act right now, or null when the turn
 * belongs to somebody else's phone.
 *
 * A pending power belongs to its owner even when the phase looks like anybody's
 * (docs/06 §2 validates `playerId === pp.ownerId`), and a snap give belongs to
 * the snapper, who is not necessarily the current player (docs/07 §5).
 */
export function actingSeat(view: PlayerView, seats: readonly PlayerId[]): PlayerId | null {
  const entitled =
    view.pendingPower?.ownerId ??
    (view.phase === "AWAIT_SNAP_GIVE" ? view.pendingSnapGive?.snapperId : undefined) ??
    view.currentPlayer;
  return seats.includes(entitled) ? entitled : null;
}

/**
 * Which owned seat may tap `ref` right now, or null if none may.
 *
 * Mirrors `isLegalTarget` in the engine (`src/engine/powers.ts`) for the pending
 * power, but only as an affordance: an illegal target is a *misuse* of the power
 * and costs a penalty card, so the engine — not this — has the last word
 * (docs/06 §2). What this must never do is disagree with the handler that
 * dispatches, which is why the board asks it for both the highlight and the tap.
 */
export function targetableBy(
  view: PlayerView,
  seats: readonly PlayerId[],
  ref: SlotRef,
): PlayerId | null {
  // The opening peek is answered before `actingSeat` has any meaning: both
  // players look at once (docs/05 §4), so it belongs to neither of them in
  // particular. And it is the one moment the board must *point*: the engine grants
  // `nearestSlots` — the lowest indices by convention — while the grid draws index
  // 0 in the row furthest from its owner, so a prompt naming a row was telling
  // players to hold the two cards the peek does not cover. Ringing them says it
  // without having to be right about which way up the grid is.
  if (view.phase === "INITIAL_PEEK") {
    if (!seats.includes(ref.playerId)) return null;
    if (view.players.find((p) => p.id === ref.playerId)?.hasPeeked !== false) return null;
    return nearestSlots(view.config).includes(ref.slot) ? ref.playerId : null;
  }

  const actor = actingSeat(view, seats);
  if (actor === null) return null;

  const owner = view.players.find((p) => p.id === ref.playerId);
  const slot = owner?.layout[ref.slot];
  // An empty slot is a hole a snap left behind, and the engine rejects it
  // outright rather than punishing it — so it is safe to grey out here.
  if (slot === undefined || slot === null) return null;
  if (owner?.eliminated) return null;

  if (view.pendingPower) {
    if (view.pendingPower.ownerId !== actor) return null;
    // The King has seen both cards and is being asked whether to swap them. It is
    // not collecting targets any more, and offering a slot here invited the
    // engine's own missing bound — a third target used to buy another reveal
    // (docs/06 §6).
    if (view.phase === "POWER_AWAIT_SWAP_CONFIRM") return null;
    const isOwn = ref.playerId === actor;
    const first = view.pendingPower.targets[0];
    switch (view.pendingPower.kind) {
      case "PEEK_OWN":
        return isOwn ? actor : null;
      case "PEEK_OPPONENT":
      case "GIVE_CARD":
        return isOwn ? null : actor;
      case "BLIND_SWAP":
      case "LOOK_AND_SWAP":
        // Yours first, then theirs — as much a UI affordance as a rule
        // (docs/06 §2).
        if (first === undefined) return isOwn ? actor : null;
        if (isOwn) return null;
        return first.playerId === ref.playerId && first.slot === ref.slot ? null : actor;
      default:
        return null;
    }
  }

  if (view.phase === "AWAIT_HELD_DECISION" || view.phase === "AWAIT_SLOT_FOR_DISCARD") {
    // The held card goes into the holder's own layout, nowhere else.
    return ref.playerId === actor ? actor : null;
  }

  if (view.phase === "AWAIT_SNAP_GIVE") {
    return ref.playerId === actor ? actor : null;
  }

  return null;
}
