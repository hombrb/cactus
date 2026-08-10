# Handover — next session: more than two players, and a real deploy

Written at the end of the session that shipped the lobby, and brought up to date by
the one that made the powers reachable on two phones. Read this before touching
anything. It is in English like `docs/` and the code; the *app* is French and must
stay French.

---

## 1. Sixty-second orientation

| | |
|---|---|
| Repo | `hombrb/cactus`, branch `claude/multiplayer-card-ux-issues-qgg2tn` |
| Last commit | the drawn card beside your hand |
| What works today | A complete 2-player game **on one shared phone or on two phones**, joined by a six-character code. End to end. |
| What is missing | More than two players, and a Git-connected deploy on a real domain. |
| Engine | `src/engine/`, pure, framework-free |
| Authority | `src/net/room-core.ts` (all decisions) + `worker/room.ts` (sockets, storage, alarm) |
| UI | `src/ui/`, no framework, retained DOM, renders from `PlayerView` only |
| Spec | `docs/`, 12 files, kept true |

```bash
npm install
npm run dev                       # dev server
npm test                          # 111 tests, ~5 s
npm run build                     # typecheck (app + worker) + vite build
npm run preview                   # needed by the two scripts below
npm run shots                     # Chromium at 390×844, fails on clipped cards — Chromium ONLY
npm run check:pwa                 # manifest, iOS metas, genuine offline reload
npm run verify                    # all of the above

npm run dev:worker                # wrangler dev on :8787, serves dist/ + /api
npm run check:room                # 24 protocol checks over raw sockets
npm run check:lobby               # 48 checks driving two browsers through the UI
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
`scripts/shots.mjs` reaches a specific situation. `?motion=off` turns off the
card flights, which is the other half of what makes the screenshots repeatable
(trap 19), and what you want on one of two phones while debugging one.

**Do not run `npx playwright install`.** The browsers are preinstalled and the
scripts point at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` explicitly.

---

## 2. Where things stand

### Done and verified

- **Engine**: full `standard` and `school` rulesets, all powers, snap, scoring.
  Touched twice since the refactor: host promotion, and one bound in
  `isLegalTarget` that closed the black King's free reveal (trap-worthy, but it is
  a rule, so it lives in docs/06 §2 rather than in §5 below).
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
- **The board reads like cards.** Red backs (a cream margin, a printed panel, a
  diamond lattice — all layered gradients, no assets), every private moment in a
  row at its owner's own edge rather than facing the opponent, the drawn card
  face up on arrival, and cards that fly between the places they moved between:
  `src/ui/game/flights.ts` says what moved, `src/ui/game/flight.ts` draws it in
  a layer of its own, and a fast discard follows the finger. See docs/10 §6.
- **The turn ends by itself, and "Cactus" outlives it.** `announce.timing` gains
  `AFTER_TURN` (now the default): you may announce once you have played and
  still while the next player takes their turn, until *they* end theirs. That is
  what a table actually does, and the lap arithmetic comes out identical either
  way — `tests/announce.test.ts` asserts the equivalence, which is what makes
  the wider window an affordance rather than a variant. Since `TURN_END` then
  has nothing left to decide, the board ends the turn itself; the `EndTurn`
  action is unchanged, so replays are too. `Réglages → Fin de tour automatique`
  turns it off, and the host's choice reaches a room. New state field:
  `previousPlayerId`.
- **And the powers can actually be aimed.** Reported from a real two-phone game as
  "with a Jack or a 7 it often does nothing", which turned out to be five bugs
  wearing one coat — traps 21-25, all client-side, the engine and the authority
  right throughout. A hold that latched without being able to decline; a hold that
  earned a grant a round trip too late; eight pixels of slide that lifted the card
  for a snap instead; a dead band between the tap slop and the snap threshold where
  nothing at all happened; and, worst, gestures wired to card elements that had
  already been thrown away, so **one penalty card left a player's own half
  accepting no touch for the rest of the match**. Holding the card a power is asking
  about now chooses it *and* reveals it under the finger, which is the gesture a
  player reaches for anyway.
  Three more found on the way: the black King could read the **whole opposing hand**
  one tap at a time (`POWER_AWAIT_SWAP_CONFIRM` leaves `pendingPower` in place and
  nothing bounded the target count — docs/06 §2); the opening peek pointed at the
  two cards it does *not* cover, so following the prompt showed nothing (the
  peekable pair is ringed now, through `targetableBy`); and a snapped card visibly
  fell back into its slot before flying, online only.
- **A swap is something you can follow.** The two legs bow to opposite sides and
  take longer over it, and both slots stay ringed for a couple of seconds — on both
  phones, which is the point: a swap is public in position, so the player it
  happened *to* is entitled to know which of their cards changed.
- **The drawn card sits beside your hand, and you drag it to throw it away.**
  Online only — the edge row exists so a hand can cover it, which is a shared-phone
  concern (docs/10 §6 rule 1). The row slides left, the card lands to its right, and
  the opponent's device shows the *back* of it in the same place, so their turn
  stops happening off screen. Dragging it onto the discard throws it away and onto
  one of your own cards places it; the "Défausser" button is gone and tapping the
  discard pile is the tap-only twin of the drag.
- **Powers that target an opponent work in a room.** They never did: the board
  gated every slot gesture on "is this seat mine", so with one seat per device
  the opponent's half accepted no input at all and `PEEK_OPPONENT` / the second
  half of a swap expired on the turn clock. `src/ui/game/targeting.ts` now
  answers "which seat may act" and "which slot may be aimed at" separately.
  docs/10 §3 records the rule; `tests/targeting.test.ts` and both online checks
  cover it.
- **Tests**: 111 in `npm test` — the 37-step worked trace, the invariant sweep
  (now including an assembled config: custom powers, no opening discard, stock
  only, and the late announcement interleaved with everything else, and a
  `PowerTarget` offered in `POWER_AWAIT_SWAP_CONFIRM` so the King's bound is
  walked), the projection/wire-format sweep, 21 room tests, 16 config tests
  covering what a client is allowed to ask for, 14 on the announcement window, 16
  on who may aim at what, 14 on events → card movements, and 7 on the powers
  themselves. Plus 24 protocol checks and 48 two-browser checks against a real
  Durable Object — `check:lobby` grew four scenarios: a power aimed at your own
  hand by *holding* it (with a 10 px slide, which used to snap instead), the drawn
  card dragged onto the discard, the column it sits in beside the hand, and a swap
  whose marker has to appear on the victim's phone as well as the swapper's.

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
  reached from the powers editor. The board now expresses both (a swipe on a
  card that is not yours, and an opponent target) rather than being unable to,
  but neither is reachable from any settings screen.
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

21-26 came out of the session that made the powers reachable again, and they are
worth reading as a group: **five separate bugs all presented as "the power
sometimes doesn't work"**, none of them in the engine, and not one of them visible
to a gate that only ever clicks buttons. If a gesture is not doing what it looks
like it should, the recogniser and the node it is attached to are the first two
places to look, in that order.

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
18. **A card must never be animated where it lives.** Three separate things
    forbid it, and each one bit before it was understood: `.layout` is a
    `container-type: size` container, so it is a containing block for
    `position: fixed` *and* a stacking context — a card moving inside it cannot
    leave it; the far half's `.rotor` is `rotate(180deg)`, which makes it a
    containing block too **and negates any `translate` on a descendant, on both
    axes**; and nothing in this app has a `z-index`, so with `.middle` sitting
    between the two halves in DOM order, a far-half card crossing the band
    passes underneath it. `src/ui/game/flight.ts` therefore flies a *clone* in a
    fixed, unrotated layer that is the last child of `#app`. Build the clone
    with `createCardElement`, never `cloneNode`: a copy carries `card--slot`
    (trap 16 measures those), `data-slot`, `data-target` and the pulsing
    `data-grant`.
19. **Motion is one switch, and the gate depends on it.** `tokens.css` zeroes
    `--flight` / `--flight-near` under `prefers-reduced-motion`, and
    `flight.ts` reads those tokens back rather than duplicating the media query
    — so Playwright's `reducedMotion: "reduce"` turns off the JS animations too.
    Both `shots.mjs` and `check-lobby.mjs` rely on that: their `waitForTimeout`s
    are 60–200 ms and a card caught mid-flight is a different screenshot every
    run. `?motion=off` says the same thing on the URL, which is what you want on
    one of two phones while debugging.
20. **A flying card looks like its destination, not like the event.** The event
    supplies only the card's *identity*; whether a face may be drawn is
    `el.dataset.face`, which the renderer has already decided with the reveal
    grants applied (trap 5). Take the face from the event and the flat table
    leaks: `mergeSeatEvents` deliberately picks the *most entitled* of the two
    seats' redacted streams, so it will hand you a real card id for a card the
    board is showing as a back.
21. **Never re-derive a node from `half.slots` inside the `map` that builds it.**
    The array is still the *previous* layout's nodes until the assignment
    completes, so `attachSlotGestures` used to wire every gesture to a card that
    had just been thrown away: four of them when a penalty card grew the layout to
    five, and *all* of them when the next deal shrank it back to four. That half
    then accepted no tap, no hold and no placement for the rest of the match — no
    power target, no `PlaceInSlot`, no initial peek. It was correct by accident on
    the first build only, because the array is empty then and the `?? children[i]`
    fallback happened to pick the right node. The element is passed in now and the
    lookup is gone. `shots.mjs` grows a layout deliberately and then taps a slot;
    before that it swiped once and only ever clicked buttons afterwards, which is
    how this survived so long.
22. **`attachGestures` returns a detacher, and it is the only thing that can end a
    gesture whose node is being destroyed.** A penalty card landing while a finger
    is down removes the element mid-hold: no `pointerup` reaches it, so
    `onLongPressEnd` never fires and the look stays open on a card that has moved.
    Store the detachers and call them before `innerHTML = ""`. But note the
    consequence — detaching fires `onDragEnd` — so the drag bookkeeping has to be
    **"cancel only what nothing claimed"**: `dragPending` marks a card whose action
    is already on its way, and the sweep after `takeOff` only cancels a drag the
    finger has already let go of. Otherwise the rebuild cancels the very drag
    `takeOff` was about to adopt.
23. **A gesture handler that cannot decline swallows the tap.** Tap, hold and
    inward drag overlap on the same pixels, so whichever fires first must be able
    to hand the input back — `onLongPressStart` and `onDragStart` both return
    `false` for that, and the recogniser must ask *before* it latches. A hold on a
    card with nothing to reveal latched anyway and refused the release's tap, which
    is why holding your own card during a Jack or a 7 did nothing at all. Related:
    the tap slop is the width of a **dead band** — above it the hold is cancelled
    and the tap refused, so between it and the 26 px snap threshold nothing
    happens. 12 px was under a sixth of a card; cards use 18.
24. **A grant can arrive after the finger is already down.** `RemoteClient.dispatch`
    is fire-and-forget, so the `CardRevealed` a gesture earns comes back a round
    trip later — `beginLook` in the same tick finds nothing. `HalfRefs.pressing`
    remembers the ref and the look starts when the grant lands. Without it the
    first press of every round revealed nothing and players learned to press twice.
    Clear it wherever grants are dropped, or a finger still down re-opens a look on
    the next update.
25. **Anything derived from events for *rendering* must read `update.events`, not
    `mergeSeatEvents`.** The merged stream is `[]` whenever motion is off — and both
    browser gates run reduced-motion, as does any player who asked their phone to.
    A marker built on it would be invisible to exactly the people and the tests
    most likely to need it. Corollary: reduced motion turns off *movement*, not
    *information*, which is why `--mark` is not zeroed with the other durations.
26. **A card sized in percent inside a `max-content` wrapper paints nowhere near
    the box it reports.** `.held` was `display: grid; place-items: center`, so the
    wrapper sized to its content and the content was a card whose width was 100% of
    the wrapper — trap 11 again, from the other direction. Chromium resolved it
    without complaint and `getBoundingClientRect` returned a plausible rect, but
    `elementFromPoint` at the centre of that rect hit the *wrapper*, so every
    pointer gesture missed the card. `align-items: stretch` gives the card a
    definite width to be a percentage of. If a gesture on a card mysteriously does
    nothing, check `elementFromPoint` before you check the recogniser.
27. **Whatever the page does not paint, iOS fills from the *root* element.**
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
