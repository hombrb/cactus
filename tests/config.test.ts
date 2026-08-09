// The rules a player is allowed to assemble.
//
// Configs used to come only from `presets`, so `validateConfig` was never
// called and `powers.map` was never built from input. Both are now reachable
// from a settings screen and from a POST body, which is what these cover.

import { describe, expect, it } from "vitest";
import {
  POWER_RANK_KEYS,
  SELECTABLE_POWERS,
  parsePowerMap,
  presets,
  school,
  standard,
  table2p,
  validateConfig,
  withPowerMap,
} from "../src/engine/config";
import { powerFor } from "../src/engine/cards";
import { configForRoom, defaultRoomSettings, parseRoomSettings } from "../src/net/room-config";
import type { RuleConfig } from "../src/engine/types";

describe("validateConfig", () => {
  for (const [name, cfg] of Object.entries(presets)) {
    it(`accepts the ${name} preset`, () => {
      expect(validateConfig(cfg)).toEqual([]);
    });
  }

  it("rejects a map keyed on something that is not a rank", () => {
    const bad: RuleConfig = {
      ...standard,
      powers: { ...standard.powers, map: { "7": "PEEK_OWN", banana: "PEEK_OWN" } },
    };
    expect(validateConfig(bad)).toEqual(["powers.map has an unknown rank key: banana"]);
  });

  it("still refuses GIVE_CARD without aceGiveEnabled", () => {
    const bad: RuleConfig = {
      ...standard,
      powers: { ...standard.powers, map: { A: "GIVE_CARD" } },
    };
    expect(validateConfig(bad)).toContain("GIVE_CARD is mapped but aceGiveEnabled is false");
  });
});

describe("parsePowerMap", () => {
  it("keeps every rank key the engine knows", () => {
    const all = Object.fromEntries(POWER_RANK_KEYS.map((k) => [k, "PEEK_OWN"]));
    // Compared as a set: JS floats integer-like keys ("2".."10") ahead of the
    // rest, and the map is only ever read by lookup.
    expect(new Set(Object.keys(parsePowerMap(all) ?? {}))).toEqual(new Set(POWER_RANK_KEYS));
  });

  it("drops unknown ranks and unknown powers rather than throwing", () => {
    expect(parsePowerMap({ "7": "PEEK_OWN", "15": "PEEK_OWN", J: "TELEPORT" })).toEqual({
      "7": "PEEK_OWN",
    });
  });

  it("refuses GIVE_CARD, which is not a selectable power", () => {
    expect(SELECTABLE_POWERS).not.toContain("GIVE_CARD");
    expect(parsePowerMap({ A: "GIVE_CARD" })).toBeNull();
  });

  it("returns null for anything unusable, meaning 'keep the preset'", () => {
    for (const raw of [null, undefined, 42, "J", [], {}, { "99": "PEEK_OWN" }]) {
      expect(parsePowerMap(raw)).toBeNull();
    }
  });
});

describe("withPowerMap", () => {
  it("leaves the config alone when nothing was chosen", () => {
    expect(withPowerMap(standard, null)).toBe(standard);
  });

  it("replaces the map wholesale rather than merging into the preset", () => {
    const cfg = withPowerMap(standard, { "7": "PEEK_OWN", J: "PEEK_OPPONENT" });
    expect(cfg.powers.map).toEqual({ "7": "PEEK_OWN", J: "PEEK_OPPONENT" });
    // The 8 had a power in `standard`; an absent rank means NONE (docs/02).
    expect(powerFor(cfg, { id: "x", rank: "8", suit: "H" })).toBe("NONE");
    expect(powerFor(cfg, { id: "y", rank: "J", suit: "S" })).toBe("PEEK_OPPONENT");
  });
});

describe("room settings", () => {
  it("round-trips a custom power map through the wire", () => {
    const parsed = parseRoomSettings({
      preset: "standard",
      snap: true,
      scoreLimit: 100,
      powers: { "7": "PEEK_OWN", J: "PEEK_OPPONENT" },
      seedDiscard: false,
      takeFromDiscard: false,
    });
    const cfg = configForRoom(parsed);

    expect(cfg.powers.map).toEqual({ "7": "PEEK_OWN", J: "PEEK_OPPONENT" });
    expect(cfg.deck.seedDiscard).toBe(false);
    expect(cfg.turn.takeFromDiscard).toBe(false);
    expect(validateConfig(cfg)).toEqual([]);
  });

  it("falls back to the preset's rules for a body that says nothing", () => {
    const cfg = configForRoom(parseRoomSettings({}));
    expect(cfg.powers.map).toEqual(standard.powers.map);
    expect(cfg.deck.seedDiscard).toBe(true);
    expect(cfg.turn.takeFromDiscard).toBe(true);
    expect(cfg.announce.timing).toBe("AFTER_TURN");
  });

  it("carries the host's choice of when Cactus may be said", () => {
    // The guest is playing the host's rules, and this one changes when a turn
    // ends as well as when the announcement closes (docs/01 §7).
    expect(configForRoom(parseRoomSettings({ announceAfterTurn: false })).announce.timing).toBe(
      "END_OF_TURN",
    );
    expect(configForRoom(parseRoomSettings({ announceAfterTurn: true })).announce.timing).toBe(
      "AFTER_TURN",
    );
  });

  it("cannot be talked into a rule the game does not have", () => {
    const cfg = configForRoom(
      parseRoomSettings({ powers: { K: "GIVE_CARD", "7": "PEEK_OWN", zzz: "PEEK_OWN" } }),
    );
    expect(cfg.powers.map).toEqual({ "7": "PEEK_OWN" });
    expect(cfg.powers.aceGiveEnabled).toBe(false);
    expect(validateConfig(cfg)).toEqual([]);
  });

  it("keeps the room's timings, unlike the flat table", () => {
    expect(configForRoom(defaultRoomSettings).timing.turnTimeoutMs).toBe(
      standard.timing.turnTimeoutMs,
    );
    expect(table2p.timing.turnTimeoutMs).toBeNull();
    expect(configForRoom({ ...defaultRoomSettings, preset: "school" }).match).toEqual(school.match);
  });
});
