// Power resolution — see docs/06-powers.md
// A power fires when a card drawn from the stock is discarded directly, and —
// with `powers.onHandDiscard` — when a card leaves its owner's layout for the
// discard (docs/06 §10).

import { powerFor } from "./cards";
import { drawPenaltyCards } from "./deck";
import {
  addCardToLayout,
  cardOf,
  isLocked,
  markKnown,
  playerOf,
  sameRef,
  slotOf,
  swapSlots,
  withSlot,
} from "./state";
import type {
  Action,
  CardId,
  Event,
  GameState,
  PendingPower,
  Phase,
  PlayerId,
  PowerKind,
  SlotRef,
  Verdict,
} from "./types";
import { OK, reject } from "./types";

export function phaseForPower(kind: PowerKind): Phase {
  switch (kind) {
    case "PEEK_OWN":
      return "POWER_AWAIT_OWN_SLOT";
    case "PEEK_OPPONENT":
      return "POWER_AWAIT_OPPONENT_SLOT";
    case "BLIND_SWAP":
    case "LOOK_AND_SWAP":
      return "POWER_AWAIT_TWO_SLOTS";
    case "GIVE_CARD":
      return "POWER_AWAIT_GIVE_TARGET";
    case "NONE":
      return "TURN_END";
  }
}

/**
 * The one place `pendingPower` is ever set. Returns null when the card has no
 * power, so the caller keeps whatever phase it had decided on.
 *
 * `resumePhase` is what a power owed to a *hand* discard needs and a power owed
 * to the drawn card does not. A snap happens out of turn (docs/07 §4.1), so the
 * power interrupts somebody else's phase and `clearPower` has to put it back.
 * On the turn's own path it is null, and `clearPower` falls to `TURN_END` as it
 * always did — same mechanism `AWAIT_SNAP_GIVE` already uses.
 */
export function beginPower(
  s: GameState,
  ownerId: PlayerId,
  cardId: CardId,
  resumePhase: Phase | null,
): { state: GameState; events: Event[] } | null {
  const kind = powerFor(s.config, cardOf(s, cardId));
  if (kind === "NONE") return null;

  const state: GameState = {
    ...s,
    pendingPower: { kind, sourceCard: cardId, ownerId, targets: [], revealed: [] },
    resumePhase,
    phase: phaseForPower(kind),
  };
  return { state, events: [{ type: "PowerStarted", playerId: ownerId, kind }] };
}

export function clearPower(s: GameState): GameState {
  return {
    ...s,
    pendingPower: null,
    lockedSlots: [],
    // Back to the phase the power interrupted, or to the end of the turn that
    // earned it. See `beginPower`.
    phase: s.resumePhase ?? "TURN_END",
    resumePhase: null,
  };
}

/**
 * Targeting order for two-target powers is yours first, then theirs. As much a
 * UI affordance as a rule: it removes the ambiguity of "which of these two am I
 * giving away".
 */
export function isLegalTarget(s: GameState, pp: PendingPower, ref: SlotRef): boolean {
  const slot = slotOf(s, ref);
  if (!slot) return false;
  if (slot.cardId === null) return false;
  if (isLocked(s, ref)) return false;
  if (playerOf(s, ref.playerId)?.eliminated) return false;

  switch (pp.kind) {
    case "PEEK_OWN":
      return ref.playerId === pp.ownerId;
    case "PEEK_OPPONENT":
    case "GIVE_CARD":
      return ref.playerId !== pp.ownerId;
    case "BLIND_SWAP":
    case "LOOK_AND_SWAP": {
      // A power holding everything it asked for is waiting for an answer, not
      // for another target. Without this bound the black King is a free reader:
      // `POWER_AWAIT_SWAP_CONFIRM` leaves `pendingPower` in place, so a third
      // target fell back into `askToSwap` and revealed another card, over and
      // over, across the whole opposing hand.
      if (pp.targets.length >= 2) return false;
      const first = pp.targets[0];
      if (first === undefined) return ref.playerId === pp.ownerId;
      return ref.playerId !== pp.ownerId && !sameRef(ref, first);
    }
    default:
      return false;
  }
}

export function validatePowerTarget(s: GameState, a: Action & { type: "PowerTarget" }): Verdict {
  const pp = s.pendingPower;
  if (!pp) return reject("NO_PENDING_POWER");
  if (a.playerId !== pp.ownerId) return reject("NOT_YOUR_POWER");
  return OK;
  // Legality of the *target* is checked in the reducer on purpose: an illegal
  // target is a misuse of the power (a game event with a penalty), not a
  // rejection. Rejecting would let a player probe the board for free.
}

export function onPowerTarget(
  s: GameState,
  a: Action & { type: "PowerTarget" },
): { state: GameState; events: Event[] } {
  const pp = s.pendingPower!;
  if (!isLegalTarget(s, pp, a.target)) return applyMisusePenalty(s, pp);

  const next: PendingPower = { ...pp, targets: [...pp.targets, a.target] };
  return resolvePowerTarget({ ...s, pendingPower: next }, next);
}

function resolvePowerTarget(
  s: GameState,
  pp: PendingPower,
): { state: GameState; events: Event[] } {
  switch (pp.kind) {
    case "PEEK_OWN":
    case "PEEK_OPPONENT":
      return finishPeek(s, pp);
    case "BLIND_SWAP":
      return pp.targets.length < 2 ? { state: s, events: [] } : finishBlindSwap(s, pp);
    case "LOOK_AND_SWAP":
      return pp.targets.length < 2 ? revealTarget(s, pp) : askToSwap(s, pp);
    case "GIVE_CARD":
      return finishGive(s, pp);
    default:
      return { state: clearPower(s), events: [] };
  }
}

function finishPeek(s: GameState, pp: PendingPower): { state: GameState; events: Event[] } {
  const ref = pp.targets[0]!;
  const slot = slotOf(s, ref)!;
  const cardId = slot.cardId!;
  const next = clearPower(withSlot(s, ref, markKnown(slot, pp.ownerId)));
  return {
    state: next,
    events: [{ type: "CardRevealed", toPlayerId: pp.ownerId, ref, cardId }],
  };
}

function revealTarget(s: GameState, pp: PendingPower): { state: GameState; events: Event[] } {
  const ref = pp.targets[pp.targets.length - 1]!;
  const slot = slotOf(s, ref)!;
  const cardId = slot.cardId!;
  const withKnowledge = withSlot(s, ref, markKnown(slot, pp.ownerId));
  const next: GameState = {
    ...withKnowledge,
    pendingPower: { ...pp, revealed: [...pp.revealed, ref] },
  };
  return {
    state: next,
    events: [{ type: "CardRevealed", toPlayerId: pp.ownerId, ref, cardId }],
  };
}

function askToSwap(s: GameState, pp: PendingPower): { state: GameState; events: Event[] } {
  const revealed = revealTarget(s, pp);
  // Lock both targets: a snap must not yank a card out from under a decision
  // the King owner has already been shown (docs/07 §6).
  const state: GameState = {
    ...revealed.state,
    phase: "POWER_AWAIT_SWAP_CONFIRM",
    lockedSlots: [pp.targets[0]!, pp.targets[1]!],
  };
  return { state, events: revealed.events };
}

function finishBlindSwap(
  s: GameState,
  pp: PendingPower,
): { state: GameState; events: Event[] } {
  const a = pp.targets[0]!;
  const b = pp.targets[1]!;
  // swapSlots wipes knownBy on both sides — the entire point of a blind swap.
  return { state: clearPower(swapSlots(s, a, b)), events: [{ type: "CardsSwapped", a, b }] };
}

export function validatePowerConfirmSwap(
  s: GameState,
  a: Action & { type: "PowerConfirmSwap" },
): Verdict {
  if (s.phase !== "POWER_AWAIT_SWAP_CONFIRM") return reject("WRONG_PHASE");
  if (!s.pendingPower || a.playerId !== s.pendingPower.ownerId) return reject("NOT_YOUR_POWER");
  return OK;
}

export function onPowerConfirmSwap(
  s: GameState,
  a: Action & { type: "PowerConfirmSwap" },
): { state: GameState; events: Event[] } {
  const pp = s.pendingPower!;
  if (!a.swap) {
    return {
      state: clearPower(s),
      events: [{ type: "PowerDeclined", playerId: pp.ownerId, kind: pp.kind }],
    };
  }

  const first = pp.targets[0]!;
  const second = pp.targets[1]!;
  // Defensive: unreachable while both targets are locked, but a swap of a card
  // that no longer exists would corrupt card conservation (docs/07 §6).
  const unlocked: GameState = { ...s, lockedSlots: [] };
  if (
    !isLegalTarget(unlocked, { ...pp, targets: [] }, first) ||
    slotOf(s, second)?.cardId == null
  ) {
    return applyMisusePenalty(s, pp);
  }

  return {
    state: clearPower(swapSlots(s, first, second)),
    events: [{ type: "CardsSwapped", a: first, b: second }],
  };
}

function finishGive(s: GameState, pp: PendingPower): { state: GameState; events: Event[] } {
  const victim = pp.targets[0]!.playerId;
  const cardId = pp.sourceCard;

  // onDiscardHeld already pushed the Ace onto the discard; take it back. The
  // version bump closes the snap window it briefly opened.
  const withoutAce: GameState =
    s.discard[0] === cardId
      ? { ...s, discard: s.discard.slice(1), discardVersion: s.discardVersion + 1 }
      : s;

  const added = addCardToLayout(withoutAce, victim, cardId, [pp.ownerId]);
  return {
    state: clearPower(added.state),
    events: [
      {
        type: "CardGiven",
        fromPlayerId: pp.ownerId,
        toPlayerId: victim,
        slot: added.slot,
        cardId,
      },
    ],
  };
}

export function validatePowerSkip(s: GameState, a: Action & { type: "PowerSkip" }): Verdict {
  if (!s.pendingPower) return reject("NO_PENDING_POWER");
  if (a.playerId !== s.pendingPower.ownerId) return reject("NOT_YOUR_POWER");
  return OK;
}

/** Declining is always free and always legal. */
export function onPowerSkip(s: GameState): { state: GameState; events: Event[] } {
  const pp = s.pendingPower!;
  return {
    state: clearPower(s),
    events: [{ type: "PowerDeclined", playerId: pp.ownerId, kind: pp.kind }],
  };
}

export function applyMisusePenalty(
  s: GameState,
  pp: PendingPower,
): { state: GameState; events: Event[] } {
  const cleared = clearPower(s);
  return drawPenaltyCards(
    cleared,
    pp.ownerId,
    s.config.powers.misusePenaltyCards,
    "POWER_MISUSE",
  );
}
