import { applyAction } from "../engine/reduce";
import type { Action, Event, GameState } from "../engine/types";

type Listener = (state: GameState, events: readonly Event[]) => void;

/**
 * Holds the authoritative state for this device and notifies the renderer.
 *
 * In hotseat both players dispatch into the same store; each half is then
 * rendered from its own projection, so the store never decides what is visible.
 */
export class Store {
  private listeners: Listener[] = [];

  constructor(public state: GameState) {}

  dispatch(action: Action): readonly Event[] {
    const { state, events } = applyAction(this.state, action);
    this.state = state;
    for (const listener of this.listeners) listener(state, events);
    return events;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
