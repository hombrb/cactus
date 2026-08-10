// Saying "Cactus" after you have played — docs/01 §7, docs/05 §6.
//
// The window is the point: at a table you play, and then you say it, and the
// others let you as long as nobody has gone yet. `AFTER_TURN` is that, and the
// property that makes it safe to allow is that the final lap comes out
// *identical* to announcing at your own turn end — the announcement is late, the
// round is not.

import { describe, expect, it } from "vitest";
import { buildDeck, cardTable } from "../src/engine/cards";
import { standard } from "../src/engine/config";
import { applyAction } from "../src/engine/reduce";
import { createMatch, createRound, inAnnounceWindow } from "../src/engine/turn";
import type { Event, GameState, PlayerId, Reduction, RuleConfig } from "../src/engine/types";

const AFTER: RuleConfig = standard;
const STRICT: RuleConfig = {
  ...standard,
  announce: { ...standard.announce, timing: "END_OF_TURN" },
};

/** A round already past the peek barrier, with every player ready. */
function round(config: RuleConfig, ids: readonly PlayerId[]): GameState {
  const deck = buildDeck(config);
  const base = createMatch({
    config,
    players: ids.map((id) => ({ id, name: id.toUpperCase() })),
    seed: "announce",
  });
  let s = createRound({ ...base, phase: "DEALING" }, deck.map((c) => c.id), cardTable(deck)).state;
  for (const id of ids) s = applyAction(s, { type: "PeekInitial", playerId: id, slots: [0, 1] }).state;
  expect(s.phase).toBe("TURN_START");
  return s;
}

/** Draw, throw it away, skip whatever power it had. One whole turn, no announce. */
function playTurn(s: GameState): GameState {
  const me = s.turnOrder[s.currentPlayerIndex]!;
  let next = applyAction(s, { type: "DrawStock", playerId: me }).state;
  next = applyAction(next, { type: "DiscardHeld", playerId: me }).state;
  if (next.pendingPower) next = applyAction(next, { type: "PowerSkip", playerId: me }).state;
  return next;
}

const announce = (s: GameState, playerId: PlayerId): Reduction =>
  applyAction(s, { type: "AnnounceCactus", playerId });

const rejection = (events: readonly Event[]): string | undefined =>
  events.find((e) => e.type === "ActionRejected")?.reason;

describe("AFTER_TURN — announcing once you have played", () => {
  it("is accepted while the next player is still taking their turn", () => {
    let s = round(AFTER, ["a", "b"]);
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
    expect(s.turnOrder[s.currentPlayerIndex]).toBe("b");
    expect(s.previousPlayerId).toBe("a");

    // B has drawn but not finished. A can still say it.
    s = applyAction(s, { type: "DrawStock", playerId: "b" }).state;
    const said = announce(s, "a");
    expect(rejection(said.events)).toBeUndefined();
    expect(said.state.announcerId).toBe("a");
  });

  it("leaves the current player's turn alone — it is theirs to finish", () => {
    let s = round(AFTER, ["a", "b"]);
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
    s = applyAction(s, { type: "DrawStock", playerId: "b" }).state;
    expect(s.phase).toBe("AWAIT_HELD_DECISION");

    const said = announce(s, "a").state;
    // Not ended, not skipped, not rewound: B is still holding their card.
    expect(said.phase).toBe("AWAIT_HELD_DECISION");
    expect(said.heldCard).toBe(s.heldCard);
    expect(said.turnOrder[said.currentPlayerIndex]).toBe("b");
  });

  it("gives exactly the same final lap as announcing at your own turn end", () => {
    const atOwnEnd = (() => {
      let s = round(AFTER, ["a", "b", "c"]);
      s = playTurn(s);
      return announce(s, "a").state;
    })();

    const late = (() => {
      let s = round(AFTER, ["a", "b", "c"]);
      s = playTurn(s);
      s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
      return announce(s, "a").state;
    })();

    expect(atOwnEnd.finalLapRemaining).toBe(2);
    expect(late.finalLapRemaining).toBe(2);

    // And both round off after the same number of turns.
    const lapsToReveal = (start: GameState): number => {
      let s = start;
      let turns = 0;
      while (s.phase !== "REVEAL" && s.phase !== "ROUND_END" && turns < 10) {
        s = playTurn(s);
        s = applyAction(s, {
          type: "EndTurn",
          playerId: s.turnOrder[s.currentPlayerIndex]!,
        }).state;
        turns++;
      }
      return turns;
    };
    expect(lapsToReveal(late)).toBe(lapsToReveal(atOwnEnd));
  });

  it("closes the moment the next player ends their turn", () => {
    let s = round(AFTER, ["a", "b", "c"]);
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "b" }).state;

    expect(s.previousPlayerId).toBe("b");
    expect(rejection(announce(s, "a").events)).toBe("NOT_YOUR_TURN");
    // B, who has just played, now holds the window instead.
    expect(rejection(announce(s, "b").events)).toBeUndefined();
  });

  it("is refused to a player who has not just played", () => {
    let s = round(AFTER, ["a", "b", "c"]);
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
    expect(rejection(announce(s, "c").events)).toBe("NOT_YOUR_TURN");
  });

  it("is refused before anybody has finished a turn", () => {
    const s = round(AFTER, ["a", "b"]);
    expect(s.previousPlayerId).toBeNull();
    expect(rejection(announce(s, "a").events)).toBe("WRONG_PHASE");
    expect(rejection(announce(s, "b").events)).toBe("NOT_YOUR_TURN");
  });

  it("is refused once somebody else has announced", () => {
    let s = round(AFTER, ["a", "b", "c"]);
    s = playTurn(s);
    s = announce(s, "a").state;
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "b" }).state;
    expect(rejection(announce(s, "b").events)).toBe("ALREADY_ANNOUNCED");
  });

  it("still lets you announce at your own turn end, as before", () => {
    let s = round(AFTER, ["a", "b"]);
    s = playTurn(s);
    expect(s.phase).toBe("TURN_END");
    const said = announce(s, "a");
    expect(rejection(said.events)).toBeUndefined();
    // That path ends the turn as it always did.
    expect(said.events.some((e) => e.type === "TurnEnded")).toBe(true);
    expect(said.state.turnOrder[said.state.currentPlayerIndex]).toBe("b");
  });

  it("does not open a window into the reveal", () => {
    // A round can end with nobody having announced — stock death, or a layout
    // emptied by a snap. The player who took the last turn must not then be able
    // to announce over the scores.
    let s = round(AFTER, ["a", "b"]);
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
    expect(s.previousPlayerId).toBe("a");
    expect(inAnnounceWindow(s, "a")).toBe(true);

    for (const phase of ["REVEAL", "ROUND_END", "MATCH_END"] as const) {
      expect(inAnnounceWindow({ ...s, phase }, "a")).toBe(false);
    }
  });

  it("is refused to a player who has been eliminated", () => {
    let s = round(AFTER, ["a", "b", "c"]);
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
    const out: GameState = {
      ...s,
      players: s.players.map((p) => (p.id === "a" ? { ...p, eliminated: true } : p)),
    };
    expect(inAnnounceWindow(out, "a")).toBe(false);
  });
});

describe("END_OF_TURN — the strict variant is untouched", () => {
  it("refuses an announcement once the turn has been handed over", () => {
    let s = round(STRICT, ["a", "b"]);
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "a" }).state;
    expect(rejection(announce(s, "a").events)).toBe("NOT_YOUR_TURN");
  });

  it("accepts it during your own TURN_END", () => {
    let s = round(STRICT, ["a", "b"]);
    s = playTurn(s);
    expect(s.phase).toBe("TURN_END");
    expect(rejection(announce(s, "a").events)).toBeUndefined();
  });

  it("refuses it mid-turn", () => {
    let s = round(STRICT, ["a", "b"]);
    s = applyAction(s, { type: "DrawStock", playerId: "a" }).state;
    expect(rejection(announce(s, "a").events)).toBe("WRONG_PHASE");
  });
});

describe("the window survives the round boundary correctly", () => {
  it("is empty again at the start of a new round", () => {
    let s = round(AFTER, ["a", "b"]);
    s = playTurn(s);
    s = announce(s, "a").state;
    s = playTurn(s);
    s = applyAction(s, { type: "EndTurn", playerId: "b" }).state;
    expect(s.phase).toBe("ROUND_END");

    const next = applyAction(s, { type: "StartNextRound", playerId: s.hostId }).state;
    expect(next.previousPlayerId).toBeNull();
    expect(next.announcerId).toBeNull();
  });
});
