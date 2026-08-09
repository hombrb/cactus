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
// A swipe also *reports its progress*, so the card can follow the finger: the
// drag begins after a few pixels, the snap is still dispatched the moment the
// 26px threshold is crossed, and the two are separate flags on purpose. Latching
// one "resolved" flag at the threshold — which is what this did — meant no
// movement could ever be reported past it.

export interface GestureHandlers {
  onTap?: () => void;
  onLongPressStart?: () => void;
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
  /** Always called if `onDragStart` was — on pointerup and on pointercancel. */
  onDragEnd?: () => void;
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

  const endDrag = () => {
    if (dragging) {
      dragging = false;
      handlers.onDragEnd?.();
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
        longPressing = true;
        handlers.onLongPressStart?.();
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
