// End-to-end check of the room authority against a real Durable Object.
//
// RoomCore is unit-tested on a fake clock; this is the part that cannot be:
// workerd's hibernation API, the socket attachments that identity rides on, the
// alarm, and the assets binding. Run it against `wrangler dev`.
//
//   npx wrangler dev --port 8787 --local &
//   node scripts/check-room.mjs

const ORIGIN = process.env.ROOM_ORIGIN ?? "http://localhost:8787";
const WS_ORIGIN = ORIGIN.replace(/^http/, "ws");
const HIDDEN = "hidden";

let failures = 0;

function check(ok, label) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

/** A player's socket, with the inbound messages queued for assertion. */
class Peer {
  constructor(code, playerId, name) {
    this.playerId = playerId;
    this.messages = [];
    this.waiters = [];
    const url = new URL(`${WS_ORIGIN}/api/room/socket`);
    url.searchParams.set("code", code);
    url.searchParams.set("playerId", playerId);
    url.searchParams.set("name", name);
    this.socket = new WebSocket(url);

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      // Answer pings inline: the server needs them to time the snap race, and
      // an unanswered ping would stall nothing but would make the check lie.
      if (message.t === "ping") {
        this.socket.send(JSON.stringify({ t: "pong", token: message.token }));
        return;
      }
      this.messages.push(message);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("socket error")), {
        once: true,
      });
    });
  }

  send(action) {
    this.socket.send(JSON.stringify({ t: "action", action }));
  }

  /** Waits for the next message satisfying `predicate`, consuming it. */
  async next(predicate, label, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.messages.findIndex(predicate);
      if (index !== -1) return this.messages.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close() {
    this.socket.close();
  }
}

const eventsOf = (message) => (message.t === "update" ? message.events : []);

async function main() {
  // --- the assets binding still serves the game --------------------------
  const page = await fetch(`${ORIGIN}/`);
  check(page.ok, "worker serves the built app");
  check((await page.text()).includes("<div id=\"app\""), "index.html is the real build");

  // --- codes -------------------------------------------------------------
  const created = await fetch(`${ORIGIN}/api/room`, { method: "POST" });
  const { code } = await created.json();
  check(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code), `minted a legible code (${code})`);

  const bad = await fetch(`${ORIGIN}/api/room/socket?code=OOPS`);
  check(bad.status === 400, "rejects a malformed code");

  // `idFromName` gives every well-formed string an object, so "unknown room"
  // has to be an explicit check — otherwise a typo silently opens an empty one.
  const ghost = await fetch(`${ORIGIN}/api/room/socket?code=ZZZZZZ&playerId=x&name=X`);
  check(ghost.status === 404, "a well-formed but uncreated code is 404, not a new room");

  // --- two players join --------------------------------------------------
  const a = new Peer(code, "player-a", "Alice");
  await a.open();
  const welcomeA = await a.next((m) => m.t === "welcome", "welcome for A");
  check(welcomeA.seat === "player-a", "A is welcomed into its own seat");
  check(welcomeA.view.hostId === "player-a", "first joiner is host");
  check(welcomeA.code === code, "welcome carries the room code");

  const b = new Peer(code, "player-b", "Bob");
  await b.open();
  await b.next((m) => m.t === "welcome", "welcome for B");
  await a.next(
    (m) => eventsOf(m).some((e) => e.type === "ConnectionChanged" && e.playerId === "player-b"),
    "A hears B arrive",
  );
  check(true, "a second player joins the same code");

  // --- play --------------------------------------------------------------
  a.send({ type: "StartMatch", playerId: "player-a" });
  // One reduction, one update: the deal arrives inside the MatchStarted message
  // rather than after it, so consuming them separately would hang.
  const dealt = await a.next(
    (m) => eventsOf(m).some((e) => e.type === "MatchStarted"),
    "match start",
  );
  check(dealt.view.phase === "INITIAL_PEEK", "the match starts in the initial peek");
  check(dealt.view.players.length === 2, "both players were dealt in");
  check(
    eventsOf(dealt)
      .filter((e) => e.type === "CardsDealt")
      .every((e) => e.deals.every((d) => d.cardId === HIDDEN)),
    "the deal itself is face down, even to its recipient",
  );

  a.send({ type: "PeekInitial", playerId: "player-a", slots: [0, 1] });
  const peeked = await a.next(
    (m) => eventsOf(m).some((e) => e.type === "InitialPeeked"),
    "A's peek",
  );
  const peekEvent = eventsOf(peeked).find((e) => e.type === "InitialPeeked");
  check(
    peekEvent.reveals.every((r) => r.cardId !== HIDDEN),
    "A sees its own initial peek",
  );

  const peekSeenByB = await b.next(
    (m) => eventsOf(m).some((e) => e.type === "InitialPeeked"),
    "B's copy of A's peek",
  );
  check(
    eventsOf(peekSeenByB)
      .find((e) => e.type === "InitialPeeked")
      .reveals.every((r) => r.cardId === HIDDEN),
    "B does NOT see the cards A peeked at",
  );

  b.send({ type: "PeekInitial", playerId: "player-b", slots: [0, 1] });
  const live = await a.next((m) => m.t === "update" && m.view.phase === "TURN_START", "first turn");
  const current = live.view.currentPlayer;
  const actor = current === "player-a" ? a : b;
  const bystander = current === "player-a" ? b : a;

  // --- the authority overwrites the claimed identity ---------------------
  bystander.send({ type: "DrawStock", playerId: current });
  const rejected = await bystander.next(
    (m) => eventsOf(m).some((e) => e.type === "ActionRejected"),
    "impostor rejected",
  );
  check(
    eventsOf(rejected).find((e) => e.type === "ActionRejected").playerId === bystander.playerId,
    "an action claiming another seat is issued under the sender's own id",
  );

  // --- redaction across the wire -----------------------------------------
  actor.send({ type: "DrawStock", playerId: current });
  const drewMine = await actor.next(
    (m) => eventsOf(m).some((e) => e.type === "StockDrawn"),
    "actor's draw",
  );
  const drewTheirs = await bystander.next(
    (m) => eventsOf(m).some((e) => e.type === "StockDrawn"),
    "bystander's copy",
  );
  check(
    eventsOf(drewMine).find((e) => e.type === "StockDrawn").cardId !== HIDDEN,
    "the drawing player sees the card they drew",
  );
  check(
    eventsOf(drewTheirs).find((e) => e.type === "StockDrawn").cardId === HIDDEN,
    "the other player does not",
  );
  check(drewTheirs.view.heldCard === HIDDEN, "and their view hides the held card too");

  // --- nothing secret ever crosses ---------------------------------------
  const everything = JSON.stringify([...a.messages, ...b.messages, welcomeA]);
  check(!everything.includes("\"stock\""), "the stock never crosses the wire");
  check(!everything.includes("rngSeed"), "the seed never crosses the wire");

  // --- reconnection ------------------------------------------------------
  bystander.close();
  await actor.next(
    (m) =>
      eventsOf(m).some(
        (e) => e.type === "ConnectionChanged" && e.playerId === bystander.playerId && !e.connected,
      ),
    "disconnect noticed",
  );
  check(true, "a dropped socket marks the player disconnected");

  const back = new Peer(code, bystander.playerId, "Returning");
  await back.open();
  const rewelcome = await back.next((m) => m.t === "welcome", "welcome back");
  check(
    rewelcome.view.players.find((p) => p.id === bystander.playerId).connected,
    "a returning player is let back into their seat mid-match",
  );
  check(
    rewelcome.view.phase === live.view.phase || rewelcome.view.roundNumber >= 1,
    "and rejoins the match already in progress",
  );

  // --- persistence: a fresh object for a fresh code is genuinely fresh ----
  const other = await (await fetch(`${ORIGIN}/api/room`, { method: "POST" })).json();
  check(other.code !== code, "a second room gets a different code");

  a.close();
  back.close();

  console.log(failures === 0 ? "\nroom checks passed" : `\n${failures} room check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
