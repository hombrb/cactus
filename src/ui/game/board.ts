import { nearestSlots } from "../../engine/turn";
import { projectFor, HIDDEN, type PlayerView, type VisibleCard } from "../../engine/project";
import type { Action, Event, GameState, PlayerId, SlotRef } from "../../engine/types";
import type { Store } from "../store";
import { createCardElement, paintCard } from "./card";
import { attachGestures } from "./gestures";
import { RevealGrants } from "./privacy";

type Seat = "top" | "bottom";

interface HalfRefs {
  readonly seat: Seat;
  readonly playerId: PlayerId;
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

export class Board {
  private readonly halves: HalfRefs[] = [];
  private readonly grants = new RevealGrants();
  private readonly discardCard: HTMLElement;
  private readonly stockCard: HTMLElement;
  private readonly middle: HTMLElement;
  private menuOpenFor: PlayerId | null = null;
  private unsubscribe: () => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
    private readonly onQuit: () => void,
  ) {
    const [bottomId, topId] = [store.state.turnOrder[0]!, store.state.turnOrder[1]!];

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
      this.dispatch({ type: "DrawStock", playerId: this.store.state.turnOrder[this.store.state.currentPlayerIndex]! });
    });
    this.middle.querySelector(".pile--discard")!.addEventListener("click", () => {
      this.dispatch({ type: "TakeDiscard", playerId: this.store.state.turnOrder[this.store.state.currentPlayerIndex]! });
    });

    this.unsubscribe = store.subscribe((_state, events) => {
      this.grants.ingest(events);
      this.patch();
    });
    this.patch();
  }

  destroy(): void {
    this.unsubscribe();
    this.root.innerHTML = "";
  }

  private dispatch(action: Action): void {
    const events = this.store.dispatch(action);
    this.reactTo(events);
  }

  /** Anything private still on screen is hidden the instant the round ends. */
  private reactTo(events: readonly Event[]): void {
    if (events.some((e) => e.type === "RoundRevealed")) this.grants.hideAll();
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

    const half: HalfRefs = {
      seat,
      playerId,
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
    const inward = half.seat === "top" ? "down" : "up";
    attachGestures(
      half.trayCard,
      {
        onTap: () => {
          const state = this.store.state;
          if (state.heldCard !== null && this.currentId() === half.playerId) {
            half.trayCard.dataset.revealed =
              half.trayCard.dataset.revealed === "1" ? "0" : "1";
            this.patch();
          }
        },
        onLongPressStart: () => {
          const ref = this.foreignGrant(half.playerId);
          if (ref && this.grants.beginLook(half.playerId, ref)) this.patch();
        },
        onLongPressEnd: () => {
          const ref = this.foreignGrant(half.playerId);
          if (ref) {
            this.grants.endLook(half.playerId, ref);
            this.patch();
          }
        },
      },
      { inward },
    );
  }

  /** A pending grant on a slot that is not the viewer's own. */
  private foreignGrant(viewer: PlayerId): SlotRef | null {
    for (const p of this.store.state.players) {
      if (p.id === viewer) continue;
      for (let i = 0; i < p.layout.length; i++) {
        const ref = { playerId: p.id, slot: i };
        if (this.grants.has(viewer, ref)) return ref;
      }
    }
    return null;
  }

  private currentId(): PlayerId {
    const s = this.store.state;
    return s.turnOrder[s.currentPlayerIndex]!;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private patch(): void {
    const state = this.store.state;
    for (const half of this.halves) {
      const view = projectFor(state, half.playerId);
      this.patchHalf(half, view, state);
    }
    this.patchMiddle(state);
  }

  private patchMiddle(state: GameState): void {
    const top = state.discard[0];
    if (top) paintCard(this.discardCard, "face", state.cards[top]);
    else paintCard(this.discardCard, "empty");

    paintCard(this.stockCard, state.stock.length > 0 ? "back" : "empty");

    const actionable = state.phase === "TURN_START";
    this.middle.querySelector(".pile--stock")!.toggleAttribute("data-live", actionable);
    this.middle
      .querySelector(".pile--discard")!
      .toggleAttribute("data-live", actionable && state.discard.length > 0);
  }

  private patchHalf(half: HalfRefs, view: PlayerView, state: GameState): void {
    const me = view.players.find((p) => p.id === half.playerId)!;
    const isCurrent = view.currentPlayer === half.playerId;
    const revealAll = REVEAL_PHASES.has(state.phase);

    half.root.dataset.active = String(isCurrent && !revealAll);
    half.name.textContent = me.name + (state.announcerId === me.id ? " · cactus" : "");
    half.score.textContent = revealAll && me.roundScore !== null
      ? `${me.roundScore} · total ${me.cumulativeScore}`
      : `${me.cumulativeScore}`;
    half.stock.textContent = `pioche ${view.stockCount}`;

    this.patchSlots(half, view, state, revealAll);
    this.patchTray(half, view, state, revealAll, isCurrent);
  }

  private patchSlots(
    half: HalfRefs,
    view: PlayerView,
    state: GameState,
    revealAll: boolean,
  ): void {
    const me = view.players.find((p) => p.id === half.playerId)!;

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
      } else if (revealAll || this.grants.isLooking(half.playerId, ref)) {
        // The projection permits it AND the player is actively looking.
        paintCard(el, "face", view.cards[visible]);
      } else {
        paintCard(el, "back");
      }

      el.dataset.grant = this.grants.has(half.playerId, ref) ? "1" : "0";
      el.dataset.target = this.isTargetable(state, ref) ? "1" : "0";
      el.dataset.chosen = state.pendingPower?.targets.some(
        (t) => t.playerId === ref.playerId && t.slot === ref.slot,
      )
        ? "1"
        : "0";
    });
  }

  private isTargetable(state: GameState, ref: SlotRef): boolean {
    const owner = state.players.find((p) => p.id === ref.playerId);
    const slot = owner?.layout[ref.slot];
    if (!slot || slot.cardId === null) return false;

    if (state.pendingPower) {
      const kind = state.pendingPower.kind;
      const isOwn = ref.playerId === state.pendingPower.ownerId;
      const first = state.pendingPower.targets[0];
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

    if (state.phase === "AWAIT_HELD_DECISION" || state.phase === "AWAIT_SLOT_FOR_DISCARD") {
      return ref.playerId === this.currentId();
    }
    return false;
  }

  private attachSlotGestures(half: HalfRefs, index: number): void {
    const el = half.slots[index] ?? half.layout.children[index];
    if (!(el instanceof HTMLElement)) return;
    const ref: SlotRef = { playerId: half.playerId, slot: index };
    const inward = half.seat === "top" ? "down" : "up";

    attachGestures(
      el,
      {
        onTap: () => this.onSlotTap(ref),
        onLongPressStart: () => {
          if (this.store.state.phase === "INITIAL_PEEK") this.ensurePeekDispatched(half.playerId);
          if (this.grants.beginLook(half.playerId, ref)) this.patch();
        },
        onLongPressEnd: () => {
          this.grants.endLook(half.playerId, ref);
          this.patch();
        },
        onSwipeInward: () => {
          if (!this.store.state.config.snap.enabled) return;
          this.dispatch({
            type: "Snap",
            playerId: half.playerId,
            target: ref,
            forVersion: this.store.state.discardVersion,
          });
        },
      },
      { inward },
    );
  }

  private ensurePeekDispatched(playerId: PlayerId): void {
    const state = this.store.state;
    const me = state.players.find((p) => p.id === playerId);
    if (!me || me.hasPeeked) return;
    this.dispatch({ type: "PeekInitial", playerId, slots: nearestSlots(state.config) });
  }

  private onSlotTap(ref: SlotRef): void {
    const state = this.store.state;
    const current = this.currentId();

    if (state.pendingPower) {
      this.dispatch({ type: "PowerTarget", playerId: state.pendingPower.ownerId, target: ref });
      return;
    }
    if (
      (state.phase === "AWAIT_HELD_DECISION" || state.phase === "AWAIT_SLOT_FOR_DISCARD") &&
      ref.playerId === current
    ) {
      this.dispatch({ type: "PlaceInSlot", playerId: current, slot: ref.slot });
      return;
    }
    if (state.phase === "AWAIT_SNAP_GIVE" && state.pendingSnapGive?.snapperId === ref.playerId) {
      this.dispatch({ type: "SnapGive", playerId: ref.playerId, slot: ref.slot });
    }
  }

  // -------------------------------------------------------------------------
  // Tray: prompt, private card, contextual buttons
  // -------------------------------------------------------------------------

  private patchTray(
    half: HalfRefs,
    view: PlayerView,
    state: GameState,
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
      prompt = this.endOfRoundPrompt(state, half.playerId);
      if (state.phase === "ROUND_END") {
        buttons.push({
          label: "Manche suivante",
          run: () => this.dispatch({ type: "StartNextRound", playerId: state.hostId }),
        });
      } else if (state.phase === "MATCH_END") {
        buttons.push({ label: "Nouvelle partie", run: () => this.onQuit() });
      }
    } else if (state.phase === "INITIAL_PEEK") {
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
              slots: nearestSlots(state.config),
            }),
        });
      }
    } else {
      // A card this player may look at, sitting in the other half.
      const foreign = this.foreignGrant(half.playerId);
      if (foreign) {
        const looking = this.grants.isLooking(half.playerId, foreign);
        const cardId = view.players
          .find((p) => p.id === foreign.playerId)
          ?.layout[foreign.slot];
        trayFace = looking && cardId && cardId !== HIDDEN ? "face" : "back";
        trayCardId = looking && cardId && cardId !== HIDDEN ? cardId : null;
        trayLabel = looking ? "" : "maintiens";
        prompt = looking ? "" : "Tu peux regarder cette carte";
      }

      if (isCurrent) {
        const result = this.currentPlayerTray(state, view, half);
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

    this.renderButtons(half.actions, buttons);
  }

  private currentPlayerTray(
    state: GameState,
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

    switch (state.phase) {
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
        const first = state.pendingPower?.targets.length ?? 0;
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
        if (state.announcerId === null) {
          buttons.push({ label: "Cactus !", kind: "accent", run: () => this.dispatch({ type: "AnnounceCactus", playerId: me }) });
        }
        buttons.push({ label: "Terminer", run: () => this.dispatch({ type: "EndTurn", playerId: me }) });
        return { prompt: "Fin de ton tour", buttons };

      default:
        return { prompt: "", buttons };
    }
  }

  private endOfRoundPrompt(state: GameState, viewer: PlayerId): string {
    const me = state.players.find((p) => p.id === viewer);
    const other = state.players.find((p) => p.id !== viewer);
    if (!me || !other) return "";

    if (state.phase === "MATCH_END") {
      if (me.cumulativeScore === other.cumulativeScore) return "Égalité !";
      return me.cumulativeScore < other.cumulativeScore ? "Tu gagnes la partie !" : "Tu perds la partie";
    }

    const mine = me.roundScore ?? 0;
    const theirs = other.roundScore ?? 0;
    const announced = state.announcerId === viewer;
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
