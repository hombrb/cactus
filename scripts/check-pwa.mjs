// Verifies the installable/offline claims against the built bundle:
// manifest parses, icons resolve, the service worker registers, and a second
// load succeeds with the network cut.

import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const problems = [];

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

await page.goto(BASE, { waitUntil: "networkidle" });

// --- manifest -------------------------------------------------------------
const manifestHref = await page.getAttribute('link[rel="manifest"]', "href");
if (!manifestHref) problems.push("no <link rel=manifest>");

const manifest = await page.evaluate(async (href) => {
  const res = await fetch(href);
  if (!res.ok) return { error: res.status };
  return res.json();
}, manifestHref);

if (manifest.error) problems.push(`manifest fetch failed: ${manifest.error}`);
else {
  if (manifest.display !== "standalone") problems.push(`display is ${manifest.display}`);
  if (manifest.orientation !== "portrait") problems.push(`orientation is ${manifest.orientation}`);
  if (!manifest.icons?.some((i) => i.purpose === "maskable")) problems.push("no maskable icon");
  for (const icon of manifest.icons ?? []) {
    const ok = await page.evaluate(async (src) => (await fetch(src)).ok, icon.src);
    if (!ok) problems.push(`icon missing: ${icon.src}`);
  }
}

// --- iOS meta tags --------------------------------------------------------
for (const name of [
  "apple-mobile-web-app-capable",
  "mobile-web-app-capable",
  "apple-mobile-web-app-status-bar-style",
  "theme-color",
]) {
  const content = await page.getAttribute(`meta[name="${name}"]`, "content");
  if (!content) problems.push(`missing meta ${name}`);
}
const viewport = await page.getAttribute('meta[name="viewport"]', "content");
if (!viewport?.includes("viewport-fit=cover")) problems.push("viewport lacks viewport-fit=cover");
const touchIcon = await page.getAttribute('link[rel="apple-touch-icon"]', "href");
if (!touchIcon) problems.push("no apple-touch-icon");

// --- service worker + offline --------------------------------------------
const registered = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  return Boolean(reg?.active);
});
if (!registered) problems.push("service worker did not activate");

await page.waitForTimeout(600); // let the shell finish caching
await context.setOffline(true);
const offlinePage = await context.newPage();
try {
  await offlinePage.goto(BASE, { waitUntil: "domcontentloaded", timeout: 8000 });
  const playable = await offlinePage.getByRole("button", { name: "Jouer" }).count();
  if (playable === 0) problems.push("offline load rendered no menu");
  else console.log("offline reload: menu rendered");
} catch (e) {
  problems.push(`offline load failed: ${e.message.split("\n")[0]}`);
}
await context.setOffline(false);

await browser.close();

if (problems.length > 0) {
  console.error("\nPWA PROBLEMS:");
  for (const p of problems) console.error(" - " + p);
  process.exit(1);
}
console.log("\nPWA checks passed");
