// Invariants — see docs/11 §2. A violation is an engine bug, never a rules
// outcome. Card conservation alone catches most swap, snap and power bugs, and
// is cheap enough (O(deck)) to run in production.

import { totalDeckSize } from "./cards";
import type { CardId, GameState } from "./types";

export function checkInvariants(s: GameState): string[] {
  const problems: string[] = [];
  if (s.phase === "LOBBY") return problems;

  // --- card conservation ---
  const seen: CardId[] = [...s.stock, ...s.discard];
  if (s.heldCard !== null) seen.push(s.heldCard);
  for (const p of s.players) {
    for (const slot of p.layout) if (slot.cardId !== null) seen.push(slot.cardId);
  }

  const expected = totalDeckSize(s.config);
  if (seen.length !== expected) {
    problems.push(`card count ${seen.length} != ${expected}`);
  }
  if (new Set(seen).size !== seen.length) {
    problems.push("same card id in two places");
  }
  for (const id of seen) {
    if (!(id in s.cards)) problems.push(`unknown card id ${id}`);
  }

  // --- structural ---
  const heldPhase =
    s.phase === "AWAIT_HELD_DECISION" || s.phase === "AWAIT_SLOT_FOR_DISCARD";
  if (heldPhase !== (s.heldCard !== null)) {
    problems.push(`heldCard/${s.phase} mismatch`);
  }

  const powerPhase = s.phase.startsWith("POWER_AWAIT_");
  if (powerPhase !== (s.pendingPower !== null)) {
    problems.push(`pendingPower/${s.phase} mismatch`);
  }

  const givePhase = s.phase === "AWAIT_SNAP_GIVE";
  if (givePhase !== (s.pendingSnapGive !== null)) {
    problems.push(`pendingSnapGive/${s.phase} mismatch`);
  }
  if (givePhase && s.resumePhase === null) {
    problems.push("AWAIT_SNAP_GIVE without a resumePhase");
  }

  if (s.phase !== "POWER_AWAIT_SWAP_CONFIRM" && s.lockedSlots.length > 0) {
    problems.push("stale lockedSlots outside POWER_AWAIT_SWAP_CONFIRM");
  }

  // `discardVersion` is only ever compared across successive states (it must
  // never decrease), so it is checked by the test sweep rather than here. It is
  // NOT equal to the discard's size in general: TakeDiscard and the Ace-give
  // both bump the version while shrinking the pile.

  if (s.finalLapRemaining !== null && s.announcerId === null) {
    problems.push("finalLapRemaining set without an announcer");
  }
  if (s.finalLapRemaining !== null && s.finalLapRemaining < 0) {
    problems.push("finalLapRemaining went negative");
  }
  // The announcement window is a seat, not an index: a stale id would silently
  // hand the window to nobody, or to somebody who left.
  if (s.previousPlayerId !== null && !s.turnOrder.includes(s.previousPlayerId)) {
    problems.push(`previousPlayerId names an unknown player: ${s.previousPlayerId}`);
  }

  const layoutFloor = s.config.deck.handSize;
  for (const p of s.players) {
    if (!p.eliminated && s.phase !== "DEALING" && p.layout.length < layoutFloor) {
      problems.push(`${p.id} layout shrank to ${p.layout.length}`);
    }
    for (const slot of p.layout) {
      for (const knower of slot.knownBy) {
        if (!s.turnOrder.includes(knower)) problems.push(`stale knownBy ${knower}`);
      }
    }
  }

  const current = s.turnOrder[s.currentPlayerIndex];
  if (current === undefined) {
    problems.push("currentPlayerIndex out of range");
  }

  const scoredPhase = s.phase === "ROUND_END" || s.phase === "MATCH_END";
  if (scoredPhase) {
    for (const p of s.players) {
      if (!p.eliminated && p.roundScore === null) problems.push(`${p.id} unscored at ${s.phase}`);
    }
  }

  return problems;
}
