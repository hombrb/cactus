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
 * Mints a code and asks the object that code addresses whether it is already in
 * use, retrying on collision. With a 32-character alphabet over six characters
 * the space is ~10^9, so this practically never loops — but "practically never"
 * is not "never", and handing two groups the same room is not recoverable.
 */
async function mintCode(env: Env, url: URL): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = new Uint8Array(CODE_BYTES);
    crypto.getRandomValues(bytes);
    const code = makeRoomCode(bytes);

    const probe = new URL(url.origin);
    probe.pathname = "/api/room/socket";
    probe.searchParams.set("code", code);
    probe.searchParams.set("probe", "1");

    const response = await env.ROOM.get(env.ROOM.idFromName(code)).fetch(probe.toString());
    const body = (await response.json()) as { exists?: boolean };
    if (body.exists !== true) return code;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/room" && request.method === "POST") {
      const code = await mintCode(env, url);
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
