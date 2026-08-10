// Two devices, one room, driven through the real UI.
//
// scripts/check-room.mjs proves the authority over raw sockets. This proves the
// part a player actually touches: create a room, read the code aloud, join it
// from a second phone, start, and see the board agree on both. Two browser
// contexts means two localStorages, so two genuinely different identities.
//
//   npx wrangler dev --port 8787 --local &
//   node scripts/check-lobby.mjs

import { chromium } from "playwright";

const ORIGIN = process.env.ROOM_ORIGIN ?? "http://localhost:8787";
const PHONE = { width: 390, height: 844 };

let failures = 0;

function check(ok, label) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

async function phone(settings) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    // Cards fly between the piles and the players. Every width and visibility
    // assertion below wants the board settled, so ask for the app's own
    // no-motion mode rather than sleeping past each animation.
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    console.error(`  FAIL page error: ${error.message}`);
    failures += 1;
  });
  // Chosen rules normally come from the Réglages screens; a phone that needs a
  // specific ruleset writes them straight into the store the screens use.
  if (settings) {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      ["cactus.settings.v1", JSON.stringify(settings)],
    );
  }
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  return page;
}

/** Geometry of one half, as the player sees it. */
function halfInfo(page, seat) {
  return page.evaluate((which) => {
    const half = document.querySelector(`.half[data-seat="${which}"]`);
    const rotor = half.querySelector(".rotor");
    const cards = [...half.querySelectorAll(".card--slot")];
    return {
      name: half.querySelector(".plate__name").textContent,
      rotated: getComputedStyle(rotor).transform !== "none",
      count: cards.length,
      faces: cards.map((c) => c.dataset.face),
      minWidth: Math.min(...cards.map((c) => c.getBoundingClientRect().width)),
      trayVisible: getComputedStyle(half.querySelector(".tray")).display !== "none",
      prompt: half.querySelector(".tray__prompt").textContent,
    };
  }, seat);
}

const ALL_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

/**
 * A power aimed at the opponent's half, from a phone that holds one seat.
 *
 * The regression this exists for: every slot gesture used to be gated on "is this
 * half mine", so in a room the opponent's cards accepted no input at all.
 * `PEEK_OPPONENT` (docs/06 §4) would sit there with the prompt "Regarde une carte
 * adverse" and nothing to tap, until the 45-second turn clock skipped it. Neither
 * `check-room` nor the flat-table screenshots could see it: the authority was
 * always willing, and the flat table owns both halves.
 *
 * Its own pair of phones and its own room, because it needs every rank to be that
 * power — a choice the host is allowed to make, and the only way to be
 * deterministic about a deal the server seeds.
 */
async function checkOpponentPower() {
  const powers = Object.fromEntries(ALL_RANKS.map((rank) => [rank, "PEEK_OPPONENT"]));
  const settings = {
    preset: "standard",
    snap: false,
    names: ["Joueur 1", "Joueur 2"],
    scoreLimit: 100,
    powers,
    seedDiscard: true,
    takeFromDiscard: true,
  };
  const host = await phone(settings);
  const guest = await phone();

  await host.getByRole("button", { name: "Jouer à plusieurs" }).click();
  await host.fill('input[name="name"]', "Hôte");
  await host.getByRole("button", { name: "Créer une partie" }).click();
  await host.waitForSelector(".lobby__code:not(:empty)", { timeout: 10000 });
  const roomCode = (await host.textContent(".lobby__code")).trim();

  await guest.getByRole("button", { name: "Jouer à plusieurs" }).click();
  await guest.fill('input[name="name"]', "Invité");
  await guest.fill('input[name="code"]', roomCode);
  await guest.getByRole("button", { name: "Rejoindre" }).click();
  await guest.waitForSelector(".lobby__code:not(:empty)", { timeout: 10000 });

  await host.waitForFunction(() => document.querySelectorAll(".lobby__player").length === 2, {
    timeout: 10000,
  });
  await host.getByRole("button", { name: "Démarrer" }).click();
  for (const page of [host, guest]) {
    await page.waitForSelector(".board", { timeout: 10000 });
    await page.getByRole("button", { name: "Prêt sans regarder" }).first().click();
  }

  const prompt = (page) =>
    page.evaluate(
      () => document.querySelector('.half[data-seat="bottom"] .tray__prompt').textContent ?? "",
    );
  await host.waitForTimeout(400);
  const hostPlays = (await prompt(host)).includes("Pioche");
  const player = hostPlays ? host : guest;
  const other = hostPlays ? guest : host;

  // Draw, then throw it away — which is the only thing that fires a power.
  await player.locator(".pile--stock").click();
  await player.waitForTimeout(200);
  await player.getByRole("button", { name: "Défausser" }).click();
  await player.waitForFunction(
    () => (document.querySelector('.half[data-seat="bottom"] .tray__prompt').textContent ?? "")
      .includes("adverse"),
    { timeout: 5000 },
  );
  check(true, "a discard fires a power that has to be aimed at the opponent");

  const targets = await player.evaluate(
    () => document.querySelectorAll('.half[data-seat="top"] .card--slot[data-target="1"]').length,
  );
  check(targets > 0, `the opponent's cards are offered as targets (${targets} of them)`);
  check(
    (await player.evaluate(
      () => document.querySelectorAll('.half[data-seat="bottom"] .card--slot[data-target="1"]').length,
    )) === 0,
    "and the player's own are not",
  );

  await player.locator('.half[data-seat="top"] .card--slot[data-slot="1"]').click();
  await player.waitForTimeout(300);

  // The card is shown at the actor's own edge, where a hand can shield it —
  // never lit up in the opponent's half (docs/10 §6 rule 1).
  const tray = await player.evaluate(() => {
    const card = document.querySelector('.half[data-seat="bottom"] .card--tray');
    return { hidden: card.hidden, face: card.dataset.face, grant: card.dataset.grant };
  });
  check(tray.hidden === false, "the reveal is offered in the actor's own tray");

  await player.locator('.half[data-seat="bottom"] .card--tray').hover();
  await player.mouse.down();
  await player.waitForTimeout(500);
  const looking = await player.evaluate(
    () => document.querySelector('.half[data-seat="bottom"] .card--tray').dataset.face,
  );
  await player.mouse.up();
  check(looking === "face", "holding it down shows the opponent's card");

  const leaked = await other.evaluate(() =>
    [...document.querySelectorAll(".card--slot, .card--tray")]
      .filter((c) => !c.hidden)
      .map((c) => c.dataset.face),
  );
  check(!leaked.includes("face"), "the other phone is shown no face at all");

  // --- the turn ends by itself, and Cactus outlives it --------------------
  // Nobody pressed anything: the power resolved and the turn passed on. The
  // player who just played keeps the offer for as long as the other one takes
  // (docs/01 §7).
  await player.waitForTimeout(600);
  const passed = await player.evaluate(
    () => document.querySelector('.half[data-seat="bottom"] .tray__prompt').textContent ?? "",
  );
  check(passed.includes("Au tour de"), "the turn ends without a button");
  check(
    (await player.getByRole("button", { name: "Cactus !" }).count()) > 0,
    "and the player who just played can still say Cactus",
  );
  check(
    (await other.getByRole("button", { name: "Cactus !" }).count()) === 0,
    "while the one now playing cannot — they have not played yet this window",
  );

  await player.getByRole("button", { name: "Cactus !" }).first().click();
  await other.waitForTimeout(500);
  const announced = await other.evaluate(
    () => document.querySelector('.half[data-seat="top"] .plate__name').textContent ?? "",
  );
  check(announced.includes("cactus"), "the other phone is told, on the announcer's plate");

  await host.context().close();
  await guest.context().close();
}

const alice = await phone();
const bob = await phone();

// --- the host picks rules that are not a preset ---------------------------
// The room is minted from the host's own settings, so a variant chosen here has
// to reach the guest's phone — otherwise Bob plays rules he was never told.
await alice.getByRole("button", { name: "Réglages" }).click();
await alice.locator('[data-act="powers"]').click();
await alice.locator('[data-starter="seven-jack"]').click();
await alice.locator('[data-act="back"]').click(); // → Réglages
await alice.locator('[data-act="back"]').click(); // → menu

// --- create ---------------------------------------------------------------
await alice.getByRole("button", { name: "Jouer à plusieurs" }).click();
await alice.fill('input[name="name"]', "Alice");
await alice.getByRole("button", { name: "Créer une partie" }).click();

await alice.waitForSelector(".lobby__code:not(:empty)", { timeout: 10000 });
const code = (await alice.textContent(".lobby__code")).trim();
check(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code), `host gets a legible code (${code})`);
check(
  (await alice.locator(".lobby__player").allTextContents()).includes("Alice"),
  "host appears in the player list",
);
check(
  await alice.getByRole("button", { name: "Démarrer" }).isDisabled(),
  "start is refused while the host is alone",
);

// --- a wrong code is refused ----------------------------------------------
await bob.getByRole("button", { name: "Jouer à plusieurs" }).click();
await bob.fill('input[name="name"]', "Bob");
await bob.fill('input[name="code"]', "ZZZZZZ");
await bob.getByRole("button", { name: "Rejoindre" }).click();
await bob.waitForSelector('[data-role="error"]:not([hidden])', { timeout: 10000 });
check(true, "an uncreated code is refused instead of opening an empty room");

// --- join -----------------------------------------------------------------
await bob.fill('input[name="code"]', code.toLowerCase()); // codes are case-insensitive
await bob.getByRole("button", { name: "Rejoindre" }).click();
await bob.waitForSelector(".lobby__code:not(:empty)", { timeout: 10000 });
check(true, "the second phone joins by code, typed in lower case");

await alice.waitForFunction(() => document.querySelectorAll(".lobby__player").length === 2, {
  timeout: 10000,
});
const names = await alice.locator(".lobby__player").allTextContents();
check(names.some((n) => n.includes("Bob")), "the host sees the guest arrive");
check(
  await alice.getByRole("button", { name: "Démarrer" }).isEnabled(),
  "start unlocks once two players are in",
);

const aliceRules = await alice.locator(".lobby__rules li").allTextContents();
const bobRules = await bob.locator(".lobby__rules li").allTextContents();
check(
  aliceRules.some((c) => c === "Pouvoirs : 7 · Valet"),
  "the host's chosen powers are named in the lobby",
);
check(
  JSON.stringify(bobRules) === JSON.stringify(aliceRules),
  `the guest is told the same rules (${bobRules.join(", ")})`,
);
check(
  (await bob.getByRole("button", { name: "Démarrer" }).count()) === 0,
  "only the host is offered the start button",
);

// --- start ----------------------------------------------------------------
await alice.getByRole("button", { name: "Démarrer" }).click();
await alice.waitForSelector(".board", { timeout: 10000 });
await bob.waitForSelector(".board", { timeout: 10000 });
check(true, "both phones land on the board");

const aliceBottom = await halfInfo(alice, "bottom");
const aliceTop = await halfInfo(alice, "top");
const bobBottom = await halfInfo(bob, "bottom");

check(aliceBottom.name.includes("Alice"), "Alice sees herself at the bottom");
check(bobBottom.name.includes("Bob"), "Bob sees himself at the bottom");
check(aliceTop.name.includes("Bob"), "and the opponent across the table");

check(!aliceTop.rotated, "the far half is NOT rotated online");
check(!aliceTop.trayVisible, "the far half has no tray to leak a private card");
check(aliceTop.faces.every((f) => f === "back"), "every opponent card is face down");

// The iOS collapse would show up here too — this is the remote layout, which
// the flat-table screenshots never exercise.
check(aliceBottom.minWidth > 40, `own cards have real width (${aliceBottom.minWidth.toFixed(1)}px)`);
check(aliceTop.minWidth > 40, `opponent cards have real width (${aliceTop.minWidth.toFixed(1)}px)`);

// --- play a turn ----------------------------------------------------------
for (const page of [alice, bob]) {
  await page.getByRole("button", { name: "Prêt sans regarder" }).first().click();
}

await alice.waitForFunction(
  () => document.querySelector('.half[data-seat="bottom"] .tray__prompt').textContent !== "" ||
        document.querySelector('.half[data-seat="top"]') !== null,
  { timeout: 10000 },
);
await alice.waitForTimeout(300);

const aliceTurn = (await halfInfo(alice, "bottom")).prompt.includes("Pioche");
const actor = aliceTurn ? alice : bob;
const watcher = aliceTurn ? bob : alice;
check(
  aliceTurn !== (await halfInfo(bob, "bottom")).prompt.includes("Pioche"),
  "exactly one of the two is told to play",
);

await actor.locator(".pile--stock").click();
await watcher.waitForFunction(
  () => document.querySelector('.half[data-seat="top"] .plate__name') !== null,
  { timeout: 5000 },
);
await watcher.waitForTimeout(400);

const actorTray = await actor.evaluate(
  () => document.querySelector('.half[data-seat="bottom"] .card--tray').hidden,
);
check(actorTray === false, "the drawing player gets the card in their own tray");

const watcherSees = await watcher.evaluate(() => {
  const trays = [...document.querySelectorAll(".card--tray")].filter((c) => !c.hidden);
  return trays.map((c) => c.dataset.face);
});
check(
  watcherSees.every((face) => face !== "face"),
  "the other phone never renders the drawn card face up",
);

const actorTrayFace = await actor.evaluate(
  () => document.querySelector('.half[data-seat="bottom"] .card--tray').dataset.face,
);
check(actorTrayFace === "face", "and gets to read it without a second gesture");

await checkOpponentPower();

await browser.close();
console.log(failures === 0 ? "\nlobby checks passed" : `\n${failures} lobby check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
