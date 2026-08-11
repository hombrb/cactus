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
  turn:     TurnConfig
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
| `deck.seedDiscard` | bool | `true` | — | `createRound` (05) |

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

`seedDiscard = false` deals no face-up card: the round opens on an empty
discard. `discardVersion` **still starts at 1** — it counts changes to the top
card, not cards. `validate(SNAP)` and `validate(TAKE_DISCARD)` already reject an
empty discard, so the first player simply has one fewer option.

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
| `powers.onHandDiscard` | bool | `false` | — | `onPlaceInSlot` (05), `resolveSuccessfulSnap` (07) |

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

`onHandDiscard` widens *when* a power fires without touching *which* rank has
one: on, a card that goes from a layout to the discard fires its own power for
the player whose layout it left. See [06 §10](06-powers.md#10-powers-on-a-hand-discard--onhanddiscard)
for the three cases it deliberately does not cover. It is the only rule key read
outside the group it names, because it is a statement about powers enforced at the
two places a card leaves a layout.

### `turn`

| Key | Type | Default | Allowed | Read by |
|-----|------|---------|---------|---------|
| `turn.takeFromDiscard` | bool | `true` | — | `validate(TAKE_DISCARD)` (05) |

`false` makes the stock the only source: the discard becomes a destination and a
snap target, never a draw. Setting it alongside `deck.seedDiscard = false` is
coherent — the discard is then purely a record of what has been played.

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
| `announce.timing` | `AFTER_TURN` \| `END_OF_TURN` \| `INSTEAD_OF_TURN` | `AFTER_TURN` | — | `validate(ANNOUNCE_CACTUS)` (05) |
| `announce.requiresThreshold` | int? | `null` | `null`, `5`, `6` | `validate(ANNOUNCE_CACTUS)` (05) |

`timing` decides *when*, and it decides more than it looks. `AFTER_TURN` — the
default — keeps the announcement open until the next player finishes their turn
([01 §7](01-rules-reference.md#7-ending-the-round)), which also means `TURN_END`
has nothing left to decide and a turn needs no button to end it. `END_OF_TURN` is
the strict reading and is the only value for which `timing.endOfTurnWindowMs`
means anything.

`requiresThreshold` is **not** enforceable against the announcer's real hand — a
player announces on belief, and the engine cannot read belief. When set, it is
enforced only in modes where the engine knows the hand (offline replay, tests) and
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

Not rules. Tuning for networked play; all null on a single shared device.

| Key | Type | Default | Read by |
|-----|------|---------|---------|
| `timing.turnTimeoutMs` | int? | `45000` | `Timeout` handling (05, 10) |
| `timing.endOfTurnWindowMs` | int? | `3000` | `TURN_END` window (04, 05) — `END_OF_TURN` only |
| `timing.snapGraceMs` | int | `250` | `resolveSnapWindow` (07) |
| `timing.peekRevealMs` | int | `4000` | client only (09) |
| `timing.initialPeekMs` | int | `10000` | `INITIAL_PEEK` barrier (05) |

`turnTimeoutMs = null` disables timeouts (correct on one shared device, where
there is nobody to time out against; dangerous online).

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

### `table2p`

Not a rules variant — a **mode** preset. Two players around one phone lying flat
on the table between them. There is nobody to time out against, so every timer is
disabled and the end-of-turn window is closed by a human instead.

```
table2p = standard with {
  timing: { turnTimeoutMs: null, endOfTurnWindowMs: null, initialPeekMs: null },
}
```

> **This replaces the earlier `hotseat` preset, which set `snap.enabled: false`.**
> That reasoning — a shared screen makes the snap race unfair — holds when the
> phone is *passed from hand to hand*, because only the holder can reach it. It
> does not hold when the phone sits flat between two players who can both reach
> it, which is the arrangement this app actually uses. Snap is therefore on by
> default here, arbitrated by which `pointerdown` landed first. See
> [10 §6](10-multiplayer-and-modes.md#6-two-players-one-phone-flat-table) and
> [07 §8](07-snap.md#8-two-players-on-one-device).

---

## Choosing a config

A preset is a starting point, not the unit of choice. What a player picks in
*Réglages* is a preset **plus a small set of overrides**, and the same answers
are what a host sends when opening a room:

| Answer | Overrides |
|---|---|
| preset | everything below the overrides |
| powers | `powers.map`, wholesale |
| powers on a hand discard | `powers.onHandDiscard` |
| snap | `snap.enabled` |
| seed discard | `deck.seedDiscard` |
| take from discard | `turn.takeFromDiscard` |
| score limit | `match.scoreLimit` (ignored by `school`, which counts rounds) |

**A client never sends a `RuleConfig`.** It sends those answers, and the
authority rebuilds the config from its own presets — `configFrom` for the flat
table, `configForRoom` for a room; they differ only in `timing`.

`powers.map` is the one answer with structure, and it is allow-listed on both
axes before it is believed:

```
POWER_RANK_KEYS   = [A, 2..10, J, Q, K:red, K:black]
SELECTABLE_POWERS = [NONE, PEEK_OWN, PEEK_OPPONENT, BLIND_SWAP, LOOK_AND_SWAP]

fn parsePowerMap(raw) -> PowerMap | null
  drop every key not in POWER_RANK_KEYS
  drop every value not in SELECTABLE_POWERS
  return null if nothing survives      // "keep the preset's own map"
```

So the client picks a rank and a power out of a fixed menu: it can choose among
the game's rules but not invent one. `GIVE_CARD` is absent from
`SELECTABLE_POWERS` on purpose — it is implemented but untested in a real game,
and `powers.aceGiveEnabled` still gates it for configs built in code.

Dropping rather than rejecting is deliberate: an old client, a hand-edited
`localStorage` and a hostile POST body all degrade to fewer powers instead of to
an error.

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

Called by `createMatch` in DEV, the way `checkInvariants` is called by
`applyAction` — every match passes through one place, and configs are now
assembled from user answers rather than only read from `presets`.

Config is **frozen for the duration of a match**. Changing rules mid-match would
invalidate cumulative scores; the lobby is the only place a config may be chosen.
