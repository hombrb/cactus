# 06 — Powers

Resolution of the card powers. Which rank has which power is
`cfg.powers.map` ([02](02-rule-config.md)); the values below are the `standard`
preset.

**A power fires if and only if a card drawn from the stock is discarded directly**
([01 §4](01-rules-reference.md#4-turn-structure)). Never on a swap, never on a
card taken from the discard, never on the round's seed card, never on a card that
reaches the discard by being snapped.

---

## 1. Resolving which power

```
fn powerFor(cfg, card: Card) -> PowerKind
  if card.rank == K:
    key = isRed(card) ? "K:red" : "K:black"
    if cfg.powers.map has key: return cfg.powers.map[key]

  if card.rank == A and not cfg.powers.aceGiveEnabled: return NONE

  if cfg.powers.map has string(card.rank): return cfg.powers.map[string(card.rank)]
  return NONE
```

Colour-qualified keys win over bare rank keys; an absent rank is `NONE`. This is
what lets the red/black King split coexist with rulesets where all Kings are the
same ([02](02-rule-config.md), `school` preset).

```
fn phaseForPower(kind: PowerKind) -> Phase
  match kind:
    PEEK_OWN       -> POWER_AWAIT_OWN_SLOT
    PEEK_OPPONENT  -> POWER_AWAIT_OPPONENT_SLOT
    BLIND_SWAP     -> POWER_AWAIT_TWO_SLOTS
    LOOK_AND_SWAP  -> POWER_AWAIT_TWO_SLOTS
    GIVE_CARD      -> POWER_AWAIT_GIVE_TARGET
    NONE           -> unreachable
```

`BLIND_SWAP` and `LOOK_AND_SWAP` share a collection phase and differ only in what
happens once both targets are in: the blind one swaps immediately, the King reveals
first and then asks.

## 2. One entry point

Every power collects its targets through the same action, so there is exactly one
validator and one dispatcher.

```
fn validate(state, PowerTarget { playerId, target }) -> Verdict
  pp = state.pendingPower
  if pp == null:                                  reject "NO_PENDING_POWER"
  if playerId != pp.ownerId:                      reject "NOT_YOUR_POWER"
  if not isCurrent(state, playerId):              reject "NOT_YOUR_TURN"
  return Ok                     // legality of the *target* is checked in reduce

fn onPowerTarget(state, action) -> (GameState, Event[])
  pp = state.pendingPower
  if not isLegalTarget(state, pp, action.target):
    return applyMisusePenalty(state, pp, reason: BAD_TARGET)

  pp = pp with { targets: pp.targets + [action.target] }
  s  = state with { pendingPower: pp }
  return resolvePowerTarget(s, pp)

fn resolvePowerTarget(state, pp) -> (GameState, Event[])
  match pp.kind:
    PEEK_OWN, PEEK_OPPONENT -> finishPeek(state, pp)
    BLIND_SWAP              -> len(pp.targets) < 2 ? (state, []) : finishBlindSwap(state, pp)
    LOOK_AND_SWAP           -> len(pp.targets) < 2 ? revealSecond(state, pp)
                                                   : askToSwap(state, pp)
    GIVE_CARD               -> finishGive(state, pp)
```

> **Why target legality is checked in `reduce`, not `validate`.** An illegal target
> is not a rejected action — it is a **misuse of the power**, which by the rules
> costs you a penalty card and your turn
> ([01 §5](01-rules-reference.md#5-powers)). Rejecting it instead would let a
> player probe the board for free ("is that slot empty?") with no consequence.
> This is the one place where a bad input is a game event rather than a no-op.

### Target legality

```
fn isLegalTarget(state, pp, ref: SlotRef) -> bool
  slot = slotOf(state, ref)
  if slot == null:                         return false     // no such player/slot
  if slot.cardId == EMPTY:                 return false     // snapped away
  if ref in state.lockedSlots:             return false     // mid-swap, see 07
  if playerOf(state, ref.playerId).eliminated: return false

  match pp.kind:
    PEEK_OWN       -> return ref.playerId == pp.ownerId
    PEEK_OPPONENT  -> return ref.playerId != pp.ownerId
    GIVE_CARD      -> return ref.playerId != pp.ownerId
    BLIND_SWAP, LOOK_AND_SWAP ->
      if len(pp.targets) == 0: return ref.playerId == pp.ownerId   // first: yours
      else:                    return ref.playerId != pp.ownerId   // second: theirs
                                  and ref != pp.targets[0]
```

The ordering rule for two-target powers (**yours first, then theirs**) is a UI
affordance as much as a rule: it removes the ambiguity of "which of these two do I
give away".

## 3. `PEEK_OWN` — 7, 8

Look at one of your own cards.

```
fn finishPeek(state, pp) -> (GameState, Event[])
  ref  = pp.targets[0]
  card = slotOf(state, ref).cardId
  s = withSlot(state, ref, markKnown(slotOf(state, ref), pp.ownerId))
  s = clearPower(s)
  return (s, [ CardRevealed { toPlayerId: pp.ownerId, ref, cardId: card } ])
```

- Knowledge gained: `ref.knownBy += ownerId`.
- Everyone else sees only *that* a peek happened, at which slot — never the face.
  That public fact is itself information (they now know you know), and it is
  correct to expose it.

## 4. `PEEK_OPPONENT` — 9, 10

Identical code path; only `isLegalTarget` differs. Peeking your own card with a
9 or 10 is a **misuse**, not a rejection.

The victim learns that their slot was looked at — again correct, and strategically
relevant.

## 5. `BLIND_SWAP` — Jack, Queen

Exchange one of yours for one of theirs, neither revealed.

```
fn finishBlindSwap(state, pp) -> (GameState, Event[])
  a = pp.targets[0]        // yours
  b = pp.targets[1]        // theirs
  s = swapSlots(state, a, b)
  s = clearPower(s)
  return (s, [ CardsSwapped { a, b } ])

fn swapSlots(state, a: SlotRef, b: SlotRef) -> GameState
  ca = slotOf(state, a).cardId
  cb = slotOf(state, b).cardId
  s = withSlot(state, a, Slot { cardId: cb, knownBy: {} })
  s = withSlot(s,     b, Slot { cardId: ca, knownBy: {} })
  return s
```

**`knownBy` is wiped on both sides.** This is the entire point of a blind swap:
whatever either player had memorised about those two positions is now wrong. An
implementation that carries `knownBy` across with the card would preserve the
victim's knowledge of a card they cannot see — and would leak through projection
([09](09-hidden-information.md)).

`CardsSwapped` is public in *position* and private in *content* — everyone sees
which two slots changed hands, nobody (including the swapper) sees what moved.

## 6. `LOOK_AND_SWAP` — black King

The strongest power: see one of yours, see one of theirs, then decide.

```
fn revealSecond(state, pp) -> (GameState, Event[])
  ref  = pp.targets[len(pp.targets) - 1]
  card = slotOf(state, ref).cardId
  s = withSlot(state, ref, markKnown(slotOf(state, ref), pp.ownerId))
  s = s with { pendingPower: pp with { revealed: pp.revealed + [ref] } }
  return (s, [ CardRevealed { toPlayerId: pp.ownerId, ref, cardId: card } ])

fn askToSwap(state, pp) -> (GameState, Event[])
  (s, events) = revealSecond(state, pp)          // reveal the opponent's card too
  s = s with { phase: POWER_AWAIT_SWAP_CONFIRM }
  return (s, events)

fn validate(state, PowerConfirmSwap { playerId, swap }) -> Verdict
  if state.phase != POWER_AWAIT_SWAP_CONFIRM: reject "WRONG_PHASE"
  if playerId != state.pendingPower.ownerId:  reject "NOT_YOUR_POWER"
  return Ok

fn onPowerConfirmSwap(state, action) -> (GameState, Event[])
  pp = state.pendingPower
  if not action.swap:
    return (clearPower(state), [ PowerDeclined { pp.ownerId, kind: pp.kind } ])

  a = pp.targets[0]; b = pp.targets[1]
  if not isLegalTarget(state, pp, a) or slotOf(state, b).cardId == EMPTY:
    // a snap emptied one of them while the King was deciding — see 07 and 11
    return applyMisusePenalty(state, pp, reason: TARGET_VANISHED)

  s = clearPower(swapSlots(state, a, b))
  return (s, [ CardsSwapped { a, b } ])
```

Two subtleties:

- **`knownBy` is wiped even here**, although the owner just saw both cards. This is
  deliberate and it is *not* a loss of fidelity: the owner saw the faces and is
  expected to remember them, exactly like a human. `knownBy` models *what the
  engine may show a client*, not *what a player remembers*
  ([09](09-hidden-information.md)). Keeping it set would let the client re-render
  the card indefinitely, which is cheating.
- **Between the reveal and the confirmation, the board can change.** A snap can
  empty a target slot. The re-check in `onPowerConfirmSwap` is mandatory, and the
  outcome is a misuse penalty rather than a silent no-op, because the King owner
  chose to dawdle.

## 7. `GIVE_CARD` — Ace *(off by default)*

Hand the drawn card to a player of your choice; it lands in their layout.

```
fn finishGive(state, pp) -> (GameState, Event[])
  victim = pp.targets[0].playerId
  cardId = pp.sourceCard

  // the Ace was already pushed onto the discard by onDiscardHeld — take it back
  s = state with { discard: state.discard[1..],
                   discardVersion: state.discardVersion + 1 }
  (s, slot) = addCardToLayout(s, victim, cardId, knownBy: {pp.ownerId})
  s = clearPower(s)
  return (s, [ CardGiven { fromPlayerId: pp.ownerId, toPlayerId: victim,
                           slot, cardId } ])
```

Consequences to be aware of before enabling `cfg.powers.aceGiveEnabled`:

- The victim's layout **grows**, so `handSize` stops being uniform. Everything
  downstream already tolerates this (`scoreLayout` iterates, `isLegalTarget`
  range-checks), but UI layouts must not assume 4.
- The given card is **known to the giver and nobody else** — including the victim.
  A hostile Ace is therefore strictly information-positive for the giver.
- Removing the Ace from the discard **bumps `discardVersion`**, closing the snap
  window it briefly opened. Anyone who snapped an Ace in that window loses the race
  cleanly rather than snapping onto a card that is no longer there.

## 8. Declining and misusing

```
fn validate(state, PowerSkip { playerId }) -> Verdict
  if state.pendingPower == null:             reject "NO_PENDING_POWER"
  if playerId != state.pendingPower.ownerId: reject "NOT_YOUR_POWER"
  return Ok

fn onPowerSkip(state, action) -> (GameState, Event[])
  pp = state.pendingPower
  return (clearPower(state), [ PowerDeclined { pp.ownerId, kind: pp.kind } ])
```

Declining is always free and always legal. A player who has nothing useful to look
at should not be forced to reveal that they looked.

```
fn applyMisusePenalty(state, pp, reason) -> (GameState, Event[])
  s = clearPower(state)
  events = []
  for i from 1 to state.config.powers.misusePenaltyCards:
    (s, drawEvents, slot, cardId) = drawPenaltyCard(s, pp.ownerId, reason)
    events += drawEvents + [ PenaltyCardTaken { pp.ownerId, slot, cardId, reason } ]
  return (s, events)

fn drawPenaltyCard(state, playerId, reason) -> (GameState, Event[], SlotIndex, CardId)
  if len(state.stock) == 0 and not canRefillStock(state):
    return (state, [], -1, null)                    // no cards left: penalty is void
  (s, refillEvents) = ensureStock(state)
  cardId = s.stock[0]
  s = s with { stock: s.stock[1..] }
  (s, slot) = addCardToLayout(s, playerId, cardId, knownBy: {})
  return (s, refillEvents, slot, cardId)

fn addCardToLayout(state, playerId, cardId, knownBy) -> (GameState, SlotIndex)
  layout = layoutOf(state, playerId)
  i = index of the first EMPTY slot in layout, or len(layout) if none
  // reuse holes before growing, so layouts stay compact and renderable
  return (withSlot(state, SlotRef{playerId, i}, Slot { cardId, knownBy }), i)
```

The penalty card is **face down and known to nobody** — including its owner. It is
a pure liability of unknown size, which is what makes power misuse expensive.

```
fn clearPower(state) -> GameState
  return state with { pendingPower: null, phase: TURN_END }
```

## 9. What each power teaches whom

The table projection ([09](09-hidden-information.md)) depends on this being exact.

| Power | Actor learns | Target learns | Table learns |
|-------|--------------|---------------|--------------|
| `PEEK_OWN` | the face of one own card | — | that the actor peeked, and at which own slot |
| `PEEK_OPPONENT` | the face of one opponent card | that this slot was seen, by whom | which slot was seen, by whom |
| `BLIND_SWAP` | nothing | that this slot changed | which two slots changed |
| `LOOK_AND_SWAP` | the face of both cards | that this slot was seen, and whether it changed | which slots were seen and whether a swap followed |
| `GIVE_CARD` | the face of the given card | that they received a card, at which slot | who gave to whom, at which slot |
| misuse | nothing | — | that a penalty card was taken, and the reason |

Every "learns" in the actor column corresponds to a `CardRevealed` with
`toPlayerId = actor`; everything in the other two columns is derivable from the
public shape of the events. If an implementation can reconstruct more than this
table allows from the projected stream, projection is leaking.
