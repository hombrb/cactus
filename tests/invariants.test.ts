// Plays seeded random games to exhaustion and asserts the invariants of
// docs/11 §2 after every single reduction.

import { describe, expect, it } from "vitest";
import { school, standard, table2p } from "../src/engine/config";
import { checkInvariants } from "../src/engine/invariants";
import { projectFor, HIDDEN } from "../src/engine/project";
import { applyAction } from "../src/engine/reduce";
import { prf } from "../src/engine/rng";
import { currentPlayerId } from "../src/engine/state";
import { createMatch } from "../src/engine/turn";
import { nearestSlots } from "../src/engine/turn";
import type { Action, GameState, RuleConfig, SlotRef } from "../src/engine/types";

function candidates(s: GameState): Action[] {
  const me = currentPlayerId(s);
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
      out.push({ type: "TakeDiscard", playerId: me });
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
      out.push({ type: "PowerConfirmSwap", playerId: me, swap: true });
      out.push({ type: "PowerConfirmSwap", playerId: me, swap: false });
      break;
    case "POWER_AWAIT_OWN_SLOT":
    case "POWER_AWAIT_OPPONENT_SLOT":
    case "POWER_AWAIT_TWO_SLOTS":
    case "POWER_AWAIT_GIVE_TARGET":
      out.push({ type: "PowerSkip", playerId: me });
      // Deliberately includes illegal targets so the misuse path gets exercised.
      for (const target of everySlot()) out.push({ type: "PowerTarget", playerId: me, target });
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

function playGame(cfg: RuleConfig, seed: string, playerCount: number): GameState {
  let s = createMatch({
    config: cfg,
    players: Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
    seed,
  });

  let cursor = 0;
  for (let step = 0; step < 4000; step++) {
    if (s.phase === "MATCH_END") break;

    const options = candidates(s);
    if (options.length === 0) break;

    const pick = options[prf(seed, cursor++) % options.length]!;
    const before = {
      version: s.discardVersion,
      cursor: s.rngCursor,
      counter: s.actionCounter,
      round: s.roundNumber,
    };
    const result = applyAction(s, pick);

    const problems = checkInvariants(result.state);
    expect(problems, `after ${pick.type} (${cfg.match.roundLimit ? "school" : "std"}/${seed})`)
      .toEqual([]);

    // discardVersion is monotonic *within* a round; each deal restarts it at 1.
    if (result.state.roundNumber === before.round) {
      expect(result.state.discardVersion).toBeGreaterThanOrEqual(before.version);
    } else {
      expect(result.state.discardVersion).toBe(1);
    }
    expect(result.state.rngCursor).toBeGreaterThanOrEqual(before.cursor);
    expect(result.state.actionCounter).toBeGreaterThanOrEqual(before.counter);

    s = result.state;
  }
  return s;
}

describe("invariant sweep over seeded random games", () => {
  const configs: [string, RuleConfig, number][] = [
    ["standard 3p", standard, 3],
    ["standard 4p", standard, 4],
    ["school 2p", school, 2],
    ["table2p", table2p, 2],
  ];

  for (const [label, cfg, players] of configs) {
    it(`holds every invariant — ${label}`, () => {
      for (let i = 0; i < 40; i++) {
        const final = playGame(cfg, `sweep-${label}-${i}`, players);
        expect(["MATCH_END", "ROUND_END", "REVEAL"]).toContain(final.phase);
      }
    });
  }

  it("never projects a card the viewer is not entitled to", () => {
    let s = createMatch({
      config: standard,
      players: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
      seed: "leak-check",
    });

    let cursor = 0;
    for (let step = 0; step < 400 && s.phase !== "MATCH_END"; step++) {
      const options = candidates(s);
      if (options.length === 0) break;
      s = applyAction(s, options[prf("leak", cursor++) % options.length]!).state;

      if (s.phase === "REVEAL" || s.phase === "ROUND_END" || s.phase === "MATCH_END") break;

      for (const viewer of ["a", "b", "c"]) {
        const view = projectFor(s, viewer);
        const entitled = new Set<string>(s.discard);
        for (const p of s.players) {
          for (const slot of p.layout) {
            if (slot.cardId !== null && slot.knownBy.includes(viewer)) entitled.add(slot.cardId);
          }
        }
        if (s.heldCard !== null && currentPlayerId(s) === viewer) entitled.add(s.heldCard);

        for (const id of Object.keys(view.cards)) {
          expect(entitled.has(id), `${viewer} was shown ${id}`).toBe(true);
        }
        for (const p of view.players) {
          for (const visible of p.layout) {
            if (visible !== null && visible !== HIDDEN) {
              expect(entitled.has(visible), `${viewer} sees ${visible} in a layout`).toBe(true);
            }
          }
        }
      }
    }
  });
});
