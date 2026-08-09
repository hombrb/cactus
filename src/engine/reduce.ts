// The reducer — see docs/05 §1.
//
// Pure and total: same (state, action) always yields the same (state, events),
// and an illegal action never throws — it returns the state unchanged plus one
// ActionRejected.

import { checkInvariants } from "./invariants";
import {
  onPowerConfirmSwap,
  onPowerSkip,
  onPowerTarget,
  validatePowerConfirmSwap,
  validatePowerSkip,
  validatePowerTarget,
} from "./powers";
import { onSnap, onSnapGive, validateSnap, validateSnapGive } from "./snap";
import { currentPlayerId, firstLegalSlot, isPowerPhase, withPlayer } from "./state";
import {
  beginFirstTurn,
  onAnnounceCactus,
  onDiscardHeld,
  onDrawStock,
  onEndTurn,
  onPeekInitial,
  onPlaceInSlot,
  onStartMatch,
  onStartNextRound,
  onTakeDiscard,
  validateAnnounce,
  validateDiscardHeld,
  validateDrawStock,
  validateEndTurn,
  validatePeekInitial,
  validatePlaceInSlot,
  validateStartMatch,
  validateStartNextRound,
  validateTakeDiscard,
} from "./turn";
import type { Action, Event, GameState, PlayerId, Reduction, Verdict } from "./types";
import { OK, reject } from "./types";

export function validate(s: GameState, a: Action): Verdict {
  switch (a.type) {
    case "LobbyJoin":
      return s.phase === "LOBBY" ? OK : reject("MATCH_STARTED");
    case "LobbyLeave":
      return OK;
    case "StartMatch":
      return validateStartMatch(s, a);
    case "PeekInitial":
      return validatePeekInitial(s, a);
    case "DrawStock":
      return validateDrawStock(s, a);
    case "TakeDiscard":
      return validateTakeDiscard(s, a);
    case "PlaceInSlot":
      return validatePlaceInSlot(s, a);
    case "DiscardHeld":
      return validateDiscardHeld(s, a);
    case "PowerSkip":
      return validatePowerSkip(s, a);
    case "PowerTarget":
      return validatePowerTarget(s, a);
    case "PowerConfirmSwap":
      return validatePowerConfirmSwap(s, a);
    case "Snap":
      return validateSnap(s, a);
    case "SnapGive":
      return validateSnapGive(s, a);
    case "AnnounceCactus":
      return validateAnnounce(s, a);
    case "EndTurn":
      return validateEndTurn(s, a);
    case "StartNextRound":
      return validateStartNextRound(s, a);
    case "Timeout":
      return a.phaseToken === s.actionCounter ? OK : reject("STALE_TIMEOUT");
  }
}

/**
 * The next connected, non-eliminated player after the departing host, in seating
 * order. Returns null when nobody is left to promote — the room is empty and
 * will die by TTL, so the departed host stays nominal host.
 */
function nextHost(s: GameState, leaving: PlayerId): PlayerId | null {
  const from = s.turnOrder.indexOf(leaving);
  for (let step = 1; step <= s.turnOrder.length; step++) {
    const id = s.turnOrder[(from + step) % s.turnOrder.length]!;
    if (id === leaving) continue;
    const p = s.players.find((q) => q.id === id);
    if (p && p.connected && !p.eliminated) return id;
  }
  return null;
}

function reduce(s: GameState, a: Action): { state: GameState; events: Event[] } {
  switch (a.type) {
    case "LobbyJoin": {
      const exists = s.players.some((p) => p.id === a.playerId);
      const state = exists
        ? withPlayer(s, a.playerId, (p) => ({ ...p, connected: true, name: a.name }))
        : {
            ...s,
            players: [
              ...s.players,
              {
                id: a.playerId,
                name: a.name,
                layout: [],
                connected: true,
                hasPeeked: false,
                roundScore: null,
                cumulativeScore: 0,
                eliminated: false,
              },
            ],
            turnOrder: [...s.turnOrder, a.playerId],
          };
      return {
        state,
        events: [{ type: "ConnectionChanged", playerId: a.playerId, connected: true }],
      };
    }
    case "LobbyLeave": {
      const left = withPlayer(s, a.playerId, (p) => ({ ...p, connected: false }));
      const events: Event[] = [
        { type: "ConnectionChanged", playerId: a.playerId, connected: false },
      ];
      // Never block the room on one person's tab (docs/10 §2).
      if (a.playerId !== s.hostId) return { state: left, events };

      const heir = nextHost(left, a.playerId);
      if (heir === null) return { state: left, events };
      events.push({ type: "HostChanged", playerId: heir });
      return { state: { ...left, hostId: heir }, events };
    }
    case "StartMatch":
      return onStartMatch(s);
    case "PeekInitial":
      return onPeekInitial(s, a);
    case "DrawStock":
      return onDrawStock(s, a);
    case "TakeDiscard":
      return onTakeDiscard(s, a);
    case "PlaceInSlot":
      return onPlaceInSlot(s, a);
    case "DiscardHeld":
      return onDiscardHeld(s, a);
    case "PowerSkip":
      return onPowerSkip(s);
    case "PowerTarget":
      return onPowerTarget(s, a);
    case "PowerConfirmSwap":
      return onPowerConfirmSwap(s, a);
    case "Snap":
      return onSnap(s, a);
    case "SnapGive":
      return onSnapGive(s, a);
    case "AnnounceCactus":
      return onAnnounceCactus(s, a);
    case "EndTurn":
      return onEndTurn(s);
    case "StartNextRound":
      return onStartNextRound(s);
    case "Timeout":
      return onTimeout(s);
  }
}

/**
 * Auto-actions never announce and never take from the discard: both are
 * strategic commitments. Drawing and discarding is the neutral move.
 */
function onTimeout(s: GameState): { state: GameState; events: Event[] } {
  const current = currentPlayerId(s);
  if (isPowerPhase(s)) return reduce(s, { type: "PowerSkip", playerId: current });

  switch (s.phase) {
    case "INITIAL_PEEK":
      return beginFirstTurn(s);
    case "TURN_START":
      return reduce(s, { type: "DrawStock", playerId: current });
    case "AWAIT_HELD_DECISION":
      return reduce(s, { type: "DiscardHeld", playerId: current });
    case "AWAIT_SLOT_FOR_DISCARD":
      return reduce(s, {
        type: "PlaceInSlot",
        playerId: current,
        slot: firstLegalSlot(s, current),
      });
    case "AWAIT_SNAP_GIVE": {
      const snapper = s.pendingSnapGive?.snapperId;
      if (!snapper) return { state: s, events: [] };
      return reduce(s, {
        type: "SnapGive",
        playerId: snapper,
        slot: firstLegalSlot(s, snapper),
      });
    }
    case "TURN_END":
      return onEndTurn(s);
    default:
      return { state: s, events: [] };
  }
}

export function applyAction(s: GameState, a: Action): Reduction {
  const verdict = validate(s, a);
  if (!verdict.ok) {
    // A stale timeout is the engine's own message, not the player's: dropping it
    // silently keeps it out of the log.
    if (a.type === "Timeout") return { state: s, events: [] };
    return {
      state: s,
      events: [{ type: "ActionRejected", playerId: a.playerId, action: a, reason: verdict.reason }],
    };
  }

  const result = reduce(s, a);
  const state: GameState = { ...result.state, actionCounter: result.state.actionCounter + 1 };

  // Cast rather than rely on vite/client: the engine now also has to compile
  // inside the worker, where Vite's ImportMeta typing is absent.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const problems = checkInvariants(state);
    if (problems.length > 0) {
      throw new Error(`engine invariant broken after ${a.type}: ${problems.join("; ")}`);
    }
  }

  return { state, events: result.events };
}
