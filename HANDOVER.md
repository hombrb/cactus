# Handover — next session: more than two players, and a real deploy

Written at the end of the session that shipped the lobby. Read this
before touching anything. It is in English like `docs/` and the code; the *app*
is French and must stay French.

---

## 1. Sixty-second orientation

| | |
|---|---|
| Repo | `hombrb/cactus`, branch `claude/reprise-handover-ewoyce` |
| Last commit | the lobby |
| What works today | A complete 2-player game **on one shared phone or on two phones**, joined by a six-character code. End to end. |
| What is missing | More than two players, and a Git-connected deploy on a real domain. |
| Engine | `src/engine/`, pure, framework-free |
| Authority | `src/net/room-core.ts` (all decisions) + `worker/room.ts` (sockets, storage, alarm) |
| UI | `src/ui/`, no framework, retained DOM, renders from `PlayerView` only |
| Spec | `docs/`, 12 files, kept true |

```bash
npm install
npm run dev                       # dev server
npm test                          # 59 tests, ~5 s
npm run build                     # typecheck (app + worker) + vite build
npm run preview                   # needed by the two scripts below
npm run shots                     # Chromium at 390×844, fails on clipped cards — Chromium ONLY
npm run check:pwa                 # manifest, iOS metas, genuine offline reload
npm run verify                    # all of the above

npm run dev:worker                # wrangler dev on :8787, serves dist/ + /api
npm run check:room                # 24 protocol checks over raw sockets
npm run check:lobby               # 22 checks driving two browsers through the UI
npm run check:online              # both of the above
```

`npm run verify` is the gate and needs `npm run preview` running.
`npm run check:online` is separate on purpose — it needs `npm run dev:worker`
running, and booting workerd is a heavier dependency than the gate should carry.
**Run both before committing anything that touches `src/net/`, `worker/` or the
online path.** `check:lobby` opens two browser contexts, so two localStorages,
so two genuinely different players — it is the only test that plays the game the
way a person does.

`?seed=xxx` on the URL forces a deterministic deal — that is how
`scripts/shots.mjs` reaches a specific situation.

**Do not run `npx playwright install`.** The browsers are preinstalled and the
scripts point at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` explicitly.

---

## 2. Where things stand

### Done and verified

- **Engine**: unchanged this session except for host promotion. Full `standard`
  and `school` rulesets, all powers, snap, scoring.
- **Rules are choosable, not just presets.** `Réglages → Pouvoirs` edits
  `powers.map` rank by rank, and `deck.seedDiscard` / `turn.takeFromDiscard`
  turn the opening face-up card and taking the discard on and off. A preset is
  now a starting point plus overrides; the host's choices reach a room intact
  and are named back to the guest in the lobby. See
  [docs/02 §Choosing a config](docs/02-rule-config.md#choosing-a-config).
- **The renderer no longer knows what a `GameState` is.** `board.ts` reads only
  `PlayerView`s obtained from a `GameClient`. This was the point of the whole
  refactor: the flat-table mode now goes through per-seat `projectFor` and
  `projectEvent`, so it is a live test of the network path rather than a
  separate one.
- **`GameClient` seam** (`src/ui/client.ts`) with two implementations:
  `LocalClient` (applies actions itself, holds every seat) and `RemoteClient`
  (`src/ui/remote-client.ts`, one seat, a socket, no state).
- **The room** (`src/net/room-core.ts`): membership, identity substitution,
  per-recipient fan-out, the snap grace buffer, turn timeouts, host promotion.
  Transport-free, so it is tested on a fake clock.
- **The Durable Object** (`worker/room.ts`): hibernation, persistence after
  every action, alarms, ping/pong latency, socket attachments.
- **The lobby** (`src/ui/screens/lobby.ts`): create a room with the host's own
  rules, join by code, player list, host-only start. Identity is
  `src/ui/identity.ts`.
- **Tests**: 59 in `npm test` — the 37-step worked trace, the invariant sweep
  (now including an assembled config: custom powers, no opening discard, stock
  only), the projection/wire-format sweep, 21 room tests, and 15 config tests
  covering what a client is allowed to ask for. Plus 24 protocol checks and 22
  two-browser checks against a real Durable Object.

### Known gaps (deliberate, not forgotten)

- **Deployed to a `workers.dev` subdomain**, by hand. No Git-connected build
  and no custom domain yet — see §7.
- **Rooms are two players.** The lobby's start button unlocks at two and the
  board is two-sided. Phase 5.
- **No room TTL.** An abandoned Durable Object idles for free, so this is
  tidiness rather than cost — but docs/10 §2 promises one.
- `snap.allowOnOpponent` and the Ace `GIVE_CARD` power remain implemented,
  off by default, and never exercised in a real game. Still untested — which is
  why `GIVE_CARD` is deliberately absent from `SELECTABLE_POWERS` and cannot be
  reached from the powers editor.
- The board is still a two-sided flat table. 3–8 players is phase 5.
- No CI. The two commands above are the gate, and neither of them can see
  Safari — see trap 12.

---

## 3. What was decided this session

Asked and answered, so do not re-open without a reason:

- **The host picks the rules** at creation, from their own settings. The client
  sends answers — `preset`, `snap`, `scoreLimit`, `powers`, `seedDiscard`,
  `takeFromDiscard` — never a `RuleConfig`, so it can choose among the game's
  rules but not invent one. `powers` is the one answer with structure, and
  `parsePowerMap` allow-lists both its ranks and its power kinds against the
  engine's own lists before anything believes it.
- **The online pseudonym is asked in the lobby**, prefilled from settings —
  otherwise two fresh phones both call themselves "Joueur 1".
- **Online player count: 2 for now, but designed for N.** So `PlayerView`
  carries `turnOrder` rather than assuming two seats, `endOfRoundPrompt`
  compares against "the best of the others", and the board builds one half per
  player. The *layout* is still two-sided; that is the honest remaining limit.
- **The flat-table mode stays**, as the offline fallback. It must keep passing
  `npm run verify` — that is the test of every refactor here.
- **Hosting: Cloudflare Workers + Durable Objects, free plan.** Recorded with
  the numbers and the rejected alternatives in
  [docs/10 §3](docs/10-multiplayer-and-modes.md#3-authority).

---

## 4. The work, in order

**Phase 5 — 3-to-8 players. This is the next session's job.**

The engine already supports it (`autoTwoDecksAbove` switches to two decks above
4) and `PlayerView` no longer assumes two seats. Three things do:

- `board.ts` builds exactly two halves, top and bottom, from `turnOrder`.
- `src/styles/board.css` is a two-row grid with one half rotated.
- `lobby.ts` unlocks its start button at two connected players.

A table of N is probably opponents as compact strips across the top with your
own hand large at the bottom — a different board, not a wider one. Do not try to
stretch the flat table into it. Note the flat table stays two-player either way;
it is a phone lying between two people.

**Phase 6 — deploy properly.** `npm run deploy` is `build && wrangler deploy` and wants
an authenticated Cloudflare account. See §7.

---

## 5. Traps that will bite

1-4 came out of the network work. 11-14 are all layout, and all cost a real
device or a real second browser to find — they are the ones a passing gate will
not save you from. The rest predate this session and are still live.

1. **A hibernating Durable Object loses everything in memory while its sockets
   stay open.** Hence: the snapshot is persisted after every action, an open
   snap buffer is persisted too, and per-socket identity rides on
   `ws.serializeAttachment` rather than in a `Map`. A `Map<socket, player>` will
   appear to work for an hour and then drop a room.
2. **`GameState` must stay JSON-serialisable.** Every `Set`/`Map` in the engine
   is local to a function body; `knownBy` and `lockedSlots` are arrays. One
   `Set` on the state object and hibernation silently turns it into `{}`.
   `tests/projection.test.ts` asserts the round-trip — keep that test.
3. **The authority overwrites the `playerId` on every incoming action.** A
   client asserting somebody else's id gets its own substituted and the reducer
   rejects it on the merits. Never trust the payload's id.
4. **`playerId` is the credential.** It is a `crypto.randomUUID` in
   `localStorage`, and whoever presents it gets that seat. Never put it in a
   join link, a log, or a QR code. The join *code* is the shareable thing.
5. **Rendering everything the projection permits is a leak.** `knownBy`
   persists, so a card peeked at the start stays *permitted* all round. The
   reveal-grant mechanism in `src/ui/game/privacy.ts` is the fix; it is now
   per-seat and consumes projected events. See docs/09 §5.
6. **Never enforce `announce.requiresThreshold` server-side.** Rejecting an
   announcement leaks the announcer's hand through the rejection itself. It is
   advisory on purpose (docs/05 §6).
7. **Never send `rngSeed`.** It is the stock order. Both `projectFor` and the
   room fan-out omit it, and two separate tests assert it.
8. **Illegal power targets and wrong snaps are punished, not rejected.**
   Rejecting turns the UI into a free board oracle. docs/06 §2, docs/07 §3.
9. **`SnapFailed` and `SnapSucceeded` name a card nobody is "entitled" to.**
   That is deliberate — the card was flipped in front of everyone and `knownBy`
   is cleared on purpose. The leak sweep names them as exceptions; if you widen
   the rule to make them pass, you have disabled the sweep.
10. **`discardVersion` restarts at 1 every deal.** Monotonic *within* a round
    only, and it does not track the discard's size.
11. **WebKit will not derive a grid track's width from its item's height.**
    `grid-template-columns: auto` with `height: 100%` cards and `aspect-ratio`
    is circular — the track wants the card's intrinsic width, which comes from
    its height, which comes from the track. Chromium resolves it; **iOS Safari
    takes the contribution as zero and collapses every card to a 2px sliver**,
    which shipped to a real phone while every Chromium screenshot stayed clean.
    `.layout` is now a `container-type: size` container and the tracks are plain
    `cqh`/`cqw` lengths, so nothing in a track depends on its card. Do not put
    `auto` tracks back.
12. **`npm run shots` only drives Chromium, so it cannot catch trap 11.**
    There is no WebKit binary in `/opt/pw-browsers`. Until there is, anything
    touching `board.css` or `card.css` needs a look on a real iPhone before it
    is called done — the gate passing is not evidence for Safari.
13. **`[hidden]` loses to any author rule that sets `display`.** `.btn` and
    `.lobby` both do, so `el.hidden = true` was silently ignored — which is how
    a guest was shown the host's start button and the waiting panel rendered on
    top of the join form. `base.css` now carries
    `[hidden] { display: none !important }`. Do not remove it.
14. **Never hide a child of `.rotor` and let auto-placement re-flow it.** With
    the tray `display: none` online, `.layout` slid from the `1fr` row up into
    an `auto` one, its height became indefinite, and every card collapsed to
    2px — the same symptom as trap 11, from a different cause. The three rows
    are now pinned with explicit `grid-row`. This was caught by
    `check:lobby`, not by the gate, because the flat table never hides a tray.
15. **The service worker does not control the page that registered it.** Hence
    the build-time precache plugin in `vite.config.ts`. And `caches.match` needs
    `ignoreVary: true`. Do not undo either.
16. **`overflow: hidden` hides layout bugs from scroll-height checks.**
    `scripts/shots.mjs` measures card bounding boxes against the viewport for
    exactly this reason. Keep that assertion.
17. **Cards must size from available height, never fixed width.** A layout
    grown past four cards by penalties has to shrink, not overflow.
    `src/styles/board.css`.
18. **Whatever the page does not paint, iOS fills from the *root* element.**
    The felt used to live on `#app`, which is `position: fixed; inset: 0` and so
    only ever covered the layout viewport. In an installed web app the strip
    left below it showed the flat `--felt-deep` of `html, body` — darker than
    the gradient's own bottom edge, with a hard seam. That seam was the dark bar
    along the bottom of the screen on a real iPhone. The felt is now a root
    background (propagated to the canvas) that reaches `--felt-deep` *before*
    the edges, so the canvas fill and the visible edge are the same colour.
    **`body` must stay `background: transparent`** — it is `height: 100%`, so
    any background of its own repaints a flat rectangle over the fix.
    `check:pwa` asserts all three.

---

## 6. What the engine and the room already give you

- **`applyAction` is pure and deterministic**, and the Durable Object is the
  thin loop that promised: receive → substitute identity → `applyAction` →
  persist → fan out projected events.
- **`projectFor` / `projectEvent`** are load-bearing now, not decoration.
- **Snap fairness is solved and tested.** Competing snaps buffer for
  `cfg.timing.snapGraceMs`, order by arrival minus half the smoothed RTT, and
  submit in that order. `snapGraceMs = 0` disables it and lets packet arrival
  decide — a legitimate choice, it just means fibre always wins.
- **Timeouts carry `phaseToken`**, so a Cloudflare alarm firing late against a
  phase that has moved on is dropped rather than applied.
- **Reconnection works**: a known `playerId` is let back into its seat mid-match
  and is sent a fresh `welcome` view. It replays no events — the view is
  authoritative and the event stream is only ever a hint for animation.

---

## 7. Ask the user before deciding

- **Deployment.** Which Cloudflare account, which domain, and whether to point
  the Hostinger domain's DNS at Cloudflare. Nothing can ship until this is
  answered. `wrangler deploy` also needs an interactive login the sandbox does
  not have.
- **Room TTL and cleanup.** docs/10 §2 says rooms die by TTL; nothing implements
  one yet. A Durable Object with no sockets and no alarm simply idles, which
  costs nothing, so this is a tidiness question rather than a cost one. Note a
  code is claimed at creation and never released, so codes only accumulate.
- **Spectators / rejoin after a match ends** — still not specified anywhere.

---

## 8. Conventions to keep

- **The engine stays pure.** No DOM, no clock, no ambient randomness. Real time
  lives in `room-core.ts` and nowhere else. This is what lets the Durable Object
  be a thin loop.
- **The Durable Object stays thin.** If you find yourself writing a rule in
  `worker/room.ts`, it belongs in `room-core.ts`, where it can be tested.
- **No rule constant as a literal.** Everything reads from `RuleConfig`. If you
  type `13` or `100` or `250` in the engine, it is a bug.
- **The spec is the reference, and it is kept true.** When implementation proves
  the spec wrong, **fix the spec in the same commit** — that is what happened to
  the `hotseat` preset, the `discardVersion` invariant, and this session to
  docs/10 §3's hosting recommendation and docs/09 §2's view shape.
- **French UI, English code and docs.**
- **`npm run verify` before every commit; `npm run check:room` too when the
  network path changed.**
