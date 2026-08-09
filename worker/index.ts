// Worker entry: static assets, plus one WebSocket route per room.
//
// `idFromName(code)` is the whole room directory — the join code *is* the
// address of the Durable Object, so there is no registry to keep, and no
// database (docs/10 §2).

import { CODE_LENGTH, makeRoomCode, normaliseRoomCode } from "../src/net/protocol";

/** One byte of entropy per code character. */
const CODE_BYTES = CODE_LENGTH;

export { Room } from "./room";

interface Env {
  readonly ROOM: DurableObjectNamespace;
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Mints a code and asks the object that code addresses to claim it, retrying on
 * collision. With a 32-character alphabet over six characters the space is
 * ~10^9, so this practically never loops — but "practically never" is not
 * "never", and handing two groups the same room is not recoverable.
 *
 * Claiming and checking are the same call on purpose: a probe followed by a
 * separate write would leave a window in which two creators both see a free
 * code. The object is single-threaded, so `create` is atomic.
 */
async function mintCode(env: Env, url: URL, body: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = new Uint8Array(CODE_BYTES);
    crypto.getRandomValues(bytes);
    const code = makeRoomCode(bytes);

    const claim = new URL(url.origin);
    claim.pathname = "/api/room/socket";
    claim.searchParams.set("code", code);
    claim.searchParams.set("create", "1");

    const response = await env.ROOM.get(env.ROOM.idFromName(code)).fetch(
      new Request(claim.toString(), {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = (await response.json()) as { created?: boolean };
    if (result.created === true) return code;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/room" && request.method === "POST") {
      // Forwarded verbatim; the object parses and clamps it, so an odd body is
      // a default room rather than an error.
      const body = await request.text().catch(() => "");
      const code = await mintCode(env, url, body);
      return code === null
        ? json({ error: "NO_CODE_AVAILABLE" }, 503)
        : json({ code });
    }

    if (url.pathname === "/api/room/socket") {
      const code = normaliseRoomCode(url.searchParams.get("code") ?? "");
      if (code === null) return new Response("bad room code", { status: 400 });

      const id = env.ROOM.idFromName(code);
      const forwarded = new URL(request.url);
      forwarded.searchParams.set("code", code);
      return env.ROOM.get(id).fetch(new Request(forwarded, request));
    }

    return env.ASSETS.fetch(request);
  },
};
