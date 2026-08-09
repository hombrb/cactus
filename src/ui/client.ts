// The transport seam — see docs/10 §4.
//
// The renderer talks to a GameClient and never to a GameState. Two things ride
// on that: a networked player physically cannot hold the authoritative state,
// and the flat-table mode becomes a live test of the network path, because it
// goes through the very same projection.
//
// A client owns one or more *seats*: the players whose private view this device
// is entitled to render. Flat-table holds two seats on one screen; an online
// player holds exactly one.

import { projectEvents, projectFor, type PlayerView } from "../engine/project";
import { applyAction } from "../engine/reduce";
import type { Action, Event, GameState, PlayerId } from "../engine/types";

export interface SeatUpdate {
  readonly seat: PlayerId;
  readonly view: PlayerView;
  /** Already redacted for this seat — the renderer never sees a raw event. */
  readonly events: readonly Event[];
}

export type ClientListener = (updates: readonly SeatUpdate[]) => void;

export interface GameClient {
  /** Seats this device renders, in the order the engine deals them. */
  readonly seats: readonly PlayerId[];
  view(seat: PlayerId): PlayerView;
  dispatch(action: Action): void;
  subscribe(listener: ClientListener): () => void;
  destroy(): void;
}

/** Projects one reduction into the per-seat updates a renderer consumes. */
export function seatUpdates(
  state: GameState,
  seats: readonly PlayerId[],
  events: readonly Event[],
): readonly SeatUpdate[] {
  return seats.map((seat) => ({
    seat,
    view: projectFor(state, seat),
    events: projectEvents(events, seat),
  }));
}

/**
 * Authority and client in one process: the flat-table game.
 *
 * It applies actions itself, then hands the renderer exactly what a server
 * would have sent. If a change breaks the wire format, this breaks too.
 */
export class LocalClient implements GameClient {
  readonly seats: readonly PlayerId[];
  private listeners: ClientListener[] = [];
  private views = new Map<PlayerId, PlayerView>();

  constructor(
    private state: GameState,
    seats?: readonly PlayerId[],
  ) {
    this.seats = seats ?? state.turnOrder;
    this.reproject();
  }

  view(seat: PlayerId): PlayerView {
    const view = this.views.get(seat);
    if (view) return view;
    // A seat that is not ours still gets a correct, redacted view rather than a
    // throw — the renderer asking is a bug, but a blank board is not a leak.
    return projectFor(this.state, seat);
  }

  dispatch(action: Action): void {
    const result = applyAction(this.state, action);
    this.state = result.state;
    this.reproject();

    const updates = seatUpdates(this.state, this.seats, result.events);
    for (const listener of this.listeners) listener(updates);
  }

  subscribe(listener: ClientListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  destroy(): void {
    this.listeners = [];
  }

  private reproject(): void {
    this.views.clear();
    for (const seat of this.seats) this.views.set(seat, projectFor(this.state, seat));
  }
}
