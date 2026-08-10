import { HIDDEN, type PlayerView, type VisibleCard } from "../../engine/project";
import { nearestSlots } from "../../engine/turn";
import type { Action, CardId, Event, PlayerId, SlotRef } from "../../engine/types";
import type { GameClient } from "../client";
import { createCardElement, paintCard } from "./card";
import {
  FlightLayer,
  msToken,
  rectOf,
  type DragHandle,
  type Look,
  type Rect,
} from "./flight";
import {
  mergeSeatEvents,
  planFlights,
  sameAnchor,
  type Anchor,
  type Flight,
} from "./flights";
import { attachGestures } from "./gestures";
import { RevealGrants } from "./privacy";
import { actingSeat, targetableBy } from "./targeting";

type Seat = "top" | "bottom";

interface HalfRefs {
  readonly seat: Seat;
  /** Whose cards this half shows. */
  readonly playerId: PlayerId;
  /**
   * Whose projection this half is rendered from. Equal to `playerId` when this
   * device holds that player's seat; otherwise the local player, who sees the
   * opponent's half exactly as the network lets them — backs.
   */
  readonly viewer: PlayerId;
  /** Only a seat this device owns may dispatch from its half. */
  readonly live: boolean;
  readonly root: HTMLElement;
  readonly name: HTMLElement;
  readonly score: HTMLElement;
  readonly stock: HTMLElement;
  readonly prompt: HTMLElement;
  readonly trayCard: HTMLElement;
  /** The card and its label, moved between the tray and `held` as one. */
  readonly traySlot: HTMLElement;
  /** Where `traySlot` lives when it is not beside the hand. */
  readonly trayHome: HTMLElement;
  readonly trayLabel: HTMLElement;
  readonly actions: HTMLElement;
  readonly layout: HTMLElement;
  /**
   * The column beside the hand where the card being held sits, online.
   *
   * Empty on the flat table: there the drawn card belongs in the tray at its
   * owner's own edge, which is the row a cupped hand covers (docs/10 §6 rule 1).
   * In a room nobody is leaning over, so it sits next to the cards it can
   * replace — and the row slides left to make space for it.
   */
  readonly held: HTMLElement;
  slots: HTMLElement[];
  /**
   * One detacher per slot node, in slot order.
   *
   * Kept and called, not for memory — a discarded node and its listeners are
   * collected anyway — but because `attachGestures`' cleanup is the only thing
   * that can end a hold or a drag whose element is being destroyed under the
   * finger. A penalty card landing mid-look used to leave the look open on a
   * card that had moved.
   */
  detach: (() => void)[];
  /**
   * The slot this half's finger is currently holding down, if any.
   *
   * Online the event that entitles a player to look arrives a round trip after
   * the hold that earned it (`RemoteClient.dispatch` is fire-and-forget), so the
   * ref has to outlive the dispatch: when the grant lands, the look begins under
   * a finger that never moved.
   */
  pressing: SlotRef | null;
}

const REVEAL_PHASES = new Set(["REVEAL", "ROUND_END", "MATCH_END"]);

/**
 * How long `TURN_END` is left on screen before the turn ends by itself.
 *
 * Not a rule — the rule is `announce.timing`, and the announcement window
 * outlives this by a whole turn. It is only long enough for the card that just
 * moved to land, so the handover does not happen underneath it.
 */
const AUTO_END_MS = 260;

/**
 * How long a card whose action has been dispatched is left in the air waiting to
 * be adopted by the movement it caused.
 *
 * Longer than any round trip, and it exists only for the actions that answer
 * with nothing this device can see — a snap that lost its race with
 * `loserPenalty: NONE` emits a rejection for somebody else and silence for us.
 */
const DRAG_ADOPTION_MS = 1500;

/**
 * How far a finger may drift on a card and still be a tap, or still be a hold.
 *
 * The recogniser's 12 px default is under a sixth of a card here, and it was the
 * width of a dead band: past it the hold was cancelled and the tap refused, so
 * anything between it and the 26 px snap threshold produced nothing at all. It
 * also governs how much drift a hold survives, which is what "hold the card you
 * are aiming at" needs. Buttons and piles keep the default.
 */
const SLOT_TAP_SLOP = 18;

/**
 * How far outside the discard pile a release still counts as landing on it.
 *
 * The pile is the smallest target on the board and it sits at the end of the
 * gesture's natural direction of travel, so it is worth being generous about. The
 * slots get none of this: they are neighbours, and slop would make two of them
 * claim the same pixel.
 */
const DROP_SLOP = 28;

const slotKey = (ref: { playerId: PlayerId; slot: number }): string =>
  `${ref.playerId}|${ref.slot}`;

const within = (
  rect: Rect,
  at: { clientX: number; clientY: number },
  slop: number,
): boolean =>
  at.clientX >= rect.x - slop &&
  at.clientX <= rect.x + rect.w + slop &&
  at.clientY >= rect.y - slop &&
  at.clientY <= rect.y + rect.h + slop;

/** A planned movement, with the source measured before the board was repainted. */
interface Departure {
  readonly flight: Flight;
  readonly from: Rect;
  readonly fromLook: Look;
}

/**
 * The flat-table board: two players facing each other across one phone.
 *
 * It reads nothing but `PlayerView`s obtained from the client, so the same
 * renderer works whether the authority is this process or a socket away.
 */
export class Board {
  private readonly halves: HalfRefs[] = [];
  /** One grant ledger per seat this device owns — never one per player. */
  private readonly grants = new Map<PlayerId, RevealGrants>();
  private readonly discardCard: HTMLElement;
  private readonly stockCard: HTMLElement;
  private readonly middle: HTMLElement;
  private readonly flights: FlightLayer;
  /** Whether the far half is drawn upside down — see `spin`. */
  private readonly rotated: boolean;
  /**
   * Whether the card being held sits beside its owner's hand rather than in the
   * private row at their own edge.
   *
   * True online and false on the shared phone, and the two are not a style
   * choice: the edge row exists so a hand can cover it (docs/10 §6 rule 1), and
   * that only matters when somebody is sitting opposite you.
   */
  private readonly heldBeside: boolean;
  /** The pile or slot a released drag would land on, while one is live. */
  private dropEl: HTMLElement | null = null;
  /** The card the finger is holding, if any, and where it came from. */
  private drag: DragHandle | null = null;
  private dragFrom: Anchor | null = null;
  /**
   * An action has been dispatched for the card in the air, and the movement it
   * causes is expected to adopt it (`takeOff`).
   *
   * Without this the finger lifting first would cancel a drag that was about to
   * be adopted, which is what a snap looks like online: `onSwipeInward`
   * dispatches at the threshold, the authority answers a round trip later, and
   * the card fell back into its slot in between before a fresh clone flew to the
   * discard. The flat table never showed it — `LocalClient.dispatch` is
   * synchronous.
   */
  private dragPending = false;
  /** Whether the finger is still on the card in the air. */
  private dragHeld = false;
  private dragTimer: number | null = null;
  private autoEndTimer: number | null = null;
  /**
   * The slots a swap has just moved, held long enough to be noticed.
   *
   * In board state rather than left on the elements, because `patchSlots` rewrites
   * every `data-*` on every patch. Keyed `playerId|slot`, which also dedupes the
   * flat table's two views of the same event.
   */
  private swapped = new Set<string>();
  private swapTimer: number | null = null;
  private menuOpenFor: PlayerId | null = null;
  private unsubscribe: () => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly client: GameClient,
    private readonly onQuit: () => void,
  ) {
    for (const seat of client.seats) this.grants.set(seat, new RevealGrants(seat));

    // Flat table is a two-sided layout by construction. Three-to-eight players
    // is a different board, not a wider one — see HANDOVER phase 5.
    //
    // With one seat, that seat takes the bottom: your own cards belong at your
    // edge. With two, the dealing order decides, which is what the screenshots
    // were taken against.
    const view = this.primaryView();
    const bottomId = client.seats.length === 1 ? client.seats[0]! : view.turnOrder[0]!;
    const topId = view.turnOrder.find((id) => id !== bottomId)!;

    // Flat table sits between two people, so one half is upside down. Online
    // nobody is opposite anybody, and the same rotation would just be wrong.
    const mode = client.seats.length === 1 ? "remote" : "table";
    this.rotated = mode === "table";
    this.heldBeside = mode === "remote";

    root.innerHTML = `
      <div class="board" data-mode="${mode}">
        <section class="half" data-seat="top"></section>
        <div class="middle">
          <button class="pile pile--stock" type="button" aria-label="pioche"></button>
          <button class="pile pile--discard" type="button" aria-label="défausse"></button>
        </div>
        <section class="half" data-seat="bottom"></section>
      </div>
    `;

    this.middle = root.querySelector<HTMLElement>(".middle")!;
    this.stockCard = createCardElement("card card--pile");
    this.discardCard = createCardElement("card card--pile");
    root.querySelector<HTMLElement>(".pile--stock")!.append(this.stockCard);
    root.querySelector<HTMLElement>(".pile--discard")!.append(this.discardCard);

    // Last child of the root, so it paints over both halves and the band between
    // them without anything in this app needing a z-index.
    this.flights = new FlightLayer(root);

    this.halves.push(this.buildHalf("bottom", bottomId));
    this.halves.push(this.buildHalf("top", topId));

    // Both piles dispatch as *a seat this device owns*, never as whoever's turn
    // it happens to be. Online the authority substitutes the sender's id
    // anyway (docs/10 §3), so asserting the opponent's would only earn a
    // confusing rejection — and it would have lit the piles on their turn.
    this.middle.querySelector(".pile--stock")!.addEventListener("click", () => {
      const actor = this.actor();
      if (actor !== null) this.dispatch({ type: "DrawStock", playerId: actor });
    });
    this.middle.querySelector(".pile--discard")!.addEventListener("click", () => {
      const actor = this.actor();
      if (actor === null) return;
      const view = this.primaryView();
      // Holding a card, the pile is where you throw it away: the tap that says
      // what dragging the card onto it says, for a thumb that would rather not
      // slide. It is also the only focusable way to do it — the card is a div,
      // the pile is a button.
      if (view.phase === "AWAIT_HELD_DECISION" && view.heldBy === actor) {
        this.dispatch({ type: "DiscardHeld", playerId: actor });
        return;
      }
      // Otherwise it is only ever a draw source; when the rule is off it is
      // scenery, and dispatching would just earn an ActionRejected.
      if (!view.config.turn.takeFromDiscard) return;
      this.dispatch({ type: "TakeDiscard", playerId: actor });
    });

    this.unsubscribe = client.subscribe((updates) => {
      // Order is the whole trick. The DOM still shows the board as it was, so
      // this is the only moment at which a card's *old* position can be read;
      // destinations can only be read after the patch, because a slot grown by a
      // penalty card does not exist until then.
      const events = this.flights.enabled ? mergeSeatEvents(updates) : [];
      if (events.some((e) => e.type === "RoundStarted")) this.flights.clear();
      // `RevealGrants.ingest` drops the grants a new deal invalidates; what it
      // cannot know about is a finger still resting on a card from the last one.
      // Read from `update.events`, not `events`, which is empty whenever motion is
      // off (HANDOVER trap 26).
      if (updates.some((u) => u.events.some((e) => e.type === "RoundStarted"))) {
        for (const half of this.halves) half.pressing = null;
      }
      const departures = this.measureDepartures(
        planFlights(events, this.primaryView().phase),
      );

      for (const update of updates) {
        this.grants.get(update.seat)?.ingest(update.events);
        // The round can end on somebody else's action; anything still exposed
        // has to go the moment it does.
        if (update.events.some((e) => e.type === "RoundRevealed")) this.hideAllGrants();
        this.markSwaps(update.events);
      }
      this.resumePendingLooks();

      this.patch();
      this.takeOff(departures);
      // The finger has gone and nothing adopted the card it left in the air:
      // this is the answer it was waiting for, and it was not a movement. While
      // the finger is still down the card stays with it — only the timer in
      // `dispatchForDrag` can end that.
      if (this.drag !== null && this.dragPending && !this.dragHeld) this.releaseDrag();
    });
    this.patch();
  }

  destroy(): void {
    this.unsubscribe();
    if (this.autoEndTimer !== null) clearTimeout(this.autoEndTimer);
    if (this.dragTimer !== null) clearTimeout(this.dragTimer);
    if (this.swapTimer !== null) clearTimeout(this.swapTimer);
    for (const half of this.halves) for (const detach of half.detach) detach();
    this.flights.destroy();
    this.root.innerHTML = "";
  }

  private dispatch(action: Action): void {
    this.client.dispatch(action);
  }

  /** Public state — piles, phase, turn — is identical in every view. */
  private primaryView(): PlayerView {
    return this.client.view(this.client.seats[0]!);
  }

  private viewFor(half: HalfRefs): PlayerView {
    return this.client.view(half.viewer);
  }

  private grantsFor(half: HalfRefs): RevealGrants | undefined {
    return this.grants.get(half.viewer);
  }

  private hideAllGrants(): void {
    for (const grants of this.grants.values()) grants.hideAll();
    // A finger still down must not re-open a look on the next update.
    for (const half of this.halves) half.pressing = null;
  }

  private buildHalf(seat: Seat, playerId: PlayerId): HalfRefs {
    const root = this.root.querySelector<HTMLElement>(`.half[data-seat="${seat}"]`)!;
    root.dataset.player = playerId;
    root.innerHTML = `
      <div class="rotor">
        <div class="plate">
          <span class="plate__name"></span>
          <span class="plate__stock"></span>
          <span class="plate__score"></span>
          <button class="plate__menu" type="button" aria-label="menu">•••</button>
        </div>
        <div class="tray">
          <p class="tray__prompt"></p>
          <div class="tray__slot"><span class="tray__label"></span></div>
          <div class="tray__actions"></div>
        </div>
        <div class="layout"><div class="layout__grid"></div></div>
        <div class="held"></div>
      </div>
    `;

    const trayCard = createCardElement("card card--tray");
    root.querySelector<HTMLElement>(".tray__slot")!.prepend(trayCard);

    const live = this.client.seats.includes(playerId);
    const half: HalfRefs = {
      seat,
      playerId,
      viewer: live ? playerId : this.client.seats[0]!,
      live,
      root,
      name: root.querySelector<HTMLElement>(".plate__name")!,
      score: root.querySelector<HTMLElement>(".plate__score")!,
      stock: root.querySelector<HTMLElement>(".plate__stock")!,
      prompt: root.querySelector<HTMLElement>(".tray__prompt")!,
      trayCard,
      traySlot: root.querySelector<HTMLElement>(".tray__slot")!,
      trayHome: root.querySelector<HTMLElement>(".tray")!,
      trayLabel: root.querySelector<HTMLElement>(".tray__label")!,
      actions: root.querySelector<HTMLElement>(".tray__actions")!,
      // The grid, not its container: .layout is the size container the track
      // widths are measured against, so it must stay free of the cards.
      layout: root.querySelector<HTMLElement>(".layout__grid")!,
      held: root.querySelector<HTMLElement>(".held")!,
      slots: [],
      detach: [],
      pressing: null,
    };

    root.querySelector(".plate__menu")!.addEventListener("click", () => {
      this.menuOpenFor = this.menuOpenFor === playerId ? null : playerId;
      this.patch();
    });

    // A card the actor is entitled to see but that lives in the OTHER player's
    // half is shown here instead, at the actor's own edge, where they can
    // shield it (docs/10 §6).
    this.attachTrayGestures(half);

    return half;
  }

  private attachTrayGestures(half: HalfRefs): void {
    if (!half.live) return;
    const inward = half.seat === "top" ? "down" : "up";
    attachGestures(
      half.trayCard,
      {
        onTap: () => {
          // The drawn card is face up from the moment it lands (see patchTray),
          // so a tap *hides* it — the escape hatch for when the other player
          // leans over the table.
          if (this.viewFor(half).heldBy === half.playerId) {
            half.trayCard.dataset.hidden = half.trayCard.dataset.hidden === "1" ? "0" : "1";
            this.patch();
          }
        },
        // Declined when there is nothing here to look at, so a slow tap on the
        // drawn card still hides it instead of dwelling into nothing.
        onLongPressStart: () => {
          const ref = this.foreignGrant(half);
          if (ref === null) return false;
          if (this.grantsFor(half)?.beginLook(ref)) this.patch();
          return true;
        },
        onLongPressEnd: () => {
          const ref = this.foreignGrant(half);
          if (ref) {
            this.grantsFor(half)?.endLook(ref, this.keepsGrant(half));
            this.patch();
          }
        },
        // No `onSwipeInward`: a snap fires at a fixed threshold because the race
        // is timestamped and the finger must not be allowed to decide it
        // (docs/07 §8). Throwing your own card away races nobody, so this can
        // afford a real drop target — which is far harder to fire by accident.
        onDragStart: () => this.onHeldDragStart(half),
        onDragMove: (at) => {
          // Measured before the clone is moved, not after: the other order writes
          // a transform and then reads a rect, which forces a layout every frame
          // of the drag.
          this.markDrop(half, at);
          this.drag?.moveTo(at.clientX, at.clientY);
        },
        onDragEnd: (release) => this.onHeldDragEnd(half, release),
      },
      { inward, tapSlopPx: SLOT_TAP_SLOP },
    );
  }

  /**
   * Lift the card this player is holding.
   *
   * Declined unless there is really a card here and it is still theirs to place,
   * so a small slide on anything else still ends as the tap that hides it.
   */
  private onHeldDragStart(half: HalfRefs): boolean {
    // Not gated on `flights.enabled`, unlike the snap lift below it. There the
    // drag is decoration on a gesture that fires by itself at a threshold; here it
    // *is* the gesture, and reduced motion must not take the only way to throw a
    // card away. `FlightLayer.lift` follows the finger by writing a transform, not
    // by animating, so it works with every duration zeroed — the card simply
    // arrives instead of travelling.
    const view = this.viewFor(half);
    if (view.heldBy !== half.playerId) return false;
    if (view.phase !== "AWAIT_HELD_DECISION" && view.phase !== "AWAIT_SLOT_FOR_DISCARD") {
      return false;
    }

    const anchor: Anchor = { kind: "tray", playerId: half.playerId };
    this.dragFrom = anchor;
    this.dragHeld = true;
    this.drag = this.flights.lift(
      rectOf(half.trayCard),
      this.lookOf(half.trayCard, HIDDEN),
      this.spin(anchor),
      half.trayCard,
    );
    return true;
  }

  /**
   * Dropped. On the discard it is thrown away, on one of your own cards it takes
   * that card's place, and anywhere else it goes back where it came from.
   *
   * Both landings already have a flight — `HeldDiscarded` flies tray → discard and
   * `CardPlaced` flies tray → slot — so `takeOff` adopts the clone under the
   * finger rather than making a second one.
   */
  private onHeldDragEnd(
    half: HalfRefs,
    release: { clientX: number; clientY: number } | null,
  ): void {
    this.clearDrop();
    const target = release === null ? null : this.dropTargetAt(half, release);
    if (target === "discard") {
      this.dispatchForDrag({ type: "DiscardHeld", playerId: half.playerId });
    } else if (target !== null) {
      this.dispatchForDrag({ type: "PlaceInSlot", playerId: half.playerId, slot: target });
    }
    this.onDragRelease();
  }

  /** What a release at this point would mean, if anything. */
  private dropTargetAt(
    half: HalfRefs,
    at: { clientX: number; clientY: number },
  ): "discard" | number | null {
    const view = this.viewFor(half);
    // Generous, because the pile is small and it is the whole middle of the
    // gesture's direction of travel. A card taken from the discard has to be
    // placed, never thrown back (docs/05), hence the phase check.
    if (
      view.phase === "AWAIT_HELD_DECISION" &&
      within(rectOf(this.discardCard), at, DROP_SLOP)
    ) {
      return "discard";
    }
    // Exact, because the slots are neighbours: any slop here would make two of
    // them claim the same pixel.
    for (let slot = 0; slot < half.slots.length; slot++) {
      const el = half.slots[slot]!;
      if (targetableBy(view, this.client.seats, { playerId: half.playerId, slot }) === null) {
        continue;
      }
      if (within(rectOf(el), at, 0)) return slot;
    }
    return null;
  }

  /** Show where the card would land, so a drag is never a guess. */
  private markDrop(half: HalfRefs, at: { clientX: number; clientY: number }): void {
    const target = this.dropTargetAt(half, at);
    const el =
      target === "discard"
        ? this.middle.querySelector<HTMLElement>(".pile--discard")
        : target === null
          ? null
          : (half.slots[target] ?? null);
    if (el === this.dropEl) return;
    this.clearDrop();
    if (el) el.dataset.drop = "1";
    this.dropEl = el;
  }

  private clearDrop(): void {
    if (this.dropEl) delete this.dropEl.dataset.drop;
    this.dropEl = null;
  }

  /**
   * Ring the two slots a swap has just exchanged, on both halves.
   *
   * A blind swap is public in *position* and private in *content* (docs/06 §5), so
   * this is exactly what everyone at the table is entitled to know — and it is the
   * half the victim was missing: two backs crossing in a quarter of a second told
   * them nothing about which of their cards had changed.
   *
   * Read from a seat's own `update.events` rather than from the merged stream,
   * which is empty whenever motion is off — the marker is information, not
   * animation, and it has to survive `prefers-reduced-motion` and `?motion=off`.
   */
  private markSwaps(events: readonly Event[]): void {
    let marked = false;
    for (const e of events) {
      if (e.type === "RoundStarted") {
        this.swapped.clear();
        continue;
      }
      if (e.type !== "CardsSwapped") continue;
      for (const ref of [e.a, e.b]) this.swapped.add(slotKey(ref));
      marked = true;
    }
    if (!marked) return;

    if (this.swapTimer !== null) clearTimeout(this.swapTimer);
    // The duration lives in tokens.css, so the ring and the timer that ends it
    // cannot drift apart. Long enough to look up and find the two cards, and much
    // longer than the flight: the flight is what happened, the ring is what
    // happened *to you*.
    this.swapTimer = window.setTimeout(() => {
      this.swapTimer = null;
      this.swapped.clear();
      this.patch();
    }, msToken("--mark", 2600));
  }

  /** A pending grant on a slot that is not this half's own. */
  private foreignGrant(half: HalfRefs): SlotRef | null {
    const grants = this.grantsFor(half);
    if (!grants) return null;
    for (const p of this.viewFor(half).players) {
      if (p.id === half.playerId) continue;
      for (let i = 0; i < p.layout.length; i++) {
        const ref = { playerId: p.id, slot: i };
        if (grants.has(ref)) return ref;
      }
    }
    return null;
  }

  /** The seat this device owns that may act right now, if any. */
  private actor(): PlayerId | null {
    return actingSeat(this.primaryView(), this.client.seats);
  }

  /**
   * Whose hand is over this half: its owner at a shared table, where a gesture in
   * this half means "the player at this end", and otherwise the one seat this
   * device holds — which is how a gesture on an opponent's card is expressed.
   */
  private fingerOn(half: HalfRefs): PlayerId | null {
    return half.live ? half.playerId : this.actor();
  }

  /**
   * Non-null when this half's own hand is being asked to aim a pending power at
   * `ref` — then it is not a card to snap and not a card to slide, it is the card
   * the board is waiting to be told about.
   *
   * Not `targetableBy(...) !== null`: at a shared table that also matches the
   * *victim's* own card during somebody else's swap, and the hand physically over
   * that half is theirs. Taking their snap away to protect the other player's
   * power would be the wrong trade.
   */
  private aimingAt(half: HalfRefs, ref: SlotRef): PlayerId | null {
    const view = this.viewFor(half);
    if (!view.pendingPower) return null;
    const finger = this.fingerOn(half);
    return finger !== null && targetableBy(view, this.client.seats, ref) === finger
      ? finger
      : null;
  }

  /**
   * Whether this player has played and may still say "Cactus" — the affordance
   * for `inAnnounceWindow` in the engine, which has the last word. Kept here
   * rather than imported so the board never reaches past a `PlayerView`.
   */
  private canAnnounceLate(view: PlayerView, playerId: PlayerId): boolean {
    return (
      view.config.announce.timing === "AFTER_TURN" &&
      view.announcerId === null &&
      view.previousPlayerId === playerId &&
      view.players.find((p) => p.id === playerId)?.eliminated === false
    );
  }

  // -------------------------------------------------------------------------
  // Animation
  //
  // Driven by events and never by a diff of two views: a reconnecting client is
  // sent a fresh view and no events at all (see RemoteClient), and the board it
  // missed must appear rather than fly in from wherever it used to be.
  // -------------------------------------------------------------------------

  /** Where each moving card is *now*, read before the patch repaints the board. */
  private measureDepartures(plan: readonly Flight[]): Departure[] {
    const out: Departure[] = [];
    for (const flight of plan) {
      const el = this.anchorEl(flight.from);
      if (!el) continue;
      const from = rectOf(el);
      // Nothing to fly from: an empty pile, or the tray card while hidden.
      if (from.w === 0) continue;
      out.push({ flight, from, fromLook: this.lookOf(el, flight.cardId) });
    }
    return out;
  }

  private takeOff(departures: readonly Departure[]): void {
    if (departures.length === 0) return;

    // Every destination is measured first, then the cards are hidden and the
    // clones made: one layout flush per update rather than one per flight.
    const arrivals = departures.map((departure) => {
      const at = departure.flight.kind === "return" ? departure.flight.from : departure.flight.to;
      const el = this.anchorEl(at);
      return { departure, at, el, to: el ? rectOf(el) : null };
    });

    for (const { departure, at, el, to } of arrivals) {
      const { flight } = departure;
      if (!el || !to || to.w === 0) continue;
      const toLook = this.lookOf(el, flight.cardId);
      const spin = this.spin(at);

      // The card under the finger is the one that lands: adopted, never cloned a
      // second time.
      if (this.drag && this.dragFrom && sameAnchor(this.dragFrom, flight.from)) {
        this.drag.release(to, toLook, spin, el);
        this.forgetDrag();
        continue;
      }

      // A card that was shown and put back never moved, so there is nothing to
      // fly — only something to admit to.
      if (flight.kind === "return") {
        this.shake(el);
        continue;
      }

      this.flights.fly({
        from: departure.from,
        to,
        fromLook: departure.fromLook,
        toLook,
        spin,
        hide: el,
        bow: flight.bow,
      });
    }
  }

  private anchorEl(anchor: Anchor): HTMLElement | null {
    switch (anchor.kind) {
      case "stock":
        return this.stockCard;
      case "discard":
        return this.discardCard;
      case "tray": {
        const half = this.halfOf(anchor.playerId);
        return half && !half.trayCard.hidden ? half.trayCard : null;
      }
      case "slot":
        return this.halfOf(anchor.playerId)?.slots[anchor.slot] ?? null;
      case "hand":
        return this.halfOf(anchor.playerId)?.layout ?? null;
    }
  }

  private halfOf(playerId: PlayerId): HalfRefs | undefined {
    return this.halves.find((h) => h.playerId === playerId);
  }

  /**
   * How a flying card must look at one end of its journey.
   *
   * The *face* is whatever the renderer decided that element shows — grants and
   * all (docs/09 §5) — so a card that is a back on the board is a back in the
   * air. The event only ever supplies the identity, for the case where the
   * destination is already face up.
   */
  private lookOf(el: HTMLElement, cardId: CardId | typeof HIDDEN): Look {
    const face = (el.dataset.face ?? "back") as "back" | "face" | "empty";
    if (face !== "face" || cardId === HIDDEN) return { face: face === "empty" ? "back" : face };
    for (const seat of this.client.seats) {
      const card = this.client.view(seat).cards[cardId];
      if (card) return { face: "face", card };
    }
    return { face: "back" };
  }

  /** The far half is drawn upside down; the flight layer is not rotated. */
  private spin(anchor: Anchor): number {
    if (!this.rotated || anchor.kind === "stock" || anchor.kind === "discard") return 0;
    return this.halfOf(anchor.playerId)?.seat === "top" ? 180 : 0;
  }

  private shake(el: HTMLElement): void {
    el.dataset.shake = "1";
    el.addEventListener("animationend", () => delete el.dataset.shake, { once: true });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private patch(): void {
    for (const half of this.halves) this.patchHalf(half, this.viewFor(half));
    this.patchMiddle(this.primaryView());
    // A layout that grew was rebuilt from scratch, so a flight may be on its way
    // to a node that no longer exists.
    this.flights.prune();
    this.endTurnIfNothingLeftToDecide();
  }

  /**
   * `TURN_END` exists so a player can say "Cactus" before handing over. Once the
   * announcement outlives the turn (`AFTER_TURN`, docs/01 §7) there is nothing
   * left to decide there, so the phase is passed through rather than parked in,
   * and the game moves on by itself.
   *
   * Deferred by a timer for two reasons: dispatching inside a subscribe callback
   * would re-enter the client's own listener loop, and the card that just landed
   * deserves to be seen arriving before the board says it is somebody else's
   * turn.
   */
  private endTurnIfNothingLeftToDecide(): void {
    const view = this.primaryView();
    if (view.config.announce.timing === "END_OF_TURN") return;
    if (view.phase !== "TURN_END") return;
    // Only the phone whose turn it is; on a shared table that is still exactly
    // one of the two halves.
    const actor = this.actor();
    if (actor === null || this.autoEndTimer !== null) return;

    this.autoEndTimer = window.setTimeout(() => {
      this.autoEndTimer = null;
      const now = this.primaryView();
      if (now.phase !== "TURN_END") return; // a snap, or somebody beat us to it
      const current = actingSeat(now, this.client.seats);
      if (current !== null) this.dispatch({ type: "EndTurn", playerId: current });
    }, AUTO_END_MS);
  }

  private patchMiddle(view: PlayerView): void {
    const top = view.discard[0];
    if (top) paintCard(this.discardCard, "face", view.cards[top]);
    else paintCard(this.discardCard, "empty");

    paintCard(this.stockCard, view.stockCount > 0 ? "back" : "empty");

    // Only ever lit for a seat this device owns: online, the opponent's turn is
    // not an invitation to draw.
    const actor = this.actor();
    const actionable = view.phase === "TURN_START" && actor !== null;
    // Lit while this device is holding a card too, because that is when the pile
    // is a *destination*: the place to drag it, and the place to tap instead.
    const throwable = view.phase === "AWAIT_HELD_DECISION" && view.heldBy === actor;
    this.middle.querySelector(".pile--stock")!.toggleAttribute("data-live", actionable);
    this.middle
      .querySelector(".pile--discard")!
      .toggleAttribute(
        "data-live",
        throwable ||
          (actionable && view.discard.length > 0 && view.config.turn.takeFromDiscard),
      );
  }

  private patchHalf(half: HalfRefs, view: PlayerView): void {
    const me = view.players.find((p) => p.id === half.playerId)!;
    const isCurrent = view.currentPlayer === half.playerId;
    const revealAll = REVEAL_PHASES.has(view.phase);

    half.root.dataset.active = String(isCurrent && !revealAll);
    half.name.textContent = me.name + (view.announcerId === me.id ? " · cactus" : "");
    half.score.textContent = revealAll && me.roundScore !== null
      ? `${me.roundScore} · total ${me.cumulativeScore}`
      : `${me.cumulativeScore}`;
    half.stock.textContent = `pioche ${view.stockCount}`;

    this.patchSlots(half, view, revealAll);
    this.patchTray(half, view, revealAll, isCurrent);
  }

  private patchSlots(half: HalfRefs, view: PlayerView, revealAll: boolean): void {
    const me = view.players.find((p) => p.id === half.playerId)!;
    const grants = this.grantsFor(half);

    // Layouts grow (penalty cards) and gain holes (snaps); rebuild only when the
    // count actually changes so cards keep their nodes and their transitions.
    if (half.slots.length !== me.layout.length) {
      // Before the nodes go: the only moment a gesture still running on one of
      // them can be ended.
      for (const detach of half.detach) detach();
      half.detach = [];
      // The finger's card is about to stop existing, so nothing may still be
      // waiting for a grant to land on it.
      half.pressing = null;
      half.layout.innerHTML = "";

      // Built first, wired after. Wiring inside the `map` reached for
      // `half.slots`, which is still the *previous* layout's nodes until this
      // assignment completes — so a grown layout wired four gestures to four
      // detached cards and a shrunk one wired all of them (HANDOVER trap 22).
      const slots = me.layout.map((_, index) => {
        const el = createCardElement("card card--slot");
        el.dataset.slot = String(index);
        half.layout.append(el);
        return el;
      });
      half.slots = slots;
      half.detach = slots.map((el, index) => this.attachSlotGestures(half, index, el));
      half.layout.dataset.count = String(me.layout.length);
    }

    me.layout.forEach((visible: VisibleCard, index) => {
      const el = half.slots[index]!;
      const ref = { playerId: half.playerId, slot: index };

      if (visible === null) {
        paintCard(el, "empty");
      } else if (visible === HIDDEN) {
        paintCard(el, "back");
      } else if (revealAll || grants?.isLooking(ref)) {
        // The projection permits it AND the player is actively looking.
        paintCard(el, "face", view.cards[visible]);
      } else {
        paintCard(el, "back");
      }

      el.dataset.grant = grants?.has(ref) ? "1" : "0";
      // Not `half.live`: a power that targets an opponent lights up their half,
      // which is the whole point of it, and online that half is not ours.
      el.dataset.target = targetableBy(view, this.client.seats, ref) !== null ? "1" : "0";
      el.dataset.chosen = view.pendingPower?.targets.some(
        (t) => t.playerId === ref.playerId && t.slot === ref.slot,
      )
        ? "1"
        : "0";
      // Rewriting the same value does not restart the animation, so patching
      // through a swap does not make the ring stutter.
      el.dataset.swapped = this.swapped.has(slotKey(ref)) ? "1" : "0";
    });
  }

  /**
   * Every slot on the board is wired, including the opponent's.
   *
   * That is what makes PEEK_OPPONENT and the second half of a swap playable when
   * this device holds one seat: `targetableBy` decides who may tap, so a half
   * this device does not own is still a legal *target* even though it is not a
   * seat we can act as. Only the two gestures that expose a card stay behind
   * `half.live` — a grant on a foreign slot is shown in the actor's own tray,
   * never lit up in the opponent's half, where they could not shield it
   * (docs/10 §6 rule 1).
   *
   * So the asymmetry is deliberate: you may **hold** a card that is in front of
   * you, and only **tap** one that is not.
   */
  private attachSlotGestures(
    half: HalfRefs,
    index: number,
    el: HTMLElement,
  ): () => void {
    const ref: SlotRef = { playerId: half.playerId, slot: index };
    const inward = half.seat === "top" ? "down" : "up";

    // The element is passed in, never looked up: re-deriving it from
    // `half.slots` is what bound every gesture to a card that had already been
    // thrown away (HANDOVER trap 22).
    return attachGestures(
      el,
      {
        onTap: () => this.onSlotTap(half, ref),
        onLongPressStart: half.live ? () => this.onSlotHoldStart(half, ref) : undefined,
        onLongPressEnd: half.live ? () => this.onSlotHoldEnd(half, ref) : undefined,
        onSwipeInward: () => this.onSlotSwipe(half, ref),
        onDragStart: () => this.onSlotDragStart(half, ref, el),
        onDragMove: ({ clientX, clientY }) => this.drag?.moveTo(clientX, clientY),
        onDragEnd: () => this.onDragRelease(),
      },
      { inward, tapSlopPx: SLOT_TAP_SLOP },
    );
  }

  /**
   * A finger has settled on one of this half's own cards.
   *
   * Returns false to decline the hold, which hands the gesture back to the tap —
   * the difference between a card that does nothing and a card that does the wrong
   * nothing. Three things are worth holding, and nothing else is:
   *
   *   - a grant already earned: the look it entitles you to;
   *   - `INITIAL_PEEK`: the two cards you may see before the game starts;
   *   - a card this power is asking you to aim at. Holding the card you want to
   *     look at *is* how you choose it — the prompt says "Regarde une de tes
   *     cartes", and answering it with a dwell used to select nothing at all.
   */
  private onSlotHoldStart(half: HalfRefs, ref: SlotRef): boolean {
    const view = this.viewFor(half);
    const grants = this.grantsFor(half);
    const earned = grants?.has(ref) ?? false;
    const peeking = view.phase === "INITIAL_PEEK";
    const aiming = this.aimingAt(half, ref);
    if (!earned && !peeking && aiming === null) return false;

    // Remembered before the dispatch, not after: online the grant this hold earns
    // arrives in a later update, and by then the only question is whether the
    // finger is still here.
    half.pressing = ref;
    if (peeking) this.ensurePeekDispatched(half);
    else if (aiming !== null) {
      // Even when a grant is already sitting on this card. The power is the live
      // question, and an unused peek grant on the very card the board is asking
      // about used to answer it with a look instead of a choice — which is the
      // report ("sometimes the Jack just does nothing") in miniature. Holding it
      // now does both: it is chosen, and its face comes up under the finger.
      this.dispatch({ type: "PowerTarget", playerId: aiming, target: ref });
    }
    if (grants?.beginLook(ref)) this.patch();
    return true;
  }

  private onSlotHoldEnd(half: HalfRefs, ref: SlotRef): void {
    half.pressing = null;
    this.grantsFor(half)?.endLook(ref, this.keepsGrant(half));
    this.patch();
  }

  /**
   * Whether letting go should leave the grant unspent — see `RevealGrants.endLook`.
   * True only while a decision is pending on what was revealed, which today means
   * the black King's question.
   */
  private keepsGrant(half: HalfRefs): boolean {
    return this.viewFor(half).phase === "POWER_AWAIT_SWAP_CONFIRM";
  }

  /**
   * A grant that landed while the finger was already down starts its look now.
   *
   * Online the entitling event is a round trip behind the hold that earned it, so
   * without this the first hold of a round revealed nothing and the player had to
   * press a second time — which is what "the powers don't always work" felt like
   * from the outside.
   */
  private resumePendingLooks(): void {
    for (const half of this.halves) {
      const ref = half.pressing;
      // `beginLook` is a no-op without a grant and idempotent with one, so this
      // needs no memory of what it has already resumed.
      if (ref !== null) this.grantsFor(half)?.beginLook(ref);
    }
  }

  /**
   * Lift a card off the table and give it to the finger.
   *
   * It is handed to the flight layer rather than transformed in place, which is
   * what lets it cross the middle band — and spares every delta the sign flip the
   * far half's 180° rotation would otherwise impose (see flight.ts).
   */
  private onSlotDragStart(half: HalfRefs, ref: SlotRef, el: HTMLElement): boolean {
    // Declined rather than ignored: a card that cannot be snapped must still
    // accept a tap after a few pixels of slide, as it did before drags existed.
    if (!this.flights.enabled) return false;
    const view = this.viewFor(half);
    // The board is asking for this card. A slide of eight pixels used to lift it
    // for a snap instead, and the tap that was aiming the power went with it.
    if (this.aimingAt(half, ref) !== null) return false;
    if (!view.config.snap.enabled) return false;
    const snapper = this.fingerOn(half);
    if (snapper === null) return false;
    if (snapper !== ref.playerId && !view.config.snap.allowOnOpponent) return false;
    if (el.dataset.face === "empty") return false;

    const anchor: Anchor = { kind: "slot", playerId: ref.playerId, slot: ref.slot };
    this.dragFrom = anchor;
    this.dragHeld = true;
    this.drag = this.flights.lift(
      rectOf(el),
      this.lookOf(el, HIDDEN),
      this.spin(anchor),
      el,
    );
    return true;
  }

  /**
   * The finger has let go — or the card it was holding is being destroyed.
   *
   * A card whose action is already on its way stays in the air: the movement it
   * causes will adopt it in `takeOff`. Anything else falls back where it came
   * from.
   */
  private onDragRelease(): void {
    this.dragHeld = false;
    if (this.dragPending) return;
    this.releaseDrag();
  }

  /** Dispatch an action for the card in the air, and expect it to be adopted. */
  private dispatchForDrag(action: Action): void {
    if (this.drag !== null) {
      this.dragPending = true;
      // Belt and braces: an action the authority never answers — a lost snap
      // race with no penalty emits nothing this device can see — must not leave
      // a card stranded over the felt.
      if (this.dragTimer !== null) clearTimeout(this.dragTimer);
      this.dragTimer = window.setTimeout(() => this.releaseDrag(), DRAG_ADOPTION_MS);
    }
    this.dispatch(action);
  }

  /** Nothing claimed it: the card falls back into the place it was lifted from. */
  private releaseDrag(): void {
    this.drag?.cancel();
    this.forgetDrag();
  }

  private forgetDrag(): void {
    this.clearDrop();
    if (this.dragTimer !== null) clearTimeout(this.dragTimer);
    this.dragTimer = null;
    this.dragPending = false;
    this.dragHeld = false;
    this.drag = null;
    this.dragFrom = null;
  }

  /**
   * Snapping. The snapper is the owner of the half when this device holds it —
   * at a shared table a swipe means "the player at this end" — and otherwise the
   * one seat we do own, which is how a snap on an opponent's card is expressed.
   */
  private onSlotSwipe(half: HalfRefs, ref: SlotRef): void {
    const view = this.viewFor(half);
    // Same reason as the drag: while this hand is being asked to aim a power at
    // this card, a swipe over it is a mis-recognised tap, and snapping it would
    // burn both the card and the power.
    if (this.aimingAt(half, ref) !== null) return;
    if (!view.config.snap.enabled) return;

    const snapper = this.fingerOn(half);
    if (snapper === null) return;
    // Off in every shipped preset; validateSnap would reject it as NOT_YOUR_CARD
    // anyway, and a rejection here would be a free board oracle (docs/07 §3).
    if (snapper !== ref.playerId && !view.config.snap.allowOnOpponent) return;

    // Through `dispatchForDrag`: the swipe fires at the threshold, so the finger
    // is usually still down and the card in the air is the one that will land.
    this.dispatchForDrag({
      type: "Snap",
      playerId: snapper,
      target: ref,
      forVersion: view.discardVersion,
    });
  }

  private ensurePeekDispatched(half: HalfRefs): void {
    const view = this.viewFor(half);
    const me = view.players.find((p) => p.id === half.playerId);
    if (!me || me.hasPeeked) return;
    this.dispatch({
      type: "PeekInitial",
      playerId: half.playerId,
      slots: nearestSlots(view.config),
    });
  }

  /**
   * One question — "may this be tapped, and by whom" — asked by the highlight and
   * by the handler, so the two can no longer disagree.
   */
  private onSlotTap(half: HalfRefs, ref: SlotRef): void {
    const view = this.viewFor(half);
    const actor = targetableBy(view, this.client.seats, ref);
    if (actor === null) return;

    if (view.pendingPower) {
      this.dispatch({ type: "PowerTarget", playerId: actor, target: ref });
      return;
    }
    if (view.phase === "AWAIT_HELD_DECISION" || view.phase === "AWAIT_SLOT_FOR_DISCARD") {
      this.dispatch({ type: "PlaceInSlot", playerId: actor, slot: ref.slot });
      return;
    }
    if (view.phase === "AWAIT_SNAP_GIVE") {
      this.dispatch({ type: "SnapGive", playerId: actor, slot: ref.slot });
    }
  }

  // -------------------------------------------------------------------------
  // Tray: prompt, private card, contextual buttons
  // -------------------------------------------------------------------------

  private patchTray(
    half: HalfRefs,
    view: PlayerView,
    revealAll: boolean,
    isCurrent: boolean,
  ): void {
    // A half this device does not own has no tray: no prompt addressed to
    // someone else, and above all no private card. The grant lookup below is
    // written from the *viewer's* side, so on a foreign half it would surface
    // the viewer's own granted card at the opponent's edge.
    if (!half.live) {
      half.prompt.textContent = "";
      half.trayLabel.textContent = "";
      half.actions.innerHTML = "";
      // One exception, and it is not a private card: `heldBy` is public and
      // `heldCard` is HIDDEN to everyone else, so the *back* of the card in the
      // opponent's hand is exactly what the projection permits. Without it a whole
      // turn happened off screen online — the tray anchor resolved to a
      // `display: none` node, so even the flight out of the stock was skipped, and
      // all you saw was the stock count tick down.
      const showsBack = this.heldBeside && view.heldBy === half.playerId;
      half.trayCard.hidden = !showsBack;
      if (showsBack) paintCard(half.trayCard, "back");
      this.placeHeldCard(half, showsBack);
      return;
    }

    // The hide toggle belongs to one held card, so it cannot outlive it —
    // otherwise a card hidden on one turn is still hidden when the next is
    // drawn. Reset here rather than in each action that lets go of the card.
    if (view.heldBy !== half.playerId) half.trayCard.dataset.hidden = "0";

    const me = view.players.find((p) => p.id === half.playerId)!;
    const buttons: { label: string; kind?: string; run: () => void }[] = [];
    let prompt = "";
    let trayFace: "back" | "face" | "empty" = "empty";
    let trayCardId: string | null = null;
    let trayLabel = "";

    if (this.menuOpenFor === half.playerId) {
      prompt = "Menu";
      buttons.push({ label: "Recommencer", run: () => { this.menuOpenFor = null; this.onQuit(); } });
      buttons.push({ label: "Fermer", kind: "ghost", run: () => { this.menuOpenFor = null; this.patch(); } });
    } else if (revealAll) {
      prompt = this.endOfRoundPrompt(view, half.playerId);
      if (view.phase === "ROUND_END") {
        // Only the host may deal (docs/05), and only a seat this device owns may
        // be dispatched for. Offering the button to a guest online promised
        // something it could not do.
        if (this.client.seats.includes(view.hostId)) {
          buttons.push({
            label: "Manche suivante",
            run: () => this.dispatch({ type: "StartNextRound", playerId: view.hostId }),
          });
        } else {
          prompt = `${prompt} · en attente de l'hôte`;
        }
      } else if (view.phase === "MATCH_END") {
        buttons.push({ label: "Nouvelle partie", run: () => this.onQuit() });
      }
    } else if (view.phase === "INITIAL_PEEK") {
      prompt = me.hasPeeked
        ? "En attente de l'autre joueur"
        : "Maintiens tes deux cartes entourées pour les regarder";
      if (!me.hasPeeked) {
        buttons.push({
          label: "Prêt sans regarder",
          kind: "ghost",
          run: () =>
            this.dispatch({
              type: "PeekInitial",
              playerId: half.playerId,
              slots: nearestSlots(view.config),
            }),
        });
      }
    } else {
      // A card this player may look at, sitting in the other half.
      const foreign = this.foreignGrant(half);
      if (foreign) {
        const looking = this.grantsFor(half)?.isLooking(foreign) ?? false;
        const cardId = view.players
          .find((p) => p.id === foreign.playerId)
          ?.layout[foreign.slot];
        trayFace = looking && cardId && cardId !== HIDDEN ? "face" : "back";
        trayCardId = looking && cardId && cardId !== HIDDEN ? cardId : null;
        trayLabel = looking ? "" : "maintiens";
        prompt = looking ? "" : "Tu peux regarder cette carte";
      }

      if (isCurrent) {
        const result = this.currentPlayerTray(view, half);
        prompt = result.prompt || prompt;
        for (const b of result.buttons) buttons.push(b);
        if (result.trayFace) {
          trayFace = result.trayFace;
          trayCardId = result.trayCardId ?? null;
          trayLabel = result.trayLabel ?? "";
        }
      } else if (!prompt) {
        prompt = `Au tour de ${view.players.find((p) => p.id === view.currentPlayer)?.name ?? ""}`;
      }

      // You have played, the next player is playing, and it is not too late:
      // the offer stands until they finish (docs/01 §7).
      if (!isCurrent && this.canAnnounceLate(view, half.playerId)) {
        prompt = prompt ? `${prompt} · encore temps de dire cactus` : prompt;
        buttons.push({
          label: "Cactus !",
          kind: "accent",
          run: () => this.dispatch({ type: "AnnounceCactus", playerId: half.playerId }),
        });
      }
    }

    half.prompt.textContent = prompt;
    half.trayLabel.textContent = trayLabel;
    half.trayCard.hidden = trayFace === "empty";
    if (trayFace !== "empty") {
      paintCard(half.trayCard, trayFace, trayCardId ? view.cards[trayCardId] : undefined);
    }
    // The card you just drew goes beside your hand online, where the cards it can
    // replace are and where the drag that discards it starts. A card revealed
    // *elsewhere* never moves out of the edge row, in either mode: that one the
    // owner may have to shield (docs/10 §6 rule 1).
    this.placeHeldCard(half, this.heldBeside && view.heldBy === half.playerId);

    this.renderButtons(half.actions, half.live ? buttons : []);
  }

  /**
   * Put the private card in the column beside the hand, or back at the owner's
   * edge.
   *
   * One node moves rather than two existing, so `anchorEl` stays a single lookup,
   * the `"tray"` anchor keeps meaning "wherever this half shows its held card",
   * and `planFlights` never has to know which mode it is in. Moving a node
   * mid-flight is safe: the flight layer keys on the element, so it un-hides
   * whatever the card's new home is.
   */
  private placeHeldCard(half: HalfRefs, beside: boolean): void {
    // Read by board.css to open the column, which is what slides the hand left.
    half.root.dataset.holding = beside ? "1" : "0";
    const target = beside ? half.held : half.trayHome;
    if (half.traySlot.parentElement === target) return;
    if (beside) target.append(half.traySlot);
    // Between the prompt and the buttons, where the markup put it.
    else target.insertBefore(half.traySlot, half.actions);
  }

  private currentPlayerTray(
    view: PlayerView,
    half: HalfRefs,
  ): {
    prompt: string;
    buttons: { label: string; kind?: string; run: () => void }[];
    trayFace?: "back" | "face";
    trayCardId?: string | null;
    trayLabel?: string;
  } {
    const me = half.playerId;
    const buttons: { label: string; kind?: string; run: () => void }[] = [];

    switch (view.phase) {
      case "TURN_START":
        return {
          prompt: view.config.turn.takeFromDiscard
            ? "Pioche ou prends la défausse"
            : "Pioche une carte",
          buttons,
        };

      case "AWAIT_HELD_DECISION": {
        // Face up by default: the card sits either at this player's own edge or
        // beside their own hand, so what they just drew is theirs to read without
        // a gesture. A tap hides it again.
        //
        // No "Défausser" button any more. Throwing the card away is dragging it
        // onto the discard — or tapping the pile, which `patchMiddle` lights while
        // the card is held, and which is the same instruction said twice rather
        // than a third control competing for the row.
        const hidden = half.trayCard.dataset.hidden === "1";
        const held = view.heldCard;
        const shown = !hidden && held !== null && held !== HIDDEN;
        return {
          prompt: hidden
            ? "Touche la carte pour la revoir"
            : "Pose-la sur une carte, ou glisse-la sur la défausse",
          buttons,
          trayFace: shown ? "face" : "back",
          trayCardId: shown ? held : null,
          trayLabel: hidden ? "voir" : "",
        };
      }

      case "AWAIT_SLOT_FOR_DISCARD": {
        const held = view.heldCard;
        return {
          prompt: "Choisis la carte à remplacer",
          buttons,
          trayFace: held && held !== HIDDEN ? "face" : "back",
          trayCardId: held && held !== HIDDEN ? held : null,
        };
      }

      case "POWER_AWAIT_OWN_SLOT":
        buttons.push({ label: "Passer", kind: "ghost", run: () => this.dispatch({ type: "PowerSkip", playerId: me }) });
        return { prompt: "Regarde une de tes cartes", buttons };

      case "POWER_AWAIT_OPPONENT_SLOT":
        buttons.push({ label: "Passer", kind: "ghost", run: () => this.dispatch({ type: "PowerSkip", playerId: me }) });
        return { prompt: "Regarde une carte adverse", buttons };

      case "POWER_AWAIT_TWO_SLOTS": {
        const first = view.pendingPower?.targets.length ?? 0;
        buttons.push({ label: "Passer", kind: "ghost", run: () => this.dispatch({ type: "PowerSkip", playerId: me }) });
        return {
          prompt:
            first === 0
              ? "Choisis une de tes cartes"
              : "Choisis une carte adverse",
          buttons,
        };
      }

      case "POWER_AWAIT_SWAP_CONFIRM":
        buttons.push({ label: "Échanger", run: () => this.dispatch({ type: "PowerConfirmSwap", playerId: me, swap: true }) });
        buttons.push({ label: "Laisser", kind: "ghost", run: () => this.dispatch({ type: "PowerConfirmSwap", playerId: me, swap: false }) });
        return { prompt: "Échanger ces deux cartes ?", buttons };

      case "POWER_AWAIT_GIVE_TARGET":
        buttons.push({ label: "Passer", kind: "ghost", run: () => this.dispatch({ type: "PowerSkip", playerId: me }) });
        return { prompt: "Donne cette carte à un joueur", buttons };

      case "AWAIT_SNAP_GIVE":
        return { prompt: "Donne une de tes cartes", buttons };

      case "TURN_END":
        // With the announcement window open past the handover there is nothing
        // left to confirm here: the board ends the turn itself, and the "Cactus"
        // offer reappears on this half a moment later, for as long as the next
        // player takes. Putting a button here too would flash it for 260 ms.
        if (view.config.announce.timing !== "END_OF_TURN") {
          return { prompt: "Fin de ton tour", buttons };
        }
        if (view.announcerId === null) {
          buttons.push({ label: "Cactus !", kind: "accent", run: () => this.dispatch({ type: "AnnounceCactus", playerId: me }) });
        }
        buttons.push({ label: "Terminer", run: () => this.dispatch({ type: "EndTurn", playerId: me }) });
        return { prompt: "Fin de ton tour", buttons };

      default:
        return { prompt: "", buttons };
    }
  }

  /** Written against "the best of the others" so it survives more than two seats. */
  private endOfRoundPrompt(view: PlayerView, viewer: PlayerId): string {
    const me = view.players.find((p) => p.id === viewer);
    const others = view.players.filter((p) => p.id !== viewer);
    if (!me || others.length === 0) return "";

    if (view.phase === "MATCH_END") {
      const best = Math.min(...others.map((p) => p.cumulativeScore));
      if (me.cumulativeScore === best) return "Égalité !";
      return me.cumulativeScore < best ? "Tu gagnes la partie !" : "Tu perds la partie";
    }

    const mine = me.roundScore ?? 0;
    const theirs = Math.min(...others.map((p) => p.roundScore ?? 0));
    const announced = view.announcerId === viewer;
    if (mine === theirs) return `Manche nulle · ${mine}`;
    if (mine < theirs) return `Manche gagnée · ${mine}`;
    return announced ? `Cactus raté · ${mine}` : `Manche perdue · ${mine}`;
  }

  private renderButtons(
    container: HTMLElement,
    buttons: { label: string; kind?: string; run: () => void }[],
  ): void {
    container.innerHTML = "";
    for (const b of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "btn";
      if (b.kind) el.dataset.kind = b.kind;
      el.textContent = b.label;
      el.addEventListener("click", b.run);
      container.append(el);
    }
  }
}
