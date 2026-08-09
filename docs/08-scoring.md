# 08 — Scoring

From `REVEAL` to `ROUND_END` to `MATCH_END`. All constants come from
`cfg.values`, `cfg.scoring` and `cfg.match` ([02](02-rule-config.md)).

---

## 1. Card values

```
fn cardValue(cfg, card: Card) -> int
  match card.rank:
    JOKER -> return cfg.values.joker
    K     -> return isRed(card) ? cfg.values.redKing : cfg.values.blackKing
    Q     -> return cfg.values.queen
    J     -> return cfg.values.jack
    A     -> return cfg.values.ace
    _     -> return cfg.values.numeric == "face"
                    ? numericValue(card.rank)
                    : cfg.values.numeric[numericValue(card.rank)]
```

The red/black King split is the only place where **suit affects value**. Everything
else is rank-only. In the `school` preset `redKing == blackKing == 0` and the
branch collapses harmlessly.

```
fn scoreLayout(cfg, state, layout: Layout) -> int
  total = 0
  for slot in layout where slot.cardId != EMPTY:
    total += cardValue(cfg, cardOf(state, slot.cardId))
  return total
```

`EMPTY` slots contribute nothing — that is the entire payoff of snapping
([07](07-snap.md)). An empty layout scores 0.

## 2. Entering the reveal

```
fn beginReveal(state, reason: Reason) -> (GameState, Event[])
  s = state with { phase: REVEAL, heldCard: null, pendingPower: null,
                   pendingSnapGive: null, lockedSlots: {} }

  // a held card is returned to the discard so card conservation still holds
  if state.heldCard != null:
    s = s with { discard: [state.heldCard] + s.discard,
                 discardVersion: s.discardVersion + 1 }

  layouts = [ { playerId: p.id, cards: nonEmptyCardIds(p.layout) }
              for p in activePlayers(s) ]
  events = [ RoundRevealed { layouts } ]

  (s, scoreEvents) = scoreRound(s, reason)
  return (s, events + scoreEvents)
```

`RoundRevealed` is the moment every card becomes public; from here projection
([09](09-hidden-information.md)) stops redacting layouts.

Draining `heldCard` matters: a round can end mid-turn (a snap empties a layout
while the current player is holding a drawn card), and the conservation invariant
in [11](11-edge-cases-and-invariants.md) counts that card.

## 3. Round scoring

```
fn scoreRound(state, reason) -> (GameState, Event[])
  cfg   = state.config
  sums  = { p.id: scoreLayout(cfg, state, p.layout) for p in activePlayers(state) }

  if cfg.scoring.kamikaze.enabled:
    k = the single player whose layout isKamikaze(cfg, state, ·), if exactly one
    if k != null:
      return finishScoring(state, kamikazeScores(cfg, sums, k), announcerSucceeded: true)

  if state.announcerId == null:
    // round ended by stock death or by an emptied layout, with nobody announcing
    return finishScoring(state, sums, announcerSucceeded: false)

  a       = state.announcerId
  others  = sums without key a
  best    = min(values of others)

  succeeded = cfg.scoring.tieCountsAsFailure ? (sums[a] <  best)
                                             : (sums[a] <= best)
  if cfg.scoring.royalBonus and sums[a] == 0:
    succeeded = true                       // a "cactus royal" cannot be beaten

  final = {}
  if succeeded:
    final[a] = cfg.scoring.announcerSuccessScore == ZERO ? 0 : sums[a]
    for id in others: final[id] = sums[id]
  else:
    final[a] = applyAnnouncerPenalty(cfg, sums[a])
    for id in others:
      final[id] = cfg.scoring.othersScoreOnAnnouncerFailure == ZERO ? 0 : sums[id]

  return finishScoring(state, final, announcerSucceeded: succeeded)

fn applyAnnouncerPenalty(cfg, sum) -> int
  match cfg.scoring.announcerFailurePenalty.kind:
    DOUBLE -> return sum * 2
    ADD    -> return sum + cfg.scoring.announcerFailurePenalty.amount
```

Three decisions worth restating, because they are where rulesets diverge most:

- **A tie is a failure by default** (`tieCountsAsFailure`). Without it, announcing
  whenever you can force a draw is risk-free and the announcement stops being a
  bet. The `school` preset flips this, because there "having cactus" is a status
  several players can share.
- **`sum * 2` punishes a bad hand harder than a good one.** Announcing on 4 and
  losing costs 8; announcing on 22 and losing costs 44. That is the intent: the
  penalty scales with how wrong you were about your own cards.
- **When there is no announcer, nobody is penalised.** A round that dies because
  the stock ran out is nobody's mistake.

```
fn finishScoring(state, final: Map<PlayerId,int>, announcerSucceeded) -> (GameState, Event[])
  s = state
  rows = []
  for p in activePlayers(s):
    cumulative = p.cumulativeScore + final[p.id]
    s = withPlayer(s, p.id, q => q with { roundScore: final[p.id],
                                          cumulativeScore: cumulative })
    rows.push({ playerId: p.id, roundScore: final[p.id], cumulative })

  s = applyMatchScores(s)
  s = s with { phase: ROUND_END }
  events = [ RoundScored { scores: rows, announcerId: s.announcerId,
                           announcerSucceeded } ]

  if isMatchOver(s):
    s = s with { phase: MATCH_END }
    events += [ MatchEnded { standings: rankPlayers(s) } ]

  return (s, events)
```

## 4. Optional flourishes

### Cactus royal

`cfg.scoring.royalBonus` — finishing on exactly 0 makes the announcement
unbeatable, ties included. It is a small rule with a real effect: it makes
"announce the instant you reach 0" strictly correct, which is the drama people
play this game for.

### Kamikaze

```
fn isKamikaze(cfg, state, layout) -> bool
  cards = [ cardOf(state, s.cardId) for s in layout where s.cardId != EMPTY ]
  if len(cards) != cfg.deck.handSize:                  return false
  if not every c in cards is (Q) or (K and isBlack(c)): return false
  if no Q in cards or no black K in cards:             return false
  return true

fn kamikazeScores(cfg, sums, kamikazeId) -> Map<PlayerId,int>
  out = {}
  out[kamikazeId] = 0
  for id in sums except kamikazeId: out[id] = cfg.scoring.kamikaze.penalty
  return out
```

The theatrical inverse of the game: assemble the *worst possible* hand and win
outright. Evaluated only at reveal, and only when exactly one player qualifies (two
simultaneous kamikazes cancel and the round scores normally — with two decks that
is reachable).

### "Having cactus" — the `school` preset

Where `cfg.announce.requiresThreshold` is set, the round has winners rather than a
winner: everyone at or under the threshold "has cactus".

```
fn hasCactus(cfg, sum) -> bool
  return cfg.announce.requiresThreshold != null
     and sum <= cfg.announce.requiresThreshold
```

Presentation only — it changes nothing in `final`. Show it next to each score.

## 5. Match scoring

```
fn applyMatchScores(state) -> GameState
  cfg = state.config
  if not cfg.match.limitEliminates: return state
  if cfg.match.scoreLimit == null:  return state

  s = state
  for p in s.players where not p.eliminated and p.cumulativeScore >= cfg.match.scoreLimit:
    s = withPlayer(s, p.id, q => q with { eliminated: true })
  return s

fn isMatchOver(state) -> bool
  cfg = state.config
  if cfg.match.roundLimit != null and state.roundNumber >= cfg.match.roundLimit:
    return true
  if cfg.match.scoreLimit != null:
    if cfg.match.limitEliminates:
      return count(active players in state) < 2
    else:
      return any p in state.players has p.cumulativeScore >= cfg.match.scoreLimit
  return false

fn rankPlayers(state) -> {playerId, cumulative, rank}[]
  rows = [ {p.id, p.cumulativeScore} for p in state.players ]
  sort rows ascending by cumulative, then by turnOrder index   // deterministic
  assign rank: equal cumulative ⇒ equal rank, next rank skips (1,2,2,4)
  return rows
```

**Lowest cumulative wins.** Two modes:

- `limitEliminates = false` (default): the first player to reach `scoreLimit` ends
  the match for everyone; whoever is lowest at that moment wins. Short, and the
  loser triggers the end.
- `limitEliminates = true`: crossing the limit knocks you out and the rest keep
  playing until one remains. Longer, and a knocked-out player has nothing to do —
  acceptable at a table, poor online.

`validateConfig` ([02](02-rule-config.md)) guarantees at least one of
`scoreLimit` / `roundLimit` is set, so `isMatchOver` cannot be permanently false.

## 6. Worked examples

Three players, `standard` preset. Layouts at reveal:

| Player | Cards | Sum |
|--------|-------|-----|
| Alice (announcer) | ♥K, 3, *empty*, 2 | 0 + 3 + 2 = **5** |
| Bob | 7, ♠K, 4, A | 7 + 13 + 4 + 1 = **25** |
| Chloé | 6, 2, ♦K, 4 | 6 + 2 + 0 + 4 = **12** |

**Branch A — announcer wins.** `best(others) = 12`, `5 < 12` ⇒ success.
`announcerSuccessScore = ZERO`.

| | Alice | Bob | Chloé |
|---|---|---|---|
| Round | **0** | 25 | 12 |

**Branch B — announcer loses.** Same table, but Alice's ♥K is really a ♠K, so her
sum is 18. `18 > 12` ⇒ failure. `DOUBLE` ⇒ `18 × 2 = 36`;
`othersScoreOnAnnouncerFailure = OWN_SUM`.

| | Alice | Bob | Chloé |
|---|---|---|---|
| Round | **36** | 25 | 12 |

**Branch C — tie.** Chloé also finishes on 5. `tieCountsAsFailure = true` ⇒ Alice
failed: `5 × 2 = 10`. She scores worse than the player she tied with, which is the
point.

| | Alice | Bob | Chloé |
|---|---|---|---|
| Round | **10** | 25 | 5 |

Under the `school` preset (`tieCountsAsFailure = false`,
`requiresThreshold = 5`), Branch C instead reads: Alice 5, Chloé 5 — **both "have
cactus"**, Alice's announcement stands, and nobody is penalised.

## 7. Round boundary

After `RoundScored` the state sits in `ROUND_END`. The host issues
`StartNextRound` ([05 §9](05-engine-core.md#9-round-and-match-boundaries)), which
rotates the dealer and calls `dealRound`. Cumulative scores and `eliminated` flags
survive; everything else in `GameState` is rebuilt.

If `isMatchOver` fired, the state is `MATCH_END` and `StartNextRound` is rejected
with `MATCH_OVER`. Starting a new match means constructing a fresh `GameState` —
the config is frozen per match ([02](02-rule-config.md)), so a rules change is a
new match by definition.
