// Replays the worked trace of docs/11 §3 and asserts the documented outcome.
// This is what makes "the implementation matches the spec" a checkable claim.

import { describe, expect, it } from "vitest";
import { standard } from "../src/engine/config";
import { buildDeck, cardTable } from "../src/engine/cards";
import { applyAction } from "../src/engine/reduce";
import { createMatch, createRound } from "../src/engine/turn";
import { scoreLayout } from "../src/engine/scoring";
import { playerOf } from "../src/engine/state";
import type { Action, CardId, Event, GameState } from "../src/engine/types";

const ALICE = "alice";
const BOB = "bob";
const CHLOE = "chloe";

// The deal of docs/11 §3, in dealing order: Alice 0-3, Bob 0-3, Chloé 0-3,
// then the discard seed, then the stock.
const DEAL: CardId[] = [
  "d1-KH", "d1-8D", "d1-4C", "d1-QS", // Alice  → 0 + 8 + 4 + 12 = 24
  "d1-3H", "d1-KS", "d1-9C", "d1-2D", // Bob    → 3 + 13 + 9 + 2 = 27
  "d1-7S", "d1-5H", "d1-KD", "d1-6C", // Chloé  → 7 + 5 + 0 + 6 = 18
  "d1-4H", // discard seed
];

const STOCK: CardId[] = [
  "d1-8S", "d1-3C", "d1-QH", "d1-9D", "d1-AC", "d1-10S",
  "d1-2C", "d1-5S", "d1-7H", "d1-6D", "d1-AD", "d1-3D", "d1-4S",
];

function traceRound(): GameState {
  const deck = buildDeck(standard);
  const rest = deck.map((c) => c.id).filter((id) => ![...DEAL, ...STOCK].includes(id));
  const order = [...DEAL, ...STOCK, ...rest];

  const match = createMatch({
    config: standard,
    players: [
      { id: ALICE, name: "Alice" },
      { id: BOB, name: "Bob" },
      { id: CHLOE, name: "Chloé" },
    ],
    seed: "trace-1",
  });

  // dealerIndex 2 (Chloé) ⇒ Alice leads, as in the doc.
  return createRound({ ...match, dealerIndex: 2 }, order, cardTable(deck)).state;
}

/** Runs the trace, asserting `discardVersion` never decreases (docs/11 §2). */
function run(state: GameState, actions: readonly Action[]): { state: GameState; events: Event[] } {
  let s = state;
  const events: Event[] = [];
  for (const action of actions) {
    const before = s.discardVersion;
    const result = applyAction(s, action);
    expect(result.state.discardVersion, `discardVersion decreased on ${action.type}`)
      .toBeGreaterThanOrEqual(before);
    s = result.state;
    events.push(...result.events);
  }
  return { state: s, events };
}

const TRACE: Action[] = [
  { type: "PeekInitial", playerId: ALICE, slots: [0, 1] },
  { type: "PeekInitial", playerId: BOB, slots: [0, 1] },
  { type: "PeekInitial", playerId: CHLOE, slots: [0, 1] },

  // turn 1 — Alice draws 8♠, discards it, peeks her own slot 2
  { type: "DrawStock", playerId: ALICE },
  { type: "DiscardHeld", playerId: ALICE },
  { type: "PowerTarget", playerId: ALICE, target: { playerId: ALICE, slot: 2 } },
  { type: "EndTurn", playerId: ALICE },

  // turn 2 — Bob draws 3♣ and swaps out his ♠K
  { type: "DrawStock", playerId: BOB },
  { type: "PlaceInSlot", playerId: BOB, slot: 1 },
  { type: "EndTurn", playerId: BOB },

  // turn 3 — Chloé discards ♥Q, blind-swaps her slot 3 with Alice's slot 1
  { type: "DrawStock", playerId: CHLOE },
  { type: "DiscardHeld", playerId: CHLOE },
  { type: "PowerTarget", playerId: CHLOE, target: { playerId: CHLOE, slot: 3 } },
  { type: "PowerTarget", playerId: CHLOE, target: { playerId: ALICE, slot: 1 } },
  { type: "EndTurn", playerId: CHLOE },

  // turn 4 — Alice discards 9♦ then misuses the power on her own card
  { type: "DrawStock", playerId: ALICE },
  { type: "DiscardHeld", playerId: ALICE },
  { type: "PowerTarget", playerId: ALICE, target: { playerId: ALICE, slot: 1 } },
  { type: "EndTurn", playerId: ALICE },

  // turn 5 — Bob discards 10♠, peeks Chloé's slot 3
  { type: "DrawStock", playerId: BOB },
  { type: "DiscardHeld", playerId: BOB },
  { type: "PowerTarget", playerId: BOB, target: { playerId: CHLOE, slot: 3 } },
  { type: "EndTurn", playerId: BOB },

  // turn 6 — Chloé swaps 2♣ in, discarding 8♦
  { type: "DrawStock", playerId: CHLOE },
  { type: "PlaceInSlot", playerId: CHLOE, slot: 3 },
  // Alice snaps on stale memory: she thinks slot 1 is 8♦, it is 6♣ → fails
  { type: "Snap", playerId: ALICE, target: { playerId: ALICE, slot: 1 }, forVersion: 7 },
  { type: "EndTurn", playerId: CHLOE },

  // turn 7 — Alice swaps 7♥ in, discarding ♠Q
  { type: "DrawStock", playerId: ALICE },
  { type: "PlaceInSlot", playerId: ALICE, slot: 3 },
  { type: "EndTurn", playerId: ALICE },

  // turn 8 — Bob swaps 6♦ in, discarding 9♣
  { type: "DrawStock", playerId: BOB },
  { type: "PlaceInSlot", playerId: BOB, slot: 2 },
  { type: "EndTurn", playerId: BOB },

  // turn 9 — Chloé swaps A♦ in, discarding 7♠, then announces
  { type: "DrawStock", playerId: CHLOE },
  { type: "PlaceInSlot", playerId: CHLOE, slot: 0 },
  { type: "AnnounceCactus", playerId: CHLOE },

  // final lap, turn 10 — Alice swaps 3♦ in, discarding 6♣
  { type: "DrawStock", playerId: ALICE },
  { type: "PlaceInSlot", playerId: ALICE, slot: 1 },
  { type: "EndTurn", playerId: ALICE },

  // final lap, turn 11 — Bob snaps his 6♦ onto the 6♣, then discards 4♠
  { type: "Snap", playerId: BOB, target: { playerId: BOB, slot: 2 }, forVersion: 11 },
  { type: "DrawStock", playerId: BOB },
  { type: "DiscardHeld", playerId: BOB },
  { type: "EndTurn", playerId: BOB },
];

describe("docs/11 §3 worked trace", () => {
  const { state, events } = run(traceRound(), TRACE);

  it("reaches the reveal via FINAL_LAP_DONE", () => {
    expect(state.roundEndReason).toBe("FINAL_LAP_DONE");
    expect(state.phase).toBe("ROUND_END");
  });

  it("produces the documented layouts", () => {
    const layout = (id: string) =>
      playerOf(state, id)!.layout.map((s) => s.cardId);

    expect(layout(ALICE)).toEqual([
      "d1-KH", "d1-3D", "d1-4C", "d1-7H", "d1-AC", "d1-5S",
    ]);
    expect(layout(BOB)).toEqual(["d1-3H", "d1-3C", null, "d1-2D"]);
    expect(layout(CHLOE)).toEqual(["d1-AD", "d1-5H", "d1-KD", "d1-2C"]);
  });

  it("sums 20 / 8 / 8 before the announcer penalty", () => {
    const sum = (id: string) => scoreLayout(standard, state, playerOf(state, id)!.layout);
    expect(sum(ALICE)).toBe(20);
    expect(sum(BOB)).toBe(8);
    expect(sum(CHLOE)).toBe(8);
  });

  it("fails the announcement on a tie and doubles Chloé's score", () => {
    const scored = events.find((e) => e.type === "RoundScored");
    expect(scored).toBeDefined();
    if (scored?.type !== "RoundScored") throw new Error("unreachable");

    expect(scored.announcerId).toBe(CHLOE);
    expect(scored.announcerSucceeded).toBe(false);

    const score = (id: string) => scored.scores.find((r) => r.playerId === id)!.roundScore;
    expect(score(ALICE)).toBe(20);
    expect(score(BOB)).toBe(8); // Bob wins the round without ever announcing
    expect(score(CHLOE)).toBe(16); // 8 × 2
  });

  it("conserves all 52 cards", () => {
    const inLayouts = state.players.flatMap((p) =>
      p.layout.filter((s) => s.cardId !== null),
    ).length;
    expect(inLayouts).toBe(13);
    expect(state.discard.length).toBe(13);
    expect(state.heldCard).toBeNull();
    expect(state.stock.length).toBe(52 - 13 - 13);
  });

  it("emits the documented failed and successful snaps", () => {
    const failed = events.filter((e) => e.type === "SnapFailed");
    const succeeded = events.filter((e) => e.type === "SnapSucceeded");

    expect(failed).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    if (failed[0]?.type !== "SnapFailed" || succeeded[0]?.type !== "SnapSucceeded") {
      throw new Error("unreachable");
    }
    expect(failed[0].playerId).toBe(ALICE);
    expect(failed[0].cardId).toBe("d1-6C"); // the card the blind swap put there
    expect(succeeded[0].playerId).toBe(BOB);
    expect(succeeded[0].cardId).toBe("d1-6D");
  });

  it("penalises the power misuse with one face-down card", () => {
    const penalties = events.filter(
      (e) => e.type === "PenaltyCardTaken" && e.reason === "POWER_MISUSE",
    );
    expect(penalties).toHaveLength(1);
  });

  it("does not let the announcer consume a final-lap slot", () => {
    const laps = events.filter((e) => e.type === "FinalLapAdvanced");
    expect(laps.map((e) => (e.type === "FinalLapAdvanced" ? e.remaining : -1))).toEqual([1, 0]);
  });
});
