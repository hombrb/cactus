// From a directory of markdown files to the list of files the deploy needs.
//
// Pure: it takes the sources it is given and returns paths and bodies, so the
// same function serves the build, the dev server and `npm run check:blog`,
// and none of them can generate a different blog from the others.

import { byDateDesc, parseArticle, type Article } from "./content";
import {
  articlePath,
  renderArticlePage,
  renderIndexPage,
  renderRobots,
  renderSitemap,
  type Site,
} from "./page";

/**
 * Where the pages think they live.
 *
 * The default is the workers.dev subdomain the app is deployed to today; the
 * public site will be `PRODUCTION_URL` (src/blog/page.ts), and getting there is
 * one environment variable:
 *
 *   SITE_URL=https://playcactus.co npm run build
 *
 * It matters more than it looks. Canonicals and the sitemap are absolute URLs,
 * so this is the value that decides which address the pages claim to live at —
 * and, since only the production origin is emitted as indexable, whether they
 * ask to be indexed at all.
 */
export const DEFAULT_SITE_URL = "https://cactus.goats-wiser-9h.workers.dev";

export function siteUrl(configured: string | undefined): string {
  const url = (configured ?? "").trim() || DEFAULT_SITE_URL;
  return url.replace(/\/+$/, "");
}

export interface SourceFile {
  /** The file's basename, which is the slug unless the front matter says otherwise. */
  readonly name: string;
  readonly source: string;
}

export interface GeneratedFile {
  /** Relative to the site root: "blog/index.html", "sitemap.xml". */
  readonly path: string;
  readonly body: string;
}

const REQUIRED = ["title", "description", "lead", "published"] as const;

/**
 * An article missing its description would still build, and would still be
 * indexed — badly, and silently, which is the worst of the three. So the build
 * fails instead.
 */
function check(articles: readonly Article[]): void {
  const seen = new Set<string>();
  for (const article of articles) {
    for (const field of REQUIRED) {
      if (article[field].trim() === "") {
        throw new Error(`blog: "${article.slug}" has no ${field} in its front matter`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(article.published)) {
      throw new Error(`blog: "${article.slug}" has a published date that is not YYYY-MM-DD`);
    }
    if (seen.has(article.slug)) throw new Error(`blog: two articles claim the slug "${article.slug}"`);
    seen.add(article.slug);
  }
}

export function buildBlog(files: readonly SourceFile[], site: Site): GeneratedFile[] {
  const articles = byDateDesc(files.map((file) => parseArticle(file.name, file.source)));
  check(articles);

  return [
    { path: "blog/index.html", body: renderIndexPage(articles, site) },
    ...articles.map((article) => ({
      // `/blog/<slug>/index.html` rather than `/blog/<slug>.html`: the URL then
      // has no extension, which is what the canonical, the sitemap and every
      // link in the articles assume.
      path: `${articlePath(article.slug).replace(/^\//, "")}index.html`,
      body: renderArticlePage(article, articles, site),
    })),
    { path: "sitemap.xml", body: renderSitemap(articles, site) },
    { path: "robots.txt", body: renderRobots(site) },
  ];
}
