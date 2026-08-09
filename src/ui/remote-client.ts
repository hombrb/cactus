// The other half of the transport seam: the same GameClient, over a socket.
//
// This client holds exactly one seat and no GameState. It cannot compute a view
// — it is *told* one after every action, already redacted. That is the whole
// point of Phase 1: the renderer above it cannot tell the difference.

import type { PlayerView } from "../engine/project";
import type { Action, Event, PlayerId } from "../engine/types";
import {
  decodeServerMessage,
  encode,
  type ServerMessage,
} from "../net/protocol";
import type { ClientListener, GameClient, SeatUpdate } from "./client";

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export interface RemoteOptions {
  readonly url: string;
  readonly code: string;
  readonly playerId: PlayerId;
  readonly name: string;
}

export class RemoteClient implements GameClient {
  readonly seats: readonly PlayerId[];
  /** The join code, so the lobby can keep showing it. */
  readonly code: string;
  private socket: WebSocket | null = null;
  private listeners: ClientListener[] = [];
  private latest: PlayerView;
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly options: RemoteOptions,
    socket: WebSocket,
    welcome: PlayerView,
  ) {
    this.seats = [options.playerId];
    this.code = options.code;
    this.latest = welcome;
    this.adopt(socket);
  }

  /** Resolves once the room has welcomed us, so the board never renders empty. */
  static connect(options: RemoteOptions): Promise<RemoteClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(socketUrl(options));
      let settled = false;

      // Every listener here is removed on the first outcome. Leaving the
      // handshake's listener attached would mean a later `error` frame — a
      // perfectly ordinary thing for the server to send mid-game — closing the
      // socket out from under the game.
      const onMessage = (event: MessageEvent) => {
        const message = decodeServerMessage(String(event.data));
        if (message === null) return;
        if (message.t === "error") return finish(null, message.message);
        if (message.t === "welcome") finish(message.view, null);
      };
      const onError = () => finish(null, "CONNECT_FAILED");
      const onClose = () => finish(null, "CONNECT_FAILED");

      function finish(view: PlayerView | null, reason: string | null): void {
        if (settled) return;
        settled = true;
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);

        if (view === null) {
          socket.close();
          reject(new Error(reason ?? "CONNECT_FAILED"));
          return;
        }
        resolve(new RemoteClient(options, socket, view));
      }

      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  view(_seat: PlayerId): PlayerView {
    // One seat, one view. The argument exists so the renderer does not have to
    // know which kind of client it is talking to.
    return this.latest;
  }

  dispatch(action: Action): void {
    // Fire and forget: the authority decides, and the answer arrives as an
    // update. An illegal action comes back as a redacted ActionRejected rather
    // than being suppressed here — a client that hides rejections becomes a
    // free board oracle (docs/06 §2).
    this.socket?.send(encode({ t: "action", action }));
  }

  subscribe(listener: ClientListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  destroy(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.listeners = [];
    this.socket?.close();
    this.socket = null;
  }

  // -------------------------------------------------------------------------

  private adopt(socket: WebSocket): void {
    this.socket = socket;
    this.attempt = 0;

    socket.addEventListener("message", (event: MessageEvent) => {
      const message = decodeServerMessage(String(event.data));
      if (message !== null) this.receive(message);
    });
    socket.addEventListener("close", () => this.scheduleReconnect());
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case "ping":
        // Echoed straight back; the server times the round trip and uses half
        // of it to order snap races (docs/10 §5).
        this.socket?.send(encode({ t: "pong", token: message.token }));
        return;

      case "welcome":
        // A reconnection: adopt the fresh view, and replay nothing. The events
        // we missed are gone, which is why the view is authoritative and the
        // event stream is only ever a hint for animation.
        this.emit(message.view, []);
        return;

      case "update":
        this.emit(message.view, message.events);
        return;

      case "error":
        return;
    }
  }

  private emit(view: PlayerView, events: readonly Event[]): void {
    this.latest = view;
    const update: SeatUpdate = { seat: this.options.playerId, view, events };
    for (const listener of this.listeners) listener([update]);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.socket = null;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt += 1;

    this.timer = setTimeout(() => {
      if (this.closed) return;
      const socket = new WebSocket(socketUrl(this.options));

      // Only one close listener may ever be live per socket, or a single drop
      // schedules two reconnects and the backoff stops meaning anything.
      const onEarlyClose = () => this.scheduleReconnect();
      socket.addEventListener("close", onEarlyClose, { once: true });
      socket.addEventListener(
        "open",
        () => {
          socket.removeEventListener("close", onEarlyClose);
          this.adopt(socket);
        },
        { once: true },
      );
    }, delay);
  }
}

function socketUrl(options: RemoteOptions): string {
  const url = new URL(options.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/room/socket";
  url.searchParams.set("code", options.code);
  url.searchParams.set("playerId", options.playerId);
  url.searchParams.set("name", options.name);
  return url.toString();
}
