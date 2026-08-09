# Cactus — Game Logic Specification

This directory is a **logic specification**, not an application. It describes, in
language-neutral pseudocode, everything needed to implement the card game
**Cactus** (also known as *Dutch*, *Tamalou*, *Cabo*, *Pablo*, *Kabo*) correctly:
the rules, the data structures, the state machine, the deterministic reducer, the
hidden-information model, and the multiplayer authority model.

Anyone should be able to read these files and write a working engine in any
language without making a single rules decision themselves.

## Non-goals

- **No application.** No UI, no framework, no routes, no build system.
- **No bot / AI design.** The engine exposes what a player was *shown*; deciding
  what to do with that is out of scope.
- **No persistence design.** Rooms are ephemeral by nature; see
  [10-multiplayer-and-modes.md](10-multiplayer-and-modes.md) for the (short)
  hosting trade-offs.
- **No memory simulation.** The engine never remembers *for* a player. See
  [09-hidden-information.md](09-hidden-information.md).

## Reading order

| # | File | What it settles |
|---|------|-----------------|
| — | [README.md](README.md) | Scope, glossary, pseudocode conventions |
| 01 | [01-rules-reference.md](01-rules-reference.md) | The rules as researched, and every point where sources disagree |
| 02 | [02-rule-config.md](02-rule-config.md) | `RuleConfig`: one key per contested rule, plus presets |
| 03 | [03-domain-model.md](03-domain-model.md) | Types: `Card`, `Slot`, `PlayerState`, `GameState`, `Action`, `Event` |
| 04 | [04-state-machine.md](04-state-machine.md) | Phases, transition table, diagram |
| 05 | [05-engine-core.md](05-engine-core.md) | `validate` + `applyAction`, deal, turn actions, turn advance |
| 06 | [06-powers.md](06-powers.md) | Resolution of 7/8, 9/10, J/Q, black King, Ace |
| 07 | [07-snap.md](07-snap.md) | *Défausse rapide*, race resolution, slot locking |
| 08 | [08-scoring.md](08-scoring.md) | Round scoring, announcer penalty, match scoring |
| 09 | [09-hidden-information.md](09-hidden-information.md) | Authoritative state vs. per-player views |
| 10 | [10-multiplayer-and-modes.md](10-multiplayer-and-modes.md) | Rooms, authority, transport, single-device hotseat |
| 11 | [11-edge-cases-and-invariants.md](11-edge-cases-and-invariants.md) | Edge-case table, invariants, worked trace |

If you only read three: **02** (what the rules actually are), **05** (the
reducer), **07** (the part everyone gets wrong).

## Glossary

| Term | Meaning |
|------|---------|
| **Layout** | The set of cards in front of one player. Starts at 4, laid out 2×2. May grow (penalties) or shrink (snaps). |
| **Slot** | One fixed position in a layout. Slots are **never reordered**; a removed card leaves an `EMPTY` hole. |
| **Stock** | The face-down draw pile. |
| **Discard** | The face-up pile. Only its top card is meaningful for play. |
| **Held card** | The card a player has drawn from the stock and not yet placed or discarded. Exists only mid-turn. |
| **Power** | An effect that triggers when a drawn card is discarded *directly* (never when it is swapped in). |
| **Peek** | Being shown a card's face without it changing position. |
| **Snap** (*défausse rapide*) | Slamming a layout card matching the discard top's rank, out of turn, at any time. |
| **Announce** | Saying "Cactus" to trigger the end of the round. |
| **Announcer** | The player who announced. |
| **Final lap** | The one turn each other player gets after an announcement. |
| **Round** | One deal, ending in a reveal and scoring. |
| **Match** | A sequence of rounds, ending when someone crosses the cumulative score limit. |

## Pseudocode conventions

The pseudocode is deliberately not any real language. It is imperative, lightly
typed, and uses `camelCase` identifiers.

```
type Name { field: Type, other: Type? }        // `?` marks nullable
type Union = VariantA | VariantB
enum Kind = A | B | C

fn name(arg: Type) -> ReturnType
  ...
  return value

assert condition, "message"                     // invariant; a violation is a bug, not a rule
reject "REASON_CODE"                            // an illegal action by a player; never throws
emit EventName { ... }                          // appended to the event log
```

- **`state` is immutable.** Every reducer returns a *new* state. `with` denotes a
  copy-with-changes: `state with { phase: REVEAL }`.
- **`cfg`** is shorthand for `state.config` — the `RuleConfig`. Any rule constant
  in this spec is written as `cfg.something`, never as a bare literal.
- **`reject`** is a normal, expected outcome (a player clicked something illegal).
  **`assert`** failing means the engine is broken.
- Card *identity* is `CardId`; card *face* is `(rank, suit)`. Pseudocode says
  `cardOf(id)` when it needs the face.
- All randomness goes through the seeded RNG in
  [03-domain-model.md](03-domain-model.md). No implementation may call a global
  random source.

## Status

This spec targets the `standard` preset defined in
[02-rule-config.md](02-rule-config.md). Everything a table might play differently
is a config key, so house rules never require touching the engine.
