// Renders scripts/icon.svg to the PNG sizes iOS and Android need.
// Uses the preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers).
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, "icon.svg"), "utf8");
const outDir = resolve(here, "../public/icons");
mkdirSync(outDir, { recursive: true });

// maskable icons need their content inside the safe zone (inner 80% circle),
// so the same artwork is drawn scaled down on a full-bleed background.
const targets = [
  { file: "apple-touch-icon-180.png", size: 180, scale: 1 },
  { file: "icon-192.png", size: 192, scale: 1 },
  { file: "icon-512.png", size: 512, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, scale: 0.72 },
];

// The preinstalled browser build may not match this playwright version's
// expected revision, so point at it explicitly instead of downloading one.
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
for (const { file, size, scale } of targets) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>
       html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
       .bg{width:${size}px;height:${size}px;background:#0c2c20;
           display:flex;align-items:center;justify-content:center}
       .art{width:${Math.round(size * scale)}px;height:${Math.round(size * scale)}px}
       svg{width:100%;height:100%;display:block}
     </style>
     <div class="bg"><div class="art">${svg}</div></div>`,
    { waitUntil: "load" },
  );
  await page.screenshot({ path: resolve(outDir, file), omitBackground: false });
  await page.close();
  console.log(`wrote ${file} (${size}px)`);
}
await browser.close();
