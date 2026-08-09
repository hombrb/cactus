// Défausse rapide — see docs/07-snap.md
//
// The reducer is timestamp-free and deterministic: given an ordered sequence of
// Snap actions it always produces the same result. Deciding whose tap counts as
// "first" belongs to the caller (docs/07 §1, docs/10 §5).

import { ranksMatch } from "./cards";
import { drawPenaltyCards } from "./deck";
import { beginReveal } from "./scoring";
import {
  cardOf,
  hasNoCards,
  inRound,
  isLocked,
  playerOf,
  setSlotCard,
  slotOf,
  withSlot,
} from "./state";
import type { Action, Event, GameState, SlotRef, Verdict } from "./types";
import { OK, reject } from "./types";

export function validateSnap(s: GameState, a: Action & { type: "Snap" }): Verdict {
  const cfg = s.config;
  if (!cfg.snap.enabled) return reject("SNAP_DISABLED");
  if (!inRound(s)) return reject("WRONG_PHASE");
  if (s.discard.length === 0) return reject("DISCARD_EMPTY");

  const player = playerOf(s, a.playerId);
  if (!player || player.eliminated) return reject("NOT_IN_ROUND");
  if (s.finalLapRemaining !== null && !cfg.snap.allowedDuringFinalLap)
    return reject("SNAP_CLOSED");
  if (a.forVersion > s.discardVersion) return reject("FUTURE_VERSION");

  const slot = slotOf(s, a.target);
  if (!slot) return reject("BAD_SLOT");
  // SLOT_EMPTY and SLOT_LOCKED are rejections rather than punishments: the
  // client can see both for itself, so nothing leaks, and both are almost
  // always a race the player did not cause.
  if (slot.cardId === null) return reject("SLOT_EMPTY");
  if (isLocked(s, a.target)) return reject("SLOT_LOCKED");
  if (a.target.playerId !== a.playerId && !cfg.snap.allowOnOpponent)
    return reject("NOT_YOUR_CARD");

  return OK;
  // Whether the rank *matches* is decided in the reducer: a wrong snap is
  // punished, not rejected, or the snap button becomes a free oracle.
}

export function onSnap(
  s: GameState,
  a: Action & { type: "Snap" },
): { state: GameState; events: Event[] } {
  const top = cardOf(s, s.discard[0]!);
  const card = cardOf(s, slotOf(s, a.target)!.cardId!);

  if (a.forVersion < s.discardVersion) return resolveLostRace(s, a);
  if (!ranksMatch(s.config, card, top)) return resolveFailedSnap(s, a, "RANK_MISMATCH");
  return resolveSuccessfulSnap(s, a);
}

function resolveSuccessfulSnap(
  s: GameState,
  a: Action & { type: "Snap" },
): { state: GameState; events: Event[] } {
  const cfg = s.config;
  const ref: SlotRef = a.target;
  const cardId = slotOf(s, ref)!.cardId!;

  // The slot stays: cardId becomes null, the array is not spliced, so everyone's
  // memory of "their bottom-right is a King" survives.
  let state = withSlot(s, ref, setSlotCard(null));
  state = {
    ...state,
    discard: [cardId, ...state.discard],
    discardVersion: state.discardVersion + 1,
  };

  const events: Event[] = [
    { type: "SnapSucceeded", playerId: a.playerId, ref, cardId },
    { type: "SlotEmptied", ref },
  ];

  if (ref.playerId !== a.playerId) {
    // Snapped somebody else's card: the snapper now owes them one.
    state = {
      ...state,
      pendingSnapGive: {
        snapperId: a.playerId,
        victimId: ref.playerId,
        victimSlot: ref.slot,
      },
      resumePhase: state.phase,
      phase: "AWAIT_SNAP_GIVE",
    };
    return { state, events };
  }

  if (cfg.snap.emptyLayoutEndsRound && hasNoCards(state, a.playerId)) {
    const revealed = beginReveal(state, "LAYOUT_EMPTIED");
    return { state: revealed.state, events: [...events, ...revealed.events] };
  }

  // Phase is untouched: a snap is not a turn. If it lands while the current
  // player holds a drawn card, they carry on holding it.
  return { state, events };
}

function resolveFailedSnap(
  s: GameState,
  a: Action & { type: "Snap" },
  reason: "RANK_MISMATCH" | "LOST_RACE",
): { state: GameState; events: Event[] } {
  const ref = a.target;
  const cardId = slotOf(s, ref)!.cardId!;

  // The card goes back face down — but the table has now seen it. knownBy is
  // cleared rather than filled in: it means "the engine may re-render this for
  // you", not "you saw it once". SnapFailed is public; humans remember.
  const state = withSlot(s, ref, setSlotCard(cardId));

  const penalties = drawPenaltyCards(
    state,
    a.playerId,
    s.config.snap.failurePenaltyCards,
    "SNAP_FAILURE",
  );

  return {
    state: penalties.state,
    events: [
      { type: "SnapFailed", playerId: a.playerId, ref, cardId, reason },
      ...penalties.events,
    ],
  };
}

/**
 * Two people going for the same 7 is not a mistake, and punishing the slower
 * connection is punishing the network — so the default is silent.
 */
function resolveLostRace(
  s: GameState,
  a: Action & { type: "Snap" },
): { state: GameState; events: Event[] } {
  if (s.config.snap.loserPenalty === "AS_FAILED_SNAP") {
    return resolveFailedSnap(s, a, "LOST_RACE");
  }
  return {
    state: s,
    events: [{ type: "ActionRejected", playerId: a.playerId, action: a, reason: "SNAP_TOO_LATE" }],
  };
}

export function validateSnapGive(s: GameState, a: Action & { type: "SnapGive" }): Verdict {
  if (s.phase !== "AWAIT_SNAP_GIVE") return reject("WRONG_PHASE");
  const psg = s.pendingSnapGive;
  if (!psg) return reject("NO_PENDING_GIVE");
  if (a.playerId !== psg.snapperId) return reject("NOT_YOUR_GIVE");

  const ref: SlotRef = { playerId: a.playerId, slot: a.slot };
  const slot = slotOf(s, ref);
  if (!slot) return reject("BAD_SLOT");
  if (slot.cardId === null) return reject("SLOT_EMPTY");
  if (isLocked(s, ref)) return reject("SLOT_LOCKED");
  return OK;
}

export function onSnapGive(
  s: GameState,
  a: Action & { type: "SnapGive" },
): { state: GameState; events: Event[] } {
  const psg = s.pendingSnapGive!;
  const from: SlotRef = { playerId: psg.snapperId, slot: a.slot };
  const cardId = slotOf(s, from)!.cardId!;

  let state = withSlot(s, from, setSlotCard(null));
  state = withSlot(
    state,
    { playerId: psg.victimId, slot: psg.victimSlot },
    setSlotCard(cardId, [psg.snapperId]),
  );
  state = {
    ...state,
    pendingSnapGive: null,
    phase: state.resumePhase ?? "TURN_END",
    resumePhase: null,
  };

  const events: Event[] = [
    {
      type: "CardGiven",
      fromPlayerId: psg.snapperId,
      toPlayerId: psg.victimId,
      slot: psg.victimSlot,
      cardId,
    },
  ];

  // The give can empty the snapper's own layout.
  if (state.config.snap.emptyLayoutEndsRound && hasNoCards(state, psg.snapperId)) {
    const revealed = beginReveal(state, "LAYOUT_EMPTIED");
    return { state: revealed.state, events: [...events, ...revealed.events] };
  }

  return { state, events };
}
