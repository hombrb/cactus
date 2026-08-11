# 07 — Snap (*défausse rapide*)

The out-of-turn matching discard. Mechanically it is three lines of rules and by
far the largest source of implementation bugs, because it is the only place where
**several players act at the same instant**.

Rules recap ([01 §6](01-rules-reference.md#6-défausse-rapide-snap)): at any moment
any player may slam a card from their layout onto the discard if its rank matches
the top. Right → that slot is gone forever. Wrong → the card goes back face down
and you take a penalty card.

---

## 1. Two mechanisms, kept apart

| Concern | Owned by | Where |
|---------|----------|-------|
| *Is this snap legal, and what does it do to the board?* | the pure reducer | this file |
| *Whose packet counts as "first"?* | the authority's transport layer | [10 §5](10-multiplayer-and-modes.md#5-snap-fairness) |

The reducer is **timestamp-free and deterministic**: given an ordered sequence of
`Snap` actions it always produces the same result. Real-time fairness — buffering
for `cfg.timing.snapGraceMs`, compensating for latency — happens *before* actions
reach the reducer, in the authority. That keeps replay exact and keeps clock
handling out of the rules.

## 2. The snap window

```
discardVersion  — increments on every change of the discard's top card
Snap.forVersion — the version the player was reacting to when they clicked
```

A snap is an answer to a specific question ("the top is a 7 — who has a 7?").
`forVersion` is what makes it latency-tolerant: a player who clicks 300 ms after
the 7 appeared, but whose packet arrives after somebody else has already snapped,
is a **loser of that race** rather than a player who snapped at the wrong card.
The two deserve different treatment, and only `forVersion` can tell them apart.

Version changes on: `DiscardSeeded`, `DiscardTaken`, `CardPlaced` (when a card was
displaced), `HeldDiscarded`, a successful `Snap`, and the Ace-give retraction
([06 §7](06-powers.md#7-give_card--ace-off-by-default)). It does **not** change on
`StockReshuffled` — the top card is untouched there, so open windows survive
([05 §5.2](05-engine-core.md#52-restocking)).

## 3. Validation

```
fn validate(state, Snap { playerId, target, forVersion }) -> Verdict
  cfg = state.config
  if not cfg.snap.enabled:                        reject "SNAP_DISABLED"
  if not inRound(state):                          reject "WRONG_PHASE"
  if len(state.discard) == 0:                     reject "DISCARD_EMPTY"
  if playerOf(state, playerId) == null
     or playerOf(state, playerId).eliminated:     reject "NOT_IN_ROUND"
  if state.finalLapRemaining != null
     and not cfg.snap.allowedDuringFinalLap:      reject "SNAP_CLOSED"
  if forVersion > state.discardVersion:           reject "FUTURE_VERSION"

  slot = slotOf(state, target)
  if slot == null:                                reject "BAD_SLOT"
  if slot.cardId == EMPTY:                        reject "SLOT_EMPTY"
  if target in state.lockedSlots:                 reject "SLOT_LOCKED"
  if target.playerId != playerId
     and not cfg.snap.allowOnOpponent:            reject "NOT_YOUR_CARD"

  return Ok                     // whether the rank *matches* is decided in reduce
```

As with powers ([06 §2](06-powers.md#2-one-entry-point)), a **wrong** snap is
validated as `Ok` and then punished. Rejecting it would turn the snap button into
a free oracle: click, get "invalid", learn the card was not a 7, pay nothing.

Note that `SLOT_EMPTY` and `SLOT_LOCKED` *are* rejections rather than punishments.
Both are states the client can see for itself, so no information leaks, and both
are almost always a race the player did not cause.

## 4. Reduction

```
fn onSnap(state, action) -> (GameState, Event[])
  cfg     = state.config
  topCard = cardOf(state, state.discard[0])
  slot    = slotOf(state, action.target)
  card    = cardOf(state, slot.cardId)

  if action.forVersion < state.discardVersion:
    return resolveLostRace(state, action, card)

  if not matches(cfg, card, topCard):
    return resolveFailedSnap(state, action, card, reason: RANK_MISMATCH)

  return resolveSuccessfulSnap(state, action, card)

fn matches(cfg, a: Card, b: Card) -> bool
  if cfg.snap.matchOn == RANK_AND_SUIT: return a.rank == b.rank and a.suit == b.suit
  return a.rank == b.rank
```

### 4.1 Success

```
fn resolveSuccessfulSnap(state, action, card) -> (GameState, Event[])
  cfg = state.config
  ref = action.target

  s = withSlot(state, ref, Slot { cardId: EMPTY, knownBy: {} })
  s = s with { discard: [card.id] + s.discard,
               discardVersion: s.discardVersion + 1 }

  events = [ SnapSucceeded { action.playerId, ref, cardId: card.id },
             SlotEmptied { ref } ]

  if ref.playerId != action.playerId:
    // snapped somebody else's card: the snapper now owes them one
    s = s with { pendingSnapGive: PendingSnapGive { snapperId: action.playerId,
                                                    victimId: ref.playerId,
                                                    victimSlot: ref.slot },
                 resumePhase: s.phase,
                 phase: AWAIT_SNAP_GIVE }
    return (s, events)

  if cfg.snap.emptyLayoutEndsRound and hasNoCards(s, action.playerId):
    (s, revealEvents) = beginReveal(s, reason: LAYOUT_EMPTIED)      // 08
    return (s, events + revealEvents)

  // The card left this player's own layout for the discard, so under this rule it
  // fires its power — theirs, and out of turn (06 §10). Deliberately after both
  // returns above, and skipped when anything is already pending: `resumePhase`
  // holds one phase, and taking it would overwrite somebody else's power.
  // `s.phase` is untouched here, which is exactly what `clearPower` puts back.
  if cfg.powers.onHandDiscard
     and state.pendingPower == null and state.pendingSnapGive == null:
    started = beginPower(s, action.playerId, card.id, resumePhase: s.phase)
    if started != null: return (started.state, events + started.events)

  return (s, events)                    // phase unchanged: the turn carries on
```

Points that matter:

- **The slot stays.** `cardId = EMPTY`, the array is not spliced. Everyone's memory
  of "their bottom-right is a King" must survive
  ([03 §2](03-domain-model.md#2-slots-and-layouts)).
- **`SnapSucceeded` is fully public, card id included** — it is face up on the pile
  now. This is the main way information enters the table.
- **The phase is untouched.** A snap that lands while the current player is holding
  a drawn card leaves them holding it. Snap is not a turn. The two exceptions both
  borrow the phase and give it back through `resumePhase`: a snap on somebody
  else's card (above) and, under `cfg.powers.onHandDiscard`, the power the snapped
  card fires ([06 §10](06-powers.md#10-powers-on-a-hand-discard--onhanddiscard)).
  The drawn card is still in its holder's hand throughout either.
- **The successful snap bumps `discardVersion`**, opening a *new* window on the
  same rank. Chained snaps ("three 7s go out in a second") fall out of this for
  free, and each one is a fresh, fair race.

### 4.2 Failure

```
fn resolveFailedSnap(state, action, card, reason) -> (GameState, Event[])
  cfg = state.config
  ref = action.target

  // the card goes back, face down, into the same slot — but the table has seen it
  s = withSlot(state, ref, Slot { cardId: card.id, knownBy: {} })

  events = [ SnapFailed { action.playerId, ref, cardId: card.id, reason } ]
  for i from 1 to cfg.snap.failurePenaltyCards:
    (s, drawEvents, slot, penaltyId) = drawPenaltyCard(s, action.playerId,
                                                       reason: SNAP_FAILURE)   // 06
    events += drawEvents + [ PenaltyCardTaken { action.playerId, slot,
                                                cardId: penaltyId,
                                                reason: SNAP_FAILURE } ]
  return (s, events)
```

- `knownBy` is **cleared, not preserved**: the snapper obviously knows the card, but
  so does everyone at the table now. Rather than add every player to `knownBy`,
  clear it and rely on `SnapFailed` being a public event — clients that were
  watching saw the face and may remember it exactly as a human would. This keeps
  `knownBy` meaning "the engine may re-render this for you", not "you saw it once".
- The penalty card lands in the first `EMPTY` slot, or extends the layout.
- Failing a snap on **somebody else's** card (`allowOnOpponent`) penalises the
  snapper and leaves the victim's card in place — revealed to the table, which is
  punishment enough for the victim.

### 4.3 Losing the race

```
fn resolveLostRace(state, action, card) -> (GameState, Event[])
  if state.config.snap.loserPenalty == AS_FAILED_SNAP:
    return resolveFailedSnap(state, action, card, reason: LOST_RACE)
  return (state, [ ActionRejected { action.playerId, action, "SNAP_TOO_LATE" } ])
```

Default (`NONE`) is forgiving: two people going for the same 7 is not a mistake,
and punishing the slower connection is punishing the network. `AS_FAILED_SNAP` is
the harsher table rule, available in the `hardcore` preset.

Note that a losing snapper **still revealed nothing** under `NONE` — the action is
rejected before any card is exposed. That is deliberate.

## 5. Paying the victim (`snap.allowOnOpponent`)

```
fn validate(state, SnapGive { playerId, slot }) -> Verdict
  if state.phase != AWAIT_SNAP_GIVE:                reject "WRONG_PHASE"
  psg = state.pendingSnapGive
  if playerId != psg.snapperId:                     reject "NOT_YOUR_GIVE"
  ref = SlotRef { playerId, slot }
  if slotOf(state, ref) == null:                    reject "BAD_SLOT"
  if slotOf(state, ref).cardId == EMPTY:            reject "SLOT_EMPTY"
  if ref in state.lockedSlots:                      reject "SLOT_LOCKED"
  return Ok

fn onSnapGive(state, action) -> (GameState, Event[])
  psg    = state.pendingSnapGive
  from   = SlotRef { psg.snapperId, action.slot }
  cardId = slotOf(state, from).cardId

  s = withSlot(state, from, Slot { cardId: EMPTY, knownBy: {} })
  s = withSlot(s, SlotRef { psg.victimId, psg.victimSlot },
               Slot { cardId, knownBy: {psg.snapperId} })

  s = s with { pendingSnapGive: null, phase: s.resumePhase, resumePhase: null }

  events = [ CardGiven { fromPlayerId: psg.snapperId, toPlayerId: psg.victimId,
                         slot: psg.victimSlot, cardId } ]

  if s.config.snap.emptyLayoutEndsRound and hasNoCards(s, psg.snapperId):
    (s, revealEvents) = beginReveal(s, reason: LAYOUT_EMPTIED)
    events += revealEvents

  return (s, events)
```

Why this is the strongest optional rule in the game: you dump your worst card into
a hole you just made, and you only do it when memory told you the victim held a
match. It converts remembering into tempo. It is off by default because it roughly
doubles the skill gap.

Note the give **can empty the snapper's own layout** — hence the second
`hasNoCards` check.

## 6. Slot locking

`lockedSlots` exists for exactly one situation: a slot that has been *revealed and
committed to* but not yet acted on, where a snap in between would change what the
acting player already saw.

In the `standard` ruleset that is one case:

- **`POWER_AWAIT_SWAP_CONFIRM`** (black King). Both targets are locked from the
  moment the second is revealed until the swap resolves or is declined.

```
// in askToSwap (06)
s = s with { lockedSlots: { pp.targets[0], pp.targets[1] } }

// in clearPower (06)
return state with { pendingPower: null, lockedSlots: {}, phase: TURN_END }
```

No lock is needed while a player holds a drawn card: the held card is out of every
layout, and placing into a slot that a snap has just emptied is legal
([05 §5.4](05-engine-core.md#54-place-the-held-card-into-a-slot)).

> **Locking vs. re-checking.** With locking in place, the `TARGET_VANISHED` branch
> in [06 §6](06-powers.md#6-look_and_swap--black-king) is unreachable. Both
> mechanisms are specified because either is a complete answer: lock and the
> re-check is dead code; skip locking and the re-check catches it. Implement one
> and keep the other as an assertion. What is **not** acceptable is neither — a
> King that swaps a card which no longer exists corrupts the card-conservation
> invariant ([11](11-edge-cases-and-invariants.md)).

## 7. Snap and the end of the round

- `cfg.snap.allowedDuringFinalLap = true` (default): the final lap is loud. Players
  dump matching cards while the announcer sweats. This is the rule as played.
- `false`: the announcement freezes the board except for turns.
- A snap that empties a layout **beats an in-flight final lap**
  ([04 §5](04-state-machine.md#5-round-over-conditions)) — the emptied player has
  provably finished at 0, so there is nothing left to play for.
- After `REVEAL`, snapping is rejected by `inRound`.

## 8. Two players on one device

Whether snap survives on a shared screen depends entirely on **how the device is
held**, and the two cases give opposite answers:

- **Passed from hand to hand.** Snap must be off. Only the holder can reach the
  screen, so they win every race by construction; the mechanic stops being a
  reflex test and becomes a device advantage.
- **Flat on the table between two players.** Snap works, and is the arrangement
  the `table2p` preset assumes. Both players can reach their own half at all
  times, so the race is genuine — it is decided by arms, exactly as at a real
  table.

In the flat-table case the authority is the browser: competing snaps are ordered
by **`pointerdown` timestamp**, not by when the gesture is recognised, so the
recogniser's own latency never decides the winner. Everything else — the window
identified by `discardVersion`, success and failure handling, the penalty card —
is unchanged from the sections above, because the reducer never knew about
timestamps in the first place.

The gesture must not be a tap. A tap already means "place a card here" or "choose
this power target", and a mis-tap that costs a penalty card is a bad trade. A
**swipe toward the middle** is unambiguous, fast enough for a reflex race, and
mirrors the physical act of slamming a card onto the pile.
