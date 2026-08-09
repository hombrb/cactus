// Domain model — see docs/03-domain-model.md
// Everything here is plain data: JSON-serialisable, structurally comparable.

export type Suit = "H" | "D" | "C" | "S" | "N"; // N = none (jokers)

export type Rank =
  | "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "JOKER";

export type CardId = string;
export type PlayerId = string;
export type SlotIndex = number;

export interface Card {
  readonly id: CardId;
  readonly rank: Rank;
  readonly suit: Suit;
}

/** Card id table for the whole match. Cards are immutable. */
export type CardTable = Readonly<Record<CardId, Card>>;

/**
 * A position in a layout. Positions are permanent: removing a card leaves a hole
 * (`cardId: null`) rather than shifting the others, so memory stays valid.
 *
 * `knownBy` answers exactly one question: may the engine currently render this
 * card's face to this player? It is NOT a model of memory. Never transmitted.
 */
export interface Slot {
  readonly cardId: CardId | null;
  readonly knownBy: readonly PlayerId[];
}

export type Layout = readonly Slot[];

export interface SlotRef {
  readonly playerId: PlayerId;
  readonly slot: SlotIndex;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string;
  readonly layout: Layout;
  readonly connected: boolean;
  readonly hasPeeked: boolean;
  readonly roundScore: number | null;
  readonly cumulativeScore: number;
  readonly eliminated: boolean;
}

export type PowerKind =
  | "NONE"
  | "PEEK_OWN"
  | "PEEK_OPPONENT"
  | "BLIND_SWAP"
  | "LOOK_AND_SWAP"
  | "GIVE_CARD";

export interface PendingPower {
  readonly kind: PowerKind;
  readonly sourceCard: CardId;
  readonly ownerId: PlayerId;
  readonly targets: readonly SlotRef[];
  readonly revealed: readonly SlotRef[];
}

export interface PendingSnapGive {
  readonly snapperId: PlayerId;
  readonly victimId: PlayerId;
  readonly victimSlot: SlotIndex;
}

export type Phase =
  | "LOBBY"
  | "DEALING"
  | "INITIAL_PEEK"
  | "TURN_START"
  | "AWAIT_HELD_DECISION"
  | "AWAIT_SLOT_FOR_DISCARD"
  | "POWER_AWAIT_OWN_SLOT"
  | "POWER_AWAIT_OPPONENT_SLOT"
  | "POWER_AWAIT_TWO_SLOTS"
  | "POWER_AWAIT_SWAP_CONFIRM"
  | "POWER_AWAIT_GIVE_TARGET"
  | "AWAIT_SNAP_GIVE"
  | "TURN_END"
  | "REVEAL"
  | "ROUND_END"
  | "MATCH_END";

export type RoundEndReason =
  | "LAYOUT_EMPTIED"
  | "FINAL_LAP_DONE"
  | "STOCK_DEAD";

export type PenaltyReason = "POWER_MISUSE" | "SNAP_FAILURE";

export type SnapFailReason = "RANK_MISMATCH" | "LOST_RACE";

// ---------------------------------------------------------------------------
// Rule configuration — see docs/02-rule-config.md
// ---------------------------------------------------------------------------

export interface DeckConfig {
  readonly deckCount: 1 | 2;
  readonly autoTwoDecksAbove: number; // 0 disables
  readonly useJokers: boolean;
  readonly handSize: number;
  readonly initialPeekCount: number;
  readonly initialPeekFree: boolean;
  readonly reshuffleDiscard: boolean;
  /** Turn the stock's top card face up at the deal. False starts on an empty discard. */
  readonly seedDiscard: boolean;
}

export interface ValueConfig {
  readonly joker: number;
  readonly redKing: number;
  readonly blackKing: number;
  readonly queen: number;
  readonly jack: number;
  readonly ace: number;
}

/** Keys are ranks, optionally colour-qualified: "7", "J", "K:black", "K:red". */
export type RankKey = string;

export type PowerMap = Readonly<Record<RankKey, PowerKind>>;

export interface PowerConfig {
  readonly map: PowerMap;
  readonly aceGiveEnabled: boolean;
  readonly misusePenaltyCards: number;
}

export interface TurnConfig {
  /** May a player take the top of the discard instead of drawing? */
  readonly takeFromDiscard: boolean;
}

export interface SnapConfig {
  readonly enabled: boolean;
  readonly failurePenaltyCards: number;
  readonly allowOnOpponent: boolean;
  readonly emptyLayoutEndsRound: boolean;
  readonly allowedDuringFinalLap: boolean;
  readonly loserPenalty: "NONE" | "AS_FAILED_SNAP";
  readonly matchOn: "RANK" | "RANK_AND_SUIT";
}

export interface AnnounceConfig {
  readonly timing: "END_OF_TURN" | "INSTEAD_OF_TURN";
  readonly requiresThreshold: number | null;
}

export type AnnouncerFailurePenalty =
  | { readonly kind: "DOUBLE" }
  | { readonly kind: "ADD"; readonly amount: number };

export interface ScoringConfig {
  readonly announcerSuccessScore: "ZERO" | "OWN_SUM";
  readonly announcerFailurePenalty: AnnouncerFailurePenalty;
  readonly tieCountsAsFailure: boolean;
  readonly othersScoreOnAnnouncerFailure: "OWN_SUM" | "ZERO";
  readonly royalBonus: boolean;
  readonly kamikaze: { readonly enabled: boolean; readonly penalty: number };
}

export interface MatchConfig {
  readonly scoreLimit: number | null;
  readonly roundLimit: number | null;
  readonly limitEliminates: boolean;
}

export interface TimingConfig {
  readonly turnTimeoutMs: number | null;
  readonly endOfTurnWindowMs: number | null;
  readonly snapGraceMs: number;
  readonly peekRevealMs: number;
  readonly initialPeekMs: number | null;
}

export interface RuleConfig {
  readonly deck: DeckConfig;
  readonly values: ValueConfig;
  readonly powers: PowerConfig;
  readonly turn: TurnConfig;
  readonly snap: SnapConfig;
  readonly announce: AnnounceConfig;
  readonly scoring: ScoringConfig;
  readonly match: MatchConfig;
  readonly timing: TimingConfig;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export interface GameState {
  readonly config: RuleConfig;
  readonly cards: CardTable;
  readonly players: readonly PlayerState[];
  readonly turnOrder: readonly PlayerId[];
  readonly currentPlayerIndex: number;
  readonly dealerIndex: number;
  readonly hostId: PlayerId;

  readonly phase: Phase;
  readonly roundNumber: number;
  readonly turnNumber: number;

  readonly stock: readonly CardId[]; // index 0 = top
  readonly discard: readonly CardId[]; // index 0 = top
  readonly discardVersion: number;
  readonly heldCard: CardId | null;
  readonly pendingPower: PendingPower | null;
  readonly pendingSnapGive: PendingSnapGive | null;
  readonly lockedSlots: readonly SlotRef[];
  readonly resumePhase: Phase | null;

  readonly announcerId: PlayerId | null;
  readonly finalLapRemaining: number | null;
  readonly roundEndReason: RoundEndReason | null;

  readonly rngSeed: string;
  readonly rngCursor: number;
  readonly actionCounter: number;
}

// ---------------------------------------------------------------------------
// Actions — see docs/03 §6. Every action carries the issuing player.
// ---------------------------------------------------------------------------

export type Action =
  | { readonly type: "LobbyJoin"; readonly playerId: PlayerId; readonly name: string }
  | { readonly type: "LobbyLeave"; readonly playerId: PlayerId }
  | { readonly type: "StartMatch"; readonly playerId: PlayerId }
  | { readonly type: "PeekInitial"; readonly playerId: PlayerId; readonly slots: readonly SlotIndex[] }
  | { readonly type: "DrawStock"; readonly playerId: PlayerId }
  | { readonly type: "TakeDiscard"; readonly playerId: PlayerId }
  | { readonly type: "PlaceInSlot"; readonly playerId: PlayerId; readonly slot: SlotIndex }
  | { readonly type: "DiscardHeld"; readonly playerId: PlayerId }
  | { readonly type: "PowerSkip"; readonly playerId: PlayerId }
  | { readonly type: "PowerTarget"; readonly playerId: PlayerId; readonly target: SlotRef }
  | { readonly type: "PowerConfirmSwap"; readonly playerId: PlayerId; readonly swap: boolean }
  | { readonly type: "Snap"; readonly playerId: PlayerId; readonly target: SlotRef; readonly forVersion: number }
  | { readonly type: "SnapGive"; readonly playerId: PlayerId; readonly slot: SlotIndex }
  | { readonly type: "AnnounceCactus"; readonly playerId: PlayerId }
  | { readonly type: "EndTurn"; readonly playerId: PlayerId }
  | { readonly type: "StartNextRound"; readonly playerId: PlayerId }
  | { readonly type: "Timeout"; readonly playerId: PlayerId; readonly phaseToken: number };

export type ActionType = Action["type"];

// ---------------------------------------------------------------------------
// Events — the reducer's output. Card ids here are redacted per viewer by
// projectEvent (docs/09 §3) before ever leaving the authority.
// ---------------------------------------------------------------------------

export type Event =
  | { readonly type: "MatchStarted"; readonly turnOrder: readonly PlayerId[] }
  | { readonly type: "RoundStarted"; readonly roundNumber: number; readonly dealerIndex: number; readonly handSize: number; readonly stockSize: number }
  | { readonly type: "CardsDealt"; readonly deals: readonly { playerId: PlayerId; slot: SlotIndex; cardId: CardId }[] }
  | { readonly type: "DiscardSeeded"; readonly cardId: CardId }
  | { readonly type: "InitialPeeked"; readonly playerId: PlayerId; readonly reveals: readonly { slot: SlotIndex; cardId: CardId }[] }
  | { readonly type: "AllPeeked" }
  | { readonly type: "TurnStarted"; readonly playerId: PlayerId; readonly turnNumber: number }
  | { readonly type: "StockDrawn"; readonly playerId: PlayerId; readonly cardId: CardId }
  | { readonly type: "DiscardTaken"; readonly playerId: PlayerId; readonly cardId: CardId }
  | { readonly type: "CardPlaced"; readonly playerId: PlayerId; readonly slot: SlotIndex; readonly placedCardId: CardId; readonly discardedCardId: CardId | null }
  | { readonly type: "HeldDiscarded"; readonly playerId: PlayerId; readonly cardId: CardId; readonly power: PowerKind }
  | { readonly type: "PowerStarted"; readonly playerId: PlayerId; readonly kind: PowerKind }
  | { readonly type: "PowerDeclined"; readonly playerId: PlayerId; readonly kind: PowerKind }
  | { readonly type: "CardRevealed"; readonly toPlayerId: PlayerId; readonly ref: SlotRef; readonly cardId: CardId }
  | { readonly type: "CardsSwapped"; readonly a: SlotRef; readonly b: SlotRef }
  | { readonly type: "CardGiven"; readonly fromPlayerId: PlayerId; readonly toPlayerId: PlayerId; readonly slot: SlotIndex; readonly cardId: CardId }
  | { readonly type: "PenaltyCardTaken"; readonly playerId: PlayerId; readonly slot: SlotIndex; readonly cardId: CardId; readonly reason: PenaltyReason }
  | { readonly type: "SnapSucceeded"; readonly playerId: PlayerId; readonly ref: SlotRef; readonly cardId: CardId }
  | { readonly type: "SnapFailed"; readonly playerId: PlayerId; readonly ref: SlotRef; readonly cardId: CardId; readonly reason: SnapFailReason }
  | { readonly type: "SlotEmptied"; readonly ref: SlotRef }
  | { readonly type: "StockReshuffled"; readonly stockSize: number }
  | { readonly type: "CactusAnnounced"; readonly playerId: PlayerId }
  | { readonly type: "FinalLapAdvanced"; readonly remaining: number }
  | { readonly type: "TurnEnded"; readonly playerId: PlayerId }
  | { readonly type: "RoundRevealed"; readonly layouts: readonly { playerId: PlayerId; cards: readonly CardId[] }[] }
  | { readonly type: "RoundScored"; readonly scores: readonly { playerId: PlayerId; roundScore: number; cumulative: number }[]; readonly announcerId: PlayerId | null; readonly announcerSucceeded: boolean }
  | { readonly type: "MatchEnded"; readonly standings: readonly { playerId: PlayerId; cumulative: number; rank: number }[] }
  | { readonly type: "ConnectionChanged"; readonly playerId: PlayerId; readonly connected: boolean }
  | { readonly type: "HostChanged"; readonly playerId: PlayerId }
  | { readonly type: "ActionRejected"; readonly playerId: PlayerId; readonly action: Action; readonly reason: string };

export interface Reduction {
  readonly state: GameState;
  readonly events: readonly Event[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export const OK: Verdict = { ok: true };
export const reject = (reason: string): Verdict => ({ ok: false, reason });
