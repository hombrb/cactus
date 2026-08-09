// Cards in the air.
//
// A movement is drawn by a *clone* travelling across a layer of its own, while
// the real card stays where the renderer put it, hidden until the clone lands.
// That is not the cheapest way to animate — animating the card in place is — but
// it is the only one that works on this board, for three reasons, each of which
// bit before it was understood:
//
//   1. `.layout` is a `container-type: size` container, so it is a containing
//      block for `position: fixed` descendants *and* a stacking context. A card
//      moving inside it can never leave it.
//   2. The far half's `.rotor` is `rotate(180deg)`, which makes it a containing
//      block too, and negates any `translate` applied to a descendant on both
//      axes. Every delta would need its sign flipped, per half.
//   3. Nothing in this app has a `z-index`, so paint order is DOM order, and
//      `.middle` sits between the two halves. A card from the far half crossing
//      the band would pass *under* it.
//
// A layer that is a fixed, last child of `#app` has none of those problems: it is
// in viewport coordinates, it is unrotated, and it paints last.

import type { Card } from "../../engine/types";
import { createCardElement, paintCard, type CardFace } from "./card";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Look {
  readonly face: CardFace;
  readonly card?: Card | undefined;
}

export interface FlightSpec {
  readonly from: Rect;
  readonly to: Rect;
  /** How the source looked before the patch, and the destination after it. */
  readonly fromLook: Look;
  readonly toLook: Look;
  /**
   * 180 for a card that lands in the half drawn upside down, 0 otherwise.
   *
   * Held for the whole flight rather than turned from the source's orientation:
   * a card leaving the shared pile for the far half differs by exactly half a
   * turn, and interpolating that has it pass through 90° — a card visibly
   * tumbling on its way across the table. Which way up a back is cannot be seen
   * anyway, and a face is better read the right way up for whoever is about to
   * receive it.
   */
  readonly spin: number;
  /** Kept invisible while the clone is airborne, released when it lands. */
  readonly hide: HTMLElement | null;
}

export interface DragHandle {
  /** Absolute pointer position; the grab offset is kept from lift time. */
  moveTo(clientX: number, clientY: number): void;
  /** Adopted by a movement: carry on from the finger into `to`. */
  release(to: Rect, toLook: Look, toSpin: number, hide: HTMLElement | null): void;
  /** Not adopted: fall back where it came from. */
  cancel(): void;
}

export function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  // A 180° rotation preserves the axis-aligned box, so this is the true visual
  // rect for a card in either half — which is what lets the layer stay flat.
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Distance at which a flight takes the full duration; shorter hops are quicker. */
const REFERENCE_TRAVEL = 320;
/** How high a card rises off the table mid-flight, in px. */
const ARC = 16;
/** A dragged card sits a little above the felt. */
const DRAG_SCALE = 1.06;

export class FlightLayer {
  private readonly root: HTMLElement;
  /** Every airborne clone, against the card it is keeping hidden. */
  private readonly live = new Map<Animation, HTMLElement | null>();
  /** Ref-counted: two cards landing on the discard must not un-hide it early. */
  private readonly hidden = new Map<HTMLElement, number>();
  private duration = 240;
  private durationNear = 160;
  private motion = true;

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "flights";
    this.root.setAttribute("aria-hidden", "true");
    host.append(this.root);

    this.readTokens();
    // Reduced motion is expressed once, in tokens.css, as zeroed durations —
    // reading it back from there means this inherits the same switch (and the
    // one the screenshot runs use) instead of duplicating the media query.
    window
      .matchMedia("(prefers-reduced-motion: reduce)")
      .addEventListener("change", () => this.readTokens());
  }

  /** False when motion is off: the board then skips planning and measuring. */
  get enabled(): boolean {
    return this.motion;
  }

  fly(spec: FlightSpec): void {
    if (!this.motion) return;

    // A second movement onto the same place lands the first one first, so no
    // stale face is left in the air over a card that has already changed.
    this.landOn(spec.hide);

    const el = this.spawn(spec.from, spec.fromLook);
    const dx = centreX(spec.to) - centreX(spec.from);
    const dy = centreY(spec.to) - centreY(spec.from);
    const scale = spec.from.w === 0 ? 1 : spec.to.w / spec.from.w;
    const ms = this.msFor(Math.hypot(dx, dy));

    this.hideNode(spec.hide);
    const flips = spec.fromLook.face !== spec.toLook.face;
    if (flips) window.setTimeout(() => paintCard(el, spec.toLook.face, spec.toLook.card), ms / 2);

    this.run(
      el,
      [
        { transform: transform(0, 0, spec.spin, 1) },
        // Lifted off the felt and a touch larger at the halfway point, so it
        // reads as thrown across the table rather than slid along it.
        { transform: transform(dx / 2, dy / 2 - ARC, spec.spin, ((1 + scale) / 2) * 1.04) },
        { transform: transform(dx, dy, spec.spin, scale) },
      ],
      ms,
      spec.hide,
    );
  }

  /**
   * Take a card out of the board and hand it to the finger.
   *
   * The clone lives in this layer, so the drag is in plain viewport coordinates:
   * no per-half sign flip, and it can cross the middle band without going under
   * it.
   */
  lift(rect: Rect, look: Look, spin: number, hide: HTMLElement | null): DragHandle {
    const el = this.spawn(rect, look);
    el.dataset.drag = "1";
    this.hideNode(hide);

    const originX = centreX(rect);
    const originY = centreY(rect);
    let held: HTMLElement | null = hide;
    let dx = 0;
    let dy = 0;
    let done = false;

    const paint = (): void => {
      el.style.transform = transform(dx, dy, spin, DRAG_SCALE);
    };
    paint();

    return {
      moveTo: (clientX, clientY) => {
        if (done) return;
        dx = clientX - originX;
        dy = clientY - originY;
        paint();
      },
      release: (to, toLook, toSpin, hideTo) => {
        if (done) return;
        done = true;
        delete el.dataset.drag;

        const toDx = centreX(to) - originX;
        const toDy = centreY(to) - originY;
        const scale = rect.w === 0 ? 1 : to.w / rect.w;
        const ms = this.msFor(Math.hypot(toDx - dx, toDy - dy));
        if (look.face !== toLook.face) {
          window.setTimeout(() => paintCard(el, toLook.face, toLook.card), ms / 2);
        }

        // The card the finger was holding is the one that lands, so the source is
        // released and the destination takes over as the hidden node.
        this.releaseNode(held);
        held = hideTo;
        this.hideNode(held);
        // Straight to the landing orientation, as in `fly` and for the same
        // reason. A dragged card is always a back — a long-press and a drag are
        // mutually exclusive — so half a turn cannot be seen.
        this.run(
          el,
          [
            { transform: transform(dx, dy, toSpin, DRAG_SCALE) },
            { transform: transform(toDx, toDy, toSpin, scale) },
          ],
          ms,
          held,
        );
      },
      cancel: () => {
        if (done) return;
        done = true;
        delete el.dataset.drag;
        this.run(
          el,
          [
            { transform: transform(dx, dy, spin, DRAG_SCALE) },
            { transform: transform(0, 0, spin, 1) },
          ],
          this.durationNear,
          held,
        );
      },
    };
  }

  /**
   * Drop anything whose hidden card has left the document.
   *
   * A layout that grows — a penalty card, an Ace given away — is rebuilt from
   * scratch, so the node a flight was going to un-hide can simply be gone.
   */
  prune(): void {
    for (const el of [...this.hidden.keys()]) {
      if (!el.isConnected) this.hidden.delete(el);
    }
  }

  /** Land everything now — a new round, a board being torn down. */
  clear(): void {
    for (const animation of [...this.live.keys()]) animation.finish();
    this.live.clear();
    for (const el of [...this.hidden.keys()]) this.reveal(el);
    this.hidden.clear();
    this.root.replaceChildren();
  }

  destroy(): void {
    this.clear();
    this.root.remove();
  }

  // -------------------------------------------------------------------------

  private readTokens(): void {
    const styles = getComputedStyle(document.documentElement);
    this.duration = ms(styles.getPropertyValue("--flight"), 240);
    this.durationNear = ms(styles.getPropertyValue("--flight-near"), 160);
    // One switch for CSS and JS alike: reduced motion zeroes the tokens, and a
    // zero-length flight is no flight at all.
    this.motion = this.duration > 0 && !offByQuery();
    if (!this.motion) this.clear();
  }

  /** Finish any flight already on its way to `el`. */
  private landOn(el: HTMLElement | null): void {
    if (!el) return;
    for (const [animation, hide] of [...this.live]) {
      if (hide === el) animation.finish();
    }
  }

  private msFor(distance: number): number {
    const near = Math.min(this.durationNear, this.duration);
    const ratio = Math.min(1, distance / REFERENCE_TRAVEL);
    return near + (this.duration - near) * ratio;
  }

  private spawn(rect: Rect, look: Look): HTMLElement {
    // Built, never cloned: a `cloneNode` of a slot card would carry `card--slot`
    // (which the screenshot gate measures against the viewport), `data-slot`,
    // `data-target` and the pulsing `data-grant`.
    const el = createCardElement("card card--flight");
    paintCard(el, look.face, look.card);
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
    this.root.append(el);
    return el;
  }

  private run(
    el: HTMLElement,
    frames: Keyframe[],
    ms: number,
    hide: HTMLElement | null,
  ): void {
    const last = frames[frames.length - 1]!;
    // The final frame is written to the element too: an animation that has been
    // removed from the timeline stops holding its own end state.
    el.style.transform = String(last.transform);

    const animation = el.animate(frames, {
      duration: Math.max(1, ms),
      easing: "cubic-bezier(0.22, 0.68, 0.35, 1)",
      fill: "none",
    });
    this.live.set(animation, hide);

    const settle = (): void => {
      if (!this.live.delete(animation)) return; // already settled

      el.remove();
      this.releaseNode(hide);
    };
    animation.onfinish = settle;
    animation.oncancel = settle;
  }

  private hideNode(el: HTMLElement | null): void {
    if (!el) return;
    this.hidden.set(el, (this.hidden.get(el) ?? 0) + 1);
    el.dataset.flying = "1";
  }

  private releaseNode(el: HTMLElement | null): void {
    if (!el) return;
    const count = (this.hidden.get(el) ?? 0) - 1;
    if (count > 0) {
      this.hidden.set(el, count);
      return;
    }
    this.hidden.delete(el);
    this.reveal(el);
  }

  private reveal(el: HTMLElement): void {
    delete el.dataset.flying;
  }
}

function transform(dx: number, dy: number, spin: number, scale: number): string {
  // translate first, then rotate: the deltas stay in screen space, which is the
  // whole reason the layer is unrotated.
  return `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(${scale})`;
}

const centreX = (r: Rect): number => r.x + r.w / 2;
const centreY = (r: Rect): number => r.y + r.h / 2;

function ms(raw: string, fallback: number): number {
  const value = raw.trim();
  if (value.endsWith("ms")) return Number.parseFloat(value) || 0;
  if (value.endsWith("s")) return (Number.parseFloat(value) || 0) * 1000;
  return fallback;
}

/**
 * `?motion=off`, following the `?seed=` precedent: the switch you want when
 * stepping through one flight by hand, or on one of two phones.
 */
function offByQuery(): boolean {
  try {
    return new URLSearchParams(location.search).get("motion") === "off";
  } catch {
    return false;
  }
}
