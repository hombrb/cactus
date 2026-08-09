// One room's authority, with the transport taken out — docs/10 §3, §5.
//
// The Durable Object is deliberately thin: it owns sockets, storage and the
// alarm clock, and nothing else. Everything that decides *what happens* lives
// here, where it can be tested with a fake clock and no workerd.
//
// The one thing this file adds to the engine is real time. The reducer never
// sees a timestamp (docs/07 §1); the authority does, and uses it for exactly
// two jobs: ordering a snap race, and firing a turn timeout.

import { projectEvents, projectFor } from "../engine/project";
import { applyAction } from "../engine/reduce";
import { inRound } from "../engine/state";
import { createMatch } from "../engine/turn";
import type {
  Action,
  Event,
  GameState,
  PlayerId,
  RuleConfig,
  SlotRef,
} from "../engine/types";
import type { ServerMessage } from "./protocol";

export interface SnapEntry {
  readonly playerId: PlayerId;
  readonly target: SlotRef;
  readonly forVersion: number;
  /** Arrival, minus this player's estimated one-way latency. */
  readonly adjusted: number;
}

export interface SnapBuffer {
  readonly forVersion: number;
  readonly closesAt: number;
  readonly entries: readonly SnapEntry[];
}

export interface TurnDeadline {
  readonly at: number;
  /** The actionCounter this timer was armed against (docs/05 §8). */
  readonly token: number;
}

/** Everything the room must survive hibernation with. JSON, all of it. */
export interface RoomSnapshot {
  readonly code: string;
  readonly state: GameState | null;
  readonly snapBuffer: SnapBuffer | null;
  readonly turnDeadline: TurnDeadline | null;
}

export interface Send {
  readonly to: PlayerId;
  readonly message: ServerMessage;
}

export interface RoomEffects {
  readonly sends: readonly Send[];
  /** The snapshot changed and must be written before the object sleeps. */
  readonly persist: boolean;
  /** Absolute epoch ms the object should next be woken at, or null for never. */
  readonly alarmAt: number | null;
}

const NOTHING: RoomEffects = { sends: [], persist: false, alarmAt: null };

export interface RoomOptions {
  readonly config: RuleConfig;
  readonly seed: string;
}

export class RoomCore {
  readonly code: string;
  private state: GameState | null;
  private snapBuffer: SnapBuffer | null;
  private turnDeadline: TurnDeadline | null;
  /** Smoothed one-way latency per player. Ephemeral: re-learned after a nap. */
  private latency = new Map<PlayerId, number>();

  constructor(
    snapshot: RoomSnapshot,
    private readonly options: RoomOptions,
  ) {
    this.code = snapshot.code;
    this.state = snapshot.state;
    this.snapBuffer = snapshot.snapBuffer;
    this.turnDeadline = snapshot.turnDeadline;
  }

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      state: this.state,
      snapBuffer: this.snapBuffer,
      turnDeadline: this.turnDeadline,
    };
  }

  /** Present so a caller can render a lobby before the first action lands. */
  view(playerId: PlayerId) {
    return this.state === null ? null : projectFor(this.state, playerId);
  }

  /** False only for a code that has never been used — the collision check. */
  get exists(): boolean {
    return this.state !== null;
  }

  get isEmpty(): boolean {
    return this.state === null || this.state.players.every((p) => !p.connected);
  }

  /** Half the smoothed RTT — an estimate, and allowed to be wrong (docs/10 §5). */
  observeRtt(playerId: PlayerId, rttMs: number): void {
    const previous = this.latency.get(playerId);
    const oneWay = Math.max(0, rttMs) / 2;
    this.latency.set(playerId, previous === undefined ? oneWay : previous * 0.7 + oneWay * 0.3);
  }

  /**
   * The first joiner creates the match and is host; everybody after them joins
   * through the reducer. A returning player is matched on `playerId`, which is
   * the whole of the identity model (docs/10 §2).
   */
  join(playerId: PlayerId, name: string, now: number): RoomEffects {
    if (this.state === null) {
      this.state = createMatch({
        config: this.options.config,
        players: [{ id: playerId, name }],
        seed: this.options.seed,
      });
      return this.settle(now, [], true, [this.welcome(playerId)]);
    }

    const rejoining = this.state.players.some((p) => p.id === playerId);
    // Mid-match, LobbyJoin is rejected — but a known player reconnecting is not
    // a join, it is a reconnection, and must not be turned away (docs/10 §4).
    if (this.state.phase !== "LOBBY" && !rejoining) {
      return {
        sends: [{ to: playerId, message: { t: "error", message: "MATCH_STARTED" } }],
        persist: false,
        alarmAt: this.nextAlarm(),
      };
    }

    if (rejoining && this.state.phase !== "LOBBY") {
      this.state = {
        ...this.state,
        players: this.state.players.map((p) =>
          p.id === playerId ? { ...p, connected: true } : p,
        ),
      };
      const events: Event[] = [{ type: "ConnectionChanged", playerId, connected: true }];
      return this.settle(now, events, true, [this.welcome(playerId)]);
    }

    const result = applyAction(this.state, { type: "LobbyJoin", playerId, name });
    this.state = result.state;
    return this.settle(now, result.events, true, [this.welcome(playerId)]);
  }

  leave(playerId: PlayerId, now: number): RoomEffects {
    if (this.state === null) return NOTHING;
    const result = applyAction(this.state, { type: "LobbyLeave", playerId });
    this.state = result.state;
    this.latency.delete(playerId);
    return this.settle(now, result.events, true);
  }

  /**
   * An action from a connection. The issuing identity is the connection's, never
   * the one in the payload: a client asserting somebody else's id gets its own
   * id substituted, and the reducer rejects it on the merits (docs/10 §3).
   */
  submit(playerId: PlayerId, incoming: Action, now: number): RoomEffects {
    if (this.state === null) return NOTHING;
    const action = { ...incoming, playerId } as Action;

    if (action.type === "Snap") return this.submitSnap(playerId, action, now);
    return this.commit(action, now);
  }

  /**
   * Woken by the alarm: flush a closed snap buffer, then fire a due timeout.
   * Both may be pending; the buffer goes first because it is the shorter fuse
   * and because its reductions move the token the timeout is armed against.
   */
  alarm(now: number): RoomEffects {
    if (this.state === null) return NOTHING;

    const buffer = this.snapBuffer;
    if (buffer !== null && now >= buffer.closesAt) {
      return this.flushSnaps(buffer, now);
    }

    const deadline = this.turnDeadline;
    if (deadline !== null && now >= deadline.at) {
      this.turnDeadline = null;
      const current = this.state.turnOrder[this.state.currentPlayerIndex]!;
      return this.commit({ type: "Timeout", playerId: current, phaseToken: deadline.token }, now);
    }

    return { sends: [], persist: false, alarmAt: this.nextAlarm() };
  }

  // -------------------------------------------------------------------------
  // Snap fairness — docs/10 §5. The only real-time logic in the system.
  // -------------------------------------------------------------------------

  private submitSnap(
    playerId: PlayerId,
    action: Action & { type: "Snap" },
    now: number,
  ): RoomEffects {
    const state = this.state!;
    const graceMs = state.config.timing.snapGraceMs;

    // A stale snap is not a race — the reducer already knows how to call it a
    // lost race (docs/07 §4.3), so buffering it would only delay the verdict.
    if (action.forVersion !== state.discardVersion || graceMs <= 0) {
      return this.commit(action, now);
    }

    const entry: SnapEntry = {
      playerId,
      target: action.target,
      forVersion: action.forVersion,
      adjusted: now - (this.latency.get(playerId) ?? 0),
    };

    const open = this.snapBuffer;
    if (open === null || open.forVersion !== action.forVersion) {
      this.snapBuffer = {
        forVersion: action.forVersion,
        closesAt: now + graceMs,
        entries: [entry],
      };
    } else {
      this.snapBuffer = { ...open, entries: [...open.entries, entry] };
    }

    // Nothing reaches the reducer yet, but the buffer is state the room cannot
    // afford to lose to hibernation.
    return { sends: [], persist: true, alarmAt: this.nextAlarm() };
  }

  private flushSnaps(buffer: SnapBuffer, now: number): RoomEffects {
    this.snapBuffer = null;

    const ordered = [...buffer.entries].sort(
      (a, b) => a.adjusted - b.adjusted || a.playerId.localeCompare(b.playerId),
    );

    // Submitted in order into the same reducer: only the first can win, and
    // every later one meets an advanced discardVersion and is judged a lost
    // race on its own terms.
    const events: Event[] = [];
    for (const entry of ordered) {
      const result = applyAction(this.state!, {
        type: "Snap",
        playerId: entry.playerId,
        target: entry.target,
        forVersion: entry.forVersion,
      });
      this.state = result.state;
      events.push(...result.events);
    }

    return this.settle(now, events, true);
  }

  // -------------------------------------------------------------------------

  private commit(action: Action, now: number): RoomEffects {
    const result = applyAction(this.state!, action);
    this.state = result.state;
    return this.settle(now, result.events, true);
  }

  /** Re-arms the turn clock, fans the events out, and reports what to persist. */
  private settle(
    now: number,
    events: readonly Event[],
    persist: boolean,
    extra: readonly Send[] = [],
  ): RoomEffects {
    this.armTurnDeadline(now);
    return {
      sends: [...extra, ...this.fanOut(events)],
      persist,
      alarmAt: this.nextAlarm(),
    };
  }

  private armTurnDeadline(now: number): void {
    const state = this.state!;
    const timeoutMs = state.config.timing.turnTimeoutMs;
    // A disconnected player's turn still comes round and still times out
    // (docs/10 §4) — so this is armed on the phase, not on who is present.
    if (timeoutMs === null || !inRound(state)) {
      this.turnDeadline = null;
      return;
    }
    this.turnDeadline = { at: now + timeoutMs, token: state.actionCounter };
  }

  private nextAlarm(): number | null {
    const times = [this.snapBuffer?.closesAt, this.turnDeadline?.at].filter(
      (t): t is number => typeof t === "number",
    );
    return times.length === 0 ? null : Math.min(...times);
  }

  private welcome(playerId: PlayerId): Send {
    return {
      to: playerId,
      message: {
        t: "welcome",
        code: this.code,
        seat: playerId,
        view: projectFor(this.state!, playerId),
      },
    };
  }

  private fanOut(events: readonly Event[]): Send[] {
    const state = this.state!;
    return state.players.map((p) => ({
      to: p.id,
      message: {
        t: "update",
        view: projectFor(state, p.id),
        events: projectEvents(events, p.id),
      } as ServerMessage,
    }));
  }
}
