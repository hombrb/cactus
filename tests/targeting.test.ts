// Who may tap what — the rule the online game was missing.
//
// The board used to gate every slot gesture on "this device owns the seat whose
// cards these are". On the flat table that is harmless, because it owns both. In
// a room it owns one, so PEEK_OPPONENT and the second half of a swap could not be
// aimed at all: the prompt said "Regarde une carte adverse" and no card would
// accept the tap. The power then expired on the turn clock.
//
// These tests are written against a one-seat client for exactly that reason, and
// the two-seat cases keep the flat table honest.

import { describe, expect, it } from "vitest";
import { buildDeck, cardTable } from "../src/engine/cards";
import { standard } from "../src/engine/config";
import { projectFor } from "../src/engine/project";
import { applyAction } from "../src/engine/reduce";
import { createMatch, createRound } from "../src/engine/turn";
import type { GameState, PlayerId, PowerKind, Rank } from "../src/engine/types";
import { actingSeat, targetableBy } from "../src/ui/game/targeting";

const A = "a";
const B = "b";

/**
 * A round dealt from the top of a real deck in a chosen order, so a phase can be
 * reached without hunting for a seed. `front` is `rank + suit` shorthand in
 * dealing order: A's four, B's four, the discard seed, then the stock.
 *
 * The whole deck still has to be there, or card conservation fails (docs/11 §2).
 */
function round(front: readonly string[]): GameState {
  const deck = buildDeck(standard);
  const idOf = new Map(deck.map((c) => [`${c.rank}${c.suit}`, c.id]));
  const head = front.map((short) => {
    const id = idOf.get(short);
    if (id === undefined) throw new Error(`no ${short} in the deck`);
    return id;
  });
  const order = [...head, ...deck.map((c) => c.id).filter((id) => !head.includes(id))];

  const base = createMatch({
    config: standard,
    players: [
      { id: A, name: "A" },
      { id: B, name: "B" },
    ],
    seed: "targeting",
  });
  // Past the peek barrier: both players ready, A to play.
  let s = createRound({ ...base, phase: "DEALING" }, order, cardTable(deck)).state;
  s = applyAction(s, { type: "PeekInitial", playerId: A, slots: [0, 1] }).state;
  s = applyAction(s, { type: "PeekInitial", playerId: B, slots: [0, 1] }).state;
  expect(s.phase).toBe("TURN_START");
  return s;
}

/** Eight distinct ranks, a seed that matches none of them, then one free slot. */
const CALM = ["2S", "3S", "4S", "5S", "6S", "8S", "10S", "QS", "AS"];

/** Draws the top of the stock and discards it, which is what fires a power. */
function withPowerPending(kind: PowerKind, rank: Rank): GameState {
  expect(standard.powers.map[rank]).toBe(kind);
  let s = round([...CALM, `${rank}S`]);
  s = applyAction(s, { type: "DrawStock", playerId: A }).state;
  s = applyAction(s, { type: "DiscardHeld", playerId: A }).state;
  expect(s.pendingPower?.kind).toBe(kind);
  return s;
}

const view = (s: GameState, viewer: PlayerId) => projectFor(s, viewer);
const at = (playerId: PlayerId, slot: number) => ({ playerId, slot });

describe("actingSeat", () => {
  it("is the current player when this device holds their seat", () => {
    const s = round(CALM);
    expect(actingSeat(view(s, A), [A])).toBe(A);
    expect(actingSeat(view(s, A), [A, B])).toBe(A);
  });

  it("is null on the opponent's turn — their phone acts, not ours", () => {
    const s = round(CALM);
    expect(actingSeat(view(s, B), [B])).toBeNull();
  });

  it("follows the power's owner rather than the phase", () => {
    const s = withPowerPending("PEEK_OPPONENT", "9");
    expect(actingSeat(view(s, A), [A])).toBe(A);
    expect(actingSeat(view(s, B), [B])).toBeNull();
  });
});

describe("targetableBy — powers, one seat per device", () => {
  it("lets a PEEK_OPPONENT aim at the opponent's half, and only there", () => {
    const s = withPowerPending("PEEK_OPPONENT", "9");
    // The regression: this was unreachable, because the opponent's half was not
    // wired for input at all.
    expect(targetableBy(view(s, A), [A], at(B, 0))).toBe(A);
    expect(targetableBy(view(s, A), [A], at(A, 0))).toBeNull();
  });

  it("keeps PEEK_OWN to the owner's own half", () => {
    const s = withPowerPending("PEEK_OWN", "7");
    expect(targetableBy(view(s, A), [A], at(A, 2))).toBe(A);
    expect(targetableBy(view(s, A), [A], at(B, 2))).toBeNull();
  });

  it("takes a swap's targets yours-first-then-theirs", () => {
    const first = withPowerPending("BLIND_SWAP", "J");
    expect(targetableBy(view(first, A), [A], at(A, 0))).toBe(A);
    expect(targetableBy(view(first, A), [A], at(B, 0))).toBeNull();

    const second = applyAction(first, {
      type: "PowerTarget",
      playerId: A,
      target: at(A, 0),
    }).state;
    expect(second.pendingPower?.targets).toHaveLength(1);
    expect(targetableBy(view(second, A), [A], at(B, 0))).toBe(A);
    expect(targetableBy(view(second, A), [A], at(A, 1))).toBeNull();
    // …and never the same slot twice.
    expect(targetableBy(view(second, A), [A], at(A, 0))).toBeNull();
  });

  it("gives the opponent's phone nothing to tap while the power is not theirs", () => {
    const s = withPowerPending("PEEK_OPPONENT", "9");
    expect(targetableBy(view(s, B), [B], at(A, 0))).toBeNull();
    expect(targetableBy(view(s, B), [B], at(B, 0))).toBeNull();
  });
});

describe("targetableBy — placing the held card", () => {
  it("allows the holder's own slots only", () => {
    let s = round(CALM);
    s = applyAction(s, { type: "DrawStock", playerId: A }).state;
    expect(s.phase).toBe("AWAIT_HELD_DECISION");

    expect(targetableBy(view(s, A), [A], at(A, 3))).toBe(A);
    expect(targetableBy(view(s, A), [A], at(B, 3))).toBeNull();
    expect(targetableBy(view(s, B), [B], at(B, 3))).toBeNull();
  });

  it("refuses a slot a snap has emptied", () => {
    // A's first card and the seeded discard are both nines, so A may snap it.
    let s = round(["9S", "3S", "4S", "5S", "6S", "8S", "10S", "QS", "9H"]);
    s = applyAction(s, {
      type: "Snap",
      playerId: A,
      target: at(A, 0),
      forVersion: s.discardVersion,
    }).state;
    s = applyAction(s, { type: "DrawStock", playerId: A }).state;

    expect(view(s, A).players.find((p) => p.id === A)!.layout[0]).toBeNull();
    expect(targetableBy(view(s, A), [A], at(A, 0))).toBeNull();
    expect(targetableBy(view(s, A), [A], at(A, 1))).toBe(A);
  });
});

describe("targetableBy — the flat table holds both seats", () => {
  it("still lights up both halves for whoever's power it is", () => {
    const s = withPowerPending("PEEK_OPPONENT", "9");
    expect(targetableBy(view(s, A), [A, B], at(B, 0))).toBe(A);
    expect(targetableBy(view(s, A), [A, B], at(A, 0))).toBeNull();
  });

  it("dispatches as the power's owner, not as the half's player", () => {
    const s = withPowerPending("PEEK_OPPONENT", "9");
    // B's card is the target, but A is who acts — the distinction the board got
    // wrong when it dispatched as the half it was tapped in.
    expect(targetableBy(view(s, A), [A, B], at(B, 2))).toBe(A);
  });
});

describe("targetableBy — nothing pending", () => {
  it("is null everywhere at the start of a turn", () => {
    const s = round(CALM);
    for (const owner of [A, B]) {
      for (let i = 0; i < 4; i++) {
        expect(targetableBy(view(s, A), [A, B], at(owner, i))).toBeNull();
      }
    }
  });
});
