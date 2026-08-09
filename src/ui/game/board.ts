import { HIDDEN, type PlayerView, type VisibleCard } from "../../engine/project";
import { nearestSlots } from "../../engine/turn";
import type { Action, PlayerId, SlotRef } from "../../engine/types";
import type { GameClient } from "../client";
import { createCardElement, paintCard } from "./card";
import { attachGestures } from "./gestures";
import { RevealGrants } from "./privacy";

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

    root.innerHTML = `
      <div class="board">
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

    this.halves.push(this.buildHalf("bottom", bottomId));
    this.halves.push(this.buildHalf("top", topId));

    this.middle.querySelector(".pile--stock")!.addEventListener("click", () => {
      this.dispatch({ type: "DrawStock", playerId: this.currentId() });
    });
    this.middle.querySelector(".pile--discard")!.addEventListener("click", () => {
      this.dispatch({ type: "TakeDiscard", playerId: this.currentId() });
    });

    this.unsubscribe = client.subscribe((updates) => {
      for (const update of updates) {
        this.grants.get(update.seat)?.ingest(update.events);
        // The round can end on somebody else's action; anything still exposed
        // has to go the moment it does.
        if (update.events.some((e) => e.type === "RoundRevealed")) this.hideAllGrants();
      }
      this.patch();
    });
    this.patch();
  }

  destroy(): void {
    this.unsubscribe();
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
        <div class="layout"></div>
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
      layout: root.querySelector<HTMLElement>(".layout")!,
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
          if (this.viewFor(half).heldBy === half.playerId) {
            half.trayCard.dataset.revealed =
              half.trayCard.dataset.revealed === "1" ? "0" : "1";
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

  private currentId(): PlayerId {
    return this.primaryView().currentPlayer;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private patch(): void {
    for (const half of this.halves) this.patchHalf(half, this.viewFor(half));
    this.patchMiddle(this.primaryView());
  }

  private patchMiddle(view: PlayerView): void {
    const top = view.discard[0];
    if (top) paintCard(this.discardCard, "face", view.cards[top]);
    else paintCard(this.discardCard, "empty");

    paintCard(this.stockCard, view.stockCount > 0 ? "back" : "empty");

    const actionable = view.phase === "TURN_START";
    this.middle.querySelector(".pile--stock")!.toggleAttribute("data-live", actionable);
    this.middle
      .querySelector(".pile--discard")!
      .toggleAttribute("data-live", actionable && view.discard.length > 0);
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
      el.dataset.target = half.live && this.isTargetable(view, ref) ? "1" : "0";
      el.dataset.chosen = view.pendingPower?.targets.some(
        (t) => t.playerId === ref.playerId && t.slot === ref.slot,
      )
        ? "1"
        : "0";
    });
  }

  private isTargetable(view: PlayerView, ref: SlotRef): boolean {
    const owner = view.players.find((p) => p.id === ref.playerId);
    const slot = owner?.layout[ref.slot];
    if (slot === undefined || slot === null) return false;

    if (view.pendingPower) {
      const kind = view.pendingPower.kind;
      const isOwn = ref.playerId === view.pendingPower.ownerId;
      const first = view.pendingPower.targets[0];
      switch (kind) {
        case "PEEK_OWN":
          return isOwn;
        case "PEEK_OPPONENT":
        case "GIVE_CARD":
          return !isOwn;
        case "BLIND_SWAP":
        case "LOOK_AND_SWAP":
          return first === undefined ? isOwn : !isOwn;
        default:
          return false;
      }
    }

    if (view.phase === "AWAIT_HELD_DECISION" || view.phase === "AWAIT_SLOT_FOR_DISCARD") {
      return ref.playerId === view.currentPlayer;
    }
    return false;
  }

  private attachSlotGestures(half: HalfRefs, index: number): void {
    if (!half.live) return;
    const el = half.slots[index] ?? half.layout.children[index];
    if (!(el instanceof HTMLElement)) return;
    const ref: SlotRef = { playerId: half.playerId, slot: index };
    const inward = half.seat === "top" ? "down" : "up";

    attachGestures(
      el,
      {
        onTap: () => this.onSlotTap(half, ref),
        onLongPressStart: () => {
          if (this.viewFor(half).phase === "INITIAL_PEEK") this.ensurePeekDispatched(half);
          if (this.grantsFor(half)?.beginLook(ref)) this.patch();
        },
        onLongPressEnd: () => {
          this.grantsFor(half)?.endLook(ref);
          this.patch();
        },
        onSwipeInward: () => {
          const view = this.viewFor(half);
          if (!view.config.snap.enabled) return;
          this.dispatch({
            type: "Snap",
            playerId: half.playerId,
            target: ref,
            forVersion: view.discardVersion,
          });
        },
      },
      { inward },
    );
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

  private onSlotTap(half: HalfRefs, ref: SlotRef): void {
    const view = this.viewFor(half);
    const current = view.currentPlayer;

    if (view.pendingPower) {
      this.dispatch({ type: "PowerTarget", playerId: view.pendingPower.ownerId, target: ref });
      return;
    }
    if (
      (view.phase === "AWAIT_HELD_DECISION" || view.phase === "AWAIT_SLOT_FOR_DISCARD") &&
      ref.playerId === current
    ) {
      this.dispatch({ type: "PlaceInSlot", playerId: current, slot: ref.slot });
      return;
    }
    if (view.phase === "AWAIT_SNAP_GIVE" && view.pendingSnapGive?.snapperId === ref.playerId) {
      this.dispatch({ type: "SnapGive", playerId: ref.playerId, slot: ref.slot });
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
        buttons.push({
          label: "Manche suivante",
          run: () => this.dispatch({ type: "StartNextRound", playerId: view.hostId }),
        });
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
        return { prompt: "Pioche ou prends la défausse", buttons };

      case "AWAIT_HELD_DECISION": {
        const revealed = half.trayCard.dataset.revealed === "1";
        const held = view.heldCard;
        buttons.push({
          label: "Défausser",
          run: () => {
            half.trayCard.dataset.revealed = "0";
            this.dispatch({ type: "DiscardHeld", playerId: me });
          },
        });
        return {
          prompt: revealed ? "Pose-la sur une carte, ou défausse" : "Touche la carte pour la voir",
          buttons,
          trayFace: revealed && held && held !== HIDDEN ? "face" : "back",
          trayCardId: revealed && held && held !== HIDDEN ? held : null,
          trayLabel: revealed ? "" : "touche",
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
