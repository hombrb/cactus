// The Durable Object — one per room, the single writer docs/10 §3 asks for.
//
// It owns three things and no game logic: sockets, storage, and the alarm
// clock. Everything that decides what happens is in RoomCore, which is why this
// file has no tests of its own and RoomCore has twenty.
//
// The trap this whole design is arranged around: **WebSocket Hibernation evicts
// the object from memory while the sockets stay open.** In-memory state is gone
// and comes back as nothing. So the snapshot is written after every action, and
// per-socket identity lives in the socket's own attachment rather than in a Map
// that will not survive the nap.

import { standard } from "../src/engine/config";
import { newSeed } from "../src/engine/rng";
import {
  decodeClientMessage,
  encode,
  type ServerMessage,
} from "../src/net/protocol";
import { RoomCore, type RoomEffects, type RoomOptions, type RoomSnapshot } from "../src/net/room-core";

const SNAPSHOT_KEY = "snapshot";
const OPTIONS_KEY = "options";

/** How often a socket is asked to time itself, for the snap grace ordering. */
const PING_EVERY_MS = 5_000;

interface Attachment {
  readonly playerId: string;
  readonly name: string;
  readonly pingSentAt: number | null;
  readonly lastPingAt: number;
}

export class Room implements DurableObject {
  private core: RoomCore | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: unknown,
  ) {
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const playerId = url.searchParams.get("playerId") ?? "";
    const name = url.searchParams.get("name") ?? "";

    // Codes are minted blind and checked here — `idFromName` means an occupied
    // code is simply an object that already has state (docs/10 §2).
    if (url.searchParams.get("probe") === "1") {
      // Reads storage directly rather than going through load(): a probe must
      // not mint a seed, and must not cost a write on the free plan's budget.
      const stored =
        this.core?.snapshot() ?? (await this.ctx.storage.get<RoomSnapshot>(SNAPSHOT_KEY));
      return new Response(JSON.stringify({ exists: (stored?.state ?? null) !== null }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (playerId === "" || name === "") {
      return new Response("missing identity", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // acceptWebSocket, not server.accept(): this is what lets the object be
    // evicted while the socket stays open.
    this.ctx.acceptWebSocket(server);
    this.attach(server, { playerId, name, pingSentAt: null, lastPingAt: 0 });

    const core = await this.load(code);
    const now = Date.now();
    await this.apply(core, core.join(playerId, name, now), now);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const attachment = this.attachmentOf(ws);
    if (attachment === null) return;

    const message = decodeClientMessage(raw);
    if (message === null) return;

    const core = await this.load();
    const now = Date.now();

    if (message.t === "pong") {
      // The token is the send time, so the round trip needs no server-side map.
      if (attachment.pingSentAt !== null && message.token === attachment.pingSentAt) {
        core.observeRtt(attachment.playerId, now - message.token);
        this.attach(ws, { ...attachment, pingSentAt: null });
      }
      return;
    }

    await this.apply(core, core.submit(attachment.playerId, message.action, now), now);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = this.attachmentOf(ws);
    if (attachment === null) return;
    const core = await this.load();
    const now = Date.now();
    await this.apply(core, core.leave(attachment.playerId, now), now);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const core = await this.load();
    const now = Date.now();
    await this.apply(core, core.alarm(now), now);
  }

  // -------------------------------------------------------------------------

  private async load(code?: string): Promise<RoomCore> {
    if (this.core !== null) return this.core;

    const stored = await this.ctx.storage.get<RoomSnapshot>(SNAPSHOT_KEY);
    let options = await this.ctx.storage.get<RoomOptions>(OPTIONS_KEY);
    if (options === undefined) {
      // The seed is minted once per room and never leaves it: it is the stock
      // order (docs/09 §2).
      options = { config: standard, seed: newSeed() };
      await this.ctx.storage.put(OPTIONS_KEY, options);
    }

    const snapshot: RoomSnapshot = stored ?? {
      code: code ?? "",
      state: null,
      snapBuffer: null,
      turnDeadline: null,
    };

    this.core = new RoomCore(snapshot, options);
    return this.core;
  }

  private async apply(core: RoomCore, effects: RoomEffects, now: number): Promise<void> {
    if (effects.persist) {
      await this.ctx.storage.put(SNAPSHOT_KEY, core.snapshot());
    }

    for (const send of effects.sends) {
      for (const ws of this.socketsFor(send.to)) this.post(ws, send.message, now);
    }

    if (effects.alarmAt === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(effects.alarmAt);
  }

  private post(ws: WebSocket, message: ServerMessage, now: number): void {
    try {
      ws.send(encode(message));
    } catch {
      // A socket that died between the fan-out and the send is not an error;
      // webSocketClose will follow and the reducer will hear about it there.
      return;
    }

    const attachment = this.attachmentOf(ws);
    if (attachment === null) return;
    if (attachment.pingSentAt !== null) return;
    if (now - attachment.lastPingAt < PING_EVERY_MS) return;

    try {
      ws.send(encode({ t: "ping", token: now }));
      this.attach(ws, { ...attachment, pingSentAt: now, lastPingAt: now });
    } catch {
      return;
    }
  }

  private socketsFor(playerId: string): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => this.attachmentOf(ws)?.playerId === playerId);
  }

  /** Identity has to ride on the socket: a Map would not survive hibernation. */
  private attach(ws: WebSocket, attachment: Attachment): void {
    ws.serializeAttachment(attachment);
  }

  private attachmentOf(ws: WebSocket): Attachment | null {
    const raw = ws.deserializeAttachment() as Attachment | null;
    return raw ?? null;
  }
}
