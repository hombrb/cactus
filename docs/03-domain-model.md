# 03 — Domain Model

Every type the engine needs. Conventions are in [README.md](README.md);
`cfg` always means `state.config` ([02](02-rule-config.md)).

---

## 1. Cards

```
enum Suit  = HEARTS | DIAMONDS | CLUBS | SPADES | NONE   // NONE for jokers
enum Rank  = A | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | J | Q | K | JOKER

type CardId = string          // stable, unique within a match

type Card {
  id:   CardId
  rank: Rank
  suit: Suit
}
```

**`id` is mandatory and must be unique even across two decks.** Rank + suit is not
an identity: with `deck.deckCount = 2` there are two ♠K, and the event log,
replay, and the "conservation of cards" invariant all break if they are
indistinguishable. Convention: `"d1-SK"`, `"d2-SK"`.

Cards are **immutable** and live in one flat table for the whole match:

```
type CardTable = Map<CardId, Card>

fn cardOf(state, id: CardId) -> Card
  return state.cards[id]

fn isRed(c: Card) -> bool    = c.suit in {HEARTS, DIAMONDS}
fn isBlack(c: Card) -> bool  = c.suit in {CLUBS, SPADES}
```

Everything else in the state stores **`CardId`s only**. This is what makes view
projection ([09](09-hidden-information.md)) a pure filtering operation.

## 2. Slots and layouts

```
type SlotIndex = int          // 0-based, position in a layout; never reordered

const EMPTY = null

type Slot {
  cardId:  CardId?            // EMPTY when the card was snapped away
  knownBy: Set<PlayerId>      // who has been shown this exact card in this position
}

type Layout = Slot[]          // length starts at cfg.deck.handSize, may grow
```

Rules that the type encodes:

- **Slots are positional and permanent.** Snapping a card away sets
  `cardId = EMPTY`; it does **not** shift the remaining slots. Memory of "the
  top-left one is a 3" must stay valid.
- **Layouts grow, never shrink in length.** Penalty cards and `GIVE_CARD` append a
  new slot at the end. An `EMPTY` slot may be reused by an incoming penalty card
  (`snap.emptyLayoutEndsRound` interacts here — see [07](07-snap.md)); reuse is
  preferred over growth so layouts stay compact.
- **`knownBy` is engine bookkeeping and is never transmitted.** It is reset for a
  slot whenever the card in it changes (a swap makes prior knowledge stale —
  that is the whole point of a blind swap).

```
fn setSlotCard(slot: Slot, cardId: CardId?, knownBy: Set<PlayerId>) -> Slot
  return Slot { cardId, knownBy }        // knowledge never survives a card change

fn markKnown(slot: Slot, playerId) -> Slot
  return slot with { knownBy: slot.knownBy ∪ {playerId} }
```

### `SlotRef`

Powers and snaps address a slot belonging to a specific player:

```
type SlotRef { playerId: PlayerId, slot: SlotIndex }
```

## 3. Players

```
type PlayerId = string        // stable per match; also the reconnection token subject

type PlayerState {
  id:              PlayerId
  name:            string
  layout:          Layout
  connected:       bool
  hasPeeked:       bool           // completed the INITIAL_PEEK barrier
  roundScore:      int?           // null until the round is scored
  cumulativeScore: int
  eliminated:      bool           // only used when cfg.match.limitEliminates
}
```

## 4. Pending power

Set while a power is mid-resolution. Exists only in the `POWER_*` phases.

```
type PendingPower {
  kind:        PowerKind          // see 02
  sourceCard:  CardId             // the discarded card that triggered it
  ownerId:     PlayerId           // the player resolving it
  targets:     SlotRef[]          // collected so far, in order
  revealed:    SlotRef[]          // targets already shown to ownerId
}
```

`LOOK_AND_SWAP` is the only kind that needs two targets and then a decision;
`targets.length` is how the reducer knows which step it is on.

## 4b. Pending snap-give

Set only when `cfg.snap.allowOnOpponent` is on and a player has successfully
snapped a card out of somebody else's layout: they now owe that player a card.

```
type PendingSnapGive {
  snapperId: PlayerId
  victimId:  PlayerId
  victimSlot: SlotIndex        // the hole to fill
}
```

Because a snap can interrupt any in-round phase, `GameState.resumePhase` records
where to go back to once the give resolves.

## 5. Game state

```
enum Phase =
    LOBBY
  | DEALING
  | INITIAL_PEEK
  | TURN_START                    // current player must choose an action
  | AWAIT_HELD_DECISION           // drew from stock, must place or discard
  | AWAIT_SLOT_FOR_DISCARD        // took from discard, must place
  | POWER_AWAIT_OWN_SLOT
  | POWER_AWAIT_OPPONENT_SLOT
  | POWER_AWAIT_TWO_SLOTS
  | POWER_AWAIT_SWAP_CONFIRM
  | POWER_AWAIT_GIVE_TARGET
  | AWAIT_SNAP_GIVE               // successful snap on an opponent: pick a card to give
  | TURN_END                      // transient; may announce here
  | REVEAL
  | ROUND_END
  | MATCH_END

type GameState {
  config:            RuleConfig
  cards:             CardTable
  players:           PlayerState[]
  turnOrder:         PlayerId[]
  currentPlayerIndex: int
  dealerIndex:       int
  hostId:            PlayerId       // may start the match and deal the next round

  phase:             Phase
  roundNumber:       int
  turnNumber:        int            // within the current round; 1-based

  stock:             CardId[]      // index 0 = top
  discard:           CardId[]      // index 0 = top
  discardVersion:    int           // increments on every change of the top card
  heldCard:          CardId?       // non-null only in AWAIT_HELD_DECISION
  pendingPower:      PendingPower?
  pendingSnapGive:   PendingSnapGive?
  lockedSlots:       Set<SlotRef>  // slots a snap may not touch right now (07)
  resumePhase:       Phase?        // phase to return to after AWAIT_SNAP_GIVE

  announcerId:       PlayerId?
  finalLapRemaining: int?          // null until an announcement

  rngSeed:           string
  rngCursor:         int
  eventLog:          Event[]
  actionCounter:     int           // monotonic; every accepted action increments it
}
```

Notes on three fields that carry most of the subtlety:

- **`discardVersion`** is the snap window identifier. A `SNAP` action names the
  version it was reacting to; a stale version is rejected without penalty. This
  is what makes snapping latency-tolerant. See [07](07-snap.md).
- **`finalLapRemaining`** is a counter, **not a phase**. After an announcement it
  is set to `playerCount - 1` and decremented at each `TURN_END`. Normal turn
  phases continue to apply during the final lap; only the round-end condition
  changes. Treating it as a phase would duplicate the entire turn state machine.
- **`lockedSlots`** prevents a snap from yanking a card out from under a swap that
  is already in flight.

## 6. Actions

Actions are the only way state changes. Every action carries the `playerId` that
issued it — the reducer never infers "the current player" from context.

```
type Action =
  | LobbyJoin        { playerId, name }
  | LobbyLeave       { playerId }
  | StartMatch       { playerId }                       // host only
  | PeekInitial      { playerId, slots: SlotIndex[] }
  | DrawStock        { playerId }
  | TakeDiscard      { playerId }
  | PlaceInSlot      { playerId, slot: SlotIndex }
  | DiscardHeld      { playerId }
  | PowerSkip        { playerId }                       // decline the power entirely
  | PowerTarget      { playerId, target: SlotRef }
  | PowerConfirmSwap { playerId, swap: bool }           // LOOK_AND_SWAP only
  | Snap             { playerId, target: SlotRef, forVersion: int }
  | SnapGive         { playerId, slot: SlotIndex }      // snap.allowOnOpponent only
  | AnnounceCactus   { playerId }
  | EndTurn          { playerId }                       // close the end-of-turn window
  | StartNextRound   { playerId }
  | Timeout          { playerId, phaseToken: int }
```

`EndTurn` exists because the announcement happens *at the end of your turn*
(`cfg.announce.timing = END_OF_TURN`). After your move resolves, the state sits in
`TURN_END` for a short window in which you may announce; `EndTurn` closes that
window explicitly, and `Timeout` closes it after `cfg.timing.endOfTurnWindowMs` if
you do nothing. In hotseat the "pass the phone" screen *is* that window.

`Timeout.phaseToken` is the `actionCounter` value the timer was armed against. A
timeout whose token no longer matches is stale (the player acted in time) and is
dropped silently — the standard fix for timer races.

Every action above appears in the transition table in
[04](04-state-machine.md) and has a `validate` branch and a reducer branch in
[05](05-engine-core.md) / [06](06-powers.md) / [07](07-snap.md).

## 7. Events

Events are the reducer's output: the replay log, the wire format (after
projection), and the only thing clients ever animate.

```
type Event =
  | MatchStarted     { turnOrder: PlayerId[], configDigest: string }
  | RoundStarted     { roundNumber, dealerIndex, handSize, stockSize }
  | CardsDealt       { deals: {playerId, slot, cardId}[] }         // cardId private
  | DiscardSeeded    { cardId }                                    // public
  | InitialPeeked    { playerId, reveals: {slot, cardId}[] }        // cardId private
  | AllPeeked        { }
  | TurnStarted      { playerId, turnNumber }
  | StockDrawn       { playerId, cardId }                          // cardId private
  | DiscardTaken     { playerId, cardId }                          // public
  | CardPlaced       { playerId, slot, placedCardId, discardedCardId }
  | HeldDiscarded    { playerId, cardId, power: PowerKind }        // public
  | PowerStarted     { playerId, kind: PowerKind }
  | PowerDeclined    { playerId, kind: PowerKind }
  | CardRevealed     { toPlayerId, ref: SlotRef, cardId }          // cardId private
  | CardsSwapped     { a: SlotRef, b: SlotRef }                    // public, faces hidden
  | CardGiven        { fromPlayerId, toPlayerId, slot, cardId }
  | PenaltyCardTaken { playerId, slot, cardId, reason }
  | SnapSucceeded    { playerId, ref: SlotRef, cardId }            // public
  | SnapFailed       { playerId, ref: SlotRef, cardId, reason }    // public
  | SlotEmptied      { ref: SlotRef }
  | StockReshuffled  { stockSize }
  | CactusAnnounced  { playerId }
  | FinalLapAdvanced { remaining: int }
  | TurnEnded        { playerId }
  | RoundRevealed    { layouts: {playerId, cards: CardId[]}[] }    // public
  | RoundScored      { scores: {playerId, roundScore, cumulative}[],
                       announcerId: PlayerId?, announcerSucceeded: bool }
  | MatchEnded       { standings: {playerId, cumulative, rank}[] }
  | ConnectionChanged{ playerId, connected: bool }
  | ActionRejected   { playerId, action, reason }                  // private to actor
```

Two design rules:

1. **Events carry `CardId`, never `Card`.** Projection ([09](09-hidden-information.md))
   decides per recipient whether the id is replaced by `HIDDEN`.
2. **Every state change emits an event.** `applyAction` returning a changed state
   with an empty event list is a bug — replay would diverge.

## 7b. Helpers used throughout

Small accessors the pseudocode in [05](05-engine-core.md)–[08](08-scoring.md)
assumes. All are pure and total.

```
fn currentPlayer(state) -> PlayerId      = state.turnOrder[state.currentPlayerIndex]
fn layoutOf(state, id)  -> Layout        = playerOf(state, id).layout
fn slotOf(state, ref)   -> Slot?         // null if the player or index does not exist
fn activePlayers(state) -> PlayerState[] // players with eliminated == false
fn hasNoCards(state, id) -> bool         // every slot in their layout is EMPTY
fn nonEmptyCardIds(layout) -> CardId[]
fn firstLegalSlot(state) -> SlotIndex    // lowest index that is in range and unlocked
fn ids(cards: Card[]) -> CardId[]
fn table(cards: Card[]) -> CardTable
fn digest(cfg) -> string                 // stable hash, so clients can confirm the ruleset

fn withPlayer(state, id, f: PlayerState -> PlayerState) -> GameState
fn withSlot(state, ref: SlotRef, slot: Slot) -> GameState
fn shuffleOrder(state, players) -> PlayerId[]   // seat order via shuffle(), deterministic
```

Lobby plumbing — `onLobbyJoin`, `onLobbyLeave` — is deliberately not specified:
it appends to / flags `state.players`, emits `ConnectionChanged`, and touches no
game state. It is the one part of the reducer with no rules content.

## 8. Determinism and RNG

A round must be exactly reproducible from `(rngSeed, config, action sequence)`.
This is what makes replay, reconnection, and hand-verification of the worked
trace in [11](11-edge-cases-and-invariants.md) possible.

```
fn nextRandom(state) -> (int, GameState)
  value = hash(state.rngSeed, state.rngCursor)      // any deterministic PRF
  return (value, state with { rngCursor: state.rngCursor + 1 })

fn shuffle(state, cards: CardId[]) -> (CardId[], GameState)
  // Fisher-Yates driven exclusively by nextRandom
  out = copy(cards)
  s = state
  for i from length(out) - 1 down to 1:
    (r, s) = nextRandom(s)
    j = r mod (i + 1)
    swap out[i], out[j]
  return (out, s)
```

Requirements:

- `rngCursor` **only ever increases**, and only inside `nextRandom`.
- No implementation may call a global/ambient random source anywhere else.
- `rngSeed` is generated once per match by the authority and **never sent to
  clients** — it would reveal the stock order.
- Mid-round reshuffles ([05](05-engine-core.md), `refillStockFromDiscard`) use the
  same stream, so they replay identically.
