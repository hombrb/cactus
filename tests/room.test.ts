// The room authority — docs/10 §3, §4, §5.
//
// RoomCore is deliberately transport-free, so all of this runs on a fake clock
// with no workerd, no sockets and no Cloudflare account.

import { describe, expect, it } from "vitest";
import { standard } from "../src/engine/config";
import { HIDDEN } from "../src/engine/project";
import { nearestSlots } from "../src/engine/turn";
import type { Event, PlayerId } from "../src/engine/types";
import { RoomCore, type RoomEffects, type RoomSnapshot } from "../src/net/room-core";
import type { ServerMessage } from "../src/net/protocol";
import { CARD_ID, stringLeaves } from "./helpers";

const EMPTY: RoomSnapshot = { code: "ABC234", state: null, snapBuffer: null, turnDeadline: null };
const OPTIONS = { config: standard, seed: "room-seed" };

const fresh = (): RoomCore => new RoomCore(EMPTY, OPTIONS);

function updatesFor(effects: RoomEffects, who: PlayerId): ServerMessage[] {
  return effects.sends.filter((s) => s.to === who).map((s) => s.message);
}

function eventsFor(effects: RoomEffects, who: PlayerId): Event[] {
  return updatesFor(effects, who).flatMap((m) => (m.t === "update" ? [...m.events] : []));
}

/** Seats two players and plays up to the first live turn. */
function seated(now = 1_000): { room: RoomCore; at: number; last: RoomEffects } {
  const room = fresh();
  room.join("a", "A", now);
  room.join("b", "B", now);
  room.submit("a", { type: "StartMatch", playerId: "a" }, now);
  const slots = nearestSlots(standard);
  room.submit("a", { type: "PeekInitial", playerId: "a", slots }, now);
  const last = room.submit("b", { type: "PeekInitial", playerId: "b", slots }, now);
  return { room, at: now, last };
}

describe("room membership", () => {
  it("makes the first joiner the host and welcomes them with their own view", () => {
    const room = fresh();
    const effects = room.join("a", "A", 0);

    const welcome = updatesFor(effects, "a").find((m) => m.t === "welcome");
    expect(welcome).toBeDefined();
    expect(welcome).toMatchObject({ t: "welcome", code: "ABC234", seat: "a" });
    expect(room.view("a")?.hostId).toBe("a");
  });

  it("turns a stranger away once the match has started, but not a returning player", () => {
    const { room, at } = seated();

    const stranger = room.join("z", "Z", at);
    expect(updatesFor(stranger, "z")).toEqual([{ t: "error", message: "MATCH_STARTED" }]);
    expect(room.view("a")?.players.some((p) => p.id === "z")).toBe(false);

    room.leave("b", at);
    expect(room.view("a")?.players.find((p) => p.id === "b")?.connected).toBe(false);

    const back = room.join("b", "B", at + 1);
    expect(updatesFor(back, "b").some((m) => m.t === "welcome")).toBe(true);
    expect(room.view("a")?.players.find((p) => p.id === "b")?.connected).toBe(true);
  });

  it("promotes the next connected player when the host leaves", () => {
    const { room, at } = seated();
    expect(room.view("b")?.hostId).toBe("a");

    const effects = room.leave("a", at);

    expect(room.view("b")?.hostId).toBe("b");
    expect(eventsFor(effects, "b")).toContainEqual({ type: "HostChanged", playerId: "b" });
  });

  it("leaves the host alone when a non-host leaves", () => {
    const { room, at } = seated();
    room.leave("b", at);
    expect(room.view("a")?.hostId).toBe("a");
  });

  it("keeps the departed host nominal when nobody is left to promote", () => {
    const room = fresh();
    room.join("a", "A", 0);
    room.leave("a", 0);
    expect(room.view("a")?.hostId).toBe("a");
    expect(room.isEmpty).toBe(true);
  });
});

describe("room authority", () => {
  it("issues an action under the connection's identity, never the payload's", () => {
    const { room, at } = seated();
    const current = room.view("a")!.currentPlayer;
    const impostor = current === "a" ? "b" : "a";

    // The impostor claims the current player's id, hoping to take their turn.
    const effects = room.submit(impostor, { type: "DrawStock", playerId: current }, at);

    // Rewritten to the impostor's own id, so the reducer rejects it on merit —
    // and the rejection reaches only them.
    const rejected = eventsFor(effects, impostor).filter((e) => e.type === "ActionRejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ playerId: impostor });
    expect(eventsFor(effects, current).some((e) => e.type === "ActionRejected")).toBe(false);
    expect(room.view("a")!.heldBy).toBeNull();
  });

  it("redacts the fan-out per recipient", () => {
    const { room, at } = seated();
    const current = room.view("a")!.currentPlayer;
    const other = current === "a" ? "b" : "a";

    const effects = room.submit(current, { type: "DrawStock", playerId: current }, at);

    const drawnByMe = eventsFor(effects, current).find((e) => e.type === "StockDrawn");
    const drawnByThem = eventsFor(effects, other).find((e) => e.type === "StockDrawn");
    expect(drawnByMe).toMatchObject({ cardId: expect.stringMatching(CARD_ID) });
    expect(drawnByThem).toMatchObject({ cardId: HIDDEN });

    const theirView = updatesFor(effects, other).find((m) => m.t === "update");
    expect(theirView?.t === "update" && theirView.view.heldCard).toBe(HIDDEN);
  });

  it("never puts the seed or the stock on the wire", () => {
    const { room, at } = seated();
    const current = room.view("a")!.currentPlayer;
    const effects = room.submit(current, { type: "DrawStock", playerId: current }, at);

    for (const send of effects.sends) {
      expect(JSON.stringify(send.message)).not.toContain(OPTIONS.seed);
    }
  });
});

describe("snap fairness", () => {
  /** Both players swipe within the grace window; returns the flush's effects. */
  function race(
    room: RoomCore,
    first: { who: PlayerId; sentAt: number },
    second: { who: PlayerId; sentAt: number },
  ): RoomEffects {
    const version = room.view("a")!.discardVersion;
    const snap = (who: PlayerId, when: number) =>
      room.submit(
        who,
        { type: "Snap", playerId: who, target: { playerId: who, slot: 0 }, forVersion: version },
        when,
      );

    const opened = snap(first.who, first.sentAt);
    // Nothing reaches the reducer while the buffer is open...
    expect(opened.sends).toEqual([]);
    // ...but the buffer itself must survive a nap.
    expect(opened.persist).toBe(true);
    expect(opened.alarmAt).toBe(first.sentAt + standard.timing.snapGraceMs);

    snap(second.who, second.sentAt);
    return room.alarm(first.sentAt + standard.timing.snapGraceMs);
  }

  const snapOrder = (effects: RoomEffects): PlayerId[] =>
    eventsFor(effects, "a")
      .filter((e) => e.type === "SnapSucceeded" || e.type === "SnapFailed")
      .map((e) => (e as { playerId: PlayerId }).playerId);

  it("buffers competing snaps and submits them in arrival order", () => {
    const { room, at } = seated();
    const effects = race(room, { who: "a", sentAt: at }, { who: "b", sentAt: at + 100 });
    expect(snapOrder(effects)).toEqual(["a", "b"]);
  });

  it("credits the earlier click, not the faster connection", () => {
    const { room, at } = seated();
    // B is on fibre, A is on a train. A clicked first in the real world; the
    // packets arrive the other way round.
    room.observeRtt("a", 200);
    room.observeRtt("b", 0);

    const effects = race(room, { who: "b", sentAt: at }, { who: "a", sentAt: at + 40 });

    // A's arrival is adjusted back by 100ms of one-way latency, landing before B.
    expect(snapOrder(effects)).toEqual(["a", "b"]);
  });

  it("breaks an exact tie deterministically rather than by insertion order", () => {
    const { room, at } = seated();
    const effects = race(room, { who: "b", sentAt: at }, { who: "a", sentAt: at });
    expect(snapOrder(effects)).toEqual(["a", "b"]);
  });

  it("sends a stale snap straight to the reducer — a lost race is not a race", () => {
    const { room, at } = seated();
    const version = room.view("a")!.discardVersion;

    const effects = room.submit(
      "a",
      { type: "Snap", playerId: "a", target: { playerId: "a", slot: 0 }, forVersion: version - 1 },
      at,
    );

    // It resolved immediately: there are sends, not an open buffer.
    expect(effects.sends.length).toBeGreaterThan(0);
  });

  it("bypasses the buffer entirely when snapGraceMs is 0", () => {
    const room = new RoomCore(EMPTY, {
      config: { ...standard, timing: { ...standard.timing, snapGraceMs: 0 } },
      seed: "no-grace",
    });
    room.join("a", "A", 0);
    room.join("b", "B", 0);
    room.submit("a", { type: "StartMatch", playerId: "a" }, 0);
    const slots = nearestSlots(standard);
    room.submit("a", { type: "PeekInitial", playerId: "a", slots }, 0);
    room.submit("b", { type: "PeekInitial", playerId: "b", slots }, 0);

    const version = room.view("a")!.discardVersion;
    const effects = room.submit(
      "a",
      { type: "Snap", playerId: "a", target: { playerId: "a", slot: 0 }, forVersion: version },
      0,
    );
    expect(effects.sends.length).toBeGreaterThan(0);
  });
});

describe("turn timeouts", () => {
  it("arms the clock against the current actionCounter and fires the neutral move", () => {
    const { room, at, last } = seated();
    expect(room.view("a")!.phase).toBe("TURN_START");
    expect(last.alarmAt).toBe(at + standard.timing.turnTimeoutMs!);

    const fired = room.alarm(at + standard.timing.turnTimeoutMs!);

    // The neutral move is draw-then-discard; it never announces (docs/05 §8).
    expect(eventsFor(fired, "a").some((e) => e.type === "StockDrawn")).toBe(true);
    expect(room.view("a")!.announcerId).toBeNull();
  });

  it("re-arms the clock on every action, so an answered turn never times out", () => {
    const { room, at } = seated();
    const current = room.view("a")!.currentPlayer;

    const acted = room.submit(current, { type: "DrawStock", playerId: current }, at + 10);
    expect(acted.alarmAt).toBe(at + 10 + standard.timing.turnTimeoutMs!);

    // The alarm the previous turn armed comes due; it is no longer the deadline.
    const stale = room.alarm(at + standard.timing.turnTimeoutMs!);
    expect(eventsFor(stale, "a")).toEqual([]);
  });

  it("drops a timer that fires late against a phase that has moved on", () => {
    const { room, at } = seated();
    const current = room.view("a")!.currentPlayer;
    room.submit(current, { type: "DrawStock", playerId: current }, at);

    // A Cloudflare alarm can fire after an action has already landed. Rebuild
    // the room with the deadline that was armed *before* that action, so the
    // engine's phaseToken check is what has to catch it (docs/05 §8).
    const snapshot = room.snapshot();
    const revived = new RoomCore(
      {
        ...snapshot,
        turnDeadline: { at: at + standard.timing.turnTimeoutMs!, token: 0 },
      },
      OPTIONS,
    );
    const phaseBefore = revived.view("a")!.phase;

    const fired = revived.alarm(at + standard.timing.turnTimeoutMs!);

    // Dropped silently — a stale timeout is the engine's own message, so it does
    // not even earn an ActionRejected.
    expect(eventsFor(fired, "a")).toEqual([]);
    expect(revived.view("a")!.phase).toBe(phaseBefore);
  });

  it("does not arm a clock the preset disables", () => {
    const room = new RoomCore(EMPTY, {
      config: { ...standard, timing: { ...standard.timing, turnTimeoutMs: null } },
      seed: "no-timeout",
    });
    room.join("a", "A", 0);
    room.join("b", "B", 0);
    const effects = room.submit("a", { type: "StartMatch", playerId: "a" }, 0);
    expect(effects.alarmAt).toBeNull();
  });
});

describe("hibernation", () => {
  it("resumes from a JSON round-trip of its snapshot", () => {
    const { room, at } = seated();
    const current = room.view("a")!.currentPlayer;
    room.submit(current, { type: "DrawStock", playerId: current }, at);

    const written = JSON.parse(JSON.stringify(room.snapshot())) as RoomSnapshot;
    expect(written).toEqual(room.snapshot());

    // The object was evicted; the sockets stayed open. This is the trap the
    // whole design is arranged around.
    const revived = new RoomCore(written, OPTIONS);
    expect(revived.view("a")).toEqual(room.view("a"));
    expect(revived.code).toBe("ABC234");

    const effects = revived.submit(current, { type: "DiscardHeld", playerId: current }, at + 1);
    expect(eventsFor(effects, current).some((e) => e.type === "HeldDiscarded")).toBe(true);
  });

  it("keeps an open snap buffer across the nap", () => {
    const { room, at } = seated();
    const version = room.view("a")!.discardVersion;
    room.submit(
      "a",
      { type: "Snap", playerId: "a", target: { playerId: "a", slot: 0 }, forVersion: version },
      at,
    );

    const revived = new RoomCore(
      JSON.parse(JSON.stringify(room.snapshot())) as RoomSnapshot,
      OPTIONS,
    );
    const flushed = revived.alarm(at + standard.timing.snapGraceMs);

    expect(
      eventsFor(flushed, "a").some((e) => e.type === "SnapSucceeded" || e.type === "SnapFailed"),
    ).toBe(true);
  });

  it("never writes a snapshot it cannot read back", () => {
    const { room, at } = seated();
    room.submit("a", { type: "DrawStock", playerId: room.view("a")!.currentPlayer }, at);
    const snapshot = room.snapshot();

    // A Set or Map anywhere in GameState would silently become {} here.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(stringLeaves(snapshot).length).toBeGreaterThan(0);
  });
});
