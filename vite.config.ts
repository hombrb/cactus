import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import { buildBlog, siteUrl, type SourceFile } from "./src/blog/build";
import type { Site } from "./src/blog/page";

const CONTENT_DIR = resolve("content/blog");
const BLOG_CSS = resolve("src/blog/blog.css");

/** Anything the blog owns. The service worker leaves all of it alone — see below. */
const isBlogFile = (path: string): boolean =>
  path.startsWith("./blog/") || path === "./sitemap.xml" || path === "./robots.txt";

function readArticles(): SourceFile[] {
  return readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(CONTENT_DIR, name), "utf8") }));
}

function site(): Site {
  // Comments are for whoever edits blog.css, not for the six pages that inline
  // it — they are stripped on the way out.
  const css = readFileSync(BLOG_CSS, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { url: siteUrl(process.env.SITE_URL), css };
}

/**
 * Renders content/blog/*.md into static pages, plus sitemap.xml and robots.txt.
 *
 * They are emitted as build assets rather than written afterwards so Vite owns
 * the output directory, and pre-rendered rather than routed in the app because
 * the point of the exercise is a page a crawler can read without running any
 * JavaScript — which is also the fastest page for the reader it is meant to
 * convert.
 *
 * The dev server renders the same files on the fly, so `npm run dev` has a
 * working /blog/ and an edited article is one refresh away.
 */
function blog(): Plugin {
  const generate = () => buildBlog(readArticles(), site());

  return {
    name: "cactus-blog",

    generateBundle() {
      for (const file of generate()) {
        this.emitFile({ type: "asset", fileName: file.path, source: file.body });
      }
    },

    /**
     * The app's own page gets the tags that need to know the deploy origin, so
     * that index.html never hard-codes a domain and the blog and the game can
     * never disagree about where the site lives.
     */
    transformIndexHtml() {
      const url = siteUrl(process.env.SITE_URL);
      const game = {
        "@context": "https://schema.org",
        "@type": "VideoGame",
        name: "Cactus",
        alternateName: ["Dutch", "Tamalou", "Cabo", "Pablo"],
        url: `${url}/`,
        description:
          "Le jeu de cartes Cactus, à deux sur un seul téléphone ou à distance. Gratuit, sans compte, jouable hors ligne.",
        inLanguage: "fr-FR",
        applicationCategory: "GameApplication",
        gamePlatform: ["Web", "Android", "iOS"],
        numberOfPlayers: { "@type": "QuantitativeValue", minValue: 2, maxValue: 2 },
        image: `${url}/icons/icon-512.png`,
        offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      };

      return [
        { tag: "link", attrs: { rel: "canonical", href: `${url}/` }, injectTo: "head" as const },
        {
          tag: "meta",
          attrs: { property: "og:url", content: `${url}/` },
          injectTo: "head" as const,
        },
        {
          tag: "meta",
          attrs: { property: "og:image", content: `${url}/icons/icon-512.png` },
          injectTo: "head" as const,
        },
        {
          tag: "script",
          attrs: { type: "application/ld+json" },
          children: JSON.stringify(game, null, 2).replace(/</g, "\\u003c"),
          injectTo: "head" as const,
        },
      ];
    },

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "/").split("?")[0] ?? "/";

        // /blog/regles → /blog/regles/ : the pages are directories, and a
        // missing slash would break every relative link on them.
        if (/^\/blog\/[^/]+$/.test(path)) {
          response.writeHead(301, { location: `${path}/` });
          response.end();
          return;
        }

        const wanted = path === "/blog/" ? "blog/index.html" : path.replace(/^\//, "");
        const file = generate().find(
          (candidate) => candidate.path === wanted || candidate.path === `${wanted}index.html`,
        );
        if (!file) return next();

        const type = file.path.endsWith(".xml")
          ? "application/xml"
          : file.path.endsWith(".txt")
            ? "text/plain"
            : "text/html";
        response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
        response.end(file.body);
      });
    },
  };
}

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

      // The blog is deliberately not part of the app shell. It is content, not
      // the game: precaching it would put every article in the offline cache of
      // a player who never opened one, and every new article would invalidate
      // the cache of the game itself.
      const shell = files.filter((f) => f !== "./sw.js" && !isBlogFile(f));
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
  plugins: [blog(), precacheServiceWorker()],
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
