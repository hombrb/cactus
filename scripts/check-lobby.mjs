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

async function phone() {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    console.error(`  FAIL page error: ${error.message}`);
    failures += 1;
  });
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

const alice = await phone();
const bob = await phone();

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

await browser.close();
console.log(failures === 0 ? "\nlobby checks passed" : `\n${failures} lobby check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
