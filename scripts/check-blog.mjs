// Verifies the built blog against what the pages claim about themselves.
//
// The unit tests cover the renderer; this covers the *output*, which is what a
// crawler actually sees: every canonical points at the file it sits in, every
// internal link resolves to something that exists in dist/, the sitemap lists
// exactly the pages that were built, and nothing about the blog leaked into the
// offline app shell.
//
//   npm run build && node scripts/check-blog.mjs
//
// No server and no browser: it reads dist/ directly.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIST = resolve("dist");
let failures = 0;

function check(ok, label) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

if (!existsSync(DIST)) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}

/** Every file in dist, as a site-absolute path: "/blog/index.html". */
const files = new Set();
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.add("/" + relative(DIST, full).split("\\").join("/"));
  }
};
walk(DIST);

const pages = [...files].filter((path) => path.startsWith("/blog/") && path.endsWith("index.html"));

console.log(`\nblog pages: ${pages.length}`);
check(pages.length >= 2, "an index and at least one article were built");

const robots = readFileSync(join(DIST, "robots.txt"), "utf8");
const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
const origin = (/<loc>(https?:\/\/[^/]+)\//.exec(sitemap) ?? [])[1];

check(Boolean(origin), "the sitemap gives the site an absolute origin");
check(/^https:\/\//.test(origin ?? ""), "the site origin is https");

// A build for anything but the public domain must not ask to be indexed: two
// copies of the same articles at two addresses is how a site competes with
// itself. robots.txt and the pages have to say the same thing about it.
const indexable = readFileSync(join(DIST, "blog/index.html"), "utf8").includes(
  '<meta name="robots" content="index',
);
console.log(`\norigin: ${origin} — ${indexable ? "indexable" : "noindex (development)"}`);
check(
  indexable ? robots.includes("Allow: /") : robots.includes("Disallow: /"),
  "robots.txt agrees with the pages about being indexed",
);
check(
  indexable === readFileSync(join(DIST, "index.html"), "utf8").includes(
    '<meta name="robots" content="index',
  ),
  "the app page and the blog agree about being indexed",
);

// --- each page ------------------------------------------------------------

const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

for (const page of pages) {
  const url = page.replace(/index\.html$/, "");
  const html = readFileSync(join(DIST, page.slice(1)), "utf8");
  const label = (what) => `${url} — ${what}`;

  const title = (/<title>([^<]*)<\/title>/.exec(html) ?? [])[1] ?? "";
  const description = (/<meta name="description" content="([^"]*)"/.exec(html) ?? [])[1] ?? "";
  const canonical = (/<link rel="canonical" href="([^"]*)"/.exec(html) ?? [])[1] ?? "";

  check(html.startsWith("<!doctype html>\n<html lang=\"fr\">"), label("declares itself as French HTML"));
  check(title.length > 10 && title.length <= 65, label(`title is ${title.length} characters`));
  check(
    description.length >= 80 && description.length <= 165,
    label(`description is ${description.length} characters`),
  );
  check(canonical === `${origin}${url}`, label("canonical points at its own URL"));
  check((html.match(/<h1[ >]/g) ?? []).length === 1, label("has exactly one h1"));
  check(sitemapUrls.includes(canonical), label("is listed in the sitemap"));

  // Structured data has to parse; an invalid block is worse than none at all,
  // because it looks fine in the source and is silently dropped.
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  check(blocks.length === 1, label("carries exactly one JSON-LD block"));
  for (const [, json] of blocks) {
    try {
      const data = JSON.parse(json);
      const types = (data["@graph"] ?? [data]).map((node) => node["@type"]);
      check(types.length > 0, label(`structured data declares ${types.join(", ")}`));
    } catch (error) {
      check(false, label(`JSON-LD does not parse: ${error.message}`));
    }
  }

  // Conversion: an article that does not offer the game is a page that ranks
  // for someone else's benefit.
  check(html.includes('href="/?utm_source=blog'), label("links into the app"));

  // Every internal link must resolve to something that was actually built.
  for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
    const target = href.endsWith("/") ? `${href}index.html` : href;
    check(files.has(target), label(`links to ${href}`));
  }
}

// --- sitemap and the service worker --------------------------------------

for (const url of sitemapUrls) {
  const path = url.slice(origin.length);
  const target = path.endsWith("/") ? `${path}index.html` : path;
  check(files.has(target), `sitemap entry ${path} was built`);
}

const sw = readFileSync(join(DIST, "sw.js"), "utf8");
const shell = JSON.parse((/const SHELL = (\[[\s\S]*?\]);/.exec(sw) ?? [])[1] ?? "[]");
check(
  !shell.some((entry) => entry.includes("/blog/") || entry.includes("sitemap")),
  "the offline app shell does not precache the blog",
);
check(sw.includes('url.pathname.startsWith("/blog/")'), "the service worker leaves /blog/ alone");

// --- the app's own page ---------------------------------------------------

const home = readFileSync(join(DIST, "index.html"), "utf8");
check(home.includes(`<link rel="canonical" href="${origin}/">`), "the app page has a canonical");
check(home.includes('type="application/ld+json"'), "the app page carries structured data");
check(home.includes('href="/blog/"'), "the app page links to the blog");

if (failures > 0) {
  console.error(`\nBLOG PROBLEMS: ${failures}`);
  process.exit(1);
}
console.log(`\nblog checks passed (${origin})`);
