// French descriptions of a RuleConfig.
//
// The Règles screen used to hand-write its power list and branch on the preset
// name, which duplicated `powers.map` in prose. That was fine while there were
// exactly two presets; it becomes a lie the moment powers are choosable. These
// functions derive the text from the config instead, so the screen cannot drift
// from the rules the engine is actually applying.
//
// Pure and DOM-free on purpose: they are also what the lobby uses to tell a
// guest what they are about to play.

import { POWER_RANK_KEYS } from "../engine/config";
import type { PowerKind, RankKey, RuleConfig } from "../engine/types";

/** Long label, for prose: "Roi noir", "Valet", "7". */
export function rankLabel(key: RankKey): string {
  switch (key) {
    case "A":
      return "As";
    case "J":
      return "Valet";
    case "Q":
      return "Dame";
    case "K:red":
      return "Roi rouge";
    case "K:black":
      return "Roi noir";
    case "K":
      return "Roi";
    case "JOKER":
      return "Joker";
    default:
      return key;
  }
}

/** Short label for the editor's rows, where width is scarce. */
export const POWER_LABELS: Readonly<Record<PowerKind, string>> = {
  NONE: "Aucun",
  PEEK_OWN: "Tes cartes",
  PEEK_OPPONENT: "Carte adverse",
  BLIND_SWAP: "Échange aveugle",
  LOOK_AND_SWAP: "Voir puis échanger",
  GIVE_CARD: "Donner la carte",
};

/** Full sentence for the Règles screen. */
export const POWER_EFFECTS: Readonly<Record<PowerKind, string>> = {
  NONE: "aucun pouvoir.",
  PEEK_OWN: "regarde une de tes cartes.",
  PEEK_OPPONENT: "regarde une carte de l'adversaire.",
  BLIND_SWAP: "échange à l'aveugle une de tes cartes contre une des siennes.",
  LOOK_AND_SWAP: "regarde une carte de chaque, puis décide d'échanger ou non.",
  GIVE_CARD: "donne la carte piochée au joueur de ton choix.",
};

export interface PowerLine {
  readonly kind: PowerKind;
  /** "7 ou 8", "Valet", "9, 10 ou Valet". */
  readonly ranks: string;
  readonly effect: string;
}

/** Joins with commas and a final "ou", the way a French list reads. */
function joinOr(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} ou ${parts[parts.length - 1]}`;
}

/**
 * Groups the ranks that share a power, in `POWER_RANK_KEYS` order, skipping
 * NONE. An empty array means no card has a power at all — a legal choice, and
 * the caller has to say so rather than render an empty list.
 */
export function describePowers(cfg: RuleConfig): PowerLine[] {
  const byKind = new Map<PowerKind, string[]>();
  for (const key of POWER_RANK_KEYS) {
    const kind = powerOf(cfg, key);
    if (kind === "NONE") continue;
    const ranks = byKind.get(kind);
    if (ranks) ranks.push(rankLabel(key));
    else byKind.set(kind, [rankLabel(key)]);
  }
  return [...byKind].map(([kind, ranks]) => ({
    kind,
    ranks: joinOr(ranks),
    effect: POWER_EFFECTS[kind],
  }));
}

/**
 * The map's own view of a rank, without the card-level resolution `powerFor`
 * does. An unmapped rank has no power (docs/02 §powers).
 */
export function powerOf(cfg: RuleConfig, key: RankKey): PowerKind {
  const kind = cfg.powers.map[key];
  if (kind === undefined) return "NONE";
  if (kind === "GIVE_CARD" && !cfg.powers.aceGiveEnabled) return "NONE";
  return kind;
}

/** "7 · Valet", or "aucun" — the one-line summary shown in Réglages. */
export function summarisePowers(cfg: RuleConfig): string {
  const ranks = POWER_RANK_KEYS.filter((k) => powerOf(cfg, k) !== "NONE").map(rankLabel);
  return ranks.length === 0 ? "aucun" : ranks.join(" · ");
}

/**
 * The short chips shown in the lobby.
 *
 * A guest joining a room used to be told nothing about the rules the host had
 * chosen (HANDOVER §7). The config travels inside `PlayerView`, so it only ever
 * needed saying out loud.
 */
export function summariseRules(cfg: RuleConfig): string[] {
  const chips = [`Pouvoirs : ${summarisePowers(cfg)}`];
  chips.push(cfg.snap.enabled ? "Défausse rapide" : "Sans défausse rapide");
  if (!cfg.deck.seedDiscard) chips.push("Défausse vide au départ");
  if (!cfg.turn.takeFromDiscard) chips.push("Pioche seulement");
  if (cfg.match.scoreLimit !== null) chips.push(`Fin à ${cfg.match.scoreLimit} points`);
  else if (cfg.match.roundLimit !== null) chips.push(`${cfg.match.roundLimit} manches`);
  return chips;
}

export function describeValues(cfg: RuleConfig): string[] {
  const v = cfg.values;
  const lines: string[] = [];
  if (v.redKing === v.blackKing) {
    lines.push(`Tous les <b>Rois</b> valent ${v.redKing}.`);
  } else {
    lines.push(`<b>Roi rouge</b> ♥ ♦ vaut ${v.redKing} — la meilleure carte du jeu.`);
    lines.push(`<b>Roi noir</b> ♠ ♣ vaut ${v.blackKing} — la pire.`);
  }
  if (v.queen === v.jack) {
    lines.push(`<b>Valet</b> et <b>Dame</b> valent ${v.queen}, l'<b>As</b> vaut ${v.ace}.`);
  } else {
    lines.push(`<b>Dame</b> ${v.queen}, <b>Valet</b> ${v.jack}, <b>As</b> ${v.ace}.`);
  }
  if (cfg.deck.useJokers) lines.push(`<b>Joker</b> vaut ${v.joker}.`);
  lines.push("Les autres cartes valent leur numéro.");
  return lines;
}

/** The bullets under "Ton tour" — the discard one disappears when disabled. */
export function describeTurn(cfg: RuleConfig): string[] {
  const bullets = [
    "<b>Piocher</b>, puis soit poser la carte sur une des tiennes (celle qu'elle remplace part à la défausse), soit la <b>défausser directement</b> — et là son pouvoir s'active.",
  ];
  if (cfg.turn.takeFromDiscard) {
    bullets.push(
      "<b>Prendre la défausse</b>, et l'échanger obligatoirement contre une de tes cartes. Aucun pouvoir.",
    );
  }
  return bullets;
}

/** One sentence on the deal, including whether a card starts the discard. */
export function describeSetup(cfg: RuleConfig): string {
  const peek = cfg.deck.initialPeekCount;
  const start = cfg.deck.seedDiscard
    ? "Une carte est retournée au centre pour ouvrir la défausse."
    : "La défausse est vide au départ : elle se remplit au fil des tours.";
  return `Tu as ${cfg.deck.handSize} cartes face cachée devant toi et tu n'en connais que ${peek} au départ. ${start}`;
}
