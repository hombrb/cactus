import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Rewrites dist/sw.js with the real emitted filenames.
 *
 * A service worker never controls the page that registered it, so the first
 * visit's asset requests bypass it entirely. Without an explicit precache list
 * the app would not work offline until the third launch.
 */
function precacheServiceWorker(): Plugin {
  return {
    name: "cactus-precache-sw",
    apply: "build",
    closeBundle() {
      const outDir = resolve("dist");
      const files: string[] = [];

      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else files.push("./" + relative(outDir, full).split("\\").join("/"));
        }
      };
      walk(outDir);

      const shell = files.filter((f) => f !== "./sw.js");
      shell.unshift("./");

      const swPath = join(outDir, "sw.js");
      const source = readFileSync(swPath, "utf8");
      const hash = createHash("sha256").update(shell.join("|")).digest("hex").slice(0, 8);

      const patched = source
        .replace(/const CACHE = "[^"]*";/, `const CACHE = "cactus-${hash}";`)
        .replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = ${JSON.stringify(shell)};`);

      writeFileSync(swPath, patched);
      this.info?.(`precached ${shell.length} files as cactus-${hash}`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [precacheServiceWorker()],
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main: "index.html",
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
