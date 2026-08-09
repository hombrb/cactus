// Rule presets — see docs/02-rule-config.md
// No rule constant may appear as a literal anywhere else in the engine.

import type { PowerKind, PowerMap, RankKey, RuleConfig } from "./types";

export const standard: RuleConfig = {
  deck: {
    deckCount: 1,
    autoTwoDecksAbove: 4,
    useJokers: false,
    handSize: 4,
    initialPeekCount: 2,
    initialPeekFree: false,
    reshuffleDiscard: true,
    seedDiscard: true,
  },
  values: {
    joker: -1,
    redKing: 0,
    blackKing: 13,
    queen: 12,
    jack: 11,
    ace: 1,
  },
  powers: {
    map: {
      "7": "PEEK_OWN",
      "8": "PEEK_OWN",
      "9": "PEEK_OPPONENT",
      "10": "PEEK_OPPONENT",
      J: "BLIND_SWAP",
      Q: "BLIND_SWAP",
      "K:black": "LOOK_AND_SWAP",
      "K:red": "NONE",
      A: "NONE",
    },
    aceGiveEnabled: false,
    misusePenaltyCards: 1,
  },
  turn: {
    takeFromDiscard: true,
  },
  snap: {
    enabled: true,
    failurePenaltyCards: 1,
    allowOnOpponent: false,
    emptyLayoutEndsRound: true,
    allowedDuringFinalLap: true,
    loserPenalty: "NONE",
    matchOn: "RANK",
  },
  announce: {
    timing: "END_OF_TURN",
    requiresThreshold: null,
  },
  scoring: {
    announcerSuccessScore: "ZERO",
    announcerFailurePenalty: { kind: "DOUBLE" },
    tieCountsAsFailure: true,
    othersScoreOnAnnouncerFailure: "OWN_SUM",
    royalBonus: false,
    kamikaze: { enabled: false, penalty: 50 },
  },
  match: {
    scoreLimit: 100,
    roundLimit: null,
    limitEliminates: false,
  },
  timing: {
    turnTimeoutMs: 45000,
    endOfTurnWindowMs: 3000,
    snapGraceMs: 250,
    peekRevealMs: 4000,
    initialPeekMs: 10000,
  },
};

/** The French schoolyard version: flat values, only the 8 has a power. */
export const school: RuleConfig = {
  ...standard,
  values: { ...standard.values, redKing: 0, blackKing: 0, queen: 10, jack: 10 },
  powers: { map: { "8": "PEEK_OWN" }, aceGiveEnabled: false, misusePenaltyCards: 1 },
  announce: { ...standard.announce, requiresThreshold: 5 },
  scoring: { ...standard.scoring, tieCountsAsFailure: false },
  match: { scoreLimit: null, roundLimit: 5, limitEliminates: false },
};

/**
 * Two players around one phone lying flat on the table.
 *
 * This replaces the spec's original `hotseat` preset. That one disabled snap,
 * on the reasoning that a shared screen makes the race unfair — true when the
 * phone is passed from hand to hand, but not when it sits between two players
 * who can both reach it. See docs/10 §6.
 */
export const table2p: RuleConfig = {
  ...standard,
  timing: {
    ...standard.timing,
    turnTimeoutMs: null,
    endOfTurnWindowMs: null,
    initialPeekMs: null,
  },
};

export const presets = { standard, school, table2p } as const;
export type PresetName = keyof typeof presets;

/** Applies the shared table-mode timing to any base preset. */
export function forTable(base: RuleConfig, snapEnabled: boolean): RuleConfig {
  return {
    ...base,
    snap: { ...base.snap, enabled: snapEnabled },
    timing: table2p.timing,
  };
}

// ---------------------------------------------------------------------------
// The power map as a *choosable* thing.
//
// `powers.map` has always been free-form data, but nothing could be trusted to
// build one: a client that could post an arbitrary map could invent a rule. So
// both the rank keys and the power kinds are allow-listed here, once, and both
// `src/ui/settings.ts` and `src/net/room-config.ts` go through `parsePowerMap`.
// The client therefore sends a rank and a power, never a `RuleConfig`.
// ---------------------------------------------------------------------------

/** Every rank a power may be attached to, in display order. */
export const POWER_RANK_KEYS: readonly RankKey[] = [
  "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K:red", "K:black",
];

/**
 * The powers a player may assign.
 *
 * `GIVE_CARD` is deliberately absent: it is implemented but has never been
 * exercised in a real game (HANDOVER §2), and a settings screen is not the
 * place to ship untested rules. `powers.aceGiveEnabled` still gates it for any
 * config built in code.
 */
export const SELECTABLE_POWERS: readonly PowerKind[] = [
  "NONE", "PEEK_OWN", "PEEK_OPPONENT", "BLIND_SWAP", "LOOK_AND_SWAP",
];

/**
 * Never throws. Unknown ranks and unknown powers are dropped rather than
 * rejected, so an old client, a hand-edited localStorage or a hostile POST body
 * degrades to fewer powers instead of to an error.
 *
 * Returns `null` when there is nothing usable — which every caller reads as
 * "keep the preset's own map".
 */
export function parsePowerMap(raw: unknown): PowerMap | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<RankKey, PowerKind> = {};
  let seen = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!POWER_RANK_KEYS.includes(key)) continue;
    if (typeof value !== "string") continue;
    if (!SELECTABLE_POWERS.includes(value as PowerKind)) continue;
    out[key] = value as PowerKind;
    seen = true;
  }
  return seen ? out : null;
}

/** Applies a chosen power map, or leaves the config's own map alone. */
export function withPowerMap(cfg: RuleConfig, map: PowerMap | null): RuleConfig {
  if (map === null) return cfg;
  return { ...cfg, powers: { ...cfg.powers, map } };
}

export function validateConfig(cfg: RuleConfig): string[] {
  const errors: string[] = [];
  if (cfg.deck.handSize < 2) errors.push("handSize must be >= 2");
  if (cfg.deck.initialPeekCount > cfg.deck.handSize)
    errors.push("initialPeekCount cannot exceed handSize");
  if (cfg.match.scoreLimit === null && cfg.match.roundLimit === null)
    errors.push("a match needs a scoreLimit or a roundLimit, else it never ends");
  if (cfg.snap.failurePenaltyCards < 0) errors.push("failurePenaltyCards must be >= 0");
  const hasGive = Object.values(cfg.powers.map).includes("GIVE_CARD");
  if (hasGive && !cfg.powers.aceGiveEnabled)
    errors.push("GIVE_CARD is mapped but aceGiveEnabled is false");
  for (const key of Object.keys(cfg.powers.map))
    if (!POWER_RANK_KEYS.includes(key)) errors.push(`powers.map has an unknown rank key: ${key}`);
  return errors;
}
