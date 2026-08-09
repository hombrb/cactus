// Reveal, round scoring, match scoring — see docs/08-scoring.md

import { cardValue, isBlack } from "./cards";
import { stockDead } from "./deck";
import { activePlayers, cardOf, hasNoCards, nonEmptyCardIds } from "./state";
import type {
  Event,
  GameState,
  Layout,
  PlayerId,
  RoundEndReason,
  RuleConfig,
} from "./types";

export function scoreLayout(cfg: RuleConfig, s: GameState, layout: Layout): number {
  let total = 0;
  for (const slot of layout) {
    if (slot.cardId !== null) total += cardValue(cfg, cardOf(s, slot.cardId));
  }
  return total;
}

/**
 * Order matters: an emptied layout beats an in-flight final lap, because the
 * emptying player has provably finished at 0 (docs/04 §5).
 */
export function roundOverReason(s: GameState): RoundEndReason | null {
  if (s.config.snap.emptyLayoutEndsRound) {
    for (const p of activePlayers(s)) {
      if (hasNoCards(s, p.id)) return "LAYOUT_EMPTIED";
    }
  }
  if (s.finalLapRemaining !== null && s.finalLapRemaining <= 0) return "FINAL_LAP_DONE";
  if (stockDead(s)) return "STOCK_DEAD";
  return null;
}

export function beginReveal(
  s: GameState,
  reason: RoundEndReason,
): { state: GameState; events: Event[] } {
  let state: GameState = {
    ...s,
    phase: "REVEAL",
    pendingPower: null,
    pendingSnapGive: null,
    lockedSlots: [],
    resumePhase: null,
    roundEndReason: reason,
  };

  // A round can end mid-turn, so a held card must go back to the discard or the
  // card-conservation invariant breaks (docs/08 §2).
  if (s.heldCard !== null) {
    state = {
      ...state,
      heldCard: null,
      discard: [s.heldCard, ...state.discard],
      discardVersion: state.discardVersion + 1,
    };
  }

  const layouts = activePlayers(state).map((p) => ({
    playerId: p.id,
    cards: nonEmptyCardIds(p.layout),
  }));

  const scored = scoreRound(state);
  return {
    state: scored.state,
    events: [{ type: "RoundRevealed", layouts }, ...scored.events],
  };
}

function isKamikaze(cfg: RuleConfig, s: GameState, layout: Layout): boolean {
  const cards = nonEmptyCardIds(layout).map((id) => cardOf(s, id));
  if (cards.length !== cfg.deck.handSize) return false;
  const allWorst = cards.every((c) => c.rank === "Q" || (c.rank === "K" && isBlack(c)));
  if (!allWorst) return false;
  return cards.some((c) => c.rank === "Q") && cards.some((c) => c.rank === "K");
}

function applyAnnouncerPenalty(cfg: RuleConfig, sum: number): number {
  const p = cfg.scoring.announcerFailurePenalty;
  return p.kind === "DOUBLE" ? sum * 2 : sum + p.amount;
}

export function scoreRound(s: GameState): { state: GameState; events: Event[] } {
  const cfg = s.config;
  const active = activePlayers(s);
  const sums = new Map<PlayerId, number>();
  for (const p of active) sums.set(p.id, scoreLayout(cfg, s, p.layout));

  // Kamikaze: the theatrical inverse — assemble the worst possible hand and win.
  // Two simultaneous kamikazes cancel (reachable with two decks).
  if (cfg.scoring.kamikaze.enabled) {
    const winners = active.filter((p) => isKamikaze(cfg, s, p.layout));
    if (winners.length === 1) {
      const k = winners[0]!;
      const final = new Map<PlayerId, number>();
      for (const p of active) {
        final.set(p.id, p.id === k.id ? 0 : cfg.scoring.kamikaze.penalty);
      }
      return finishScoring(s, final, true);
    }
  }

  // Nobody announced (stock death, or an emptied layout): nobody is penalised.
  if (s.announcerId === null) return finishScoring(s, sums, false);

  const announcer = s.announcerId;
  const announcerSum = sums.get(announcer) ?? 0;
  const otherSums = active.filter((p) => p.id !== announcer).map((p) => sums.get(p.id) ?? 0);
  const best = otherSums.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...otherSums);

  let succeeded = cfg.scoring.tieCountsAsFailure
    ? announcerSum < best
    : announcerSum <= best;
  if (cfg.scoring.royalBonus && announcerSum === 0) succeeded = true;

  const final = new Map<PlayerId, number>();
  if (succeeded) {
    final.set(announcer, cfg.scoring.announcerSuccessScore === "ZERO" ? 0 : announcerSum);
    for (const p of active) {
      if (p.id !== announcer) final.set(p.id, sums.get(p.id) ?? 0);
    }
  } else {
    final.set(announcer, applyAnnouncerPenalty(cfg, announcerSum));
    for (const p of active) {
      if (p.id === announcer) continue;
      final.set(p.id, cfg.scoring.othersScoreOnAnnouncerFailure === "ZERO" ? 0 : (sums.get(p.id) ?? 0));
    }
  }

  return finishScoring(s, final, succeeded);
}

function finishScoring(
  s: GameState,
  final: ReadonlyMap<PlayerId, number>,
  announcerSucceeded: boolean,
): { state: GameState; events: Event[] } {
  let state = s;
  const rows: { playerId: PlayerId; roundScore: number; cumulative: number }[] = [];

  for (const p of activePlayers(s)) {
    const roundScore = final.get(p.id) ?? 0;
    const cumulative = p.cumulativeScore + roundScore;
    rows.push({ playerId: p.id, roundScore, cumulative });
    state = {
      ...state,
      players: state.players.map((q) =>
        q.id === p.id ? { ...q, roundScore, cumulativeScore: cumulative } : q,
      ),
    };
  }

  state = applyMatchScores(state);
  state = { ...state, phase: "ROUND_END" };

  const events: Event[] = [
    {
      type: "RoundScored",
      scores: rows,
      announcerId: state.announcerId,
      announcerSucceeded,
    },
  ];

  if (isMatchOver(state)) {
    state = { ...state, phase: "MATCH_END" };
    events.push({ type: "MatchEnded", standings: rankPlayers(state) });
  }

  return { state, events };
}

export function applyMatchScores(s: GameState): GameState {
  const cfg = s.config;
  if (!cfg.match.limitEliminates || cfg.match.scoreLimit === null) return s;
  return {
    ...s,
    players: s.players.map((p) =>
      !p.eliminated && p.cumulativeScore >= cfg.match.scoreLimit!
        ? { ...p, eliminated: true }
        : p,
    ),
  };
}

export function isMatchOver(s: GameState): boolean {
  const cfg = s.config;
  if (cfg.match.roundLimit !== null && s.roundNumber >= cfg.match.roundLimit) return true;
  if (cfg.match.scoreLimit !== null) {
    if (cfg.match.limitEliminates) return activePlayers(s).length < 2;
    return s.players.some((p) => p.cumulativeScore >= cfg.match.scoreLimit!);
  }
  return false;
}

/** Lowest cumulative wins. Equal scores share a rank; the next rank skips. */
export function rankPlayers(
  s: GameState,
): { playerId: PlayerId; cumulative: number; rank: number }[] {
  const rows = s.players
    .map((p) => ({
      playerId: p.id,
      cumulative: p.cumulativeScore,
      order: s.turnOrder.indexOf(p.id),
    }))
    .sort((a, b) => a.cumulative - b.cumulative || a.order - b.order);

  const out: { playerId: PlayerId; cumulative: number; rank: number }[] = [];
  let rank = 0;
  let previous: number | null = null;
  rows.forEach((row, i) => {
    if (previous === null || row.cumulative !== previous) rank = i + 1;
    previous = row.cumulative;
    out.push({ playerId: row.playerId, cumulative: row.cumulative, rank });
  });
  return out;
}
