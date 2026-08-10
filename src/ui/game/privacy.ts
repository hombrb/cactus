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
//
// One instance belongs to one viewer and is fed that viewer's *projected* event
// stream — the same bytes an online client would receive. It therefore cannot
// grant anything the network would not also have entitled that player to.

import type { Event, PlayerId, SlotRef } from "../../engine/types";

const key = (ref: SlotRef): string => `${ref.playerId}|${ref.slot}`;

export class RevealGrants {
  private granted = new Set<string>();
  private looking = new Set<string>();

  constructor(private readonly viewer: PlayerId) {}

  /** Grants created by the events that entitle this viewer to look. */
  ingest(events: readonly Event[]): void {
    for (const e of events) {
      switch (e.type) {
        case "InitialPeeked":
          // A projected InitialPeeked for somebody else carries HIDDEN ids; the
          // owner check is what keeps us from granting on it anyway.
          if (e.playerId !== this.viewer) break;
          for (const r of e.reveals) {
            this.granted.add(key({ playerId: e.playerId, slot: r.slot }));
          }
          break;
        case "CardRevealed":
          if (e.toPlayerId !== this.viewer) break;
          this.granted.add(key(e.ref));
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

  has(ref: SlotRef): boolean {
    return this.granted.has(key(ref));
  }

  isLooking(ref: SlotRef): boolean {
    return this.looking.has(key(ref));
  }

  beginLook(ref: SlotRef): boolean {
    const k = key(ref);
    if (!this.granted.has(k)) return false;
    this.looking.add(k);
    return true;
  }

  /**
   * Looking away consumes the grant: you get one look, as at a real table.
   *
   * `keepGrant` is the one exception, and it is not a loosening: while a decision
   * is still pending on what the grant revealed — the black King's "swap these
   * two?" — the player is being asked about cards they are entitled to see, and
   * they are entitled until they answer. Both looks are single-use and serial, so
   * consuming them left the King choosing from memory with the pulse already
   * gone. The card still hides on release, so a shared screen is no more exposed
   * than before, and `knownBy` is untouched: the projection closes the door by
   * itself the moment the swap resolves (docs/09 §5, docs/06 §6).
   */
  endLook(ref: SlotRef, keepGrant = false): void {
    const k = key(ref);
    if (!this.looking.delete(k)) return;
    if (!keepGrant) this.granted.delete(k);
  }

  /** Any card still exposed is hidden — used when the round ends abruptly. */
  hideAll(): void {
    this.looking.clear();
  }
}
