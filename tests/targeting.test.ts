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
import { standard } from "../src/engine/config";
import { projectFor } from "../src/engine/project";
import { applyAction } from "../src/engine/reduce";
import { nearestSlots } from "../src/engine/turn";
import type { GameState, PlayerId, PowerKind, Rank } from "../src/engine/types";
import { actingSeat, targetableBy } from "../src/ui/game/targeting";
import { A, B, CALM, firePower, round } from "./helpers";

/** Draws the top of the stock and discards it, which is what fires a power. */
function withPowerPending(kind: PowerKind, rank: Rank): GameState {
  expect(standard.powers.map[rank]).toBe(kind);
  const s = firePower(`${rank}S`);
  expect(s.pendingPower?.kind).toBe(kind);
  return s;
}

/** The black King, all the way to the question it ends on. */
function awaitingSwapConfirm(): GameState {
  let s = firePower("KS");
  expect(s.pendingPower?.kind).toBe("LOOK_AND_SWAP");
  s = applyAction(s, { type: "PowerTarget", playerId: A, target: at(A, 0) }).state;
  s = applyAction(s, { type: "PowerTarget", playerId: A, target: at(B, 0) }).state;
  expect(s.phase).toBe("POWER_AWAIT_SWAP_CONFIRM");
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

  it("offers nothing once the King is only waiting for an answer", () => {
    const s = awaitingSwapConfirm();
    // Every slot, both halves, both seat shapes: the phase collects no targets,
    // and offering one is what invited a free reveal per tap (docs/06 §6).
    for (const owner of [A, B]) {
      for (let i = 0; i < 4; i++) {
        expect(targetableBy(view(s, A), [A], at(owner, i))).toBeNull();
        expect(targetableBy(view(s, A), [A, B], at(owner, i))).toBeNull();
      }
    }
    // The seat is still the one that may act — the answer is still A's to give.
    expect(actingSeat(view(s, A), [A])).toBe(A);
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

describe("targetableBy — the opening peek", () => {
  /** A dealt round stopped at the barrier, before either player has answered. */
  function atBarrier(): GameState {
    const s = round(CALM);
    // `round` walks past the barrier, so rewind to it: same deal, nobody peeked.
    return {
      ...s,
      phase: "INITIAL_PEEK",
      players: s.players.map((p) => ({
        ...p,
        hasPeeked: false,
        layout: p.layout.map((slot) => ({ ...slot, knownBy: [] })),
      })),
    };
  }

  it("offers exactly the slots the peek will grant, in this player's own half", () => {
    const s = atBarrier();
    const granted = nearestSlots(standard);
    expect(granted).toEqual([0, 1]);

    for (const i of granted) expect(targetableBy(view(s, A), [A], at(A, i))).toBe(A);
    for (const i of [2, 3]) expect(targetableBy(view(s, A), [A], at(A, i))).toBeNull();
    // Never the opponent's, whichever seats this device holds.
    for (let i = 0; i < 4; i++) expect(targetableBy(view(s, A), [A], at(B, i))).toBeNull();
  });

  it("belongs to both players at once, not to whoever's turn it is", () => {
    const s = atBarrier();
    // `actingSeat` names one seat, because the phase carries a `currentPlayer`.
    // The peek is simultaneous, so it cannot be the gate here (docs/05 §4).
    expect(actingSeat(view(s, B), [B])).toBeNull();
    expect(targetableBy(view(s, B), [B], at(B, 0))).toBe(B);
    // And at a shared table, both halves at the same time.
    expect(targetableBy(view(s, A), [A, B], at(A, 0))).toBe(A);
    expect(targetableBy(view(s, A), [A, B], at(B, 0))).toBe(B);
  });

  it("stops offering anything once this player has peeked", () => {
    const peeked = applyAction(atBarrier(), {
      type: "PeekInitial",
      playerId: A,
      slots: [0, 1],
    }).state;
    for (let i = 0; i < 4; i++) {
      expect(targetableBy(view(peeked, A), [A], at(A, i))).toBeNull();
    }
    // B has not, and still may.
    expect(targetableBy(view(peeked, B), [B], at(B, 1))).toBe(B);
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
