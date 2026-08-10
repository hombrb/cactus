// Powers, where the engine has the last word — see docs/06.
//
// The board's affordances are tested in `targeting.test.ts`; this file is about
// what the reducer does when a client asks for something the board would not have
// offered. That distinction matters here more than anywhere else: an illegal power
// target is deliberately a *misuse* with a penalty rather than a rejection
// (docs/06 §2), so "the UI would not let you" is never the guarantee.

import { describe, expect, it } from "vitest";
import { applyAction } from "../src/engine/reduce";
import type { Event, GameState, SlotRef } from "../src/engine/types";
import { A, B, CALM, firePower, round } from "./helpers";

const at = (playerId: string, slot: number): SlotRef => ({ playerId, slot });
const layoutOf = (s: GameState, id: string) => s.players.find((p) => p.id === id)!.layout;
const revealed = (events: readonly Event[]) => events.filter((e) => e.type === "CardRevealed");

describe("LOOK_AND_SWAP — the black King", () => {
  function awaitingConfirm(): GameState {
    let s = firePower("KS");
    expect(s.pendingPower?.kind).toBe("LOOK_AND_SWAP");
    s = applyAction(s, { type: "PowerTarget", playerId: A, target: at(A, 0) }).state;
    s = applyAction(s, { type: "PowerTarget", playerId: A, target: at(B, 0) }).state;
    expect(s.phase).toBe("POWER_AWAIT_SWAP_CONFIRM");
    return s;
  }

  it("reveals exactly one card per target, and stops at two", () => {
    const s = awaitingConfirm();
    expect(s.pendingPower?.revealed).toHaveLength(2);
  });

  it("treats a third target as a misuse, not as another look", () => {
    const before = awaitingConfirm();
    // The leak this closes: `POWER_AWAIT_SWAP_CONFIRM` leaves `pendingPower` in
    // place with both targets in it, and nothing bounded the count — so a third
    // target fell back into `askToSwap` and bought another `CardRevealed`, over
    // and over, until the whole opposing hand had been read.
    const { state, events } = applyAction(before, {
      type: "PowerTarget",
      playerId: A,
      target: at(B, 1),
    });

    expect(revealed(events)).toHaveLength(0);
    expect(events.some((e) => e.type === "PenaltyCardTaken")).toBe(true);
    expect(state.pendingPower).toBeNull();
    expect(state.phase).toBe("TURN_END");
    // The penalty is what makes it expensive: the layout grows by one.
    expect(layoutOf(state, A)).toHaveLength(layoutOf(before, A).length + 1);
    // And B's second card was never named to A. (B knows it — they peeked it at
    // the start of the round — which is exactly why the check is "not A" rather
    // than "nobody".)
    expect(layoutOf(state, B)[1]!.knownBy).not.toContain(A);
  });

  it("still swaps the two it was given", () => {
    const before = awaitingConfirm();
    const mine = layoutOf(before, A)[0]!.cardId;
    const theirs = layoutOf(before, B)[0]!.cardId;

    const { state, events } = applyAction(before, {
      type: "PowerConfirmSwap",
      playerId: A,
      swap: true,
    });

    expect(events.some((e) => e.type === "CardsSwapped")).toBe(true);
    expect(layoutOf(state, A)[0]!.cardId).toBe(theirs);
    expect(layoutOf(state, B)[0]!.cardId).toBe(mine);
    // knownBy is wiped on both sides even here (docs/06 §6).
    expect(layoutOf(state, A)[0]!.knownBy).toEqual([]);
    expect(layoutOf(state, B)[0]!.knownBy).toEqual([]);
  });
});

describe("BLIND_SWAP — Jack and Queen", () => {
  it("takes the owner's card first and the opponent's second", () => {
    let s = firePower("JS");
    expect(s.pendingPower?.kind).toBe("BLIND_SWAP");

    // Theirs first is a misuse — the ordering rule is a rule, not just an
    // affordance (docs/06 §2).
    const wrongWayRound = applyAction(s, { type: "PowerTarget", playerId: A, target: at(B, 0) });
    expect(wrongWayRound.events.some((e) => e.type === "PenaltyCardTaken")).toBe(true);

    s = applyAction(s, { type: "PowerTarget", playerId: A, target: at(A, 0) }).state;
    expect(s.phase).toBe("POWER_AWAIT_TWO_SLOTS");
    const mine = layoutOf(s, A)[0]!.cardId;
    const theirs = layoutOf(s, B)[2]!.cardId;

    const done = applyAction(s, { type: "PowerTarget", playerId: A, target: at(B, 2) });
    expect(revealed(done.events)).toHaveLength(0);
    expect(layoutOf(done.state, A)[0]!.cardId).toBe(theirs);
    expect(layoutOf(done.state, B)[2]!.cardId).toBe(mine);
  });
});

describe("PEEK_OWN — 7 and 8", () => {
  it("names the card to its owner and to nobody else", () => {
    const s = firePower("7S");
    expect(s.pendingPower?.kind).toBe("PEEK_OWN");
    const { state, events } = applyAction(s, {
      type: "PowerTarget",
      playerId: A,
      target: at(A, 2),
    });

    const reveals = revealed(events);
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ toPlayerId: A, ref: at(A, 2) });
    expect(layoutOf(state, A)[2]!.knownBy).toEqual([A]);
  });

  it("aimed at the opponent is a misuse", () => {
    const s = firePower("7S");
    const { state, events } = applyAction(s, {
      type: "PowerTarget",
      playerId: A,
      target: at(B, 0),
    });
    expect(revealed(events)).toHaveLength(0);
    expect(events.some((e) => e.type === "PenaltyCardTaken")).toBe(true);
    expect(state.phase).toBe("TURN_END");
  });
});

describe("the peek that opens a round", () => {
  it("grants exactly the slots nearestSlots names, and nothing else", () => {
    const s = round(CALM);
    // Both players peeked slots 0 and 1 in `round`; 2 and 3 stay unknown, which
    // is what the board's ring has to be drawn from rather than guessed at.
    const mine = layoutOf(s, A);
    expect(mine[0]!.knownBy).toEqual([A]);
    expect(mine[1]!.knownBy).toEqual([A]);
    expect(mine[2]!.knownBy).toEqual([]);
    expect(mine[3]!.knownBy).toEqual([]);
  });
});
