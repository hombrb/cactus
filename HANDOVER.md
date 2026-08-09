# Handover — next session: the lobby

Written at the end of the session that shipped the room authority. Read this
before touching anything. It is in English like `docs/` and the code; the *app*
is French and must stay French.

---

## 1. Sixty-second orientation

| | |
|---|---|
| Repo | `hombrb/cactus`, branch `claude/reprise-handover-ewoyce` |
| Last commit | the one that added `worker/` and `src/net/` |
| What works today | A complete 2-player game on one shared phone, **and** a working server-authoritative room behind a join code. |
| What is missing | Any way for a human to *reach* the room. There is no lobby screen, so the networked path is exercised only by tests. |
| Engine | `src/engine/`, pure, framework-free |
| Authority | `src/net/room-core.ts` (all decisions) + `worker/room.ts` (sockets, storage, alarm) |
| UI | `src/ui/`, no framework, retained DOM, renders from `PlayerView` only |
| Spec | `docs/`, 12 files, kept true |

```bash
npm install
npm run dev                       # dev server
npm test                          # 42 tests, ~4 s
npm run build                     # typecheck (app + worker) + vite build
npm run preview                   # needed by the two scripts below
npm run shots                     # drives Chromium at 390×844, fails on clipped cards
npm run check:pwa                 # manifest, iOS metas, genuine offline reload
npm run verify                    # all of the above

npm run dev:worker                # wrangler dev on :8787, serves dist/ + /api
npm run check:room                # 23 end-to-end checks against that worker
```

`npm run verify` is the gate and needs `npm run preview` running.
`npm run check:room` is separate on purpose — it needs `npm run dev:worker`
running, and booting workerd is a heavier dependency than the gate should carry.
**Run both before committing anything that touches `src/net/` or `worker/`.**

`?seed=xxx` on the URL forces a deterministic deal — that is how
`scripts/shots.mjs` reaches a specific situation.

**Do not run `npx playwright install`.** The browsers are preinstalled and the
scripts point at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` explicitly.

---

## 2. Where things stand

### Done and verified

- **Engine**: unchanged this session except for host promotion. Full `standard`
  and `school` rulesets, all powers, snap, scoring.
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
- **Tests**: 42 in `npm test` — the 37-step worked trace, the invariant sweep,
  the projection/wire-format sweep (`tests/projection.test.ts`), and 20 room
  tests. Plus 23 end-to-end checks in `scripts/check-room.mjs`.

### Known gaps (deliberate, not forgotten)

- **There is no lobby UI.** This is the whole of phase 4 below and it is the
  only thing between here and a real networked game.
- **Nothing is deployed.** `wrangler.toml` is written and correct, but no
  Cloudflare account has been named. See §7.
- `snap.allowOnOpponent` and the Ace `GIVE_CARD` power remain implemented,
  off by default, and never exercised in a real game. Still untested.
- The board is still a two-sided flat table. 3–8 players is phase 5.
- No CI. The two commands above are the gate.

---

## 3. What was decided this session

Asked and answered, so do not re-open without a reason:

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

**Phase 4 — the lobby. This is the next session's job.**

Everything under it already exists; what is missing is the screen.

- `POST /api/room` returns a fresh six-character code, already collision-checked
  against the object that code addresses. Join is
  `GET /api/room/socket?code=&playerId=&name=`.
- `RemoteClient.connect({ url, code, playerId, name })` resolves once the room
  has welcomed the player, so the board never renders empty. Identity comes from
  `loadIdentity(name)` in `src/ui/identity.ts`.
- Wanted: create / join by code on the menu, a player list while in `LOBBY`,
  and a host-only start button. `LobbyJoin` / `LobbyLeave` are exercised by
  `tests/room.test.ts` now, so they are no longer the unknown they were.
- **`app.ts` currently hard-codes `p1`/`p2` and two names** (`settings.ts` has
  exactly two name fields). That is the flat-table path and it can stay, but the
  online path must not copy it.
- **The board's rotation is a flat-table assumption.** `.half[data-seat="top"]`
  rotates its contents 180° because the opponent is sitting opposite. Online,
  nobody is upside down. The seat *ordering* is already right — with one seat
  that seat takes the bottom — but the CSS needs a mode switch.

**Phase 5 — 3-to-8 players.** The engine already supports it
(`autoTwoDecksAbove` switches to two decks above 4) and the view no longer
assumes two. The UI does not: the board is two rotated halves. A table of N is
probably opponents as compact strips with your own hand large at the bottom. Do
not try to widen the flat-table board.

**Phase 6 — deploy.** `npm run deploy` is `build && wrangler deploy` and wants
an authenticated Cloudflare account. See §7.

---

## 5. Traps that will bite

The first four are new this session. The rest cost real debugging time before it
and are still live.

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
11. **The service worker does not control the page that registered it.** Hence
    the build-time precache plugin in `vite.config.ts`. And `caches.match` needs
    `ignoreVary: true`. Do not undo either.
12. **`overflow: hidden` hides layout bugs from scroll-height checks.**
    `scripts/shots.mjs` measures card bounding boxes against the viewport for
    exactly this reason. Keep that assertion.
13. **Cards must size from available height, never fixed width.**
    `src/styles/board.css`.

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
  costs nothing, so this is a tidiness question rather than a cost one.
- **Spectators / rejoin after a match ends** — still not specified anywhere.
- **Whether the online game should use `standard` or let the host pick.** The
  room currently hard-codes `standard` in `worker/room.ts`; the flat table lets
  you choose a preset in settings.

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
