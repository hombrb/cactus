# Handover — next session: multi-device play

Written at the end of the session that shipped V1 (`d48f1c5`). Read this before
touching anything. It is in English like `docs/` and the code; the *app* is
French and must stay French.

---

## 1. Sixty-second orientation

| | |
|---|---|
| Repo | `hombrb/cactus`, branch `claude/cactus-game-logic-plan-oapu0e` |
| Last commit | `d48f1c5` — "Add playable V1: two players, one phone" |
| What works today | A complete, playable 2-player game on one shared phone. Offline, installable, no backend. |
| What is next | The same game across **several phones**, joined by a Kahoot-style code. |
| Engine | `src/engine/`, ~2 400 lines, pure, framework-free |
| UI | `src/ui/`, ~1 300 lines, no framework, retained DOM |
| Spec | `docs/`, 12 files. The engine is a transcription of `docs/03`–`docs/09`. |

```bash
npm install
npm run dev                       # dev server
npm test                          # 13 engine tests, ~3 s
npm run build                     # tsc --noEmit + vite build
npm run preview                   # needed by the two scripts below
npm run shots                     # drives Chromium at 390×844, fails on clipped cards
npm run check:pwa                 # manifest, iOS metas, genuine offline reload
npm run verify                    # all of the above
```

`?seed=xxx` on the URL forces a deterministic deal — that is how `scripts/shots.mjs`
reaches a specific situation. `scripts/find-seed.ts` (run with `npx vite-node`)
searches for a seed whose first draw carries a given power.

**Do not run `npx playwright install`.** The browsers are preinstalled and the
scripts point at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` explicitly,
because the installed build does not match the playwright package's expected
revision.

---

## 2. Where things stand

### Done and verified

- **Engine**: full `standard` and `school` rulesets, all powers (7/8, 9/10, J/Q,
  black King), snap with penalties, announcement + final lap, round and match
  scoring. Pure `applyAction(state, action) → {state, events}`.
- **Tests**: `tests/trace.test.ts` replays the 37-step worked trace of
  `docs/11 §3` and asserts the documented outcome (20/8/8, tie ⇒ announcement
  fails, Chloé 16). `tests/invariants.test.ts` runs 160 seeded random games across
  4 configs, checking every invariant after *every* reduction, plus a
  projection-leak sweep.
- **UI**: flat-table 2-player board, three-gesture vocabulary, reveal grants,
  menu / rules / settings / round-end.
- **PWA**: manifest, iOS metas, build-time precache plugin, verified offline
  reload.

### Known gaps (deliberate, not forgotten)

- `snap.allowOnOpponent` and the Ace `GIVE_CARD` power are implemented in the
  engine and handled by the targeting UI, but **off by default and never
  exercised in a real game**. Treat them as untested.
- **Host promotion is specified but not implemented.** `docs/10 §2` says to
  promote the next connected player when the host leaves; nothing does this.
- `projectEvent` (`src/engine/project.ts`) is written, correct and **entirely
  unused** — the local game hands the UI raw events. It exists precisely for the
  network step. Read it before writing anything new.
- No CI. `npm run verify` is the gate; run it before every commit.

---

## 3. The objective, and what is already decided

**Goal: rooms across devices.** Six-character join code, no accounts, no
database, ephemeral rooms. The flat-table mode stays as-is alongside it.

### Hosting — settled, with the numbers

**Cloudflare Workers + Durable Objects, free plan.** One room = one Durable
Object, which is exactly the "single writer holding `GameState` in memory" the
spec demands. Static assets on the same Worker (or Pages).

Researched during the previous session and worth not re-litigating:

- Durable Objects are on the **Workers Free plan** since April 2025 (SQLite
  backend only): 100 000 requests/day, 5 GB storage.
- Incoming WebSocket messages bill at a **20:1 ratio**; outgoing are free. A
  4-player match ≈ 1 000 inbound messages ≈ **50 billable requests**. The daily
  quota is roughly 1 800 matches. It will never be reached.
- **Vercel is the wrong tool here**: functions are stateless, so a no-DB room
  needs an external KV anyway. The widely-recommended way to get realtime on
  Vercel's free tier is to put Cloudflare Workers next to it — so go straight
  there.
- Hostinger shared hosting cannot host the authority (no long-lived process, no
  WebSocket). It can serve `dist/` and hold the domain.

### The one Durable Object trap

**WebSocket Hibernation evicts the object from memory while the sockets stay
open.** In-memory `GameState` is lost. So the DO must persist state after every
action.

Good news, verified this session: **`GameState` is fully JSON-serialisable.**
Every `Set`/`Map` in the engine is local to a function body — `knownBy` and
`lockedSlots` are plain arrays, `cards` is a `Record`. `JSON.stringify(state)` is
safe today and must stay safe. Budget: 100 000 row writes/day ≈ 100 matches/day
at one write per action.

---

## 4. What the engine already gives you

Most of the hard multiplayer thinking is already in the spec and the code:

- **`applyAction` is pure and deterministic.** The DO can be a thin loop:
  receive action → `applyAction` → persist → fan out projected events.
- **`projectFor(state, viewer)`** already builds a per-player view that ships only
  the card ids that viewer is entitled to, and never `rngSeed`, `stock` contents,
  or `knownBy`. The leak sweep in `tests/invariants.test.ts` proves it.
- **`projectEvent(event, viewer)`** already redacts the event stream. Unused so
  far — this is where it earns its keep.
- **`Snap.forVersion`** already makes the snap race latency-tolerant. A snap for a
  superseded `discardVersion` is a *lost race*, not a wrong snap, and
  `snap.loserPenalty` decides whether that costs anything.
- **`Timeout` carries `phaseToken`** (the `actionCounter` it was armed against), so
  a stale timer is dropped silently instead of firing late.
- **The event log is the reconnection primitive** (`docs/09 §6`, `docs/10 §4`).

### The one thing the engine does *not* do, by design

Real-time fairness. `docs/07 §1` and `docs/10 §5` are explicit: the reducer never
sees a timestamp. The **authority** buffers competing snaps for
`cfg.timing.snapGraceMs` (250 ms), orders them by latency-adjusted arrival, and
submits them to the reducer in that order. Put that in the DO, not in the engine.

---

## 5. The work, in order

**Phase 1 — cut the UI's dependency on full `GameState`.** This is the real work,
and it is worth doing first because it is independently valuable and testable
locally.

`src/ui/game/board.ts` reads `this.store.state` on **12 lines** (42, 65, 68, 150,
175, 186, 195, 320, 328, 333, 342, 349), and `isTargetable` / `patchHalf` take a
whole `GameState` as a parameter. A networked client will only ever hold a
`PlayerView`. So:

- Move everything the UI needs into `PlayerView` — it already carries `phase`,
  `currentPlayer`, `pendingPower`, `discardVersion`, `heldBy`, `stockCount`. Add
  what is missing (`config`, `hostId`, `pendingSnapGive`) rather than reaching
  past it.
- `RevealGrants.ingest` must consume **projected** events, not raw ones.
- Keep the local game working through the same path: one device simply builds two
  views instead of talking to a socket. If the flat-table mode still passes
  `npm run verify` afterwards, the refactor is right.

**Phase 2 — transport-agnostic client seam.** Give `Store` two implementations
behind one interface: local (`applyAction` inline, today's behaviour) and remote
(send action, receive projected events). `src/ui/store.ts` is 30 lines and is the
right place.

**Phase 3 — the Durable Object.** `worker/room.ts`: WebSocket hibernation, room
code → `idFromName(code)`, `GameState` persisted after every action, projected
fan-out per connection, snap grace buffer, `Timeout` arming. Restore the timers:
`table2p` sets them all to `null`, and online play needs `standard`'s values back.

**Phase 4 — lobby UI.** Create/join by code, player list, host starts. `LobbyJoin`
/ `LobbyLeave` exist in the reducer but are barely exercised — check them.
Implement host promotion here.

**Phase 5 — 3-to-8 players.** The engine already supports it (`autoTwoDecksAbove`
switches to two decks above 4). The **UI does not**: `board.ts:42` hard-codes
`turnOrder[0]` and `[1]`, `app.ts:66-75` hard-codes `p1`/`p2`, and
`settings.ts` has exactly two name fields. A table of N opponents is a different
layout from two rotated halves — probably opponents as compact strips with your
own hand large at the bottom. Do not try to reuse the flat-table board.

---

## 6. Traps that will bite

1. **Rendering everything the projection permits is a leak.** `knownBy` persists,
   so a card peeked at the start stays *permitted* all round. On a shared screen
   that means both players' cards sit face up. The reveal-grant mechanism in
   `src/ui/game/privacy.ts` is the fix and must survive the refactor. Online this
   matters less (each player has their own screen) but the grant model is still
   correct: it is what stops a client re-rendering a card the human should have
   had to remember. See `docs/09 §5`.
2. **Never enforce `announce.requiresThreshold` server-side.** Rejecting an
   announcement leaks the announcer's hand through the rejection itself. It is
   advisory on purpose (`docs/05 §6`, `docs/02`).
3. **Never send `rngSeed`.** It is the stock order. `projectFor` already omits it;
   do not "helpfully" add state to the wire format without re-reading `docs/09 §2`.
4. **Illegal power targets and wrong snaps are punished, not rejected.** Rejecting
   turns the UI into a free board oracle. `docs/06 §2`, `docs/07 §3`.
5. **`discardVersion` restarts at 1 every deal.** It is monotonic *within* a
   round only, and it does **not** track the discard's size (`TakeDiscard` and the
   Ace-give bump it while shrinking the pile). A previous version of `docs/11`
   claimed otherwise and the invariant test caught it.
6. **The service worker does not control the page that registered it.** Hence the
   build-time precache plugin in `vite.config.ts`. And `caches.match` needs
   `ignoreVary: true`: Vite emits its module script with `crossorigin`, so the real
   request carries an `Origin` header the precached entry lacks, and a server
   answering `Vary: Origin` makes every asset lookup miss — silently breaking
   offline. Both traps cost real debugging time; do not undo either.
7. **`overflow: hidden` hides layout bugs from scroll-height checks.**
   `scripts/shots.mjs` measures card bounding boxes against the viewport for
   exactly this reason. Keep that assertion.
8. **Cards must size from available height, never fixed width.** A layout grown
   past four cards by penalties has to shrink, not overflow. `src/styles/board.css`.

---

## 7. Ask the user before deciding

These change the shape of the work and are not mine to pick:

- **Player count online.** Keep it at 2, or go to 3–8? Phase 5 is a substantial
  UI job and only worth it if wanted.
- **Does the flat-table mode stay?** Assumed yes, as the offline/no-signal
  fallback — worth confirming before the Phase 1 refactor complicates it.
- **Deployment.** Which Cloudflare account, which domain, and whether to wire the
  Hostinger domain's DNS to Cloudflare.
- **Spectators / rejoin after a match ends** — not specified anywhere yet.

---

## 8. Conventions to keep

- **The engine stays pure.** No DOM, no clock, no ambient randomness. All random
  through `src/engine/rng.ts`, seeded. This is what makes replay and the tests
  work, and it is what lets the DO be a thin loop.
- **No rule constant as a literal.** Everything reads from `RuleConfig`
  (`docs/02`). If you type `13` or `100` in the engine, it is a bug.
- **The spec is the reference, and it is kept true.** Function names in
  `src/engine/` match the pseudocode names in `docs/03`–`docs/09` deliberately.
  When implementation proves the spec wrong, **fix the spec in the same commit** —
  that is what happened to the `hotseat` preset and to the `discardVersion`
  invariant. Do not let the code and the docs drift.
- **French UI, English code and docs.**
- **`npm run verify` before every commit.**
