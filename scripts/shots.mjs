// Drives the built app in a real browser at iPhone size and screenshots the
// flow. Also asserts the board never scrolls and never overflows sideways.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/shots.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../shots");
mkdirSync(outDir, { recursive: true });

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const VIEWPORT = { width: 390, height: 844 }; // iPhone 14/15 logical size

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  // Cards fly between the piles and the players, and a card caught mid-flight is
  // a different screenshot every run. Reduced motion is the app's own switch for
  // that — tokens.css zeroes every duration, including the two the flight layer
  // reads — so this asks for a configuration the app already supports rather
  // than a test-only one. `?motion=off` below says the same thing twice.
  reducedMotion: "reduce",
});
const page = await context.newPage();

const failures = [];
let shotIndex = 0;

async function shot(name) {
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: resolve(outDir, file) });

  const overflow = await page.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  // Sheets (rules/settings) scroll on purpose; the board must not.
  const isSheet = (await page.locator(".screen--sheet").count()) > 0;
  if (!isSheet && overflow.scrollH > overflow.clientH + 1) {
    failures.push(`${file}: page scrolls vertically (${overflow.scrollH} > ${overflow.clientH})`);
  }
  if (overflow.scrollW > overflow.clientW + 1) {
    failures.push(`${file}: page overflows horizontally (${overflow.scrollW} > ${overflow.clientW})`);
  }

  // `overflow: hidden` on the board means the scroll checks above cannot see a
  // clipped card — so measure the cards themselves against the viewport.
  const clipped = await page.evaluate((vh) => {
    const out = [];
    for (const el of document.querySelectorAll(".card--slot, .card--pile")) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.top < -0.5 || r.bottom > vh + 0.5) {
        out.push(`${el.className} top=${Math.round(r.top)} bottom=${Math.round(r.bottom)}`);
      }
    }
    return out;
  }, VIEWPORT.height);
  for (const c of clipped) failures.push(`${file}: card clipped — ${c}`);

  console.log(`shot ${file}${clipped.length ? " ⚠" : ""}`);
}

const half = (seat) => page.locator(`.half[data-seat="${seat}"]`);
const slot = (seat, i) => half(seat).locator(`.card--slot[data-slot="${i}"]`);

async function longPress(locator, ms = 700) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
}

async function release() {
  await page.mouse.up();
  await page.waitForTimeout(80);
}

async function swipeInward(locator, seat) {
  const box = await locator.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dy = seat === "top" ? 60 : -60;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dy / 2, { steps: 4 });
  await page.mouse.move(cx, cy + dy, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

const phase = () =>
  page.evaluate(() => document.querySelector(".half .tray__prompt")?.textContent ?? "");

/**
 * Long enough for the board to end the turn by itself. Reduced motion zeroes the
 * flights but not this: it is a handover pause, not an animation.
 */
const settleTurn = () => page.waitForTimeout(450);

const promptIn = async (seat) =>
  (await half(seat).locator(".tray__prompt").textContent()) ?? "";

/** Press a button by name if it is on screen, and say whether it was. */
async function clickIfOffered(name) {
  const button = page.getByRole("button", { name });
  if ((await button.count()) === 0) return false;
  await button.first().click();
  await page.waitForTimeout(80);
  return true;
}

/**
 * Draw, throw it away, resolve whatever that fires, and let the turn pass.
 *
 * Buttons only, so it works from either half: the piles are shared and the board
 * dispatches as whoever's turn it is.
 */
async function playATurn() {
  const stock = page.locator(".pile--stock[data-live]");
  if ((await stock.count()) === 0) return false;
  await stock.click();
  await page.waitForTimeout(80);
  await clickIfOffered("Défausser");
  await clickIfOffered("Passer");
  await clickIfOffered("Laisser");
  await settleTurn();
  return true;
}

// ---------------------------------------------------------------------------

await page.goto(`${BASE}/?seed=s4&motion=off`, { waitUntil: "networkidle" });
await shot("menu");

await page.getByRole("button", { name: "Règles" }).click();
await page.waitForTimeout(150);
await shot("rules");
await page.locator('[data-act="back"]').click();

await page.getByRole("button", { name: "Réglages" }).click();
await page.waitForTimeout(150);
await shot("settings");

// The powers editor, and the proof that matters: the Règles screen is derived
// from the config, so choosing a variant has to rewrite it. Hand-written rules
// text would sail through this.
await page.locator('[data-act="powers"]').click();
await page.waitForTimeout(150);
await shot("powers");

await page.locator('[data-starter="seven-jack"]').click();
await page.waitForTimeout(100);
await page.locator('[data-act="back"]').click(); // → Réglages
await page.waitForTimeout(100);
await page.locator('[data-act="back"]').click(); // → menu
await page.getByRole("button", { name: "Règles" }).click();
await page.waitForTimeout(150);
await shot("rules-seven-jack");

const listed = await page.evaluate(() => {
  const sections = [...document.querySelectorAll(".prose section")];
  const powers = sections.find((s) => s.querySelector("h3")?.textContent === "Pouvoirs");
  return powers?.textContent ?? "";
});
if (!listed.includes("Valet") || listed.includes("Dame") || listed.includes("Roi noir")) {
  failures.push(`rules text did not follow the chosen powers: ${listed.replace(/\s+/g, " ").trim()}`);
} else {
  console.log("rules text follows the chosen powers");
}

// Back to the preset, or every shot below would be of a different game.
await page.locator('[data-act="back"]').click();
await page.getByRole("button", { name: "Réglages" }).click();
await page.waitForTimeout(150);
await page.locator('[data-act="powers"]').click();
await page.waitForTimeout(150);
await page.locator('[data-act="clear"]').click(); // → Réglages
await page.waitForTimeout(100);
await page.locator('[data-act="back"]').click();

await page.getByRole("button", { name: "Jouer sur ce téléphone" }).click();
await page.waitForTimeout(200);
await shot("initial-peek");

// Player 1 holds a card down: it must appear in the bottom half only.
await longPress(slot("bottom", 0));
await shot("peek-p1-holding");
await release();
await shot("peek-p1-released");

// Player 2 takes their peek too, which releases the barrier.
await longPress(slot("top", 0));
await release();
await longPress(slot("top", 1));
await release();
await page.waitForTimeout(120);
await shot("turn-start");

// Draw — the card lands face up in the private row at the player's own edge —
// then discard it to trigger the 9/10 power. A tap on it hides it again, which is
// the escape hatch when the other player leans over.
await page.locator(".pile--stock").click();
await page.waitForTimeout(120);
await shot("held-visible");

await half("bottom").locator(".card--tray").click();
await page.waitForTimeout(150);
await shot("held-hidden");

await half("bottom").locator(".card--tray").click();
await page.waitForTimeout(150);

await page.getByRole("button", { name: "Défausser" }).click();
await page.waitForTimeout(150);
await shot("power-targeting");

// Target an opponent card: the face must appear in the ACTOR's tray, never in
// the opponent's half.
await slot("top", 2).click();
await page.waitForTimeout(150);
await longPress(half("bottom").locator(".card--tray"));
await shot("power-reveal-in-own-tray");
await release();

// The turn ends by itself — there is no button to press — and the offer to say
// "Cactus" comes with the player into the opponent's turn, until the opponent
// finishes theirs (docs/01 §7).
await settleTurn();
const handedOver = (await half("bottom").locator(".tray__prompt").textContent()).includes(
  "Au tour de",
);
const stillOffered =
  (await half("bottom").getByRole("button", { name: "Cactus !" }).count()) > 0;
if (!handedOver) failures.push("the turn did not end by itself");
if (!stillOffered) failures.push("Cactus is not offered after the turn has passed");
await shot("cactus-after-your-turn");

// A snap attempt: swipe a bottom-half card toward the middle. Under `?seed=s4`
// this one is a guaranteed *failure* — the bottom player's fourth card is a 3 and
// the discard is the card they have just thrown away — so it costs a penalty card
// and the layout grows from four to five. That is asserted rather than tolerated,
// because the growth is the setup for the check below it.

const slotsBefore = await half("bottom").locator(".card--slot").count();
const emptyBefore = await half("bottom").locator('.card--slot[data-face="empty"]').count();
await swipeInward(slot("bottom", 3), "bottom");
const slotsAfter = await half("bottom").locator(".card--slot").count();
const emptyAfter = await half("bottom").locator('.card--slot[data-face="empty"]').count();

if (slotsAfter !== slotsBefore + 1 || emptyAfter !== emptyBefore) {
  failures.push(
    `the failed snap should have cost one penalty card (slots ${slotsBefore}→${slotsAfter}, empty ${emptyBefore}→${emptyAfter})`,
  );
} else {
  console.log(`snap wired: slots ${slotsBefore}→${slotsAfter}, empty ${emptyBefore}→${emptyAfter}`);
}
await shot("after-snap-attempt");

// --- and the grown layout must still answer the finger -------------------
//
// Every slot node was just rebuilt to make room for the penalty card. Wiring them
// used to read each element back out of the array the same expression was still
// building, so the four originals bound their gestures to the four cards that had
// just been thrown away — and the half accepted no tap, no hold and no placement
// for the rest of the match. It stayed green for a year because nothing below this
// line ever tapped a card again; only buttons.
for (let i = 0; i < 6 && !(await promptIn("bottom")).includes("Pioche"); i++) {
  if (!(await playATurn())) break;
}

if ((await promptIn("bottom")).includes("Pioche")) {
  await page.locator(".pile--stock[data-live]").click();
  await page.waitForTimeout(120);
  await slot("bottom", 0).click();
  await page.waitForTimeout(150);
  const answered = !(await promptIn("bottom")).includes("Pose-la");
  if (!answered) {
    failures.push("a slot stopped accepting taps after the layout grew");
  } else {
    console.log("the grown layout still takes a tap");
  }
  await settleTurn();
} else {
  failures.push("could not get back to the bottom player's turn to tap a grown layout");
}

console.log("phase prompt:", await phase());

// Play the round out quickly, then announce, to reach the reveal.
for (let i = 0; i < 40; i++) {
  const stock = page.locator(".pile--stock[data-live]");
  if ((await stock.count()) > 0) {
    await stock.click();
    await page.waitForTimeout(60);
    const discard = page.getByRole("button", { name: "Défausser" });
    if ((await discard.count()) > 0) {
      await discard.first().click();
      await page.waitForTimeout(60);
    }
  }
  const skip = page.getByRole("button", { name: "Passer" });
  if ((await skip.count()) > 0) {
    await skip.first().click();
    await page.waitForTimeout(60);
  }
  const leave = page.getByRole("button", { name: "Laisser" });
  if ((await leave.count()) > 0) {
    await leave.first().click();
    await page.waitForTimeout(60);
  }
  const cactus = page.getByRole("button", { name: "Cactus !" });
  if (i >= 3 && (await cactus.count()) > 0) {
    await cactus.first().click();
    await page.waitForTimeout(120);
    continue;
  }
  // Present only under the strict `END_OF_TURN` rule; otherwise the turn has
  // already passed on its own by the time the loop comes round again.
  const finish = page.getByRole("button", { name: "Terminer" });
  if ((await finish.count()) > 0) {
    await finish.first().click();
    await page.waitForTimeout(60);
  }
  await settleTurn();
  if ((await page.getByRole("button", { name: "Manche suivante" }).count()) > 0) break;
}
await shot("reveal-and-scores");

await browser.close();

if (failures.length > 0) {
  console.error("\nLAYOUT FAILURES:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("\nno layout failures");
