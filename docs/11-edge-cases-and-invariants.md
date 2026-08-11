# 11 — Edge Cases, Invariants, and a Worked Trace

The acceptance criteria for the spec. If an implementation handles every row of
§1, holds every invariant in §2, and reproduces §3 exactly, it is correct.

---

## 1. Edge cases

| # | Situation | Expected behaviour | Handled in |
|---|---|---|---|
| 1 | Stock empties mid-turn | Reshuffle the discard except its top card, same RNG stream; `discardVersion` unchanged so open snap windows survive | [05 §5.2](05-engine-core.md#52-restocking) |
| 2 | Stock empty **and** discard holds only its top card | No refill possible: round ends at the next check with reason `STOCK_DEAD` | [05 §7](05-engine-core.md#7-ending-a-turn), [04 §5](04-state-machine.md#5-round-over-conditions) |
| 3 | `cfg.deck.reshuffleDiscard = false` | Every stock exhaustion ends the round immediately | [05 §5.2](05-engine-core.md#52-restocking) |
| 4 | Penalty card needed but no cards remain | Penalty is **void**, not deferred; `drawPenaltyCard` returns unchanged | [06 §8](06-powers.md#8-declining-and-misusing) |
| 5 | Two players snap the same top card | The authority buffers for `snapGraceMs`, orders by latency-adjusted arrival, submits in order; first valid wins, rest are lost races | [10 §5](10-multiplayer-and-modes.md#5-snap-fairness), [07 §4.3](07-snap.md#43-losing-the-race) |
| 6 | A snap arrives for an already-superseded `discardVersion` | Lost race — silent rejection (`NONE`) or failed snap (`AS_FAILED_SNAP`) per config; **never** a mismatch penalty by default | [07 §4.3](07-snap.md#43-losing-the-race) |
| 7 | Snap targets an `EMPTY` slot | Rejected (`SLOT_EMPTY`), no penalty — the client could see it was empty, so nothing leaks | [07 §3](07-snap.md#3-validation) |
| 8 | Snap targets a locked slot (black King mid-decision) | Rejected (`SLOT_LOCKED`), no penalty | [07 §3](07-snap.md#3-validation), [07 §6](07-snap.md#6-slot-locking) |
| 9 | A snap empties a slot the current player is about to place into | Legal and harmless: placing into `EMPTY` adds nothing to the discard | [05 §5.4](05-engine-core.md#54-place-the-held-card-into-a-slot) |
| 10 | Black King's target vanishes between reveal and confirm | Impossible under locking; if locking is omitted, the re-check yields a misuse penalty. Never a corrupt swap | [06 §6](06-powers.md#6-look_and_swap--black-king), [07 §6](07-snap.md#6-slot-locking) |
| 11 | A player's layout becomes empty | `cfg.snap.emptyLayoutEndsRound` → reveal immediately, that player scores 0. Otherwise play continues with a 0-card player | [07 §4.1](07-snap.md#41-success), [08 §1](08-scoring.md#1-card-values) |
| 12 | An emptied layout coincides with an in-flight final lap | The emptied layout **wins**; the lap is abandoned | [04 §5](04-state-machine.md#5-round-over-conditions) |
| 13 | Power targets a player with no cards left | Every slot is `EMPTY`, so `isLegalTarget` fails ⇒ misuse penalty. The UI must grey those layouts out | [06 §2](06-powers.md#target-legality) |
| 14 | Power targets an `EMPTY` slot | Misuse penalty, **not** a rejection — otherwise the button becomes a free board oracle | [06 §2](06-powers.md#2-one-entry-point) |
| 15 | `PEEK_OPPONENT` aimed at your own card | Misuse penalty | [06 §4](06-powers.md#4-peek_opponent--9-10) |
| 16 | Layout grows past `handSize` via penalties or `GIVE_CARD` | Fully supported: holes are reused before appending; scoring and targeting iterate. UI must not assume 4 | [06 §8](06-powers.md#8-declining-and-misusing) |
| 17 | Two-player game, one announces | `finalLapRemaining = 1`; the opponent takes one turn; reveal | [05 §6](05-engine-core.md#6-announcing) |
| 18 | A second player tries to announce | Rejected `ALREADY_ANNOUNCED`. There is no counter-announcement in this spec | [05 §6](05-engine-core.md#6-announcing) |
| 18a | `AFTER_TURN`: announcing while the next player is mid-turn | Accepted. Their turn is untouched and is already the first of the final lap, so the lap comes out exactly as it would have one action earlier | [05 §6](05-engine-core.md#6-announcing) |
| 18b | `AFTER_TURN`: announcing after the next player has finished | Rejected `NOT_YOUR_TURN` — `previousPlayerId` has moved to them | [05 §6](05-engine-core.md#6-announcing) |
| 18c | `AFTER_TURN`: the round ends before you announce (stock death, emptied layout) | The window does not survive into `REVEAL`; nobody announced, and scoring takes the no-announcer branch | [05 §6](05-engine-core.md#6-announcing) |
| 19 | The announcer tries to play again | `advanceTurn` skips them; any action from them is `NOT_YOUR_TURN`. They may still snap | [05 §7](05-engine-core.md#7-ending-a-turn) |
| 20 | The announcer snaps during the final lap | Legal by default (`snap.allowedDuringFinalLap`) | [07 §7](07-snap.md#7-snap-and-the-end-of-the-round) |
| 21 | Round ends while a player holds a drawn card | `beginReveal` returns the held card to the discard so conservation holds | [08 §2](08-scoring.md#2-entering-the-reveal) |
| 22 | Nobody announced (stock death / emptied layout) | No announcer branch: everyone scores their own sum, nobody is penalised | [08 §3](08-scoring.md#3-round-scoring) |
| 23 | Announcer ties for lowest | `tieCountsAsFailure = true` ⇒ failure. Flipped in the `school` preset | [08 §3](08-scoring.md#3-round-scoring) |
| 24 | Two players tie for lowest, neither is the announcer | Both simply score their sum; the round has no "winner" concept, only scores | [08 §3](08-scoring.md#3-round-scoring) |
| 25 | Two players simultaneously hold a kamikaze hand | Cancels; the round scores normally. Reachable only with two decks | [08 §4](08-scoring.md#kamikaze) |
| 26 | `announce.requiresThreshold` set, in networked play | **Not enforced.** Enforcing it would leak the announcer's hand through the rejection | [05 §6](05-engine-core.md#6-announcing), [09 §5](09-hidden-information.md#5-what-the-engine-deliberately-does-not-model) |
| 27 | Disconnect mid-power | `Timeout` issues `PowerSkip`; the power is lost, no penalty | [05 §8](05-engine-core.md#8-timeouts) |
| 28 | Disconnect on your turn | `Timeout` draws and discards. **Never** announces, never takes from the discard | [05 §8](05-engine-core.md#8-timeouts) |
| 29 | A timeout races a real action | `phaseToken != actionCounter` ⇒ dropped silently, not rejected | [05 §8](05-engine-core.md#8-timeouts) |
| 30 | A player never peeks initially | `cfg.timing.initialPeekMs` expires, the round starts, they play blind | [05 §4](05-engine-core.md#4-the-initial-peek-barrier) |
| 31 | Host leaves | Promote the next connected player; never block the room | [10 §2](10-multiplayer-and-modes.md#2-rooms) |
| 32 | Reconnect after a peek you missed | Full replay by default; the redacted-replay policy is the documented alternative | [09 §6](09-hidden-information.md#6-reconnection) |
| 33 | Ace-give retracts a card from the discard | `discardVersion` bumps, closing the window it briefly opened | [06 §7](06-powers.md#7-give_card--ace-off-by-default) |
| 34 | Snapping your last card while owing a `SnapGive` | The give is resolved first, then the empty-layout check runs again | [07 §5](07-snap.md#5-paying-the-victim-snapallowonopponent) |
| 35 | Two decks: two identical cards | `CardId` disambiguates; conservation and replay stay exact | [03 §1](03-domain-model.md#1-cards) |
| 36 | Match limit reached mid-round | Checked only at `finishScoring`; a round always completes | [08 §3](08-scoring.md#3-round-scoring) |

## 2. Invariants

Asserted by `checkInvariants(state)` after **every** reduction
([05 §1](05-engine-core.md#1-the-contract)). A violation is an engine bug, never a
rules outcome.

### Card conservation

```
fn checkInvariants(state) -> bool
  seen = []
  seen += state.stock
  seen += state.discard
  if state.heldCard != null: seen += [state.heldCard]
  for p in state.players:
    for slot in p.layout where slot.cardId != EMPTY: seen += [slot.cardId]

  assert len(seen) == totalDeckSize(state.config), "cards leaked or duplicated"
  assert hasNoDuplicates(seen),                    "same card in two places"
  assert every id in seen is a key of state.cards, "unknown card id"
```

This single check catches most swap, snap, and power bugs. Run it in production
too — it is O(deck).

### Structural

| Invariant | Why |
|---|---|
| `heldCard != null` **iff** `resumePhase ?? phase` `in {AWAIT_HELD_DECISION, AWAIT_SLOT_FOR_DISCARD}` | A held card outside those phases is a lost card — but the snap channel can park `AWAIT_SNAP_GIVE`, or a power ([06 §10](06-powers.md)), on top of a turn that is still holding one. `resumePhase` is what names the phase the card really belongs to; read against `phase` alone, every such interruption looks like a loss |
| `pendingPower != null` **iff** `phase` is a `POWER_*` phase | Prevents an orphaned power surviving into the next turn |
| `pendingSnapGive != null` **iff** `phase == AWAIT_SNAP_GIVE`, and `resumePhase != null` alongside it | The snap channel must always know where to return |
| `pendingPower` and `pendingSnapGive` are never both set | They share `resumePhase`, so holding both loses one of the phases owed back. `resolveSuccessfulSnap` fires no power for a snap on somebody else's card, which is what keeps them apart |
| `lockedSlots` is empty outside `POWER_AWAIT_SWAP_CONFIRM` | A stale lock silently disables snapping |
| `discardVersion` increments exactly when `discard[0]` changes, and never decreases **within a round** (each deal restarts it at 1) | The whole snap race model rests on this |
| `rngCursor` never decreases, and changes only inside `nextRandom` | Determinism and replay |
| `actionCounter` increments exactly once per accepted action | Timeout tokens |
| `finalLapRemaining` is `null`, or decreases monotonically to 0 | The round must terminate |
| `finalLapRemaining != null` **implies** `announcerId != null` | They are set together |
| `previousPlayerId` is `null` or a player in `turnOrder` | It is the announcement window; a stale id hands it to nobody |
| `currentPlayerIndex` points at a non-eliminated player, and never at the announcer once `announcerId` is set | `advanceTurn`'s contract |
| Every layout has at least `cfg.deck.handSize` slots (some possibly `EMPTY`) | Slots are never spliced out |
| `roundScore != null` for all active players **iff** `phase in {ROUND_END, MATCH_END}` | Scoring ran exactly once |
| No `Slot.knownBy` contains a player who is not in `turnOrder` | Stale identity |

### Progress

- Every accepted action either changes `phase`, `currentPlayerIndex`,
  `actionCounter`, or a layout. The engine cannot spin.
- Every round reaches `REVEAL`: each turn consumes at least one stock card or
  advances the final lap, and both are finite.
- Every match reaches `MATCH_END`: `validateConfig` guarantees a `scoreLimit` or a
  `roundLimit` ([02](02-rule-config.md)).

### Non-leak

The projection check in
[09 §4](09-hidden-information.md#4-verifying-that-projection-is-tight)
(`assertNoLeak`) belongs in this set. Run it over the trace below.

## 3. Worked trace

Three players, **`standard` preset**, `rngSeed = "trace-1"`, deterministic shuffle.
`turnOrder = [Alice, Bob, Chloé]`, `dealerIndex = 2` (Chloé) ⇒ Alice leads.

**Deal** (`handSize = 4`):

| Player | slot 0 | slot 1 | slot 2 | slot 3 | sum |
|---|---|---|---|---|---|
| Alice | ♥K (0) | 8♦ (8) | 4♣ (4) | ♠Q (12) | 24 |
| Bob | 3♥ (3) | ♠K (13) | 9♣ (9) | 2♦ (2) | 27 |
| Chloé | 7♠ (7) | 5♥ (5) | ♦K (0) | 6♣ (6) | 18 |

Discard seed: **4♥**, `discardVersion = 1`. Stock (in order):
`8♠, 3♣, ♥Q, 9♦, A♣, 10♠, 2♣, 5♠, 7♥, 6♦, A♦, 3♦, 4♠, …`

| # | Action | Effect | Top / ver |
|---|---|---|---|
| 1 | `PeekInitial(Alice,[0,1])` | Alice learns ♥K, 8♦ | 4♥ / 1 |
| 2 | `PeekInitial(Bob,[0,1])` | Bob learns 3♥, ♠K | 4♥ / 1 |
| 3 | `PeekInitial(Chloé,[0,1])` | Chloé learns 7♠, 5♥ → `AllPeeked`, turn 1 to Alice | 4♥ / 1 |
| 4 | `DrawStock(Alice)` | holds 8♠ | 4♥ / 1 |
| 5 | `DiscardHeld(Alice)` | 8♠ to discard; power `PEEK_OWN` | **8♠ / 2** |
| 6 | `PowerTarget(Alice,{Alice,2})` | Alice learns 4♣ → `TURN_END` | 8♠ / 2 |
| 7 | `EndTurn(Alice)` | turn 2 to Bob | 8♠ / 2 |
| 8 | `DrawStock(Bob)` | holds 3♣ | 8♠ / 2 |
| 9 | `PlaceInSlot(Bob,1)` | 3♣ replaces ♠K (13 → 3); ♠K to discard | **♠K / 3** |
| — | *Alice declines to snap* | She holds ♥K (rank match!) but it is worth **0** — snapping it would cost her 0 points and gain nothing. Correct play, and the clearest illustration that snap ≠ always good | ♠K / 3 |
| 10 | `EndTurn(Bob)` | turn 3 to Chloé | ♠K / 3 |
| 11 | `DrawStock(Chloé)` | holds ♥Q (12) | ♠K / 3 |
| 12 | `DiscardHeld(Chloé)` | ♥Q to discard; power `BLIND_SWAP` | **♥Q / 4** |
| 13 | `PowerTarget(Chloé,{Chloé,3})` | first target (own) | ♥Q / 4 |
| 14 | `PowerTarget(Chloé,{Alice,1})` | swap: Alice1 ⇄ Chloé3. **Alice's `knownBy` for slot 1 is wiped** — she still believes it is 8♦, but it is now 6♣ | ♥Q / 4 |
| 15 | `EndTurn(Chloé)` | turn 4 to Alice | ♥Q / 4 |
| 16 | `DrawStock(Alice)` | holds 9♦ | ♥Q / 4 |
| 17 | `DiscardHeld(Alice)` | power `PEEK_OPPONENT` | **9♦ / 5** |
| 18 | `PowerTarget(Alice,{Alice,1})` | **misuse** — 9/10 may not target your own card. Penalty: A♣ face down at slot 4. Alice now has 5 cards | 9♦ / 5 |
| 19 | `EndTurn(Alice)` | turn 5 to Bob | 9♦ / 5 |
| 20 | `DrawStock(Bob)` → `DiscardHeld(Bob)` | 10♠; power `PEEK_OPPONENT` | **10♠ / 6** |
| 21 | `PowerTarget(Bob,{Chloé,3})` | Bob learns Chloé's slot 3 is 8♦ | 10♠ / 6 |
| 22 | `EndTurn(Bob)` | turn 6 to Chloé | 10♠ / 6 |
| 23 | `DrawStock(Chloé)` | holds 2♣ | 10♠ / 6 |
| 24 | `PlaceInSlot(Chloé,3)` | 2♣ in, 8♦ out | **8♦ / 7** |
| 25 | `Snap(Alice,{Alice,1},ver 7)` | Alice acts on stale memory: she thinks slot 1 is 8♦, but step 14 swapped it to 6♣. **Failed snap** — 6♣ back face down, penalty 5♠ at slot 5. Alice now has 6 cards | 8♦ / 7 |
| 26 | `EndTurn(Chloé)` | turn 7 to Alice | 8♦ / 7 |
| 27 | `DrawStock(Alice)` → `PlaceInSlot(Alice,3)` | 7♥ in, ♠Q (12) out | **♠Q / 8** |
| 28 | `EndTurn(Alice)` | turn 8 to Bob | ♠Q / 8 |
| 29 | `DrawStock(Bob)` → `PlaceInSlot(Bob,2)` | 6♦ in, 9♣ out | **9♣ / 9** |
| 30 | `EndTurn(Bob)` | turn 9 to Chloé | 9♣ / 9 |
| 31 | `DrawStock(Chloé)` → `PlaceInSlot(Chloé,0)` | A♦ in, 7♠ out. Chloé's known cards now total 8 with one unknown | **7♠ / 10** |
| 32 | `AnnounceCactus(Chloé)` | `announcerId = Chloé`, `finalLapRemaining = 2`. Her own `EndTurn` does **not** decrement it. Turn 10 to Alice | 7♠ / 10 |
| 33 | `DrawStock(Alice)` → `PlaceInSlot(Alice,1)` | 3♦ in, 6♣ out | **6♣ / 11** |
| 34 | `EndTurn(Alice)` | `finalLapRemaining → 1`; turn 11 to Bob | 6♣ / 11 |
| 35 | `Snap(Bob,{Bob,2},ver 11)` | Bob knows slot 2 is 6♦ — rank match. **Success**: slot 2 emptied, 6♦ to discard | **6♦ / 12** |
| 36 | `DrawStock(Bob)` → `DiscardHeld(Bob)` | 4♠, no power. Bob correctly refuses to refill his empty slot | **4♠ / 13** |
| 37 | `EndTurn(Bob)` | `finalLapRemaining → 0` ⇒ `roundOverReason = FINAL_LAP_DONE` → `REVEAL` | 4♠ / 13 |

**Reveal:**

| Player | Layout | Sum |
|---|---|---|
| Alice | ♥K (0), 3♦ (3), 4♣ (4), 7♥ (7), A♣ (1), 5♠ (5) | **20** |
| Bob | 3♥ (3), 3♣ (3), *empty*, 2♦ (2) | **8** |
| Chloé *(announcer)* | A♦ (1), 5♥ (5), ♦K (0), 2♣ (2) | **8** |

**Scoring.** `best(others) = min(20, 8) = 8`. Chloé's sum is 8.
`tieCountsAsFailure = true` ⇒ `8 < 8` is false ⇒ **the announcement fails**.
`announcerFailurePenalty = DOUBLE` ⇒ Chloé scores `8 × 2 = 16`.
`othersScoreOnAnnouncerFailure = OWN_SUM` ⇒ Alice 20, Bob 8.

| | Alice | Bob | Chloé |
|---|---|---|---|
| Round 1 | 20 | **8** | 16 |

Bob wins the round without ever announcing — one good snap (step 35) beat a
premature call. `isMatchOver` is false (`scoreLimit = 100`), so the state settles
in `ROUND_END` awaiting `StartNextRound`.

### Conservation check at reveal

| Location | Count |
|---|---|
| Layouts | 6 + 3 + 4 = **13** |
| Discard (`4♥ 8♠ ♠K ♥Q 9♦ 10♠ 8♦ ♠Q 9♣ 7♠ 6♣ 6♦ 4♠`) | **13** |
| Held | 0 |
| Stock | **26** |
| **Total** | **52** ✓ |

`discardVersion` also ends at 13 here, matching the discard's size. That is a
coincidence of this trace, not an invariant: it holds only because no turn took a
card *off* the discard. `TakeDiscard` and the Ace-give both bump the version while
shrinking the pile, so the two counters diverge in general.

### What this trace exercises

Initial peek barrier · draw-and-swap · draw-and-discard with power ·
`PEEK_OWN` · `PEEK_OPPONENT` · `BLIND_SWAP` and its `knownBy` wipe ·
power misuse penalty · a **failed snap caused by stale memory** (the direct
consequence of step 14) · a **successful snap** · declining an available snap
because it is bad play · announcement, final-lap counting, and the announcer *not*
consuming a lap slot · **tie ⇒ announcer penalty** · card conservation across
swaps, snaps, and penalties.

Not exercised, and worth adding as further traces: `LOOK_AND_SWAP`, `GIVE_CARD`,
stock exhaustion and reshuffle, a snap race between two players, an emptied layout
ending a round, and elimination at the match limit.
