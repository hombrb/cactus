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

export interface GestureHandlers {
  onTap?: () => void;
  onLongPressStart?: () => void;
  onLongPressEnd?: () => void;
  /** `at` is the pointerdown timestamp — the fair moment for a race. */
  onSwipeInward?: (at: number) => void;
}

export interface GestureOptions {
  /** Which screen direction points at the middle band from this element. */
  inward: "up" | "down";
  longPressMs?: number;
  swipeDistance?: number;
  tapSlopPx?: number;
}

const DEFAULT_LONG_PRESS_MS = 300;
const DEFAULT_SWIPE_DISTANCE = 26;
const DEFAULT_TAP_SLOP = 12;

export function attachGestures(
  el: HTMLElement,
  handlers: GestureHandlers,
  options: GestureOptions,
): () => void {
  const longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;
  const swipeDistance = options.swipeDistance ?? DEFAULT_SWIPE_DISTANCE;
  const tapSlop = options.tapSlopPx ?? DEFAULT_TAP_SLOP;

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let longPressTimer: number | null = null;
  let longPressing = false;
  let resolved = false;

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

  const reset = () => {
    clearTimer();
    endLongPress();
    pointerId = null;
    resolved = false;
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
    if (e.pointerId !== pointerId || resolved) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const travelled = options.inward === "up" ? -dy : dy;
    const sideways = Math.abs(dx);

    if (handlers.onSwipeInward && travelled > swipeDistance && sideways < travelled) {
      resolved = true;
      clearTimer();
      endLongPress();
      handlers.onSwipeInward(startedAt);
      return;
    }

    // Any real movement cancels a pending long-press.
    if (Math.hypot(dx, dy) > tapSlop) clearTimer();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
    const wasLongPressing = longPressing;
    clearTimer();
    endLongPress();

    if (!resolved && !wasLongPressing && moved <= tapSlop) handlers.onTap?.();
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
