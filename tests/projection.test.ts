// The wire format — docs/09.
//
// Once the UI renders from a PlayerView and the authority fans out projected
// events, these two functions are the only thing standing between a player and
// their opponent's hand. They get their own sweep.

import { describe, expect, it } from "vitest";
import { standard } from "../src/engine/config";
import { HIDDEN, projectEvent, projectFor } from "../src/engine/project";
import { applyAction } from "../src/engine/reduce";
import { prf } from "../src/engine/rng";
import { currentPlayerId } from "../src/engine/state";
import { createMatch } from "../src/engine/turn";
import type { Event, GameState, PlayerId } from "../src/engine/types";
import { CARD_ID, candidates, stringLeaves } from "./helpers";

const PLAYERS = ["a", "b", "c"] as const;

function entitledCards(s: GameState, viewer: PlayerId): Set<string> {
  const entitled = new Set<string>(s.discard);
  for (const p of s.players) {
    for (const slot of p.layout) {
      if (slot.cardId !== null && slot.knownBy.includes(viewer)) entitled.add(slot.cardId);
    }
  }
  if (s.heldCard !== null && currentPlayerId(s) === viewer) entitled.add(s.heldCard);
  return entitled;
}

function freshMatch(seed: string): GameState {
  return createMatch({
    config: standard,
    players: PLAYERS.map((id) => ({ id, name: id.toUpperCase() })),
    seed,
  });
}

describe("PlayerView as a wire format", () => {
  it("survives JSON unchanged — the Durable Object persists it verbatim", () => {
    let s = freshMatch("wire");
    for (let i = 0; i < 60; i++) {
      const options = candidates(s);
      if (options.length === 0) break;
      s = applyAction(s, options[prf("wire", i) % options.length]!).state;
    }

    // Not decoration: a hibernating Durable Object round-trips GameState through
    // JSON after every action. A Set or Map anywhere in here loses the game.
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);

    for (const viewer of PLAYERS) {
      const view = projectFor(s, viewer);
      expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    }
  });

  it("carries everything the renderer needs, and nothing secret", () => {
    let s = freshMatch("needs");
    for (let i = 0; i < 30; i++) {
      const options = candidates(s);
      if (options.length === 0) break;
      s = applyAction(s, options[prf("needs", i) % options.length]!).state;
    }

    const view = projectFor(s, "a");
    // The fields Phase 1 added so board.ts could stop reading GameState.
    expect(view.config).toEqual(s.config);
    expect(view.hostId).toBe(s.hostId);
    expect(view.turnOrder).toEqual(s.turnOrder);
    expect(view.pendingSnapGive).toEqual(s.pendingSnapGive);

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(s.rngSeed);
    expect(Object.keys(view)).not.toContain("stock");
    expect(Object.keys(view)).not.toContain("rngSeed");
  });

  it("never serialises a card id the viewer is not entitled to", () => {
    let s = freshMatch("leak-deep");

    for (let step = 0; step < 300 && s.phase !== "MATCH_END"; step++) {
      const options = candidates(s);
      if (options.length === 0) break;
      s = applyAction(s, options[prf("leak-deep", step) % options.length]!).state;
      if (s.phase === "REVEAL" || s.phase === "ROUND_END" || s.phase === "MATCH_END") break;

      for (const viewer of PLAYERS) {
        const entitled = entitledCards(s, viewer);
        // Walks the whole serialised view, not just the fields we remembered to
        // check — a new field that carries a card id fails here.
        for (const leaf of stringLeaves(JSON.parse(JSON.stringify(projectFor(s, viewer))))) {
          if (!CARD_ID.test(leaf)) continue;
          expect(entitled.has(leaf), `${viewer} was shown ${leaf}`).toBe(true);
        }
      }
    }
  });
});

/**
 * A snap flips a card face up in front of everyone. The engine then *clears*
 * `knownBy` — "the engine may re-render this for you" is not "you saw it once",
 * and remembering is the player's job (`src/engine/snap.ts`). So these two
 * events legitimately name a card no viewer is entitled to have re-rendered,
 * and the entitlement sweep below has to say so out loud rather than silently
 * pass because the redaction happened to be wide enough.
 */
const PUBLIC_FLIPS = new Set(["SnapFailed", "SnapSucceeded"]);

describe("projectEvent", () => {
  it("keeps the public snap flips public", () => {
    const failed: Event = {
      type: "SnapFailed",
      playerId: "a",
      ref: { playerId: "a", slot: 0 },
      cardId: "d1-KS",
      reason: "RANK_MISMATCH",
    };
    const succeeded: Event = {
      type: "SnapSucceeded",
      playerId: "a",
      ref: { playerId: "a", slot: 0 },
      cardId: "d1-KS",
    };
    for (const viewer of PLAYERS) {
      expect(projectEvent(failed, viewer)).toEqual(failed);
      expect(projectEvent(succeeded, viewer)).toEqual(succeeded);
    }
  });

  it("never leaks a card id through the event stream", () => {
    let s = freshMatch("event-leak");

    for (let step = 0; step < 300 && s.phase !== "MATCH_END"; step++) {
      const options = candidates(s);
      if (options.length === 0) break;

      const before = s;
      const result = applyAction(s, options[prf("event-leak", step) % options.length]!);
      s = result.state;

      const reveals = s.phase === "REVEAL" || s.phase === "ROUND_END" || s.phase === "MATCH_END";
      for (const viewer of PLAYERS) {
        // An event may legitimately name a card the viewer only becomes entitled
        // to *because of* that event, so both sides of the reduction count.
        const entitled = new Set([
          ...entitledCards(before, viewer),
          ...entitledCards(s, viewer),
        ]);
        for (const e of result.events) {
          if (PUBLIC_FLIPS.has(e.type)) continue;
          const projected = projectEvent(e, viewer);
          if (projected === null) continue;
          for (const leaf of stringLeaves(projected)) {
            if (!CARD_ID.test(leaf)) continue;
            // The reveal dumps every layout face up on purpose.
            if (reveals) continue;
            expect(entitled.has(leaf), `${viewer} saw ${leaf} in ${e.type}`).toBe(true);
          }
        }
      }
      if (reveals) break;
    }
  });

  it("redacts each event exactly as docs/09 §3 specifies", () => {
    const ref = { playerId: "b", slot: 1 } as const;
    const cases: readonly [Event, PlayerId, unknown][] = [
      // A deal is face down for everybody, including its recipient.
      [
        { type: "CardsDealt", deals: [{ playerId: "a", slot: 0, cardId: "d1-KS" }] },
        "a",
        { type: "CardsDealt", deals: [{ playerId: "a", slot: 0, cardId: HIDDEN }] },
      ],
      [
        { type: "InitialPeeked", playerId: "a", reveals: [{ slot: 0, cardId: "d1-KS" }] },
        "b",
        { type: "InitialPeeked", playerId: "a", reveals: [{ slot: 0, cardId: HIDDEN }] },
      ],
      [{ type: "StockDrawn", playerId: "a", cardId: "d1-KS" }, "b", { type: "StockDrawn", playerId: "a", cardId: HIDDEN }],
      [{ type: "CardRevealed", toPlayerId: "a", ref, cardId: "d1-KS" }, "b", { type: "CardRevealed", toPlayerId: "a", ref, cardId: HIDDEN }],
      [
        { type: "CardPlaced", playerId: "a", slot: 0, placedCardId: "d1-KS", discardedCardId: "d1-2H" },
        "b",
        { type: "CardPlaced", playerId: "a", slot: 0, placedCardId: HIDDEN, discardedCardId: "d1-2H" },
      ],
      [
        { type: "CardGiven", fromPlayerId: "a", toPlayerId: "b", slot: 0, cardId: "d1-KS" },
        "b",
        { type: "CardGiven", fromPlayerId: "a", toPlayerId: "b", slot: 0, cardId: HIDDEN },
      ],
      // Face down even to its owner — that is what makes it a penalty.
      [
        { type: "PenaltyCardTaken", playerId: "a", slot: 3, cardId: "d1-KS", reason: "SNAP_FAILURE" },
        "a",
        { type: "PenaltyCardTaken", playerId: "a", slot: 3, cardId: HIDDEN, reason: "SNAP_FAILURE" },
      ],
    ];

    for (const [event, viewer, expected] of cases) {
      expect(projectEvent(event, viewer), event.type).toEqual(expected);
    }
  });

  it("keeps the actor's own events intact", () => {
    const own: readonly Event[] = [
      { type: "StockDrawn", playerId: "a", cardId: "d1-KS" },
      { type: "InitialPeeked", playerId: "a", reveals: [{ slot: 0, cardId: "d1-KS" }] },
      { type: "CardRevealed", toPlayerId: "a", ref: { playerId: "b", slot: 1 }, cardId: "d1-KS" },
    ];
    for (const e of own) expect(projectEvent(e, "a")).toEqual(e);
  });

  it("hides a rejection from everybody but the player who caused it", () => {
    const rejection: Event = {
      type: "ActionRejected",
      playerId: "a",
      action: { type: "DrawStock", playerId: "a" },
      reason: "NOT_YOUR_TURN",
    };
    expect(projectEvent(rejection, "a")).toEqual(rejection);
    expect(projectEvent(rejection, "b")).toBeNull();
  });

  it("passes public events through untouched", () => {
    const seeded: Event = { type: "DiscardSeeded", cardId: "d1-KS" };
    const taken: Event = { type: "DiscardTaken", playerId: "a", cardId: "d1-KS" };
    expect(projectEvent(seeded, "b")).toEqual(seeded);
    expect(projectEvent(taken, "b")).toEqual(taken);
  });
});
