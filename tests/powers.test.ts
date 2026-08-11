// Powers, where the engine has the last word — see docs/06.
//
// The board's affordances are tested in `targeting.test.ts`; this file is about
// what the reducer does when a client asks for something the board would not have
// offered. That distinction matters here more than anywhere else: an illegal power
// target is deliberately a *misuse* with a penalty rather than a rejection
// (docs/06 §2), so "the UI would not let you" is never the guarantee.

import { describe, expect, it } from "vitest";
import { standard } from "../src/engine/config";
import { checkInvariants } from "../src/engine/invariants";
import { applyAction } from "../src/engine/reduce";
import { currentPlayerId } from "../src/engine/state";
import type { Event, GameState, RuleConfig, SlotRef } from "../src/engine/types";
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

// ---------------------------------------------------------------------------
// The variant of docs/06 §10: a card that leaves its owner's layout for the
// discard fires its power too.
//
// The interesting half is not that the power fires — it is that a snap fires it
// *out of turn*, on top of a phase somebody else is in the middle of. Every test
// below that snaps therefore also asserts what happened to the interrupted turn.
// ---------------------------------------------------------------------------

const handPowers: RuleConfig = {
  ...standard,
  powers: { ...standard.powers, onHandDiscard: true },
};

/** B holds a 9 matching the seeded 9, and A has drawn and is still holding. */
function bCanSnapWhileAHolds(cfg: RuleConfig): GameState {
  const s = round(["2S", "3S", "4S", "5S", "9S", "8S", "10S", "QS", "9H", "KH"], cfg);
  const drawn = applyAction(s, { type: "DrawStock", playerId: A }).state;
  expect(drawn.phase).toBe("AWAIT_HELD_DECISION");
  expect(drawn.heldCard).not.toBeNull();
  return drawn;
}

const snapB0 = (s: GameState) =>
  applyAction(s, {
    type: "Snap",
    playerId: B,
    target: at(B, 0),
    forVersion: s.discardVersion,
  });

describe("powers.onHandDiscard — a card of your own carrying its power", () => {
  it("off, a successful snap fires nothing and leaves the turn alone", () => {
    const before = bCanSnapWhileAHolds(standard);
    const { state, events } = snapB0(before);

    expect(events.some((e) => e.type === "SnapSucceeded")).toBe(true);
    expect(state.pendingPower).toBeNull();
    expect(state.phase).toBe("AWAIT_HELD_DECISION");
    expect(checkInvariants(state)).toEqual([]);
  });

  it("on, a snapped 9 gives its power to the snapper, out of turn", () => {
    const before = bCanSnapWhileAHolds(handPowers);
    const { state, events } = snapB0(before);

    expect(events.some((e) => e.type === "SnapSucceeded")).toBe(true);
    expect(state.pendingPower).toMatchObject({ kind: "PEEK_OPPONENT", ownerId: B });
    expect(state.phase).toBe("POWER_AWAIT_OPPONENT_SLOT");
    // The power belongs to B while it is A's turn — the whole point of the
    // branch, and the reason `PowerSkip` may not be dispatched as "the current
    // player" anywhere.
    expect(currentPlayerId(state)).toBe(A);
    // A is still holding the card they drew, and the invariant that pairs the two
    // reads the interrupted phase rather than this one.
    expect(state.heldCard).toBe(before.heldCard);
    expect(state.resumePhase).toBe("AWAIT_HELD_DECISION");
    expect(checkInvariants(state)).toEqual([]);
  });

  it("gives the interrupted turn back exactly as it was", () => {
    const held = bCanSnapWhileAHolds(handPowers);
    const snapped = snapB0(held).state;

    // Used, not declined: the peek is B's to take mid-A's-turn.
    const used = applyAction(snapped, { type: "PowerTarget", playerId: B, target: at(A, 3) });
    expect(revealed(used.events)).toHaveLength(1);
    expect(revealed(used.events)[0]).toMatchObject({ toPlayerId: B, ref: at(A, 3) });

    expect(used.state.phase).toBe("AWAIT_HELD_DECISION");
    expect(used.state.resumePhase).toBeNull();
    expect(used.state.heldCard).toBe(held.heldCard);
    expect(checkInvariants(used.state)).toEqual([]);

    // And A's turn carries on from where it was.
    const finished = applyAction(used.state, { type: "DiscardHeld", playerId: A });
    expect(finished.events.some((e) => e.type === "HeldDiscarded")).toBe(true);

    // Declining puts the same phase back.
    const skipped = applyAction(snapped, { type: "PowerSkip", playerId: B }).state;
    expect(skipped.phase).toBe("AWAIT_HELD_DECISION");
    expect(skipped.resumePhase).toBeNull();
  });

  it("lets the turn clock skip a power its owner is not the current player for", () => {
    const snapped = snapB0(bCanSnapWhileAHolds(handPowers)).state;
    // Skipped as `currentPlayerId` this earned a NOT_YOUR_POWER and the table sat
    // in the power phase until somebody reloaded.
    const timed = applyAction(snapped, {
      type: "Timeout",
      playerId: A,
      phaseToken: snapped.actionCounter,
    }).state;

    expect(timed.pendingPower).toBeNull();
    expect(timed.phase).toBe("AWAIT_HELD_DECISION");
    expect(checkInvariants(timed)).toEqual([]);
  });

  it("never overwrites a power already pending", () => {
    // A discards a 9 and is choosing whose card to look at when B snaps.
    let s = round(["2S", "3S", "4S", "5S", "9S", "8S", "10S", "QS", "9H", "9C"], handPowers);
    s = applyAction(s, { type: "DrawStock", playerId: A }).state;
    s = applyAction(s, { type: "DiscardHeld", playerId: A }).state;
    expect(s.pendingPower).toMatchObject({ kind: "PEEK_OPPONENT", ownerId: A });

    const { state, events } = snapB0(s);
    expect(events.some((e) => e.type === "SnapSucceeded")).toBe(true);
    // B's snap stands; only the power it would have earned is dropped, because
    // taking it would have stolen A's.
    expect(state.pendingPower).toMatchObject({ ownerId: A });
    expect(events.some((e) => e.type === "PowerStarted")).toBe(false);
    expect(checkInvariants(state)).toEqual([]);
  });

  it("fires nothing for a snap on somebody else's card", () => {
    // The snapper owes the victim a card, which needs `resumePhase` for itself —
    // and the card was never in the snapper's layout.
    const cfg: RuleConfig = { ...handPowers, snap: { ...handPowers.snap, allowOnOpponent: true } };
    let s = round(["9S", "3S", "4S", "5S", "6S", "8S", "10S", "QS", "9H", "KH"], cfg);
    s = applyAction(s, { type: "DrawStock", playerId: A }).state;

    const { state, events } = applyAction(s, {
      type: "Snap",
      playerId: B,
      target: at(A, 0),
      forVersion: s.discardVersion,
    });

    expect(events.some((e) => e.type === "SnapSucceeded")).toBe(true);
    expect(state.phase).toBe("AWAIT_SNAP_GIVE");
    expect(state.pendingPower).toBeNull();
    expect(state.pendingSnapGive).toMatchObject({ snapperId: B, victimId: A });
    expect(checkInvariants(state)).toEqual([]);
  });

  it("ends the round rather than firing a power when the last card goes", () => {
    // Two cards each, both of A's matching, so the second snap empties the layout
    // — which by `snap.emptyLayoutEndsRound` ends the round there and then.
    const cfg: RuleConfig = {
      ...handPowers,
      deck: { ...handPowers.deck, handSize: 2, initialPeekCount: 2 },
    };
    let s = round(["9S", "9H", "2S", "3S", "9D", "KH"], cfg);

    const first = applyAction(s, {
      type: "Snap",
      playerId: A,
      target: at(A, 0),
      forVersion: s.discardVersion,
    });
    // Not empty yet, so this one does fire — and it interrupts A's own TURN_START.
    expect(first.state.pendingPower).toMatchObject({ kind: "PEEK_OPPONENT", ownerId: A });
    s = applyAction(first.state, { type: "PowerSkip", playerId: A }).state;
    expect(s.phase).toBe("TURN_START");

    const second = applyAction(s, {
      type: "Snap",
      playerId: A,
      target: at(A, 1),
      forVersion: s.discardVersion,
    });
    expect(second.events.some((e) => e.type === "RoundRevealed")).toBe(true);
    expect(second.state.pendingPower).toBeNull();
    expect(["REVEAL", "ROUND_END", "MATCH_END"]).toContain(second.state.phase);
    expect(checkInvariants(second.state)).toEqual([]);
  });

  it("off, the card a swap displaces fires nothing", () => {
    // A draws and puts it over their own 9: the 9 goes face up on the discard.
    let s = round(["9S", "3S", "4S", "5S", "6S", "8S", "10S", "QS", "AS", "2H"], standard);
    s = applyAction(s, { type: "DrawStock", playerId: A }).state;
    const { state, events } = applyAction(s, { type: "PlaceInSlot", playerId: A, slot: 0 });

    expect(events.some((e) => e.type === "PowerStarted")).toBe(false);
    expect(state.pendingPower).toBeNull();
    expect(state.phase).toBe("TURN_END");
  });

  it("on, the card a swap displaces fires its own power", () => {
    let s = round(["9S", "3S", "4S", "5S", "6S", "8S", "10S", "QS", "AS", "2H"], handPowers);
    s = applyAction(s, { type: "DrawStock", playerId: A }).state;
    const displaced = s.players.find((p) => p.id === A)!.layout[0]!.cardId;

    const { state, events } = applyAction(s, { type: "PlaceInSlot", playerId: A, slot: 0 });

    expect(events.some((e) => e.type === "CardPlaced")).toBe(true);
    expect(state.pendingPower).toMatchObject({ kind: "PEEK_OPPONENT", ownerId: A });
    // `sourceCard` has to be the card now on top of the discard: `finishGive`
    // takes it back off there (docs/06 §7).
    expect(state.pendingPower?.sourceCard).toBe(displaced);
    expect(state.discard[0]).toBe(displaced);
    // Its owner is mid-turn, so there is nothing to resume: the power ends the
    // turn as any other power does.
    expect(state.resumePhase).toBeNull();
    const done = applyAction(state, { type: "PowerSkip", playerId: A }).state;
    expect(done.phase).toBe("TURN_END");
  });

  it("still gives no power to the card kept in hand", () => {
    // The balance the rule must not break: taking a 9's value and its power both
    // is what every ruleset forbids. Here the 9 is the card *placed*, not the one
    // displaced, and the displaced 2 has none.
    let s = round(["2S", "3S", "4S", "5S", "6S", "8S", "10S", "QS", "AS", "9H"], handPowers);
    s = applyAction(s, { type: "DrawStock", playerId: A }).state;
    const { state, events } = applyAction(s, { type: "PlaceInSlot", playerId: A, slot: 0 });

    expect(events.some((e) => e.type === "PowerStarted")).toBe(false);
    expect(state.pendingPower).toBeNull();
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
