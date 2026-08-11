# 01 — Rules Reference

The rules of Cactus as they are actually played, plus an explicit record of every
point where published sources disagree. This file is the *justification* for
[02-rule-config.md](02-rule-config.md): each disagreement below maps to exactly
one configuration key.

Cactus belongs to the **Golf / Cabo family**: a hidden-information, memory-based,
lowest-score game. It is the same game as *Dutch*, *Tamalou*, *Cabo*, *Kabo*,
*Pablo*, *Gabo*, *Marmotte*, and a dozen regional names. There is **no single
authoritative ruleset** — the French schoolyard version, the Belgian *Cabo*
version and the commercial *Cambio* version differ substantially.

> Not to be confused with the unrelated commercial boardgame also marketed as
> "Cactus Game" (Personnage/Action cards, points to 7). This spec has nothing to
> do with it.

---

## 1. Objective

Finish the round with the **lowest total value** in your layout. The round is not
timed: it ends when a player believes they are lowest and announces **"Cactus"**.

Because you are only ever shown two of your four cards at the start, the game is
a memory and risk-assessment exercise: you are betting on a hand you can only
partially see.

## 2. Material and setup

- A standard **52-card deck**, no jokers. With 5–8 players, two shuffled decks.
- Each player is dealt **4 cards face down**, arranged in a 2×2 square in front of
  them.
- **Layout order is fixed.** A player may never rearrange, rotate, or reorder
  their cards. This is what makes memory meaningful.
- The rest of the deck becomes the **stock**, face down in the centre. Its top
  card is turned face up to start the **discard**.

*Disagreement:* the French schoolyard version deals no face-up card at all — the
discard starts empty and fills as cards are played, so the first player cannot
snap or take a discard. → `deck.seedDiscard`.
- Before the first turn, each player looks at their **two nearest cards** (the two
  closest to them), **once**, then puts them back face down. This peek is
  simultaneous and private.

*Disagreement:* some tables peek at any 2 of the 4 rather than the nearest 2 —
functionally identical, since layouts are private. Some peek only 1 card
(harder), some 3 (easier). → `deck.initialPeekCount`, `deck.initialPeekFree`.

## 3. Card values

The **default** column is what this spec implements as the `standard` preset.

| Card | Default | Documented variants |
|------|---------|---------------------|
| Joker (only if used) | −1 | −2, 0 |
| **Red** King ♥ ♦ | 0 | −1, −2 |
| **Black** King ♠ ♣ | 13 | 15, 20 |
| Queen | 12 | 10 |
| Jack | 11 | 10 |
| Ace | 1 | — |
| 2 – 10 | face value | — |

Two things drive this table:

- The **red/black King split** is the single most distinctive Cactus rule. The
  red King is the best card in the game (0, sometimes negative); the black King
  is the worst (13–20) *and* carries the strongest power. Holding an unknown King
  is therefore a large variance bet.
- Several simplified rulesets (notably the French schoolyard version) flatten
  this: *all* Kings are 0 and *all* face cards are 10. That is preserved as the
  `school` preset.

## 4. Turn structure

Play proceeds **clockwise**. On your turn you must do **exactly one** of:

### A. Draw from the stock

Take the top stock card into hand (the **held card**). Then choose one:

1. **Swap it in.** Put the held card face down into one of your slots; the card
   it replaces goes face up onto the discard. **No power triggers** — not the
   held card's, not the discarded card's.
2. **Discard it directly.** The held card goes face up onto the discard. If it is
   a power card, **its power triggers now**.

### B. Take the top of the discard

Take the face-up top discard card. You are then **obliged** to swap it into one
of your slots; the replaced card goes onto the discard. You may not take a
discard card and then throw it away. **No power triggers.**

*Disagreement:* every source consulted allows this, and it is the least disputed
rule in the game — but some tables play stock-only, which removes the whole
information channel of "why did they take that card". → `turn.takeFromDiscard`.

> **The critical asymmetry:** a power only ever fires on a card drawn from the
> stock and discarded *without being used*. Using a card for its value and using
> it for its power are mutually exclusive. Every ruleset consulted agrees on this,
> and it is the balancing mechanism of the whole game.

*Disagreement, not among sources but among tables:* no published account gives a
power to a card that leaves a layout, and yet players reach for it — the card is
face up on the discard, it is a 9, and nothing about "it came from my square"
feels like it should matter. Kept as an explicit variant rather than pretended
away: `powers.onHandDiscard` fires the power of any card that goes **from a
layout to the discard**, which is the card a swap displaces (A.1 above) and the
card a *défausse rapide* throws (§6). The asymmetry above survives it intact —
what still never has a power is the card you **keep**. Off by default.

## 5. Powers

| Rank | Effect |
|------|--------|
| **7, 8** | Look at **one of your own** cards. |
| **9, 10** | Look at **one opponent's** card. |
| **Jack, Queen** | **Blind swap**: exchange one of your cards with one opponent's card, without either being revealed. |
| **Black King** ♠ ♣ | Look at **one of your own** cards **and** one opponent's card, then **optionally** swap those two. |
| **Ace** *(off by default)* | Give the drawn card to a player of your choice, adding it to their layout. |

Notes:

- The black King is the strongest power in the game and the worst card to be
  caught holding — it is deliberately a "use it now or suffer" card.
- Jack/Queen are blind: you swap on inference, not knowledge. A player who has
  been watching can steal a card they know is good.
- The Ace-give power (documented on the French Wikipedia *Dutch* page) grows the
  victim's layout by one card and is unbalanced in short games. It is available
  but **off by default**.
- **Misusing a power** — targeting an illegal slot, targeting yourself with a
  9/10, dawdling past the timeout — ends your turn immediately and you take a
  **face-down penalty card** into a new slot.

*Disagreement:* the set of ranks with powers is the most-varied rule of all. Some
rulesets give powers only to the 8. Some use 7/8 = own, 9/10 = opponent, J/Q =
swap, K = look-and-swap (the version above). Cambio uses 6/7 = own, 8/9 =
opponent, 10/J = blind swap, black K = look-and-swap. → `powers.map`.

## 6. Défausse rapide (snap)

At **any moment**, in or out of turn, any player may take a card **from their own
layout** and slam it onto the discard if its **rank** matches the current top
discard card.

- **Correct.** The card leaves the game. That slot becomes permanently `EMPTY`,
  and your total drops by that card's value. This is the only way to shrink your
  layout, and it is the fastest route to a very low score. No power fires — the
  card was not drawn and discarded (§4) — unless `powers.onHandDiscard` is on,
  in which case it does, and out of turn, since a snap is not a turn.
- **Wrong.** The card goes back **face down into the same slot** — and you take a
  **face-down penalty card** into a new slot. A failed snap therefore costs you
  twice: you have revealed a card to the table, and you have grown your hand.

Optional additions:

- **Snap on an opponent** (`snap.allowOnOpponent`, off by default): if you know an
  opponent holds a matching card, you may snap *their* card onto the discard, then
  give them one of **your** cards to fill the hole. Powerful and much loved; it
  turns memory into a weapon.
- **Emptying your layout** (`snap.emptyLayoutEndsRound`, on by default): snapping
  away your last card ends the round immediately, and you score 0.

*Disagreement:* whether snap exists at all (some tables ban it as too chaotic),
what the penalty is (1 card, 2 cards, or none), and whether snapping is allowed
after an announcement. → the whole `snap` config group.

## 7. Ending the round

Once you have **played your turn**, you may announce **"Cactus"**.

- Every other player then takes **exactly one more turn** (the **final lap**), in
  normal clockwise order.
- The announcer does **not** play again.
- Then all layouts are revealed and scored.

**How late is too late.** At a table nobody ends their turn formally: you play,
and you say it, and the others let you as long as none of them has gone yet. So
the deadline is **the next player finishing their turn** — until then the
announcement is still yours to make, and its effect is identical to having made
it the moment you put your card down (the lap counts the same turns either way).
Once they have finished, the window has moved to them.

→ `announce.timing = AFTER_TURN`, the default. Two consequences worth naming:
the round needs no "end my turn" step at all, since nothing is left to decide
once you have played; and the announcement is the one action a player takes
while it is not their turn.

*Disagreement:* stricter tables close the window at the end of your own turn,
which then has to be ended explicitly (`END_OF_TURN`); some allow announcing
*instead of* taking a turn (`INSTEAD_OF_TURN`); some require you to believe you
are under a threshold (5 or 6) before you may announce; some allow a
"contre-Cactus" challenge by another player.
→ `announce.timing`, `announce.requiresThreshold`.

## 8. Scoring

Each player's round score is the sum of their remaining cards' values.

- **The announcer is strictly lowest** → announcer scores **0**; everyone else
  scores their sum.
- **The announcer is not strictly lowest** (a **tie counts as a failure**) →
  the announcer is penalised: **sum × 2** by default (variants: sum + 10,
  sum + 20). Everyone else scores their sum.

Rationale for tie = failure: without it, announcing is free whenever you can
force a draw, and the announcement stops being a risk.

The match continues over multiple rounds. A player is out — and the match ends —
when someone's **cumulative** score reaches **100**. The **lowest** cumulative
score wins.

*Disagreement:* whether non-announcers score 0 when the announcer fails (some
rulesets zero everyone else as the punishment); the size of the announcer
penalty; the match limit (100 / 200 / fixed number of rounds); whether reaching
the limit eliminates that player or ends the match.
→ `scoring.*`, `match.*`.

Two widely-played flourishes, both optional:

- **Cactus royal** (`scoring.royalBonus`): finishing on exactly 0 is a total
  victory and may zero the round for the announcer regardless of ties.
- **Kamikaze** (`scoring.kamikaze`): finishing with the *worst possible* hand
  (two Queens and two black Kings) wins the round outright and inflicts a large
  fixed penalty on everyone else.

---

## Variant matrix

Every row here is a point where sources disagree, and every row has a config key.
This table is the contract with [02-rule-config.md](02-rule-config.md): if a row
exists here, the key must exist there, and vice versa.

| # | Rule | Our default | Known variants | Config key |
|---|------|-------------|----------------|------------|
| 1 | Deck size | 52, no jokers | +2 jokers; 2 decks at 5–8 players | `deck.useJokers`, `deck.deckCount` |
| 2 | Cards dealt | 4 | 5, 6 (longer game) | `deck.handSize` |
| 3 | Initial peek count | 2 | 1, 3 | `deck.initialPeekCount` |
| 3b | Which cards may be peeked | the 2 nearest (fixed slots) | any 2 of your choice | `deck.initialPeekFree` |
| 4 | Joker value | −1 | −2, 0 | `values.joker` |
| 5 | Red King value | 0 | −1, −2 | `values.redKing` |
| 6 | Black King value | 13 | 15, 20 | `values.blackKing` |
| 7 | Queen value | 12 | 10 | `values.queen` |
| 8 | Jack value | 11 | 10 | `values.jack` |
| 9 | Which ranks have powers | 7/8, 9/10, J/Q, black K | 8 only; Cambio's 6/7, 8/9, 10/J, K | `powers.map` |
| 10 | Ace-give power | off | on | `powers.aceGiveEnabled` |
| 11 | Power misuse penalty | +1 face-down card, turn ends | no penalty; turn ends only | `powers.misusePenaltyCards` |
| 12 | Snap enabled | on | off | `snap.enabled` |
| 13 | Snap failure penalty | +1 face-down card | +2; none | `snap.failurePenaltyCards` |
| 14 | Snap on an opponent's card | off | on (give them one of yours) | `snap.allowOnOpponent` |
| 15 | Emptying layout by snap | ends round, score 0 | round continues | `snap.emptyLayoutEndsRound` |
| 16 | Snap after announcement | allowed | forbidden during final lap | `snap.allowedDuringFinalLap` |
| 17 | Losing a snap race | no penalty | treated as a failed snap | `snap.loserPenalty` |
| 18 | When you may announce | end of your turn | instead of your turn | `announce.timing` |
| 19 | Threshold to announce | none | must believe ≤ 5 or ≤ 6 | `announce.requiresThreshold` |
| 20 | Announcer succeeds | announcer 0, others sum | announcer sum, others sum | `scoring.announcerSuccessScore` |
| 21 | Announcer fails | announcer sum × 2 | sum + 10; sum + 20 | `scoring.announcerFailurePenalty` |
| 22 | Tie for lowest | counts as failure | counts as success | `scoring.tieCountsAsFailure` |
| 23 | Others when announcer fails | score their sum | score 0 | `scoring.othersScoreOnAnnouncerFailure` |
| 24 | Cactus royal (0 points) | off | on | `scoring.royalBonus` |
| 25 | Kamikaze hand | off | on, +50 to everyone else | `scoring.kamikaze` |
| 26 | Match limit | 100 cumulative | 200; fixed round count | `match.scoreLimit`, `match.roundLimit` |
| 27 | Reaching the limit | ends the match | eliminates that player only | `match.limitEliminates` |
| 28 | Stock exhausted | reshuffle discard except top | round ends immediately | `deck.reshuffleDiscard` |
| 29 | Card turned up at the deal | yes | no, the discard starts empty | `deck.seedDiscard` |
| 30 | Taking the top of the discard | allowed | stock only | `turn.takeFromDiscard` |
| 31 | A card leaving your layout for the discard | no power | fires its own power, for you | `powers.onHandDiscard` |

---

## Sources

- [Dutch (jeu de cartes) — Wikipédia (fr)](https://fr.wikipedia.org/wiki/Dutch_(jeu_de_cartes)) — the most complete single account: power table (7/8, 9/10, J/Q, black King, Ace-give), red/black King split, *défausse rapide*, announcer penalty, 100-point match limit, and the list of alternative names.
- [Les VRAIES règles du Cactus — Gamelia](https://gamelia.net/blog/regles-cactus-jeu-de-cartes/) — 2–6 players, 4 cards in a square, King 0 / Ace 1 / figures 10, the 8's power, instant-discard rule with blind penalty card, announcing under 6, "cactus royal".
- [Règle du jeu — Jeu de cartes "le cactus"](https://jeuducactus.wordpress.com/2014/04/23/regle-du-jeu/) — the French schoolyard version: peek the 2 nearest cards, only the 8 has a power, target "under 5", matching-card discard shrinks the hand, cumulative penalty variant. **The only source with no face-up card at the deal** — it says taking the discard "n'est pas possible au premier tour puisque la défausse est vide", which is what row 29 records.
- [Cambio Card Game](https://cambiocardgame.com/) — the commercial cousin: 4 cards in a 2×2 grid, one peek at 2, power ranks shifted (6/7 own, 8/9 opponent, 10/J blind swap, black King look-and-swap), call the word at the end of your turn.
- [Golf — Pagat](https://www.pagat.com/draw/golf.html) — the wider family this game belongs to, and where the "lowest layout wins, knock to end" structure comes from.
- [Le jeu de cartes "Cactus" — Webjournal](https://sasdit.wixsite.com/webjournal/post/le-jeu-de-cartes-cactus) — corroborates the schoolyard variant (memory + speed phases, "avoir cactus" under 5).

Where sources conflict, this spec follows the French Wikipedia *Dutch* article for
mechanics (it is the most complete and internally consistent), and exposes the
alternatives as configuration.
