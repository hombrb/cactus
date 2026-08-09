import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/menu.css";
import "./styles/card.css";
import "./styles/board.css";
import { App } from "./ui/app";

const root = document.querySelector<HTMLElement>("#app");
if (root) new App(root);

// Offline app shell. Registered only in production: in dev it would serve stale
// modules back to Vite.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      // Offline support is a bonus; the game works without it.
    });
  });
}

/**
 * The phone lies flat on the table for a whole round, untouched for minutes at
 * a time. Keeping the screen awake is worth the request. Available on iOS 18.4+
 * and Chrome; absent elsewhere, in which case nothing happens.
 */
async function keepAwake(): Promise<void> {
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
  };
  if (!nav.wakeLock) return;

  let sentinel: { release(): Promise<void> } | null = null;
  const acquire = async () => {
    try {
      sentinel = await nav.wakeLock!.request("screen");
    } catch {
      sentinel = null;
    }
  };

  await acquire();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && sentinel === null) void acquire();
  });
}

void keepAwake();
