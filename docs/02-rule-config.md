# 02 — Rule Configuration

Cactus has no canonical ruleset (see [01-rules-reference.md](01-rules-reference.md)).
Rather than pick one and hardcode it, the engine takes a single **`RuleConfig`**
object, and **every rule constant in this entire spec is a reference to a key in
that object**.

> **Hard requirement for implementers and for this spec:** no rule value may
> appear as a bare literal anywhere in the engine. If you find `13`, `100`, `4` or
> `× 2` written directly in reducer code, that is a bug. The only literals allowed
> are structural (array indices, `0`, `1` as arithmetic identities).

The variant matrix in `01` and the key list here are in bijection: every matrix
row has a key, every "contested" key has a matrix row. Keys marked *(not
contested)* below have no matrix row — they are constants that no source disputes
but that the engine still reads from config for consistency. The `timing` group
is likewise absent from the matrix: it is implementation tuning, not a rule.

---

## Schema

```
type RuleConfig {
  deck:     DeckConfig
  values:   ValueConfig
  powers:   PowerConfig
  snap:     SnapConfig
  announce: AnnounceConfig
  scoring:  ScoringConfig
  match:    MatchConfig
  timing:   TimingConfig
}
```

### `deck`

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `deck.deckCount` | int | `1` | `1`, `2` | `buildDeck` (05) |
| `deck.useJokers` | bool | `false` | — | `buildDeck` (05) |
| `deck.handSize` | int | `4` | `3`–`6` | `dealRound` (05) |
| `deck.initialPeekCount` | int | `2` | `0`–`handSize` | `validate(PEEK_INITIAL)` (05) |
| `deck.initialPeekFree` | bool | `false` | — | `validate(PEEK_INITIAL)` (05) |
| `deck.reshuffleDiscard` | bool | `true` | — | `refillStockFromDiscard` (05) |

`deckCount` should be raised to `2` above `deck.autoTwoDecksAbove` players; that
threshold is itself a key:

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `deck.autoTwoDecksAbove` | int | `4` | `0` disables | `startMatch` (05) |

*(not contested)* — `autoTwoDecksAbove` merely automates matrix row 1.

`initialPeekFree = false` means the peek is restricted to the fixed "nearest"
slots (indices `0` and `1` by convention). `true` lets the player choose any
`initialPeekCount` of their own slots.

`reshuffleDiscard = false` means an exhausted stock ends the round immediately
instead of recycling the discard — see [11](11-edge-cases-and-invariants.md).

### `values`

Maps a card face to a point value. Everything but `numeric` is a scalar.

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `values.joker` | int | `-1` | `-2`, `-1`, `0` | `cardValue` (08) |
| `values.redKing` | int | `0` | `-2`, `-1`, `0` | `cardValue` (08) |
| `values.blackKing` | int | `13` | `0`, `13`, `15`, `20` | `cardValue` (08) |
| `values.queen` | int | `12` | `10`, `12` | `cardValue` (08) |
| `values.jack` | int | `11` | `10`, `11` | `cardValue` (08) |
| `values.ace` | int | `1` | `1`, `11` | `cardValue` (08) |
| `values.numeric` | `"face"` \| int[] | `"face"` | — | `cardValue` (08) |

*(not contested)*: `values.ace`, `values.numeric`.

`values.numeric = "face"` means a `7` is worth 7. An explicit array allows fully
custom tables without touching `cardValue`.

Setting `values.redKing == values.blackKing` collapses the red/black split (this
is how the `school` preset gets "all Kings are 0").

### `powers`

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `powers.map` | `Map<RankKey, PowerKind>` | see below | any | `powerFor` (06) |
| `powers.aceGiveEnabled` | bool | `false` | — | `powerFor` (06) |
| `powers.misusePenaltyCards` | int | `1` | `0`–`2` | `applyMisusePenalty` (06) |

```
enum PowerKind =
    NONE
  | PEEK_OWN        // look at one of your own cards
  | PEEK_OPPONENT   // look at one opponent card
  | BLIND_SWAP      // exchange one of yours with one opponent card, unseen
  | LOOK_AND_SWAP   // look at one of each, then optionally swap
  | GIVE_CARD       // hand the drawn card to a player of your choice
```

`RankKey` is a rank (`"7"`, `"J"`, …) optionally qualified by colour
(`"K:black"`, `"K:red"`), so the black/red King split expresses cleanly.

Default `powers.map`:

```
{
  "7":       PEEK_OWN,
  "8":       PEEK_OWN,
  "9":       PEEK_OPPONENT,
  "10":      PEEK_OPPONENT,
  "J":       BLIND_SWAP,
  "Q":       BLIND_SWAP,
  "K:black": LOOK_AND_SWAP,
  "K:red":   NONE,
  "A":       NONE          // GIVE_CARD when powers.aceGiveEnabled
}
```

Any rank absent from the map has `NONE`. `powerFor` resolves colour-qualified
keys first, then bare rank, then `NONE`.

### `snap`

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `snap.enabled` | bool | `true` | — | `validate(SNAP)` (07) |
| `snap.failurePenaltyCards` | int | `1` | `0`–`2` | `resolveFailedSnap` (07) |
| `snap.allowOnOpponent` | bool | `false` | — | `validate(SNAP)` (07) |
| `snap.emptyLayoutEndsRound` | bool | `true` | — | `resolveSuccessfulSnap` (07) |
| `snap.allowedDuringFinalLap` | bool | `true` | — | `validate(SNAP)` (07) |
| `snap.loserPenalty` | `NONE` \| `AS_FAILED_SNAP` | `NONE` | — | `resolveSnapWindow` (07) |
| `snap.matchOn` | `RANK` \| `RANK_AND_SUIT` | `RANK` | — | `validate(SNAP)` (07) |

*(not contested)*: `snap.matchOn` — every source matches on rank; the key exists
because implementers reliably ask.

### `announce`

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `announce.timing` | `END_OF_TURN` \| `INSTEAD_OF_TURN` | `END_OF_TURN` | — | `validate(ANNOUNCE_CACTUS)` (05) |
| `announce.requiresThreshold` | int? | `null` | `null`, `5`, `6` | `validate(ANNOUNCE_CACTUS)` (05) |

`requiresThreshold` is **not** enforceable against the announcer's real hand — a
player announces on belief, and the engine cannot read belief. When set, it is
enforced only in modes where the engine knows the hand (hotseat replay, tests) and
is otherwise advisory. Documented as a rule variant, implemented as a no-op in
networked play. See [11](11-edge-cases-and-invariants.md).

### `scoring`

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `scoring.announcerSuccessScore` | `ZERO` \| `OWN_SUM` | `ZERO` | — | `scoreRound` (08) |
| `scoring.announcerFailurePenalty` | `{kind: DOUBLE}` \| `{kind: ADD, amount: int}` | `{kind: DOUBLE}` | `ADD` with `10`, `20` | `scoreRound` (08) |
| `scoring.tieCountsAsFailure` | bool | `true` | — | `scoreRound` (08) |
| `scoring.othersScoreOnAnnouncerFailure` | `OWN_SUM` \| `ZERO` | `OWN_SUM` | — | `scoreRound` (08) |
| `scoring.royalBonus` | bool | `false` | — | `scoreRound` (08) |
| `scoring.kamikaze` | `{enabled: bool, penalty: int}` | `{false, 50}` | — | `scoreRound` (08) |

### `match`

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `match.scoreLimit` | int? | `100` | `null`, `100`, `200` | `isMatchOver` (08) |
| `match.roundLimit` | int? | `null` | `null`, any int | `isMatchOver` (08) |
| `match.limitEliminates` | bool | `false` | — | `applyMatchScores` (08) |

At least one of `scoreLimit` / `roundLimit` must be non-null, else the match never
ends — asserted at config load.

### `timing`

Not rules. Tuning for real-time play; irrelevant in hotseat.

| Key | Type | Default | Read by |
|-----|------|---------|---------|
| `timing.turnTimeoutMs` | int? | `45000` | `Timeout` handling (05, 10) |
| `timing.endOfTurnWindowMs` | int? | `3000` | `TURN_END` window (04, 05) |
| `timing.snapGraceMs` | int | `250` | `resolveSnapWindow` (07) |
| `timing.peekRevealMs` | int | `4000` | client only (09) |
| `timing.initialPeekMs` | int | `10000` | `INITIAL_PEEK` barrier (05) |

`turnTimeoutMs = null` disables timeouts (correct for hotseat; dangerous online).

---

## Presets

### `standard` — the default

Everything as defaulted above. This is the French Wikipedia *Dutch* ruleset:
red/black King split, four power tiers, snap on, announcer penalised on failure or
tie, match to 100.

### `school` — the French schoolyard version

The version most people actually learned. Flat values, only the 8 has a power,
"under 5 is cactus".

```
school = standard with {
  values:   { redKing: 0, blackKing: 0, queen: 10, jack: 10 },
  powers:   { map: { "8": PEEK_OWN }, aceGiveEnabled: false },
  snap:     { enabled: true, failurePenaltyCards: 1, emptyLayoutEndsRound: true },
  announce: { requiresThreshold: 5 },
  scoring:  { announcerSuccessScore: ZERO, tieCountsAsFailure: false },
  match:    { scoreLimit: null, roundLimit: 5 },
}
```

Note `tieCountsAsFailure: false` — in this version "having cactus" (≤ 5) is a
status several players can hold at once, so ties are benign.

### `hardcore`

Maximum variance and maximum memory pressure.

```
hardcore = standard with {
  values:   { blackKing: 20, joker: -2 },
  deck:     { useJokers: true, initialPeekCount: 1 },
  powers:   { aceGiveEnabled: true },
  snap:     { allowOnOpponent: true, loserPenalty: AS_FAILED_SNAP,
              failurePenaltyCards: 2 },
  scoring:  { announcerFailurePenalty: {kind: ADD, amount: 20},
              royalBonus: true, kamikaze: {enabled: true, penalty: 50} },
}
```

### `hotseat`

Not a rules variant — a **mode** preset. Two players on one device cannot race to
snap, and there is no reason to time turns.

```
hotseat = standard with {
  snap:   { enabled: false },
  timing: { turnTimeoutMs: null, initialPeekMs: null },
}
```

See [10-multiplayer-and-modes.md](10-multiplayer-and-modes.md) for why snap is
disabled rather than adapted.

---

## Validation at load

```
fn validateConfig(cfg: RuleConfig) -> Ok | Error[]
  assert cfg.deck.handSize >= 2
  assert cfg.deck.initialPeekCount <= cfg.deck.handSize
  assert cfg.match.scoreLimit != null or cfg.match.roundLimit != null
  assert cfg.snap.failurePenaltyCards >= 0
  assert every key of cfg.powers.map is a valid RankKey
  assert cfg.powers.map has no GIVE_CARD entry unless cfg.powers.aceGiveEnabled
  if cfg.deck.useJokers then assert cfg.values.joker is defined
  return Ok
```

Config is **frozen for the duration of a match**. Changing rules mid-match would
invalidate cumulative scores; the lobby is the only place a config may be chosen.
