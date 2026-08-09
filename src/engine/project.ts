// Hidden information — see docs/09-hidden-information.md
//
// The authoritative GameState knows every card. No view built here may contain
// a card id the viewer is not entitled to.

import { currentPlayerId } from "./state";
import type {
  Card,
  CardId,
  Event,
  GameState,
  PendingPower,
  Phase,
  PlayerId,
  SlotIndex,
} from "./types";

export const HIDDEN = "hidden" as const;
export type VisibleCard = CardId | typeof HIDDEN | null; // null = EMPTY slot

export interface PlayerView {
  readonly you: PlayerId;
  readonly phase: Phase;
  readonly roundNumber: number;
  readonly turnNumber: number;
  readonly currentPlayer: PlayerId;
  readonly players: readonly {
    readonly id: PlayerId;
    readonly name: string;
    readonly connected: boolean;
    readonly eliminated: boolean;
    readonly cumulativeScore: number;
    readonly roundScore: number | null;
    readonly hasPeeked: boolean;
    readonly layout: readonly VisibleCard[];
  }[];
  readonly discard: readonly CardId[];
  readonly discardVersion: number;
  readonly stockCount: number;
  readonly heldBy: PlayerId | null;
  readonly heldCard: VisibleCard;
  readonly pendingPower: {
    readonly kind: PendingPower["kind"];
    readonly ownerId: PlayerId;
    readonly targets: readonly { playerId: PlayerId; slot: SlotIndex }[];
  } | null;
  readonly announcerId: PlayerId | null;
  readonly finalLapRemaining: number | null;
  readonly cards: Readonly<Record<CardId, Card>>;
}

const REVEAL_PHASES: readonly Phase[] = ["REVEAL", "ROUND_END", "MATCH_END"];

export function projectFor(s: GameState, viewer: PlayerId): PlayerView {
  const revealAll = REVEAL_PHASES.includes(s.phase);
  const holder = s.heldCard === null ? null : currentPlayerId(s);

  const visibleIds = new Set<CardId>(s.discard);

  const players = s.players.map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    eliminated: p.eliminated,
    cumulativeScore: p.cumulativeScore,
    roundScore: p.roundScore,
    hasPeeked: p.hasPeeked,
    layout: p.layout.map((slot): VisibleCard => {
      if (slot.cardId === null) return null;
      if (revealAll || slot.knownBy.includes(viewer)) {
        visibleIds.add(slot.cardId);
        return slot.cardId;
      }
      return HIDDEN;
    }),
  }));

  let heldCard: VisibleCard = null;
  if (s.heldCard !== null) {
    if (viewer === holder) {
      heldCard = s.heldCard;
      visibleIds.add(s.heldCard);
    } else {
      // In AWAIT_SLOT_FOR_DISCARD the card is in fact public — everyone watched
      // it leave the face-up pile — but the client already has it from the
      // DiscardTaken event, so hiding it here is harmless and strictly safer.
      heldCard = HIDDEN;
    }
  }

  // Only ship the card faces this viewer is allowed to render.
  const cards: Record<CardId, Card> = {};
  for (const id of visibleIds) {
    const card = s.cards[id];
    if (card) cards[id] = card;
  }

  return {
    you: viewer,
    phase: s.phase,
    roundNumber: s.roundNumber,
    turnNumber: s.turnNumber,
    currentPlayer: currentPlayerId(s),
    players,
    discard: s.discard,
    discardVersion: s.discardVersion,
    stockCount: s.stock.length,
    heldBy: holder,
    heldCard,
    pendingPower: s.pendingPower
      ? {
          kind: s.pendingPower.kind,
          ownerId: s.pendingPower.ownerId,
          targets: s.pendingPower.targets.map((t) => ({ playerId: t.playerId, slot: t.slot })),
        }
      : null,
    announcerId: s.announcerId,
    finalLapRemaining: s.finalLapRemaining,
    cards,
  };
}

/**
 * Redacts an event for one viewer. Returns null when the viewer should not see
 * the event at all.
 */
export function projectEvent(e: Event, viewer: PlayerId): Event | null {
  switch (e.type) {
    case "CardsDealt":
      return { ...e, deals: e.deals.map((d) => ({ ...d, cardId: HIDDEN })) };

    case "InitialPeeked":
      if (e.playerId === viewer) return e;
      return { ...e, reveals: e.reveals.map((r) => ({ ...r, cardId: HIDDEN })) };

    case "StockDrawn":
      return e.playerId === viewer ? e : { ...e, cardId: HIDDEN };

    case "CardRevealed":
      return e.toPlayerId === viewer ? e : { ...e, cardId: HIDDEN };

    case "CardPlaced":
      // discardedCardId lands face up, so it stays public.
      return e.playerId === viewer ? e : { ...e, placedCardId: HIDDEN };

    case "CardGiven":
      return e.fromPlayerId === viewer ? e : { ...e, cardId: HIDDEN };

    case "PenaltyCardTaken":
      // Face down and unknown even to its owner — that is what makes it a penalty.
      return { ...e, cardId: HIDDEN };

    case "ActionRejected":
      return e.playerId === viewer ? e : null;

    default:
      // Everything else is public: it happened face up on the table.
      return e;
  }
}
