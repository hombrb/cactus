// Shared accessors and immutable updates — see docs/03 §7b.
// All pure and total: nothing here throws on a missing player or slot.

import type {
  Card,
  CardId,
  GameState,
  Layout,
  PlayerId,
  PlayerState,
  Slot,
  SlotIndex,
  SlotRef,
} from "./types";

export const currentPlayerId = (s: GameState): PlayerId =>
  s.turnOrder[s.currentPlayerIndex]!;

export const playerOf = (s: GameState, id: PlayerId): PlayerState | undefined =>
  s.players.find((p) => p.id === id);

export const layoutOf = (s: GameState, id: PlayerId): Layout =>
  playerOf(s, id)?.layout ?? [];

export function slotOf(s: GameState, ref: SlotRef): Slot | undefined {
  const p = playerOf(s, ref.playerId);
  if (!p) return undefined;
  return p.layout[ref.slot];
}

export const cardOf = (s: GameState, id: CardId): Card => s.cards[id]!;

export const activePlayers = (s: GameState): readonly PlayerState[] =>
  s.players.filter((p) => !p.eliminated);

export const hasNoCards = (s: GameState, id: PlayerId): boolean =>
  layoutOf(s, id).every((slot) => slot.cardId === null);

export const nonEmptyCardIds = (layout: Layout): CardId[] =>
  layout.flatMap((slot) => (slot.cardId === null ? [] : [slot.cardId]));

export const sameRef = (a: SlotRef, b: SlotRef): boolean =>
  a.playerId === b.playerId && a.slot === b.slot;

export const isLocked = (s: GameState, ref: SlotRef): boolean =>
  s.lockedSlots.some((r) => sameRef(r, ref));

export function withPlayer(
  s: GameState,
  id: PlayerId,
  f: (p: PlayerState) => PlayerState,
): GameState {
  return { ...s, players: s.players.map((p) => (p.id === id ? f(p) : p)) };
}

export function withSlot(s: GameState, ref: SlotRef, slot: Slot): GameState {
  return withPlayer(s, ref.playerId, (p) => ({
    ...p,
    layout: p.layout.map((existing, i) => (i === ref.slot ? slot : existing)),
  }));
}

/** Knowledge never survives a card change — that is what makes a blind swap blind. */
export const setSlotCard = (cardId: CardId | null, knownBy: readonly PlayerId[] = []): Slot => ({
  cardId,
  knownBy,
});

export const markKnown = (slot: Slot, playerId: PlayerId): Slot =>
  slot.knownBy.includes(playerId) ? slot : { ...slot, knownBy: [...slot.knownBy, playerId] };

/**
 * Reuses an EMPTY hole before growing the layout, so layouts stay compact and
 * renderable. Returns the index used.
 */
export function addCardToLayout(
  s: GameState,
  playerId: PlayerId,
  cardId: CardId,
  knownBy: readonly PlayerId[] = [],
): { state: GameState; slot: SlotIndex } {
  const layout = layoutOf(s, playerId);
  const hole = layout.findIndex((slot) => slot.cardId === null);
  const index = hole === -1 ? layout.length : hole;
  const next = withPlayer(s, playerId, (p) => {
    const grown = p.layout.slice();
    grown[index] = setSlotCard(cardId, knownBy);
    return { ...p, layout: grown };
  });
  return { state: next, slot: index };
}

export function firstLegalSlot(s: GameState, playerId: PlayerId): SlotIndex {
  const layout = layoutOf(s, playerId);
  for (let i = 0; i < layout.length; i++) {
    if (!isLocked(s, { playerId, slot: i })) return i;
  }
  return 0;
}

export function swapSlots(s: GameState, a: SlotRef, b: SlotRef): GameState {
  const ca = slotOf(s, a)?.cardId ?? null;
  const cb = slotOf(s, b)?.cardId ?? null;
  return withSlot(withSlot(s, a, setSlotCard(cb)), b, setSlotCard(ca));
}

export const inRound = (s: GameState): boolean =>
  s.phase === "TURN_START" ||
  s.phase === "AWAIT_HELD_DECISION" ||
  s.phase === "AWAIT_SLOT_FOR_DISCARD" ||
  s.phase === "POWER_AWAIT_OWN_SLOT" ||
  s.phase === "POWER_AWAIT_OPPONENT_SLOT" ||
  s.phase === "POWER_AWAIT_TWO_SLOTS" ||
  s.phase === "POWER_AWAIT_SWAP_CONFIRM" ||
  s.phase === "POWER_AWAIT_GIVE_TARGET" ||
  s.phase === "TURN_END";

export const isPowerPhase = (s: GameState): boolean =>
  s.phase.startsWith("POWER_AWAIT_");
