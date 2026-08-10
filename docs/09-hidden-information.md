# 09 — Hidden Information

Cactus is a game about not knowing your own cards. If the engine leaks, there is
no game left. This file specifies exactly what each participant may see.

**The rule everything follows from:**

> The authoritative `GameState` knows every card. **No client ever receives it.**
> Clients receive a `PlayerView` and a stream of projected events, and nothing else.

---

## 1. Where knowledge lives

`Slot.knownBy: Set<PlayerId>` ([03 §2](03-domain-model.md#2-slots-and-layouts)) is
the single source of truth for both projections. It answers one question and only
one:

> *May the server currently render this card's face to this player?*

It is **not** a model of memory. A player who was shown a card and forgot it still
has their id in `knownBy`; a player who watched a `SnapFailed` go by and memorised
the card does not. That asymmetry is intentional and is covered in §5.

`knownBy` is written in exactly five places:

| Written by | Effect |
|---|---|
| `dealRound` ([05](05-engine-core.md)) | `{}` — nobody knows anything |
| `onPeekInitial` ([05](05-engine-core.md)) | `+= peeker` |
| `onPlaceInSlot` ([05](05-engine-core.md)) | reset to `{placer}` |
| `finishPeek` / `revealSecond` ([06](06-powers.md)) | `+= power owner` |
| `swapSlots`, snap outcomes ([06](06-powers.md), [07](07-snap.md)) | reset to `{}` |

The two **resets** carry the weight. Any time the card in a slot changes, prior
knowledge about that slot is void — that is what makes a blind swap blind.

## 2. Projecting state

```
const HIDDEN = "hidden"

type VisibleCard = CardId | HIDDEN

type PlayerView {
  you:            PlayerId
  phase:          Phase
  roundNumber:    int
  turnNumber:     int
  config:         RuleConfig         // the rules are public; the renderer needs them
  hostId:         PlayerId           // who may StartMatch / StartNextRound
  turnOrder:      PlayerId[]         // seating, which is public by definition
  currentPlayer:  PlayerId
  players: {
    id: PlayerId, name: string, connected: bool,
    eliminated: bool, cumulativeScore: int, roundScore: int?,
    hasPeeked: bool,
    layout: VisibleCard[]            // EMPTY stays EMPTY and is visible to all
  }[]
  discard:        CardId[]           // fully public, always
  discardVersion: int
  stockCount:     int                // count only — never contents
  heldBy:         PlayerId?          // who is holding a card
  heldCard:       VisibleCard?       // the id only if you are the holder
  pendingPower:   { kind, ownerId, targets: SlotRef[] }?   // shape, not content
  pendingSnapGive: { snapperId, victimId, victimSlot }?    // everyone saw the snap
  announcerId:    PlayerId?
  finalLapRemaining: int?
  cards:          Record<CardId, Card>   // only the faces this viewer may render
}

fn projectFor(state, viewer: PlayerId) -> PlayerView
  revealAll = state.phase in { REVEAL, ROUND_END, MATCH_END }

  players = []
  for p in state.players:
    layout = []
    for slot in p.layout:
      if slot.cardId == EMPTY:            layout.push(EMPTY)
      else if revealAll:                  layout.push(slot.cardId)
      else if viewer in slot.knownBy:     layout.push(slot.cardId)
      else:                               layout.push(HIDDEN)
    players.push({ ...p without layout/roundScore, layout })

  return PlayerView {
    you: viewer, phase: state.phase, ...,
    discard: state.discard,
    stockCount: len(state.stock),
    heldBy: state.heldCard == null ? null : currentPlayer(state),
    heldCard: (state.heldCard != null and viewer == currentPlayer(state)
               and state.phase == AWAIT_HELD_DECISION)
              ? state.heldCard : (state.heldCard == null ? null : HIDDEN),
    cards: faces the viewer is entitled to render,
  }
```

**The view is the renderer's whole world.** A client that can reach past it into
`GameState` is a client that cannot be moved onto a network, so the rule is not
"project what is secret" but "project everything, minus what is secret". That is
why `config`, `hostId`, `turnOrder` and `pendingSnapGive` are in the type above:
all four are public knowledge, and the alternative was a renderer that only works
on the authority's own machine. Round and cumulative scores ride inside
`players[]` rather than in a separate `scores` block — one place, always present,
`roundScore` null until the reveal fills it in.

Five things that are **never** projected under any circumstances:

1. `state.stock` contents — only `stockCount`.
2. `state.rngSeed` / `rngCursor` — the seed *is* the stock order.
3. `state.cards` for ids the viewer cannot see — send the `CardTable` entries
   lazily, or send only ids the viewer has been given.
4. `Slot.knownBy` — it would tell you who has memorised what.
5. `state.eventLog` raw — see §3.

> **`heldCard` when the source was the discard.** In `AWAIT_SLOT_FOR_DISCARD` the
> held card is public: everyone watched it come off the face-up pile. The
> projection above returns `HIDDEN` for non-holders in that phase, which is
> *stricter than the rules require* but harmless — the client already has the id
> from the public `DiscardTaken` event. Implementations may relax this; do not
> tighten the reverse case.

## 3. Projecting events

The event stream is where leaks actually happen, because events are easy to
broadcast verbatim.

```
fn projectEvent(state, event, viewer: PlayerId) -> Event?
  match event:

    // ---- private payloads: the fact is public, the face is not ----
    CardsDealt { deals } ->
      return CardsDealt { deals: [ {d.playerId, d.slot,
                                    cardId: HIDDEN} for d in deals ] }

    InitialPeeked { playerId, reveals } ->
      if viewer == playerId: return event
      return InitialPeeked { playerId, reveals: [{r.slot, HIDDEN} for r in reveals] }

    StockDrawn { playerId, cardId } ->
      if viewer == playerId: return event
      return StockDrawn { playerId, cardId: HIDDEN }

    CardRevealed { toPlayerId, ref, cardId } ->
      if viewer == toPlayerId: return event
      return CardRevealed { toPlayerId, ref, cardId: HIDDEN }

    CardPlaced { playerId, slot, placedCardId, discardedCardId } ->
      return CardPlaced { playerId, slot,
                          placedCardId: viewer == playerId ? placedCardId : HIDDEN,
                          discardedCardId }              // face up ⇒ public

    CardGiven { fromPlayerId, toPlayerId, slot, cardId } ->
      if viewer == fromPlayerId: return event
      return CardGiven { fromPlayerId, toPlayerId, slot, cardId: HIDDEN }

    PenaltyCardTaken { playerId, slot, cardId, reason } ->
      return PenaltyCardTaken { playerId, slot, cardId: HIDDEN, reason }
      // face down and unknown even to its owner — see 06 §8

    // ---- private to the actor ----
    ActionRejected { playerId, ... } ->
      return viewer == playerId ? event : null

    // ---- fully public ----
    DiscardSeeded, DiscardTaken, HeldDiscarded, SnapSucceeded, SnapFailed,
    SlotEmptied, CardsSwapped, PowerStarted, PowerDeclined, CactusAnnounced,
    FinalLapAdvanced, TurnStarted, TurnEnded, StockReshuffled, RoundStarted,
    MatchStarted, AllPeeked, ConnectionChanged, RoundRevealed, RoundScored,
    MatchEnded -> return event
```

Note what stays public and why:

- **`CardsSwapped { a, b }`** carries no card ids at all, so it needs no
  redaction — but the *positions* are public, and must be: everyone at a real table
  sees which two cards changed hands.
- **`PowerStarted { kind }`** is public. The table knows a 9 was discarded; they
  can see it on the pile. Hiding the power kind would leak *less* than the discard
  already does.
- **`PenaltyCardTaken`** is redacted for **everyone including the owner**. A
  penalty card is face down and unknown to its owner
  ([06 §8](06-powers.md#8-declining-and-misusing)) — that is what makes it a
  penalty.

## 4. Verifying that projection is tight

The check is mechanical: for each power and each event, what the projected stream
allows a viewer to reconstruct must match the table in
[06 §9](06-powers.md#9-what-each-power-teaches-whom) exactly.

A practical test, worth writing once:

```
fn assertNoLeak(state, actionSequence)
  for each viewer v:
    stream = [ projectEvent(s, e, v) for each (s, e) produced by replaying actionSequence ]
    known  = cardIds appearing non-HIDDEN anywhere in stream ∪ projectFor(state, v)
    expected = { id : id in state.discard }
             ∪ { slot.cardId : any slot with v in slot.knownBy }
             ∪ { state.heldCard if v is the holder }
    assert known ⊆ expected
```

If `known` ever exceeds `expected`, a projection branch is missing.

## 5. What the engine deliberately does **not** model

**Memory.** The engine never remembers for a player, and never forgets for them
either. Concretely:

- A card the player was *shown* leaves `knownBy` the moment that slot's card
  changes. The client **must stop rendering it** at that point, even though the
  human may still remember it. This is correct: the human's memory may now be
  wrong, and being wrong is the game.
- A card the player *saw in a public event* (a failed snap, a discard) is never in
  `knownBy`, and the client must not pin it to the layout. They watched it; let
  them remember it.
- Therefore: **clients must not persist revealed faces beyond the reveal
  animation** (`cfg.timing.peekRevealMs`). No "notes" overlay, no card-back
  annotations, no local cache of previously-seen values. A client that does this
  is not a UI convenience — it is a cheat client, and it makes the game trivial.

This is the one rule the server cannot enforce. State it in the client code, and
prefer a first-party client for competitive play.

The one boundary case, because it is a *pending question* rather than a memory: a
look may last until the power that granted it has been answered. The black King
shows one card, then the other, then asks whether to swap them
([06 §6](06-powers.md)); consuming both looks before the question arrives leaves the
player answering from memory about cards they are still entitled to see. Holding
the grant open until they answer is not persistence — nothing is cached, the card
still hides the moment they let go, and `knownBy` is cleared by the swap itself, so
the projection ends it whatever the client would prefer.

**Belief.** The engine cannot know whether a player *thinks* they are under the
threshold, which is why `cfg.announce.requiresThreshold` is advisory in networked
play ([05 §6](05-engine-core.md#6-announcing)). Enforcing it server-side would
leak the announcer's hand through the rejection itself: "your announcement was
refused" tells the whole table you are above 5.

## 6. Reconnection

A reconnecting client is re-sent `projectFor(state, viewer)` plus the projected
event log from their last acknowledged index
([10 §4](10-multiplayer-and-modes.md#4-reconnection)).

The subtle part: **a peek that happened while you were disconnected is gone.** The
`CardRevealed` event is in the log and will be replayed, so the id is recoverable
from the stream — which means a reconnect would hand you information you missed.
Two acceptable policies, and you must pick one explicitly:

- **Replay everything** (default): the log is the truth, and a dropped connection
  should not cost you information you had a right to. Simple, and forgiving.
- **Replay redacted**: `CardRevealed` events older than the disconnect are
  downgraded to `HIDDEN`. Harsher, and it punishes bad networks.

Default to the first. It is the only one that does not make packet loss part of
the game.
