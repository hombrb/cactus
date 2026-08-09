// What moved, and from where to where — read off the projected event stream.
//
// Pure: no DOM, no rects, no timing. It names places on the board ("the stock",
// "p2's third slot") and leaves it to `flight.ts` to find out where those are and
// to fly a card between them. That split is what makes the mapping testable, and
// it is also the honest one: the events say what happened, the layer says what it
// looks like.
//
// Two rules hold throughout:
//
//   - **One physical movement, one flight.** The flat table subscribes with two
//     seats, so every reduction arrives twice, redacted per seat. That is what
//     `mergeSeatEvents` is for.
//   - **A `cardId` here is an identity, never an entitlement.** Whether a face may
//     be shown is decided by the destination's `data-face`, which the renderer has
//     already worked out from the reveal grants (docs/09 §5). Nothing in this file
//     may be read as permission to draw a card face up.

import { HIDDEN } from "../../engine/project";
import type {
  CardId,
  Event,
  Phase,
  PlayerId,
  SlotIndex,
  SlotRef,
} from "../../engine/types";
import type { SeatUpdate } from "../client";

/** A place on the board a card can leave from or arrive at. */
export type Anchor =
  | { readonly kind: "stock" }
  | { readonly kind: "discard" }
  | { readonly kind: "tray"; readonly playerId: PlayerId }
  | { readonly kind: "slot"; readonly playerId: PlayerId; readonly slot: SlotIndex }
  /** A player's whole layout — for a movement whose event does not name a slot. */
  | { readonly kind: "hand"; readonly playerId: PlayerId };

export interface Flight {
  readonly from: Anchor;
  readonly to: Anchor;
  /** Identity only. HIDDEN means "not ours to name", not "draw a back". */
  readonly cardId: CardId | typeof HIDDEN;
  /** `return` = the card goes back where it came from — a failed snap. */
  readonly kind: "move" | "return";
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "stock":
    case "discard":
      return true;
    case "tray":
    case "hand":
      return a.playerId === (b as typeof a).playerId;
    case "slot":
      return (
        a.playerId === (b as typeof a).playerId && a.slot === (b as typeof a).slot
      );
  }
}

const stock: Anchor = { kind: "stock" };
const discard: Anchor = { kind: "discard" };
const tray = (playerId: PlayerId): Anchor => ({ kind: "tray", playerId });
const slotAt = (playerId: PlayerId, slot: SlotIndex): Anchor => ({
  kind: "slot",
  playerId,
  slot,
});
const at = (ref: SlotRef): Anchor => slotAt(ref.playerId, ref.slot);

/**
 * The events of one reduction → the movements to animate, in order.
 *
 * `phaseBefore` is the phase the board was in when the action was dispatched. It
 * is needed for exactly one event: `CardGiven` names two givings that look
 * identical on the wire (see below).
 *
 * Deliberately silent about `CardsDealt` and `DiscardSeeded`: dealing eight cards
 * one by one is a second of waiting at the start of every round, and the round
 * starts with nothing on screen worth watching a card leave.
 */
export function planFlights(
  events: readonly Event[],
  phaseBefore: Phase,
): readonly Flight[] {
  const out: Flight[] = [];
  const move = (from: Anchor, to: Anchor, cardId: CardId | typeof HIDDEN): void => {
    out.push({ from, to, cardId, kind: "move" });
  };

  for (const e of events) {
    switch (e.type) {
      case "StockDrawn":
        move(stock, tray(e.playerId), e.cardId);
        break;

      case "DiscardTaken":
        move(discard, tray(e.playerId), e.cardId);
        break;

      case "CardPlaced":
        // Two cards cross: the held one goes in, the one it replaces comes out.
        move(tray(e.playerId), slotAt(e.playerId, e.slot), e.placedCardId);
        if (e.discardedCardId !== null) {
          move(slotAt(e.playerId, e.slot), discard, e.discardedCardId);
        }
        break;

      case "HeldDiscarded":
        move(tray(e.playerId), discard, e.cardId);
        break;

      case "CardsSwapped":
        // The refs are public, the contents are not — and by the time we are
        // called the layouts have already been reprojected, so there is nothing
        // to name even for the swapper. Both ends fly backs, which is exactly
        // what a blind swap looks like at a table (docs/06 §5).
        move(at(e.a), at(e.b), HIDDEN);
        move(at(e.b), at(e.a), HIDDEN);
        break;

      case "SnapSucceeded":
        move(at(e.ref), discard, e.cardId);
        break;

      case "SnapFailed":
        // The card never left its slot; it was shown and put back. The layer
        // turns this into a shake, or into the return leg of a live drag.
        out.push({ from: at(e.ref), to: at(e.ref), cardId: e.cardId, kind: "return" });
        break;

      case "PenaltyCardTaken":
        // Off the top of the stock, face down, unknown even to its owner.
        move(stock, slotAt(e.playerId, e.slot), e.cardId);
        break;

      case "CardGiven":
        // Two very different givings share this event, and nothing in the event
        // tells them apart — hence `phaseBefore`. The Ace power hands over the
        // card it had just discarded, so that one comes off the pile
        // (docs/06 §7). A snap give hands over one of the giver's own cards, and
        // the event names only where it *lands* (docs/07 §5), so it flies out of
        // their layout rather than out of a slot we would have to guess at. Add
        // `fromSlot` to the event if that ever needs to be exact.
        move(
          phaseBefore === "POWER_AWAIT_GIVE_TARGET"
            ? discard
            : { kind: "hand", playerId: e.fromPlayerId },
          slotAt(e.toPlayerId, e.slot),
          e.cardId,
        );
        break;

      default:
        break;
    }
  }

  return out;
}

/**
 * The same reduction, seen by every seat this device holds, collapsed into one
 * stream.
 *
 * `projectEvents` redacts per viewer, so the flat table's two streams differ in
 * which card ids they name — and animating both would animate every movement
 * twice. The streams are the same reduction in the same order; the only event
 * `projectEvent` *drops* rather than redacts is somebody else's `ActionRejected`
 * (which really happens: a lost snap race with `loserPenalty: NONE` emits one).
 * Filter those and the rest is index-aligned, so the choice per index is just
 * "whichever variant hides the fewest cards".
 *
 * Online there is one seat and this is the identity function.
 */
export function mergeSeatEvents(updates: readonly SeatUpdate[]): readonly Event[] {
  const streams = updates.map((u) => u.events.filter((e) => e.type !== "ActionRejected"));
  const spine = streams[0];
  if (spine === undefined) return [];
  // Belt and braces: if the assumption above ever stops holding, one stream is
  // still exactly one animation per movement — just a back where a face was on
  // offer.
  if (streams.some((s) => s.length !== spine.length)) return spine;

  return spine.map((event, i) => {
    let best = event;
    let hidden = redactions(best);
    for (const stream of streams) {
      const other = stream[i]!;
      if (other.type !== best.type) continue;
      const count = redactions(other);
      if (count < hidden) {
        best = other;
        hidden = count;
      }
    }
    return best;
  });
}

/** How many card ids this variant of an event hides. Fewer is more entitled. */
function redactions(e: Event): number {
  let n = 0;
  const count = (id: unknown): void => {
    if (id === HIDDEN) n++;
  };

  switch (e.type) {
    case "StockDrawn":
    case "DiscardTaken":
    case "HeldDiscarded":
    case "CardGiven":
    case "PenaltyCardTaken":
    case "SnapSucceeded":
    case "SnapFailed":
      count(e.cardId);
      break;
    case "CardPlaced":
      count(e.placedCardId);
      count(e.discardedCardId);
      break;
    case "CardsDealt":
      for (const d of e.deals) count(d.cardId);
      break;
    case "InitialPeeked":
      for (const r of e.reveals) count(r.cardId);
      break;
    case "CardRevealed":
      count(e.cardId);
      break;
    default:
      break;
  }
  return n;
}
