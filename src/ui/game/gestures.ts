// Tap / long-press / swipe recogniser.
//
// With snap enabled, an accidental tap costs a penalty card, so the three
// gestures must not overlap:
//   tap          — place a card, choose a power target
//   long-press   — reveal a card you are entitled to see (hides on release)
//   swipe inward — snap this card onto the discard
//
// The snap race is timestamped at pointerdown, not at gesture completion, so
// recognition latency never decides who was first (docs/10 §5).
//
// Two of the handlers may *decline* — `onLongPressStart` and `onDragStart`. That
// is what keeps the three gestures from stealing each other's input: a card that
// has nothing to reveal and nothing to snap latches neither, so the release still
// ends as the tap the player meant. A recogniser that cannot be declined swallows
// taps, and a swallowed tap on this board is a power that will not fire.
//
// A swipe also *reports its progress*, so the card can follow the finger: the
// drag begins after a few pixels, the snap is still dispatched the moment the
// 26px threshold is crossed, and the two are separate flags on purpose. Latching
// one "resolved" flag at the threshold — which is what this did — meant no
// movement could ever be reported past it.

export interface GestureHandlers {
  onTap?: () => void;
  /**
   * The finger has dwelled. Return `false` to decline it — the gesture then
   * behaves as if no long-press handler existed at all, so the release still ends
   * as a tap.
   *
   * Declining is not an optimisation, it is the difference between a working
   * board and a dead one: a card with nothing to reveal used to latch a hold and
   * swallow the tap that was aiming a power at it, and the prompt ("Regarde une
   * de tes cartes") invites exactly that hold.
   */
  onLongPressStart?: () => boolean | void;
  onLongPressEnd?: () => void;
  /** `at` is the pointerdown timestamp — the fair moment for a race. */
  onSwipeInward?: (at: number) => void;
  /**
   * The finger has committed to an inward drag, well before the snap threshold.
   * Return `false` to decline it — the gesture then behaves as if no drag handler
   * existed at all, so a small inward slide can still end as a tap.
   */
  onDragStart?: () => boolean | void;
  onDragMove?: (at: { clientX: number; clientY: number }) => void;
  /**
   * Always called if `onDragStart` was — on pointerup and on pointercancel.
   *
   * The release point, or `null` when the gesture was cancelled rather than let
   * go of. A card dropped somewhere lands there; a card whose pointer was taken
   * away falls back.
   */
  onDragEnd?: (release: { clientX: number; clientY: number } | null) => void;
}

export interface GestureOptions {
  /** Which screen direction points at the middle band from this element. */
  inward: "up" | "down";
  longPressMs?: number;
  swipeDistance?: number;
  tapSlopPx?: number;
  dragStartPx?: number;
}

const DEFAULT_LONG_PRESS_MS = 300;
const DEFAULT_SWIPE_DISTANCE = 26;
const DEFAULT_TAP_SLOP = 12;
const DEFAULT_DRAG_START = 8;

export function attachGestures(
  el: HTMLElement,
  handlers: GestureHandlers,
  options: GestureOptions,
): () => void {
  const longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;
  const swipeDistance = options.swipeDistance ?? DEFAULT_SWIPE_DISTANCE;
  const tapSlop = options.tapSlopPx ?? DEFAULT_TAP_SLOP;
  const dragStart = options.dragStartPx ?? DEFAULT_DRAG_START;

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let longPressTimer: number | null = null;
  let longPressing = false;
  let resolved = false;
  let dragging = false;
  let dragDeclined = false;
  let swiped = false;

  const clearTimer = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const endLongPress = () => {
    if (longPressing) {
      longPressing = false;
      handlers.onLongPressEnd?.();
    }
  };

  const endDrag = (release: { clientX: number; clientY: number } | null = null) => {
    if (dragging) {
      dragging = false;
      handlers.onDragEnd?.(release);
    }
  };

  const reset = () => {
    clearTimer();
    endLongPress();
    endDrag();
    pointerId = null;
    resolved = false;
    swiped = false;
    dragDeclined = false;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (pointerId !== null) return; // one gesture at a time per element
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startedAt = e.timeStamp;
    resolved = false;
    el.setPointerCapture?.(e.pointerId);

    if (handlers.onLongPressStart) {
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        if (resolved) return;
        // Asked before latching: a declined hold must leave `longPressing` false,
        // so the release still taps and `onLongPressEnd` never fires for a hold
        // that never began.
        if (handlers.onLongPressStart?.() === false) return;
        longPressing = true;
      }, longPressMs);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const travelled = options.inward === "up" ? -dy : dy;
    const sideways = Math.abs(dx);
    const inward = travelled > 0 && sideways < travelled;

    // The card comes off the table early, so the whole gesture is visible from
    // the first few pixels rather than only once it has committed.
    if (!dragging && !dragDeclined && handlers.onDragStart && inward && travelled > dragStart) {
      if (handlers.onDragStart() === false) {
        dragDeclined = true;
      } else {
        dragging = true;
        clearTimer();
        endLongPress();
      }
    }
    if (dragging) handlers.onDragMove?.({ clientX: e.clientX, clientY: e.clientY });

    // Dispatched the instant the threshold is crossed, exactly as before the drag
    // existed. The authority timestamps a snap by its arrival (docs/10 §5), so
    // waiting for the finger to lift would lose races the player had won.
    if (!swiped && handlers.onSwipeInward && inward && travelled > swipeDistance) {
      swiped = true;
      resolved = true;
      clearTimer();
      endLongPress();
      handlers.onSwipeInward(startedAt);
    }

    // Any real movement cancels a pending long-press.
    if (Math.hypot(dx, dy) > tapSlop) clearTimer();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
    const wasLongPressing = longPressing;
    const wasDragging = dragging;
    clearTimer();
    endLongPress();
    // Before `reset()`, whose own `endDrag()` then no-ops: this is the only call
    // that knows where the finger let go.
    endDrag({ clientX: e.clientX, clientY: e.clientY });

    if (!resolved && !wasDragging && !wasLongPressing && moved <= tapSlop) handlers.onTap?.();
    reset();
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    reset();
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("contextmenu", (e) => e.preventDefault());

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
    reset();
  };
}
