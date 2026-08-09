import { HIDDEN, type PlayerView, type VisibleCard } from "../../engine/project";
import { nearestSlots } from "../../engine/turn";
import type { Action, CardId, PlayerId, SlotRef } from "../../engine/types";
import type { GameClient } from "../client";
import { createCardElement, paintCard } from "./card";
import {
  FlightLayer,
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
  readonly trayLabel: HTMLElement;
  readonly actions: HTMLElement;
  readonly layout: HTMLElement;
  slots: HTMLElement[];
}

const REVEAL_PHASES = new Set(["REVEAL", "ROUND_END", "MATCH_END"]);

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
  /** The card the finger is holding, if any, and where it came from. */
  private drag: DragHandle | null = null;
  private dragFrom: Anchor | null = null;
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
      // The pile is only ever a draw source; when the rule is off it is scenery,
      // and dispatching would just earn an ActionRejected.
      if (!this.primaryView().config.turn.takeFromDiscard) return;
      const actor = this.actor();
      if (actor !== null) this.dispatch({ type: "TakeDiscard", playerId: actor });
    });

    this.unsubscribe = client.subscribe((updates) => {
      // Order is the whole trick. The DOM still shows the board as it was, so
      // this is the only moment at which a card's *old* position can be read;
      // destinations can only be read after the patch, because a slot grown by a
      // penalty card does not exist until then.
      const events = this.flights.enabled ? mergeSeatEvents(updates) : [];
      if (events.some((e) => e.type === "RoundStarted")) this.flights.clear();
      const departures = this.measureDepartures(
        planFlights(events, this.primaryView().phase),
      );

      for (const update of updates) {
        this.grants.get(update.seat)?.ingest(update.events);
        // The round can end on somebody else's action; anything still exposed
        // has to go the moment it does.
        if (update.events.some((e) => e.type === "RoundRevealed")) this.hideAllGrants();
      }

      this.patch();
      this.takeOff(departures);
    });
    this.patch();
  }

  destroy(): void {
    this.unsubscribe();
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
      trayLabel: root.querySelector<HTMLElement>(".tray__label")!,
      actions: root.querySelector<HTMLElement>(".tray__actions")!,
      // The grid, not its container: .layout is the size container the track
      // widths are measured against, so it must stay free of the cards.
      layout: root.querySelector<HTMLElement>(".layout__grid")!,
      slots: [],
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
        onLongPressStart: () => {
          const ref = this.foreignGrant(half);
          if (ref && this.grantsFor(half)?.beginLook(ref)) this.patch();
        },
        onLongPressEnd: () => {
          const ref = this.foreignGrant(half);
          if (ref) {
            this.grantsFor(half)?.endLook(ref);
            this.patch();
          }
        },
      },
      { inward },
    );
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
        this.drag = null;
        this.dragFrom = null;
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
  }

  private patchMiddle(view: PlayerView): void {
    const top = view.discard[0];
    if (top) paintCard(this.discardCard, "face", view.cards[top]);
    else paintCard(this.discardCard, "empty");

    paintCard(this.stockCard, view.stockCount > 0 ? "back" : "empty");

    // Only ever lit for a seat this device owns: online, the opponent's turn is
    // not an invitation to draw.
    const actionable = view.phase === "TURN_START" && this.actor() !== null;
    this.middle.querySelector(".pile--stock")!.toggleAttribute("data-live", actionable);
    this.middle
      .querySelector(".pile--discard")!
      .toggleAttribute(
        "data-live",
        actionable && view.discard.length > 0 && view.config.turn.takeFromDiscard,
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
      half.layout.innerHTML = "";
      half.slots = me.layout.map((_, index) => {
        const el = createCardElement("card card--slot");
        el.dataset.slot = String(index);
        half.layout.append(el);
        this.attachSlotGestures(half, index);
        return el;
      });
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
   */
  private attachSlotGestures(half: HalfRefs, index: number): void {
    const el = half.slots[index] ?? half.layout.children[index];
    if (!(el instanceof HTMLElement)) return;
    const ref: SlotRef = { playerId: half.playerId, slot: index };
    const inward = half.seat === "top" ? "down" : "up";

    attachGestures(
      el,
      {
        onTap: () => this.onSlotTap(half, ref),
        onLongPressStart: half.live
          ? () => {
              if (this.viewFor(half).phase === "INITIAL_PEEK") this.ensurePeekDispatched(half);
              if (this.grantsFor(half)?.beginLook(ref)) this.patch();
            }
          : undefined,
        onLongPressEnd: half.live
          ? () => {
              this.grantsFor(half)?.endLook(ref);
              this.patch();
            }
          : undefined,
        onSwipeInward: () => this.onSlotSwipe(half, ref),
        onDragStart: () => this.onSlotDragStart(half, ref, el),
        onDragMove: ({ clientX, clientY }) => this.drag?.moveTo(clientX, clientY),
        onDragEnd: () => {
          // Not adopted by a movement, so the card falls back into its slot.
          this.drag?.cancel();
          this.drag = null;
          this.dragFrom = null;
        },
      },
      { inward },
    );
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
    if (!view.config.snap.enabled) return false;
    const snapper = half.live ? half.playerId : this.actor();
    if (snapper === null) return false;
    if (snapper !== ref.playerId && !view.config.snap.allowOnOpponent) return false;
    if (el.dataset.face === "empty") return false;

    const anchor: Anchor = { kind: "slot", playerId: ref.playerId, slot: ref.slot };
    this.dragFrom = anchor;
    this.drag = this.flights.lift(
      rectOf(el),
      this.lookOf(el, HIDDEN),
      this.spin(anchor),
      el,
    );
    return true;
  }

  /**
   * Snapping. The snapper is the owner of the half when this device holds it —
   * at a shared table a swipe means "the player at this end" — and otherwise the
   * one seat we do own, which is how a snap on an opponent's card is expressed.
   */
  private onSlotSwipe(half: HalfRefs, ref: SlotRef): void {
    const view = this.viewFor(half);
    if (!view.config.snap.enabled) return;

    const snapper = half.live ? half.playerId : this.actor();
    if (snapper === null) return;
    // Off in every shipped preset; validateSnap would reject it as NOT_YOUR_CARD
    // anyway, and a rejection here would be a free board oracle (docs/07 §3).
    if (snapper !== ref.playerId && !view.config.snap.allowOnOpponent) return;

    this.dispatch({
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
      half.trayCard.hidden = true;
      half.actions.innerHTML = "";
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
        : "Maintiens tes deux cartes du bas pour les regarder";
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
    }

    half.prompt.textContent = prompt;
    half.trayLabel.textContent = trayLabel;
    half.trayCard.hidden = trayFace === "empty";
    if (trayFace !== "empty") {
      paintCard(half.trayCard, trayFace, trayCardId ? view.cards[trayCardId] : undefined);
    }

    this.renderButtons(half.actions, half.live ? buttons : []);
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
        // Face up by default. The tray sits at this player's own edge (board.css
        // pins it to the outermost row), so the card they just drew is theirs to
        // read without a gesture; a tap hides it again.
        const hidden = half.trayCard.dataset.hidden === "1";
        const held = view.heldCard;
        const shown = !hidden && held !== null && held !== HIDDEN;
        buttons.push({
          label: "Défausser",
          run: () => this.dispatch({ type: "DiscardHeld", playerId: me }),
        });
        return {
          prompt: hidden
            ? "Touche la carte pour la revoir"
            : "Pose-la sur une carte, ou défausse",
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
