// Stock management and penalty cards — see docs/05 §5.2, docs/06 §8.
// Imported by turn / powers / snap; imports none of them, so there are no cycles.

import { shuffle } from "./rng";
import { addCardToLayout } from "./state";
import type { CardId, Event, GameState, PenaltyReason, PlayerId, SlotIndex } from "./types";

export const canRefillStock = (s: GameState): boolean =>
  s.config.deck.reshuffleDiscard && s.discard.length >= 2;

export const stockDead = (s: GameState): boolean =>
  s.stock.length === 0 && !canRefillStock(s);

/**
 * Recycles the discard except its top card.
 *
 * `discardVersion` is deliberately NOT bumped: the top card did not change, so
 * an in-flight snap window stays valid. Invalidating it here would punish
 * players for the engine's own bookkeeping.
 */
export function refillStockFromDiscard(s: GameState): { state: GameState; events: Event[] } {
  const top = s.discard[0]!;
  const rest = s.discard.slice(1);
  const { items, cursor } = shuffle(rest, s.rngSeed, s.rngCursor);
  const next: GameState = { ...s, stock: items, discard: [top], rngCursor: cursor };
  return { state: next, events: [{ type: "StockReshuffled", stockSize: items.length }] };
}

export function ensureStock(s: GameState): { state: GameState; events: Event[] } {
  if (s.stock.length > 0) return { state: s, events: [] };
  if (!canRefillStock(s)) return { state: s, events: [] };
  return refillStockFromDiscard(s);
}

/**
 * A penalty card is face down and known to nobody — including its owner. That
 * is what makes it a penalty: a liability of unknown size.
 */
export function drawPenaltyCard(
  s: GameState,
  playerId: PlayerId,
  reason: PenaltyReason,
): { state: GameState; events: Event[] } {
  if (stockDead(s)) return { state: s, events: [] }; // no cards left: penalty is void

  const refilled = ensureStock(s);
  let state = refilled.state;
  const cardId: CardId | undefined = state.stock[0];
  if (cardId === undefined) return { state: s, events: [] };

  state = { ...state, stock: state.stock.slice(1) };
  const added = addCardToLayout(state, playerId, cardId, []);
  const slot: SlotIndex = added.slot;

  return {
    state: added.state,
    events: [
      ...refilled.events,
      { type: "PenaltyCardTaken", playerId, slot, cardId, reason },
    ],
  };
}

export function drawPenaltyCards(
  s: GameState,
  playerId: PlayerId,
  count: number,
  reason: PenaltyReason,
): { state: GameState; events: Event[] } {
  let state = s;
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const drawn = drawPenaltyCard(state, playerId, reason);
    state = drawn.state;
    events.push(...drawn.events);
  }
  return { state, events };
}
