// Shared test driving: enumerate every action a state legally invites, so a
// seeded walk can play whole games without knowing the rules.

import { buildDeck, cardTable } from "../src/engine/cards";
import { standard } from "../src/engine/config";
import { applyAction } from "../src/engine/reduce";
import { createMatch, createRound, nearestSlots } from "../src/engine/turn";
import { currentPlayerId } from "../src/engine/state";
import type { Action, GameState, RuleConfig, SlotRef } from "../src/engine/types";

export const A = "a";
export const B = "b";

/**
 * A round dealt from the top of a real deck in a chosen order, so a phase can be
 * reached without hunting for a seed. `front` is `rank + suit` shorthand in
 * dealing order: A's hand, B's hand, the discard seed, then the stock.
 *
 * The whole deck still has to be there, or card conservation fails (docs/11 §2).
 * Returns a state past the peek barrier, with A to play.
 *
 * `cfg` is for the rule variants: the deal follows `deck.handSize`, so a config
 * with a smaller hand changes where `front` is cut, not just what the rules say.
 */
export function round(front: readonly string[], cfg: RuleConfig = standard): GameState {
  const deck = buildDeck(cfg);
  const idOf = new Map(deck.map((c) => [`${c.rank}${c.suit}`, c.id]));
  const head = front.map((short) => {
    const id = idOf.get(short);
    if (id === undefined) throw new Error(`no ${short} in the deck`);
    return id;
  });
  const order = [...head, ...deck.map((c) => c.id).filter((id) => !head.includes(id))];

  const base = createMatch({
    config: cfg,
    players: [
      { id: A, name: "A" },
      { id: B, name: "B" },
    ],
    seed: "targeting",
  });
  let s = createRound({ ...base, phase: "DEALING" }, order, cardTable(deck)).state;
  const peek = nearestSlots(cfg);
  s = applyAction(s, { type: "PeekInitial", playerId: A, slots: peek }).state;
  s = applyAction(s, { type: "PeekInitial", playerId: B, slots: peek }).state;
  if (s.phase !== "TURN_START") throw new Error(`expected TURN_START, got ${s.phase}`);
  return s;
}

/** Eight distinct ranks, a seed that matches none of them, then one free slot. */
export const CALM = ["2S", "3S", "4S", "5S", "6S", "8S", "10S", "QS", "AS"];

/** Draws the top of the stock and discards it, which is what fires a power. */
export function firePower(rank: string): GameState {
  let s = round([...CALM, rank]);
  s = applyAction(s, { type: "DrawStock", playerId: A }).state;
  return applyAction(s, { type: "DiscardHeld", playerId: A }).state;
}

export function candidates(s: GameState): Action[] {
  const me = currentPlayerId(s);
  // A power belongs to its owner, who is only the current player when the drawn
  // card earned it. Under `powers.onHandDiscard` a snap earns one out of turn, so
  // offering the power actions as `me` would offer them to nobody and the sweep
  // would stall at the first snapped 7.
  const owner = s.pendingPower?.ownerId ?? me;
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
      if (s.config.turn.takeFromDiscard) out.push({ type: "TakeDiscard", playerId: me });
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
      out.push({ type: "PowerConfirmSwap", playerId: owner, swap: true });
      out.push({ type: "PowerConfirmSwap", playerId: owner, swap: false });
      // `pendingPower` is still set here, so `PowerTarget` still validates — and
      // for a long time it still *resolved*, buying one reveal per tap. Offered
      // so the sweep walks that path rather than trusting the phase to close it.
      for (const target of everySlot()) out.push({ type: "PowerTarget", playerId: owner, target });
      break;
    case "POWER_AWAIT_OWN_SLOT":
    case "POWER_AWAIT_OPPONENT_SLOT":
    case "POWER_AWAIT_TWO_SLOTS":
    case "POWER_AWAIT_GIVE_TARGET":
      out.push({ type: "PowerSkip", playerId: owner });
      // Deliberately includes illegal targets so the misuse path gets exercised.
      for (const target of everySlot()) out.push({ type: "PowerTarget", playerId: owner, target });
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

  // The announcement outlives the turn that earned it, so it is not tied to a
  // phase: whoever just played may say it while somebody else is mid-turn
  // (docs/01 §7). Offered here so the sweep interleaves it with everything else.
  if (
    s.config.announce.timing === "AFTER_TURN" &&
    s.announcerId === null &&
    s.previousPlayerId !== null &&
    s.previousPlayerId !== me
  ) {
    out.push({ type: "AnnounceCactus", playerId: s.previousPlayerId });
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
