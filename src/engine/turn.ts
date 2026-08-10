// Match setup, dealing and turn actions — see docs/05-engine-core.md

import { buildDeck, cardTable, powerFor } from "./cards";
import { validateConfig } from "./config";
import { canRefillStock, ensureStock } from "./deck";
import { phaseForPower } from "./powers";
import { shuffle } from "./rng";
import { beginReveal, roundOverReason } from "./scoring";
import {
  activePlayers,
  cardOf,
  currentPlayerId,
  isLocked,
  layoutOf,
  markKnown,
  playerOf,
  setSlotCard,
  slotOf,
  withPlayer,
  withSlot,
} from "./state";
import type {
  Action,
  CardId,
  Event,
  GameState,
  PlayerId,
  PlayerState,
  RuleConfig,
  SlotIndex,
  Verdict,
} from "./types";
import { OK, reject } from "./types";

export interface MatchSetup {
  readonly config: RuleConfig;
  readonly players: readonly { id: PlayerId; name: string }[];
  readonly seed: string;
}

export function createMatch(setup: MatchSetup): GameState {
  // Configs used to come only from `presets`, so nothing ever called
  // `validateConfig`. They are now assembled from user choices, so the one
  // place every match passes through checks them. Same DEV-only cast as
  // `applyAction`: the engine also compiles inside the worker.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const problems = validateConfig(setup.config);
    if (problems.length > 0) {
      throw new Error(`invalid rule config: ${problems.join("; ")}`);
    }
  }

  const players: PlayerState[] = setup.players.map((p) => ({
    id: p.id,
    name: p.name,
    layout: [],
    connected: true,
    hasPeeked: false,
    roundScore: null,
    cumulativeScore: 0,
    eliminated: false,
  }));

  return {
    config: setup.config,
    cards: {},
    players,
    turnOrder: players.map((p) => p.id),
    currentPlayerIndex: 0,
    dealerIndex: players.length - 1,
    hostId: players[0]!.id,
    phase: "LOBBY",
    roundNumber: 0,
    turnNumber: 0,
    stock: [],
    discard: [],
    discardVersion: 0,
    heldCard: null,
    pendingPower: null,
    pendingSnapGive: null,
    lockedSlots: [],
    resumePhase: null,
    announcerId: null,
    finalLapRemaining: null,
    roundEndReason: null,
    previousPlayerId: null,
    rngSeed: setup.seed,
    rngCursor: 0,
    actionCounter: 0,
  };
}

export function validateStartMatch(s: GameState, a: Action & { type: "StartMatch" }): Verdict {
  if (s.phase !== "LOBBY") return reject("WRONG_PHASE");
  if (a.playerId !== s.hostId) return reject("NOT_HOST");
  if (s.players.length < 2) return reject("NOT_ENOUGH_PLAYERS");
  return OK;
}

export function onStartMatch(s: GameState): { state: GameState; events: Event[] } {
  let cfg = s.config;
  if (cfg.deck.autoTwoDecksAbove > 0 && s.players.length > cfg.deck.autoTwoDecksAbove) {
    cfg = { ...cfg, deck: { ...cfg.deck, deckCount: 2 } };
  }
  // The config is frozen from here on: cumulative scores would be meaningless
  // if the rules changed mid-match (docs/02).
  const base: GameState = { ...s, config: cfg, phase: "DEALING" };
  const dealt = dealRound(base);
  return {
    state: dealt.state,
    events: [{ type: "MatchStarted", turnOrder: s.turnOrder }, ...dealt.events],
  };
}

/**
 * Builds a round from an explicit card order.
 *
 * Split out from `dealRound` so a test can supply a known deal — the worked
 * trace in docs/11 §3 is only checkable this way.
 */
export function createRound(
  s: GameState,
  order: readonly CardId[],
  cards: GameState["cards"],
): { state: GameState; events: Event[] } {
  const cfg = s.config;
  let cursor = 0;
  const deals: { playerId: PlayerId; slot: SlotIndex; cardId: CardId }[] = [];

  const players = s.players.map((p) => {
    if (p.eliminated) return { ...p, layout: [], hasPeeked: true, roundScore: null };
    const layout = [];
    for (let i = 0; i < cfg.deck.handSize; i++) {
      const cardId = order[cursor++]!;
      layout.push(setSlotCard(cardId));
      deals.push({ playerId: p.id, slot: i, cardId });
    }
    return { ...p, layout, hasPeeked: false, roundScore: null };
  });

  // Some tables start on an empty discard and only ever discard what has been
  // played — the French schoolyard version does (docs/01 §2). Nothing else in
  // the round changes: `validateSnap` already rejects DISCARD_EMPTY, so the
  // first player simply has nothing to snap or to take.
  const seedCard = cfg.deck.seedDiscard ? order[cursor++]! : null;
  const stock = order.slice(cursor);

  const state: GameState = {
    ...s,
    cards,
    players,
    stock,
    discard: seedCard === null ? [] : [seedCard],
    // Starts at 1, never 0, so a client with no state yet cannot match it.
    // True with an empty discard too: the version counts changes, not cards.
    discardVersion: 1,
    heldCard: null,
    pendingPower: null,
    pendingSnapGive: null,
    lockedSlots: [],
    resumePhase: null,
    announcerId: null,
    finalLapRemaining: null,
    roundEndReason: null,
    // Nobody has played yet, so nobody is inside the announcement window.
    previousPlayerId: null,
    roundNumber: s.roundNumber + 1,
    turnNumber: 1,
    currentPlayerIndex: (s.dealerIndex + 1) % s.turnOrder.length,
    phase: "INITIAL_PEEK",
  };

  return {
    state,
    events: [
      {
        type: "RoundStarted",
        roundNumber: state.roundNumber,
        dealerIndex: state.dealerIndex,
        handSize: cfg.deck.handSize,
        stockSize: stock.length,
      },
      { type: "CardsDealt", deals },
      // The seeded discard card has no power: powers fire only on a card drawn
      // from the stock and discarded (docs/05 §3).
      ...(seedCard === null
        ? []
        : [{ type: "DiscardSeeded", cardId: seedCard } as const]),
    ],
  };
}

export function dealRound(s: GameState): { state: GameState; events: Event[] } {
  const deck = buildDeck(s.config);
  const { items, cursor } = shuffle(
    deck.map((c) => c.id),
    s.rngSeed,
    s.rngCursor,
  );
  return createRound({ ...s, rngCursor: cursor }, items, cardTable(deck));
}

// ---------------------------------------------------------------------------
// Initial peek
// ---------------------------------------------------------------------------

export function nearestSlots(cfg: RuleConfig): SlotIndex[] {
  return Array.from({ length: cfg.deck.initialPeekCount }, (_, i) => i);
}

export function validatePeekInitial(
  s: GameState,
  a: Action & { type: "PeekInitial" },
): Verdict {
  const cfg = s.config;
  if (s.phase !== "INITIAL_PEEK") return reject("WRONG_PHASE");
  const p = playerOf(s, a.playerId);
  if (!p) return reject("NOT_IN_MATCH");
  if (p.hasPeeked) return reject("ALREADY_PEEKED");
  if (a.slots.length !== cfg.deck.initialPeekCount) return reject("WRONG_PEEK_COUNT");
  if (new Set(a.slots).size !== a.slots.length) return reject("DUPLICATE_SLOT");
  if (a.slots.some((i) => i < 0 || i >= p.layout.length)) return reject("BAD_SLOT");
  if (!cfg.deck.initialPeekFree) {
    const expected = nearestSlots(cfg);
    if (a.slots.some((i) => !expected.includes(i))) return reject("PEEK_SLOTS_FIXED");
  }
  return OK;
}

export function onPeekInitial(
  s: GameState,
  a: Action & { type: "PeekInitial" },
): { state: GameState; events: Event[] } {
  let state = s;
  const reveals: { slot: SlotIndex; cardId: CardId }[] = [];

  for (const i of a.slots) {
    const ref = { playerId: a.playerId, slot: i };
    const slot = slotOf(state, ref)!;
    reveals.push({ slot: i, cardId: slot.cardId! });
    state = withSlot(state, ref, markKnown(slot, a.playerId));
  }
  state = withPlayer(state, a.playerId, (p) => ({ ...p, hasPeeked: true }));

  const events: Event[] = [{ type: "InitialPeeked", playerId: a.playerId, reveals }];

  if (activePlayers(state).every((p) => p.hasPeeked)) {
    const started = beginFirstTurn(state);
    return { state: started.state, events: [...events, ...started.events] };
  }
  return { state, events };
}

export function beginFirstTurn(s: GameState): { state: GameState; events: Event[] } {
  const state: GameState = { ...s, phase: "TURN_START" };
  return {
    state,
    events: [
      { type: "AllPeeked" },
      { type: "TurnStarted", playerId: currentPlayerId(state), turnNumber: state.turnNumber },
    ],
  };
}

// ---------------------------------------------------------------------------
// Turn actions
// ---------------------------------------------------------------------------

export function validateDrawStock(s: GameState, a: Action & { type: "DrawStock" }): Verdict {
  if (s.phase !== "TURN_START") return reject("WRONG_PHASE");
  if (currentPlayerId(s) !== a.playerId) return reject("NOT_YOUR_TURN");
  if (s.stock.length === 0 && !canRefillStock(s)) return reject("STOCK_DEAD");
  return OK;
}

export function onDrawStock(
  s: GameState,
  a: Action & { type: "DrawStock" },
): { state: GameState; events: Event[] } {
  const refilled = ensureStock(s);
  const cardId = refilled.state.stock[0]!;
  const state: GameState = {
    ...refilled.state,
    stock: refilled.state.stock.slice(1),
    heldCard: cardId,
    phase: "AWAIT_HELD_DECISION",
  };
  // cardId is private to the drawer: everyone else sees only that a card left
  // the stock, exactly as at a real table.
  return {
    state,
    events: [...refilled.events, { type: "StockDrawn", playerId: a.playerId, cardId }],
  };
}

export function validateTakeDiscard(s: GameState, a: Action & { type: "TakeDiscard" }): Verdict {
  // Every source consulted allows this (docs/01 §4B), but some tables play
  // stock-only, so it is a rule rather than a constant.
  if (!s.config.turn.takeFromDiscard) return reject("TAKE_DISCARD_DISABLED");
  if (s.phase !== "TURN_START") return reject("WRONG_PHASE");
  if (currentPlayerId(s) !== a.playerId) return reject("NOT_YOUR_TURN");
  if (s.discard.length === 0) return reject("DISCARD_EMPTY");
  return OK;
}

export function onTakeDiscard(
  s: GameState,
  a: Action & { type: "TakeDiscard" },
): { state: GameState; events: Event[] } {
  const cardId = s.discard[0]!;
  // Taking from the discard changes the top card, so every open snap window closes.
  const state: GameState = {
    ...s,
    discard: s.discard.slice(1),
    discardVersion: s.discardVersion + 1,
    heldCard: cardId,
    phase: "AWAIT_SLOT_FOR_DISCARD",
  };
  return { state, events: [{ type: "DiscardTaken", playerId: a.playerId, cardId }] };
}

export function validatePlaceInSlot(
  s: GameState,
  a: Action & { type: "PlaceInSlot" },
): Verdict {
  if (s.phase !== "AWAIT_HELD_DECISION" && s.phase !== "AWAIT_SLOT_FOR_DISCARD")
    return reject("WRONG_PHASE");
  if (currentPlayerId(s) !== a.playerId) return reject("NOT_YOUR_TURN");
  const layout = layoutOf(s, a.playerId);
  if (a.slot < 0 || a.slot >= layout.length) return reject("BAD_SLOT");
  if (isLocked(s, { playerId: a.playerId, slot: a.slot })) return reject("SLOT_LOCKED");
  return OK;
}

export function onPlaceInSlot(
  s: GameState,
  a: Action & { type: "PlaceInSlot" },
): { state: GameState; events: Event[] } {
  const ref = { playerId: a.playerId, slot: a.slot };
  const outgoing = slotOf(s, ref)?.cardId ?? null;
  const incoming = s.heldCard!;

  // The placer knows what they just put there; any opponent who had memorised
  // the old card now holds stale information, and knownBy must say so.
  let state = withSlot(s, ref, setSlotCard(incoming, [a.playerId]));

  if (outgoing !== null) {
    state = {
      ...state,
      discard: [outgoing, ...state.discard],
      discardVersion: state.discardVersion + 1,
    };
  }
  state = { ...state, heldCard: null, phase: "TURN_END" };

  // No power triggers on a swap — neither the incoming card's nor the outgoing
  // card's. Powers are the price of not using a card's value.
  return {
    state,
    events: [
      {
        type: "CardPlaced",
        playerId: a.playerId,
        slot: a.slot,
        placedCardId: incoming,
        discardedCardId: outgoing,
      },
    ],
  };
}

export function validateDiscardHeld(s: GameState, a: Action & { type: "DiscardHeld" }): Verdict {
  // Deliberately not AWAIT_SLOT_FOR_DISCARD: a card taken from the discard must
  // be placed, never thrown away.
  if (s.phase !== "AWAIT_HELD_DECISION") return reject("WRONG_PHASE");
  if (currentPlayerId(s) !== a.playerId) return reject("NOT_YOUR_TURN");
  return OK;
}

export function onDiscardHeld(
  s: GameState,
  a: Action & { type: "DiscardHeld" },
): { state: GameState; events: Event[] } {
  const cardId = s.heldCard!;
  const power = powerFor(s.config, cardOf(s, cardId));

  let state: GameState = {
    ...s,
    discard: [cardId, ...s.discard],
    discardVersion: s.discardVersion + 1,
    heldCard: null,
  };

  const events: Event[] = [
    { type: "HeldDiscarded", playerId: a.playerId, cardId, power },
  ];

  if (power === "NONE") return { state: { ...state, phase: "TURN_END" }, events };

  state = {
    ...state,
    pendingPower: {
      kind: power,
      sourceCard: cardId,
      ownerId: a.playerId,
      targets: [],
      revealed: [],
    },
    phase: phaseForPower(power),
  };
  events.push({ type: "PowerStarted", playerId: a.playerId, kind: power });
  return { state, events };
}

// ---------------------------------------------------------------------------
// Announcing and ending a turn
// ---------------------------------------------------------------------------

/**
 * Under `AFTER_TURN`, the announcement outlives the turn that earned it: the
 * player who just played may still say it while the next player is playing.
 * `previousPlayerId` is that window, and it closes on its own when the next turn
 * ends (docs/01 §7).
 */
export function inAnnounceWindow(s: GameState, playerId: PlayerId): boolean {
  if (s.config.announce.timing !== "AFTER_TURN") return false;
  if (s.previousPlayerId !== playerId) return false;
  if (s.announcerId !== null) return false;
  if (playerOf(s, playerId)?.eliminated !== false) return false;
  // Not `inRound`: once the round is being revealed it is over for everyone.
  return s.phase !== "REVEAL" && s.phase !== "ROUND_END" && s.phase !== "MATCH_END";
}

export function validateAnnounce(
  s: GameState,
  a: Action & { type: "AnnounceCactus" },
): Verdict {
  const cfg = s.config;
  if (s.announcerId !== null) return reject("ALREADY_ANNOUNCED");
  if (inAnnounceWindow(s, a.playerId)) return OK;
  if (currentPlayerId(s) !== a.playerId) return reject("NOT_YOUR_TURN");
  if (cfg.announce.timing === "INSTEAD_OF_TURN" && s.phase !== "TURN_START")
    return reject("WRONG_PHASE");
  if (cfg.announce.timing !== "INSTEAD_OF_TURN" && s.phase !== "TURN_END")
    return reject("WRONG_PHASE");
  return OK;
  // cfg.announce.requiresThreshold is NOT enforced: a player announces on
  // belief, and consulting their hand would leak it through the rejection
  // itself (docs/05 §6).
}

export function onAnnounceCactus(
  s: GameState,
  a: Action & { type: "AnnounceCactus" },
): { state: GameState; events: Event[] } {
  const others = activePlayers(s).length - 1;
  const announced: GameState = {
    ...s,
    announcerId: a.playerId,
    finalLapRemaining: others,
  };
  const event: Event = { type: "CactusAnnounced", playerId: a.playerId };

  // Said late, while somebody else is playing: their turn is theirs to finish,
  // and it is already the first of the final lap. Nothing else has to happen —
  // `onEndTurn` will count it, and `advanceTurn` skips the announcer from here
  // on, so the lap comes out exactly as it would have at the announcer's own
  // turn end.
  if (currentPlayerId(s) !== a.playerId) return { state: announced, events: [event] };

  const ended = onEndTurn({ ...announced, phase: "TURN_END" });
  return { state: ended.state, events: [event, ...ended.events] };
}

export function validateEndTurn(s: GameState, a: Action & { type: "EndTurn" }): Verdict {
  if (s.phase !== "TURN_END") return reject("WRONG_PHASE");
  if (currentPlayerId(s) !== a.playerId) return reject("NOT_YOUR_TURN");
  return OK;
}

export function onEndTurn(s: GameState): { state: GameState; events: Event[] } {
  const events: Event[] = [{ type: "TurnEnded", playerId: currentPlayerId(s) }];
  // Whoever just played takes the announcement window from whoever held it,
  // which is how that window closes without anything having to close it.
  let state: GameState = { ...s, lockedSlots: [], previousPlayerId: currentPlayerId(s) };

  // The announcer's own turn-end does not consume a final-lap slot: the lap is
  // the *other* players' last turns.
  const lap = state.finalLapRemaining;
  if (lap !== null && currentPlayerId(s) !== state.announcerId) {
    state = { ...state, finalLapRemaining: lap - 1 };
    events.push({ type: "FinalLapAdvanced", remaining: lap - 1 });
  }

  const reason = roundOverReason(state);
  if (reason !== null) {
    const revealed = beginReveal(state, reason);
    return { state: revealed.state, events: [...events, ...revealed.events] };
  }

  state = advanceTurn(state);
  events.push({
    type: "TurnStarted",
    playerId: currentPlayerId(state),
    turnNumber: state.turnNumber,
  });
  return { state, events };
}

/** Skips eliminated players and the announcer: once you announce you do not play again. */
export function advanceTurn(s: GameState): GameState {
  let i = s.currentPlayerIndex;
  for (let step = 0; step < s.turnOrder.length; step++) {
    i = (i + 1) % s.turnOrder.length;
    const id = s.turnOrder[i]!;
    const p = playerOf(s, id);
    if (p && !p.eliminated && id !== s.announcerId) break;
  }
  return {
    ...s,
    currentPlayerIndex: i,
    phase: "TURN_START",
    turnNumber: s.turnNumber + 1,
  };
}

export function validateStartNextRound(
  s: GameState,
  a: Action & { type: "StartNextRound" },
): Verdict {
  if (s.phase !== "ROUND_END") return reject("WRONG_PHASE");
  if (a.playerId !== s.hostId) return reject("NOT_HOST");
  return OK;
}

export function onStartNextRound(s: GameState): { state: GameState; events: Event[] } {
  const rotated: GameState = {
    ...s,
    dealerIndex: (s.dealerIndex + 1) % s.turnOrder.length,
  };
  return dealRound(rotated);
}
