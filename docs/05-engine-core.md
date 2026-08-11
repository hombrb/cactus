# 05 — Engine Core

The reducer. Powers live in [06](06-powers.md), snap in [07](07-snap.md), scoring
in [08](08-scoring.md); this file owns everything else.

---

## 1. The contract

```
fn applyAction(state: GameState, action: Action) -> (GameState, Event[])
```

- **Pure.** Same `(state, action)` ⇒ same `(state', events)`. No clock, no I/O, no
  ambient randomness — all randomness flows through `nextRandom`
  ([03 §8](03-domain-model.md#8-determinism-and-rng)).
- **Total.** Never throws for player input. An illegal action returns the state
  unchanged plus one `ActionRejected`.
- **Validation is separable**, so the same function can run on the client for
  optimistic UI and on the authority for truth:

```
type Verdict = Ok | Reject { reason: string }

fn validate(state: GameState, action: Action) -> Verdict
```

The top level is a thin dispatcher:

```
fn applyAction(state, action) -> (GameState, Event[])
  verdict = validate(state, action)
  if verdict is Reject:
    return (state, [ActionRejected { action.playerId, action, verdict.reason }])

  (next, events) = reduce(state, action)
  next = next with { actionCounter: next.actionCounter + 1 }
  assert checkInvariants(next)                     // see 11
  return (next, events)

fn reduce(state, action) -> (GameState, Event[])
  match action:
    LobbyJoin        -> onLobbyJoin(state, action)
    LobbyLeave       -> onLobbyLeave(state, action)
    StartMatch       -> onStartMatch(state, action)
    PeekInitial      -> onPeekInitial(state, action)
    DrawStock        -> onDrawStock(state, action)
    TakeDiscard      -> onTakeDiscard(state, action)
    PlaceInSlot      -> onPlaceInSlot(state, action)
    DiscardHeld      -> onDiscardHeld(state, action)
    PowerSkip        -> onPowerSkip(state, action)          // 06
    PowerTarget      -> onPowerTarget(state, action)        // 06
    PowerConfirmSwap -> onPowerConfirmSwap(state, action)   // 06
    Snap             -> onSnap(state, action)               // 07
    SnapGive         -> onSnapGive(state, action)           // 07
    AnnounceCactus   -> onAnnounceCactus(state, action)
    EndTurn          -> onEndTurn(state, action)
    StartNextRound   -> onStartNextRound(state, action)
    Timeout          -> onTimeout(state, action)
```

### Shared guards

```
fn isCurrent(state, playerId) -> bool
  return state.turnOrder[state.currentPlayerIndex] == playerId

fn playerOf(state, playerId) -> PlayerState?
fn slotOf(state, ref: SlotRef) -> Slot?

fn inRound(state) -> bool
  return state.phase in { TURN_START, AWAIT_HELD_DECISION, AWAIT_SLOT_FOR_DISCARD,
                          POWER_AWAIT_OWN_SLOT, POWER_AWAIT_OPPONENT_SLOT,
                          POWER_AWAIT_TWO_SLOTS, POWER_AWAIT_SWAP_CONFIRM,
                          POWER_AWAIT_GIVE_TARGET, TURN_END }
```

## 2. Building the deck

```
fn buildDeck(cfg) -> Card[]
  cards = []
  for d from 1 to cfg.deck.deckCount:
    for suit in {HEARTS, DIAMONDS, CLUBS, SPADES}:
      for rank in {A,2,3,4,5,6,7,8,9,10,J,Q,K}:
        cards.push(Card { id: "d{d}-{rank}{suit}", rank, suit })
    if cfg.deck.useJokers:
      cards.push(Card { id: "d{d}-JOKER-1", rank: JOKER, suit: NONE })
      cards.push(Card { id: "d{d}-JOKER-2", rank: JOKER, suit: NONE })
  return cards
```

`cfg.deck.deckCount` is raised to 2 at match start when the table is larger than
`cfg.deck.autoTwoDecksAbove`:

```
fn onStartMatch(state, action) -> (GameState, Event[])
  cfg = state.config
  if cfg.deck.autoTwoDecksAbove > 0 and len(state.players) > cfg.deck.autoTwoDecksAbove:
    cfg = cfg with { deck: cfg.deck with { deckCount: 2 } }

  order = shuffleOrder(state, state.players)         // seat order, deterministic
  s = state with { config: cfg, turnOrder: order, dealerIndex: 0,
                   roundNumber: 0, phase: DEALING }
  (s, dealEvents) = dealRound(s)
  return (s, [MatchStarted { turnOrder: order, configDigest: digest(cfg) }] + dealEvents)
```

The config is **frozen from here on** ([02](02-rule-config.md)).

## 3. Dealing a round

```
fn dealRound(state) -> (GameState, Event[])
  cfg = state.config
  deck = buildDeck(cfg)
  (order, s) = shuffle(state, ids(deck))

  players = []
  deals = []
  cursor = 0
  for p in state.players where not p.eliminated:
    layout = []
    for i from 0 to cfg.deck.handSize - 1:
      cardId = order[cursor]; cursor += 1
      layout.push(Slot { cardId, knownBy: {} })
      deals.push({ playerId: p.id, slot: i, cardId })
    players.push(p with { layout, hasPeeked: false, roundScore: null })

  seedCard = null
  if cfg.deck.seedDiscard:
    seedCard = order[cursor]; cursor += 1
  stock = order[cursor ..]

  s = s with {
    cards: table(deck), players, stock,
    discard: seedCard == null ? [] : [seedCard],
    discardVersion: 1,
    heldCard: null, pendingPower: null, pendingSnapGive: null,
    lockedSlots: {}, announcerId: null, finalLapRemaining: null,
    roundNumber: state.roundNumber + 1,
    turnNumber: 1,
    currentPlayerIndex: (state.dealerIndex + 1) mod len(state.turnOrder),
    phase: INITIAL_PEEK,
  }

  return (s, [ RoundStarted { s.roundNumber, s.dealerIndex, cfg.deck.handSize,
                              stockSize: len(stock) },
               CardsDealt { deals } ]
             + (seedCard == null ? [] : [ DiscardSeeded { cardId: seedCard } ]))
```

`discardVersion` starts at 1 whether or not a card was seeded: it counts changes
to the top of the discard, not cards ([02](02-rule-config.md#deck)).

Two details that are easy to get wrong:

- **The seeded discard card has no power.** Powers fire only on a card drawn from
  the stock and discarded ([01 §4](01-rules-reference.md#4-turn-structure)). The
  seed card is simply a snap target from turn zero.
- **`discardVersion` starts at 1**, not 0, so a client that has not yet received
  any state cannot accidentally match it.

## 4. The initial peek barrier

All players peek **simultaneously and privately**. The round does not start until
everybody has, or the window expires.

```
fn validate(state, PeekInitial { playerId, slots }) -> Verdict
  if state.phase != INITIAL_PEEK:                 reject "WRONG_PHASE"
  p = playerOf(state, playerId)
  if p == null:                                   reject "NOT_IN_MATCH"
  if p.hasPeeked:                                 reject "ALREADY_PEEKED"
  if len(slots) != cfg.deck.initialPeekCount:     reject "WRONG_PEEK_COUNT"
  if hasDuplicates(slots):                        reject "DUPLICATE_SLOT"
  if any s in slots is out of range:              reject "BAD_SLOT"
  if not cfg.deck.initialPeekFree
     and slots != nearestSlots(cfg):              reject "PEEK_SLOTS_FIXED"
  return Ok

fn nearestSlots(cfg) -> SlotIndex[]
  // convention: the two nearest cards are the lowest indices
  return [0 .. cfg.deck.initialPeekCount - 1]
  // "Nearest" is a name, not a layout: nothing here knows which way up a client
  // draws the grid, and index 0 may well be the row furthest from its owner. A UI
  // must therefore *point at* the slots this returns rather than describe them —
  // naming a row in a prompt sends the player to hold the two cards the peek does
  // not cover, and the one look of the round shows nothing.

fn onPeekInitial(state, action) -> (GameState, Event[])
  reveals = [ { slot: i, cardId: layoutOf(state, action.playerId)[i].cardId }
              for i in action.slots ]
  s = state
  for i in action.slots:
    s = withSlot(s, SlotRef{action.playerId, i}, markKnown(...))
  s = withPlayer(s, action.playerId, p => p with { hasPeeked: true })

  events = [ InitialPeeked { action.playerId, reveals } ]
  if every active player in s has hasPeeked:
    (s, more) = beginFirstTurn(s)
    events += more
  return (s, events)

fn beginFirstTurn(state) -> (GameState, Event[])
  s = state with { phase: TURN_START }
  return (s, [ AllPeeked {},
               TurnStarted { playerId: currentPlayer(s), turnNumber: 1 } ])
```

`InitialPeeked.reveals` carries card ids that are **private to that player** —
projection ([09](09-hidden-information.md)) strips them for everyone else, who see
only that the peek happened.

If `cfg.timing.initialPeekMs` elapses, `Timeout` calls `beginFirstTurn` directly;
players who never peeked simply start blind. That is a legitimate (bad) way to
play, not an error.

## 5. Turn actions

### 5.1 Draw from the stock

```
fn validate(state, DrawStock { playerId }) -> Verdict
  if state.phase != TURN_START:      reject "WRONG_PHASE"
  if not isCurrent(state, playerId): reject "NOT_YOUR_TURN"
  if len(state.stock) == 0 and not canRefillStock(state):
                                     reject "STOCK_DEAD"
  return Ok

fn onDrawStock(state, action) -> (GameState, Event[])
  (s, refillEvents) = ensureStock(state)
  cardId = s.stock[0]
  s = s with { stock: s.stock[1..], heldCard: cardId, phase: AWAIT_HELD_DECISION }
  return (s, refillEvents + [ StockDrawn { action.playerId, cardId } ])
```

`StockDrawn.cardId` is private to the drawer. Everyone else learns only that a
card left the stock — which is exactly what they see at a real table.

### 5.2 Restocking

```
fn canRefillStock(state) -> bool
  return state.config.deck.reshuffleDiscard and len(state.discard) >= 2

fn ensureStock(state) -> (GameState, Event[])
  if len(state.stock) > 0: return (state, [])
  assert canRefillStock(state), "caller must check STOCK_DEAD first"
  return refillStockFromDiscard(state)

fn refillStockFromDiscard(state) -> (GameState, Event[])
  top  = state.discard[0]
  rest = state.discard[1..]
  (shuffled, s) = shuffle(state, rest)             // same RNG stream ⇒ replayable
  s = s with { stock: shuffled, discard: [top] }
  // discardVersion is NOT bumped: the top card did not change,
  // so an in-flight snap window stays valid.
  return (s, [ StockReshuffled { stockSize: len(shuffled) } ])
```

The comment about `discardVersion` matters: a reshuffle that invalidated open snap
windows would punish players for the engine's bookkeeping.

### 5.3 Take the top of the discard

```
fn validate(state, TakeDiscard { playerId }) -> Verdict
  if not cfg.turn.takeFromDiscard:   reject "TAKE_DISCARD_DISABLED"
  if state.phase != TURN_START:      reject "WRONG_PHASE"
  if not isCurrent(state, playerId): reject "NOT_YOUR_TURN"
  if len(state.discard) == 0:        reject "DISCARD_EMPTY"
  return Ok

fn onTakeDiscard(state, action) -> (GameState, Event[])
  cardId = state.discard[0]
  s = state with { discard: state.discard[1..],
                   discardVersion: state.discardVersion + 1,
                   heldCard: cardId,
                   phase: AWAIT_SLOT_FOR_DISCARD }
  return (s, [ DiscardTaken { action.playerId, cardId } ])
```

Taking from the discard **changes the top card**, so `discardVersion` increments
and every open snap window closes. `DiscardTaken.cardId` is **public** — everyone
watched it happen.

The player is now obliged to place it ([01 §4](01-rules-reference.md#4-turn-structure));
there is no `DiscardHeld` transition out of `AWAIT_SLOT_FOR_DISCARD`.

### 5.4 Place the held card into a slot

Shared by both sources.

```
fn validate(state, PlaceInSlot { playerId, slot }) -> Verdict
  if state.phase not in {AWAIT_HELD_DECISION, AWAIT_SLOT_FOR_DISCARD}:
                                                  reject "WRONG_PHASE"
  if not isCurrent(state, playerId):              reject "NOT_YOUR_TURN"
  if slot out of range of layoutOf(state, playerId): reject "BAD_SLOT"
  if SlotRef{playerId, slot} in state.lockedSlots:   reject "SLOT_LOCKED"
  return Ok

fn onPlaceInSlot(state, action) -> (GameState, Event[])
  ref      = SlotRef { action.playerId, action.slot }
  outgoing = slotOf(state, ref).cardId              // may be EMPTY
  incoming = state.heldCard

  s = withSlot(state, ref, Slot { cardId: incoming, knownBy: {action.playerId} })
  // the placer knows what they just put there; everyone else's knowledge is void

  if outgoing != EMPTY:
    s = s with { discard: [outgoing] + s.discard,
                 discardVersion: s.discardVersion + 1 }

  s = s with { heldCard: null, phase: TURN_END }
  events = [ CardPlaced { action.playerId, action.slot,
                          placedCardId: incoming, discardedCardId: outgoing } ]

  // The displaced card is on the discard now, so under this rule it fires its own
  // power (06 §10). Its owner is mid-turn: nothing to resume, so `clearPower`
  // still lands on TURN_END.
  if outgoing != EMPTY and state.config.powers.onHandDiscard:
    started = beginPower(s, action.playerId, outgoing, resumePhase: null)
    if started != null: return (started.state, events + started.events)

  return (s, events)
```

Three rules the code encodes:

1. **No power triggers for the card you keep** — the incoming one, ever, whatever
   `powers.onHandDiscard` says. Powers are the price you pay for not using the
   card's value. Whether the *outgoing* card fires one is that key's business, and
   only that key's (01 §4, matrix row 31).
2. **`knownBy` is reset to `{placer}`.** The placer knows the new card; any
   opponent who had memorised the old one now holds stale information, and the
   engine must not pretend otherwise.
3. **Placing into an `EMPTY` slot is legal** and adds nothing to the discard. This
   happens after a snap and is how a shrunk layout can grow back.

`CardPlaced.discardedCardId` is public (it lands face up); `placedCardId` is
private to the placer.

### 5.5 Discard the held card — the power branch

```
fn validate(state, DiscardHeld { playerId }) -> Verdict
  if state.phase != AWAIT_HELD_DECISION: reject "WRONG_PHASE"   // NOT from the discard
  if not isCurrent(state, playerId):     reject "NOT_YOUR_TURN"
  return Ok

fn onDiscardHeld(state, action) -> (GameState, Event[])
  cardId = state.heldCard
  power  = powerFor(state.config, cardOf(state, cardId))         // 06

  s = state with { discard: [cardId] + state.discard,
                   discardVersion: state.discardVersion + 1,
                   heldCard: null }

  events = [ HeldDiscarded { action.playerId, cardId, power } ]

  // It is this player's own turn, so there is no phase to come back to (06 §10).
  started = beginPower(s, action.playerId, cardId, resumePhase: null)
  if started == null:
    return (s with { phase: TURN_END }, events)
  return (started.state, events + started.events)
```

`HeldDiscarded` is fully public, including the card id — it is face up on the pile
and it just opened a snap window (`discardVersion` incremented).

## 6. Announcing

```
// AFTER_TURN only: you have played, and the next player has not finished.
// `previousPlayerId` is set by onEndTurn (§7), so it moves on by itself.
fn inAnnounceWindow(state, playerId) -> bool
  if state.config.announce.timing != AFTER_TURN:      return false
  if state.previousPlayerId != playerId:              return false
  if state.announcerId != null:                       return false
  if playerOf(state, playerId).eliminated:            return false
  return state.phase not in { REVEAL, ROUND_END, MATCH_END }

fn validate(state, AnnounceCactus { playerId }) -> Verdict
  cfg = state.config
  if state.announcerId != null:              reject "ALREADY_ANNOUNCED"
  if inAnnounceWindow(state, playerId):      return Ok
  if not isCurrent(state, playerId):         reject "NOT_YOUR_TURN"
  if cfg.announce.timing == INSTEAD_OF_TURN and state.phase != TURN_START:
                                             reject "WRONG_PHASE"
  if cfg.announce.timing != INSTEAD_OF_TURN and state.phase != TURN_END:
                                             reject "WRONG_PHASE"
  return Ok

fn onAnnounceCactus(state, action) -> (GameState, Event[])
  activeOthers = count(active players in state) - 1
  s = state with { announcerId: action.playerId,
                   finalLapRemaining: activeOthers }

  // Said late, while somebody else is playing: their turn is theirs to finish,
  // and it is already the first of the final lap.
  if not isCurrent(state, action.playerId):
    return (s, [ CactusAnnounced { action.playerId } ])

  (s, endEvents) = onEndTurn(s with { phase: TURN_END }, EndTurn { action.playerId })
  return (s, [ CactusAnnounced { action.playerId } ] + endEvents)
```

**The late announcement changes nothing about the round.** `onEndTurn` decrements
the lap for every non-announcer turn end and `advanceTurn` skips the announcer, so
a `Cactus` said during the next player's turn produces exactly the lap that the
same `Cactus` said one action earlier would have. That equivalence is what makes
the wider window a UI affordance rather than a rules variant, and it is asserted
in `tests/announce.test.ts`.

It is also **the only action a player may take while it is not their turn**, other
than a snap.

`cfg.announce.requiresThreshold` is deliberately **not** enforced here. A player
announces on belief, and the authority must not consult their hand to permit or
forbid it — doing so would leak information through the rejection itself. When the
key is set it is enforced only in offline/replay modes where no leak is possible;
see [11](11-edge-cases-and-invariants.md).

## 7. Ending a turn

```
fn onEndTurn(state, action) -> (GameState, Event[])
  events = [ TurnEnded { playerId: currentPlayer(state) } ]
  // Whoever just played takes the announcement window (§6) from whoever held
  // it, which is how that window closes without anything having to close it.
  s = state with { lockedSlots: {}, previousPlayerId: currentPlayer(state) }

  // the announcer's own turn-end does not consume a final-lap slot:
  // the lap is the *other* players' last turns
  if state.finalLapRemaining != null and currentPlayer(state) != state.announcerId:
    s = s with { finalLapRemaining: s.finalLapRemaining - 1 }
    events += [ FinalLapAdvanced { remaining: s.finalLapRemaining } ]

  reason = roundOverReason(s)
  if reason != null:
    (s, revealEvents) = beginReveal(s, reason)     // 08
    return (s, events + revealEvents)

  s = advanceTurn(s)
  return (s, events + [ TurnStarted { currentPlayer(s), turnNumber: s.turnNumber } ])

fn advanceTurn(state) -> GameState
  i = state.currentPlayerIndex
  repeat:
    i = (i + 1) mod len(state.turnOrder)
  until player at i is active (not eliminated) and i != announcer's index
  return state with { currentPlayerIndex: i, phase: TURN_START,
                      turnNumber: state.turnNumber + 1 }
```

`advanceTurn` skips the announcer: once you have announced, you do not play again
([01 §7](01-rules-reference.md#7-ending-the-round)).

### Round-over conditions

Order is significant — see [04 §5](04-state-machine.md#5-round-over-conditions).

```
fn roundOverReason(state) -> Reason?
  if state.config.snap.emptyLayoutEndsRound
     and any active player has no non-EMPTY slot:      return LAYOUT_EMPTIED
  if state.finalLapRemaining != null
     and state.finalLapRemaining <= 0:                 return FINAL_LAP_DONE
  if len(state.stock) == 0 and not canRefillStock(state): return STOCK_DEAD
  return null
```

## 8. Timeouts

```
fn validate(state, Timeout { playerId, phaseToken }) -> Verdict
  if phaseToken != state.actionCounter: reject "STALE_TIMEOUT"     // dropped silently
  return Ok

fn onTimeout(state, action) -> (GameState, Event[])
  match state.phase:
    INITIAL_PEEK           -> beginFirstTurn(state)
    TURN_START             -> reduce(state, DrawStock { currentPlayer(state) })
    AWAIT_HELD_DECISION    -> reduce(state, DiscardHeld { currentPlayer(state) })
    AWAIT_SLOT_FOR_DISCARD -> reduce(state, PlaceInSlot { currentPlayer(state),
                                                          firstLegalSlot(state) })
    // The owner, not the current player: a snap can earn a power out of turn
    // (06 §10), and skipping it as the current player earns NOT_YOUR_POWER and
    // parks the table in the power phase for good.
    POWER_*                -> reduce(state, PowerSkip { state.pendingPower.ownerId })
    AWAIT_SNAP_GIVE        -> reduce(state, SnapGive { snapper,
                                                       firstLegalSlot(state) })
    TURN_END               -> reduce(state, EndTurn { currentPlayer(state) })
    otherwise              -> (state, [])
```

Design rules for auto-actions:

- **Never announce on a player's behalf**, and never take a discard for them: both
  are strategic commitments. Drawing and discarding is the neutral move.
- **A stale timeout is dropped, not rejected.** It is the engine's own message, not
  the player's; surfacing it as `ActionRejected` would spam the log.
- `cfg.timing.turnTimeoutMs == null` disables arming entirely (two players on
  one device — see [10 §6](10-multiplayer-and-modes.md#6-two-players-one-phone-flat-table)).

## 9. Round and match boundaries

```
fn onStartNextRound(state, action) -> (GameState, Event[])
  if state.phase != ROUND_END:      reject "WRONG_PHASE"
  if action.playerId != host:       reject "NOT_HOST"
  if isMatchOver(state):            reject "MATCH_OVER"           // 08
  s = state with { dealerIndex: (state.dealerIndex + 1) mod len(state.turnOrder) }
  return dealRound(s)
```

`REVEAL → ROUND_END → (DEALING | MATCH_END)` is engine-driven and covered in
[08-scoring.md](08-scoring.md).
