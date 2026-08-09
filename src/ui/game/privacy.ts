// Reveal grants — the client half of docs/09 §5.
//
// `projectFor` says whether the engine MAY show a card to a player. It is not
// enough on its own: knownBy persists, so a card peeked at the start of the
// round would stay permanently readable — on a shared screen the opponent would
// simply lean over and read it.
//
// So a face is drawn only when BOTH hold: the projection permits it, and an
// explicit, single-use grant exists. A grant is created by the rules event that
// entitled the player to look, and is consumed the moment they stop looking.

import type { Event, PlayerId, SlotRef } from "../../engine/types";

const key = (viewer: PlayerId, ref: SlotRef): string =>
  `${viewer}|${ref.playerId}|${ref.slot}`;

export class RevealGrants {
  private granted = new Set<string>();
  private looking = new Set<string>();

  /** Grants created by the events that entitle a player to look. */
  ingest(events: readonly Event[]): void {
    for (const e of events) {
      switch (e.type) {
        case "InitialPeeked":
          for (const r of e.reveals) {
            this.granted.add(key(e.playerId, { playerId: e.playerId, slot: r.slot }));
          }
          break;
        case "CardRevealed":
          this.granted.add(key(e.toPlayerId, e.ref));
          break;
        case "RoundStarted":
          this.granted.clear();
          this.looking.clear();
          break;
        default:
          break;
      }
    }
  }

  has(viewer: PlayerId, ref: SlotRef): boolean {
    return this.granted.has(key(viewer, ref));
  }

  isLooking(viewer: PlayerId, ref: SlotRef): boolean {
    return this.looking.has(key(viewer, ref));
  }

  beginLook(viewer: PlayerId, ref: SlotRef): boolean {
    const k = key(viewer, ref);
    if (!this.granted.has(k)) return false;
    this.looking.add(k);
    return true;
  }

  /** Looking away consumes the grant: you get one look, as at a real table. */
  endLook(viewer: PlayerId, ref: SlotRef): void {
    const k = key(viewer, ref);
    if (!this.looking.delete(k)) return;
    this.granted.delete(k);
  }

  /** Any card still exposed is hidden — used when the round ends abruptly. */
  hideAll(): void {
    this.looking.clear();
  }
}
