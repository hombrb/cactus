// Rule presets — see docs/02-rule-config.md
// No rule constant may appear as a literal anywhere else in the engine.

import type { RuleConfig } from "./types";

export const standard: RuleConfig = {
  deck: {
    deckCount: 1,
    autoTwoDecksAbove: 4,
    useJokers: false,
    handSize: 4,
    initialPeekCount: 2,
    initialPeekFree: false,
    reshuffleDiscard: true,
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
  return errors;
}
