// Cards, values and power lookup — see docs/05 §2, docs/06 §1, docs/08 §1.

import type { Card, CardId, CardTable, PowerKind, Rank, RuleConfig, Suit } from "./types";

const SUITS: readonly Suit[] = ["H", "D", "C", "S"];
const RANKS: readonly Rank[] = [
  "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
];

export const isRed = (c: Card): boolean => c.suit === "H" || c.suit === "D";
export const isBlack = (c: Card): boolean => c.suit === "C" || c.suit === "S";

/**
 * Card ids must be unique even across two decks: with `deckCount: 2` there are
 * two ♠K, and the event log, replay and card-conservation invariant all break if
 * they cannot be told apart (docs/03 §1).
 */
export function buildDeck(cfg: RuleConfig): Card[] {
  const cards: Card[] = [];
  for (let d = 1; d <= cfg.deck.deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ id: `d${d}-${rank}${suit}`, rank, suit });
      }
    }
    if (cfg.deck.useJokers) {
      cards.push({ id: `d${d}-JOKER1`, rank: "JOKER", suit: "N" });
      cards.push({ id: `d${d}-JOKER2`, rank: "JOKER", suit: "N" });
    }
  }
  return cards;
}

export function cardTable(cards: readonly Card[]): CardTable {
  const table: Record<CardId, Card> = {};
  for (const c of cards) table[c.id] = c;
  return table;
}

export function totalDeckSize(cfg: RuleConfig): number {
  return cfg.deck.deckCount * (52 + (cfg.deck.useJokers ? 2 : 0));
}

/** The red/black King split is the only place suit affects value. */
export function cardValue(cfg: RuleConfig, card: Card): number {
  switch (card.rank) {
    case "JOKER":
      return cfg.values.joker;
    case "K":
      return isRed(card) ? cfg.values.redKing : cfg.values.blackKing;
    case "Q":
      return cfg.values.queen;
    case "J":
      return cfg.values.jack;
    case "A":
      return cfg.values.ace;
    default:
      return Number(card.rank);
  }
}

/**
 * Colour-qualified keys win over bare rank keys, so a ruleset where all Kings
 * behave alike and one where they differ both express cleanly (docs/06 §1).
 */
export function powerFor(cfg: RuleConfig, card: Card): PowerKind {
  if (card.rank === "K") {
    const key = isRed(card) ? "K:red" : "K:black";
    const qualified = cfg.powers.map[key];
    if (qualified !== undefined) return qualified;
  }
  if (card.rank === "A" && !cfg.powers.aceGiveEnabled) return "NONE";
  return cfg.powers.map[card.rank] ?? "NONE";
}

export function ranksMatch(cfg: RuleConfig, a: Card, b: Card): boolean {
  if (cfg.snap.matchOn === "RANK_AND_SUIT") return a.rank === b.rank && a.suit === b.suit;
  return a.rank === b.rank;
}

// Display helpers (pure data, no DOM).
export const SUIT_SYMBOL: Readonly<Record<Suit, string>> = {
  H: "♥",
  D: "♦",
  C: "♣",
  S: "♠",
  N: "★",
};

export function rankLabel(rank: Rank): string {
  return rank === "JOKER" ? "JK" : rank;
}
