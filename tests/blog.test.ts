// The blog generator, and the articles themselves.
//
// Two kinds of test live here on purpose. The first half covers the renderer —
// a markdown subset written by hand is exactly the sort of code that quietly
// starts emitting broken HTML. The second half covers content/blog/*.md: a
// missing description or a link to an article that no longer exists is not a
// crash, it is a page that ranks badly and nobody notices for a month.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBlog, siteUrl, type SourceFile } from "../src/blog/build";
import { extractFaq, formatDate, parseArticle, parseFrontMatter } from "../src/blog/content";
import { renderInline, renderMarkdown, slugify } from "../src/blog/markdown";
import { renderArticlePage, renderSitemap, type Site } from "../src/blog/page";

const SITE: Site = { url: "https://example.test", css: "/*css*/" };

const article = (over: Partial<Record<string, string>> = {}, body = "## Un titre\n\nDu texte.") =>
  [
    "---",
    `title: ${over.title ?? "Un article"}`,
    `description: ${over.description ?? "Une description."}`,
    `lead: ${over.lead ?? "Un chapeau."}`,
    `published: ${over.published ?? "2026-01-02"}`,
    ...(over.slug ? [`slug: ${over.slug}`] : []),
    ...(over.related ? [`related: ${over.related}`] : []),
    "---",
    "",
    body,
  ].join("\n");

describe("markdown", () => {
  it("gives every heading an anchor, and collects h2 and h3", () => {
    const { html, headings } = renderMarkdown("## Défausse rapide\n\n### Détail\n\n#### Trop bas");
    expect(html).toContain('<h2 id="defausse-rapide">Défausse rapide</h2>');
    expect(headings.map((h) => h.id)).toEqual(["defausse-rapide", "detail"]);
  });

  it("joins a wrapped paragraph into one", () => {
    expect(renderMarkdown("une phrase\ncoupée en deux").html).toBe("<p>une phrase coupée en deux</p>");
  });

  it("renders both kinds of list", () => {
    expect(renderMarkdown("- un\n- deux").html).toBe("<ul><li>un</li><li>deux</li></ul>");
    expect(renderMarkdown("1. un\n2. deux").html).toBe("<ol><li>un</li><li>deux</li></ol>");
  });

  it("renders a table into a scrollable wrapper", () => {
    const { html } = renderMarkdown("| Carte | Valeur |\n|---|---|\n| Roi rouge | 0 |");
    expect(html).toContain('<div class="table-wrap">');
    expect(html).toContain('<th scope="col">Carte</th>');
    expect(html).toContain("<td>Roi rouge</td>");
  });

  it("turns a quote into a callout and three dashes into a rule", () => {
    expect(renderMarkdown("> attention\n> ici").html).toBe(
      '<blockquote class="callout"><p>attention ici</p></blockquote>',
    );
    expect(renderMarkdown("---").html).toBe("<hr />");
  });

  it("renders inline markup", () => {
    expect(renderInline("**gras** et *penché* et `code`")).toBe(
      "<strong>gras</strong> et <em>penché</em> et <code>code</code>",
    );
    expect(renderInline("[les règles](/blog/regles/)")).toBe(
      '<a href="/blog/regles/">les règles</a>',
    );
  });

  it("escapes what would otherwise be markup", () => {
    expect(renderInline("a < b & c")).toBe("a &lt; b &amp; c");
    // The apostrophe is left alone: it is only dangerous in an attribute.
    expect(renderInline("l'as")).toBe("l'as");
  });

  it("does not read markup inside a code span", () => {
    expect(renderInline("`**pas gras**`")).toBe("<code>**pas gras**</code>");
  });

  it("refuses a link that could execute", () => {
    expect(renderInline("[clic](javascript:alert(1))")).not.toContain("<a");
  });

  it("strips accents rather than encoding them", () => {
    expect(slugify("Dire « Cactus » !")).toBe("dire-cactus");
  });
});

describe("front matter", () => {
  it("keeps everything after the first colon", () => {
    const { fields, body } = parseFrontMatter("---\ntitle: Cactus : les règles\n---\n\nDu texte.");
    expect(fields.get("title")).toBe("Cactus : les règles");
    expect(body).toBe("Du texte.");
  });

  it("takes the slug from the file name unless it is overridden", () => {
    expect(parseArticle("regles.md", article()).slug).toBe("regles");
    expect(parseArticle("regles.md", article({ slug: "autre" })).slug).toBe("autre");
  });

  it("reads the FAQ back out of the prose", () => {
    const faq = extractFaq(
      "## Questions fréquentes\n\n### Combien de joueurs ?\n\nDe **2** à 6.\n\n### Et sinon ?\n\nNon.",
    );
    expect(faq).toEqual([
      { question: "Combien de joueurs ?", answer: "De 2 à 6." },
      { question: "Et sinon ?", answer: "Non." },
    ]);
  });

  it("does not mistake an ordinary h3 for a question", () => {
    expect(extractFaq("## Les pouvoirs\n\n### Le roi noir\n\nIl regarde.")).toEqual([]);
  });

  it("writes a date the way it is read aloud", () => {
    expect(formatDate("2026-08-12")).toBe("12 août 2026");
  });
});

describe("pages", () => {
  const built = (files: readonly SourceFile[]) => buildBlog(files, SITE);

  it("emits an index, a directory per article, and the two crawler files", () => {
    const paths = built([
      { name: "regles.md", source: article() },
      { name: "strategie.md", source: article({ published: "2026-02-02" }) },
    ]).map((file) => file.path);

    expect(paths).toEqual([
      "blog/index.html",
      "blog/strategie/index.html", // newest first
      "blog/regles/index.html",
      "sitemap.xml",
      "robots.txt",
    ]);
  });

  it("refuses to build an article that would be indexed badly", () => {
    expect(() => built([{ name: "a.md", source: article({ description: "" }) }])).toThrow(
      /description/,
    );
    expect(() => built([{ name: "a.md", source: article({ published: "avril" }) }])).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it("refuses two articles with the same slug", () => {
    expect(() =>
      built([
        { name: "a.md", source: article({ slug: "meme" }) },
        { name: "b.md", source: article({ slug: "meme" }) },
      ]),
    ).toThrow(/same slug|claim the slug/);
  });

  it("points the canonical, the og:url and the breadcrumb at the same URL", () => {
    const html = renderArticlePage(parseArticle("regles.md", article()), [], SITE);
    const canonical = "https://example.test/blog/regles/";
    expect(html).toContain(`<link rel="canonical" href="${canonical}" />`);
    expect(html).toContain(`<meta property="og:url" content="${canonical}" />`);
    expect(html).toContain(`"item": "${canonical}"`);
  });

  it("declares a FAQPage only when the article has a FAQ", () => {
    const plain = renderArticlePage(parseArticle("a.md", article()), [], SITE);
    expect(plain).not.toContain("FAQPage");

    const withFaq = renderArticlePage(
      parseArticle("a.md", article({}, "## Questions fréquentes\n\n### Ah ?\n\nOui.")),
      [],
      SITE,
    );
    expect(withFaq).toContain('"@type": "FAQPage"');
  });

  it("ships no JavaScript and fetches nothing while rendering", () => {
    const html = renderArticlePage(parseArticle("a.md", article()), [], SITE);
    // The only script is the structured data, and the stylesheet is inlined:
    // nothing blocks the first paint, which is the whole design of these pages.
    expect(html).not.toMatch(/<script(?![^>]*application\/ld\+json)/);
    expect(html).not.toContain("<script src");
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toMatch(/<img[^>]+src="http/);
  });

  it("always offers a way into the game", () => {
    const html = renderArticlePage(parseArticle("regles.md", article()), [], SITE);
    expect(html).toContain('href="/?utm_source=blog&amp;utm_medium=cta&amp;utm_content=regles"');
    expect(html).toContain("Ouvrir le jeu");
  });

  it("lists every page in the sitemap, home included", () => {
    const articles = [parseArticle("regles.md", article())];
    const xml = renderSitemap(articles, SITE);
    expect(xml).toContain("http://www.sitemaps.org/schemas/sitemap/0.9");
    expect(xml).toContain("<loc>https://example.test/</loc>");
    expect(xml).toContain("<loc>https://example.test/blog/</loc>");
    expect(xml).toContain("<loc>https://example.test/blog/regles/</loc>");
  });

  it("falls back to the default origin, and never keeps a trailing slash", () => {
    expect(siteUrl("https://cactus.example/")).toBe("https://cactus.example");
    expect(siteUrl(undefined)).toMatch(/^https:\/\/[^/]+$/);
  });
});

// --- the articles themselves ---------------------------------------------

const DIR = join(process.cwd(), "content/blog");
const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ name, source: readFileSync(join(DIR, name), "utf8") }));

describe("content/blog", () => {
  const articles = files.map((file) => parseArticle(file.name, file.source));
  const slugs = new Set(articles.map((a) => a.slug));

  it("has articles at all", () => {
    expect(articles.length).toBeGreaterThan(0);
  });

  for (const item of articles) {
    describe(item.slug, () => {
      it("has a title that fits in a search result", () => {
        // Google cuts the title around 60 characters and the description
        // around 160; past that the promise the page makes is truncated.
        expect(item.metaTitle.length).toBeLessThanOrEqual(60);
        expect(item.description.length).toBeLessThanOrEqual(165);
        expect(item.description.length).toBeGreaterThanOrEqual(80);
      });

      it("is structured enough to be navigable", () => {
        const sections = item.headings.filter((heading) => heading.level === 2);
        expect(sections.length).toBeGreaterThanOrEqual(4);
        expect(item.faq.length).toBeGreaterThanOrEqual(3);
      });

      it("only points at articles that exist", () => {
        for (const slug of item.related) expect(slugs).toContain(slug);
        for (const [, href] of item.html.matchAll(/href="\/blog\/([^/"]+)\//g)) {
          expect(slugs).toContain(href);
        }
      });
    });
  }
});
