// Events → movements, and two seats → one movement.
//
// `planFlights` and `mergeSeatEvents` are the whole reason the animation layer is
// split in two: everything that decides *what moved* is pure, so it can be tested
// here, and only "where is that on screen" needs a browser.

import { describe, expect, it } from "vitest";
import { HIDDEN } from "../src/engine/project";
import type { Event } from "../src/engine/types";
import type { SeatUpdate } from "../src/ui/client";
import { mergeSeatEvents, planFlights, sameAnchor } from "../src/ui/game/flights";

const A = "a";
const B = "b";

/** Only `events` is read; the view is never consulted. */
const update = (seat: string, events: Event[]): SeatUpdate =>
  ({ seat, events, view: undefined } as unknown as SeatUpdate);

describe("planFlights", () => {
  it("takes a drawn card from the stock to the drawer's own tray", () => {
    const flights = planFlights(
      [{ type: "StockDrawn", playerId: A, cardId: "d1-7S" }],
      "TURN_START",
    );
    expect(flights).toEqual([
      { from: { kind: "stock" }, to: { kind: "tray", playerId: A }, cardId: "d1-7S", kind: "move" },
    ]);
  });

  it("crosses two cards on a swap: one in from the tray, one out to the discard", () => {
    const flights = planFlights(
      [
        {
          type: "CardPlaced",
          playerId: A,
          slot: 2,
          placedCardId: "d1-7S",
          discardedCardId: "d1-KH",
        },
      ],
      "AWAIT_HELD_DECISION",
    );
    expect(flights).toHaveLength(2);
    expect(flights[0]).toMatchObject({
      from: { kind: "tray", playerId: A },
      to: { kind: "slot", playerId: A, slot: 2 },
      cardId: "d1-7S",
    });
    expect(flights[1]).toMatchObject({
      from: { kind: "slot", playerId: A, slot: 2 },
      to: { kind: "discard" },
      cardId: "d1-KH",
    });
  });

  it("moves only one card when the slot was empty", () => {
    const flights = planFlights(
      [
        {
          type: "CardPlaced",
          playerId: A,
          slot: 0,
          placedCardId: "d1-7S",
          discardedCardId: null,
        },
      ],
      "AWAIT_HELD_DECISION",
    );
    expect(flights).toHaveLength(1);
  });

  it("sends a blind swap both ways, and names neither card", () => {
    const flights = planFlights(
      [{ type: "CardsSwapped", a: { playerId: A, slot: 0 }, b: { playerId: B, slot: 3 } }],
      "POWER_AWAIT_TWO_SLOTS",
    );
    expect(flights).toEqual([
      {
        from: { kind: "slot", playerId: A, slot: 0 },
        to: { kind: "slot", playerId: B, slot: 3 },
        cardId: HIDDEN,
        kind: "move",
        bow: 1,
      },
      {
        from: { kind: "slot", playerId: B, slot: 3 },
        to: { kind: "slot", playerId: A, slot: 0 },
        cardId: HIDDEN,
        kind: "move",
        bow: -1,
      },
    ]);
  });

  it("bows the two legs of a swap in opposite directions, and nothing else", () => {
    const swap = planFlights(
      [{ type: "CardsSwapped", a: { playerId: A, slot: 1 }, b: { playerId: B, slot: 1 } }],
      "POWER_AWAIT_TWO_SLOTS",
    );
    // Opposite, so they pass each other. Two cards on the same line at the same
    // speed read as one card flickering, which is why nobody could tell which of
    // their cards had changed.
    expect(swap.map((f) => f.bow)).toEqual([1, -1]);

    // Every other movement is a single card and has no partner to avoid.
    const everythingElse = planFlights(
      [
        { type: "StockDrawn", playerId: A, cardId: "d1-2S" },
        { type: "HeldDiscarded", playerId: A, cardId: "d1-2S", power: "NONE" },
        {
          type: "CardPlaced",
          playerId: A,
          slot: 0,
          placedCardId: "d1-3S",
          discardedCardId: "d1-4S",
        },
        { type: "SnapSucceeded", playerId: A, ref: { playerId: A, slot: 2 }, cardId: "d1-5S" },
        {
          type: "SnapFailed",
          playerId: A,
          ref: { playerId: A, slot: 2 },
          cardId: "d1-5S",
          reason: "RANK_MISMATCH",
        },
        {
          type: "PenaltyCardTaken",
          playerId: A,
          slot: 4,
          cardId: "d1-6S",
          reason: "POWER_MISUSE",
        },
      ],
      "TURN_START",
    );
    expect(everythingElse.every((f) => f.bow === undefined)).toBe(true);
  });

  it("returns a failed snap to its own slot, and flies the penalty in", () => {
    const flights = planFlights(
      [
        {
          type: "SnapFailed",
          playerId: A,
          ref: { playerId: A, slot: 1 },
          cardId: "d1-4C",
          reason: "RANK_MISMATCH",
        },
        {
          type: "PenaltyCardTaken",
          playerId: A,
          slot: 4,
          cardId: HIDDEN,
          reason: "SNAP_FAILURE",
        },
      ],
      "TURN_START",
    );
    expect(flights).toHaveLength(2);
    expect(flights[0]).toMatchObject({ kind: "return", from: { kind: "slot", playerId: A, slot: 1 } });
    expect(sameAnchor(flights[0]!.from, flights[0]!.to)).toBe(true);
    expect(flights[1]).toMatchObject({
      from: { kind: "stock" },
      to: { kind: "slot", playerId: A, slot: 4 },
      kind: "move",
    });
  });

  it("tells the two givings apart by the phase they came from", () => {
    const given: Event = {
      type: "CardGiven",
      fromPlayerId: A,
      toPlayerId: B,
      slot: 2,
      cardId: "d1-AS",
    };
    // The Ace was pushed onto the discard and is taken back off it (docs/06 §7).
    expect(planFlights([given], "POWER_AWAIT_GIVE_TARGET")[0]).toMatchObject({
      from: { kind: "discard" },
      to: { kind: "slot", playerId: B, slot: 2 },
    });
    // A snap give comes out of the giver's own hand, and the event does not say
    // which slot (docs/07 §5).
    expect(planFlights([given], "AWAIT_SNAP_GIVE")[0]).toMatchObject({
      from: { kind: "hand", playerId: A },
      to: { kind: "slot", playerId: B, slot: 2 },
    });
  });

  it("leaves the deal alone — a round begins with the cards already down", () => {
    const flights = planFlights(
      [
        { type: "RoundStarted", roundNumber: 1, dealerIndex: 1, handSize: 4, stockSize: 43 },
        {
          type: "CardsDealt",
          deals: [
            { playerId: A, slot: 0, cardId: HIDDEN },
            { playerId: B, slot: 0, cardId: HIDDEN },
          ],
        },
        { type: "DiscardSeeded", cardId: "d1-4H" },
      ],
      "DEALING",
    );
    expect(flights).toEqual([]);
  });
});

describe("mergeSeatEvents", () => {
  it("is the identity for the one seat an online client holds", () => {
    const events: Event[] = [{ type: "StockDrawn", playerId: A, cardId: HIDDEN }];
    expect(mergeSeatEvents([update(A, events)])).toEqual(events);
  });

  it("animates one movement once, from the seat entitled to name the card", () => {
    // The flat table's two streams: p1 drew, so only p1's stream has the id.
    const merged = mergeSeatEvents([
      update(A, [{ type: "StockDrawn", playerId: A, cardId: "d1-7S" }]),
      update(B, [{ type: "StockDrawn", playerId: A, cardId: HIDDEN }]),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ cardId: "d1-7S" });
  });

  it("prefers the more entitled variant whichever seat it arrives on", () => {
    const merged = mergeSeatEvents([
      update(A, [{ type: "StockDrawn", playerId: B, cardId: HIDDEN }]),
      update(B, [{ type: "StockDrawn", playerId: B, cardId: "d1-9D" }]),
    ]);
    expect(merged[0]).toMatchObject({ cardId: "d1-9D" });
  });

  it("stays aligned when one seat is told about a rejection and the other is not", () => {
    // A lost snap race with loserPenalty NONE: `projectEvent` drops a foreign
    // ActionRejected entirely, so the streams are different lengths until those
    // are filtered out.
    const rejection: Event = {
      type: "ActionRejected",
      playerId: B,
      action: { type: "EndTurn", playerId: B },
      reason: "SNAP_TOO_LATE",
    };
    const merged = mergeSeatEvents([
      update(A, [{ type: "StockDrawn", playerId: A, cardId: "d1-7S" }]),
      update(B, [rejection, { type: "StockDrawn", playerId: A, cardId: HIDDEN }]),
    ]);
    expect(merged).toEqual([{ type: "StockDrawn", playerId: A, cardId: "d1-7S" }]);
  });

  it("falls back to one whole stream rather than mixing two that disagree", () => {
    // Should never happen; if it ever does, one animation per movement still
    // holds — the card just flies as a back.
    const spine: Event[] = [{ type: "StockDrawn", playerId: A, cardId: HIDDEN }];
    const merged = mergeSeatEvents([update(A, spine), update(B, [])]);
    expect(merged).toEqual(spine);
  });

  it("is empty for no seats at all", () => {
    expect(mergeSeatEvents([])).toEqual([]);
  });
});
