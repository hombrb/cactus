// The blog's HTML: two templates, the structured data that goes with them, and
// the two files a crawler looks for.
//
// Every page is emitted at build time and ships **no JavaScript**. That is not
// minimalism for its own sake: a crawler indexes what the HTML already says,
// and the fastest possible article page is the one that converts best on a
// phone. The stylesheet is inlined for the same reason — one request, nothing
// render-blocking, and the whole page arrives in the first response.

import type { Article } from "./content";
import { formatDate } from "./content";
import { escapeAttr, escapeHtml, renderInline } from "./markdown";

export interface Site {
  /** Absolute origin, no trailing slash: canonicals and the sitemap need one. */
  readonly url: string;
  /** blog.css, inlined into every page. */
  readonly css: string;
}

const NAME = "Cactus";
const TAGLINE = "Le jeu de cartes Cactus, gratuit et sans compte.";
const REPOSITORY = "https://github.com/hombrb/cactus";

/**
 * The domain the blog is written for.
 *
 * Everything else — the workers.dev subdomain the app is deployed to today, a
 * preview, a fork — is a copy of the same pages at another address, which is
 * the textbook way to end up competing with yourself in the results. So a build
 * for any other origin is emitted `noindex`, and only `SITE_URL=…playcactus.co`
 * produces pages that ask to be indexed at all.
 */
export const PRODUCTION_URL = "https://playcactus.co";

export const isIndexable = (url: string): boolean => url === PRODUCTION_URL;

export const BLOG_PATH = "/blog/";

export const articlePath = (slug: string): string => `${BLOG_PATH}${slug}/`;

/**
 * Every link into the app carries where it came from.
 *
 * The game ignores unknown query parameters, so this costs nothing at runtime
 * and is the only way to tell later which article actually sends players.
 */
function playHref(content: string): string {
  // `&amp;` because these go straight into an attribute: a bare `&` there is a
  // character reference as far as a validator is concerned.
  return `/?utm_source=blog&amp;utm_medium=cta&amp;utm_content=${encodeURIComponent(content)}`;
}

/** JSON-LD, made safe to sit inside a `<script>` element. */
function jsonLd(data: unknown): string {
  const json = JSON.stringify(data, null, 2).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

interface Meta {
  readonly title: string;
  readonly description: string;
  readonly canonical: string;
  readonly type: "article" | "website";
  readonly structured: string;
}

function head(meta: Meta, site: Site): string {
  const image = `${site.url}/icons/icon-512.png`;
  return `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeAttr(meta.description)}" />
<link rel="canonical" href="${escapeAttr(meta.canonical)}" />
<meta name="robots" content="${
    isIndexable(site.url)
      ? "index, follow, max-image-preview:large, max-snippet:-1"
      : "noindex, nofollow"
  }" />
<meta name="theme-color" content="#0c2c20" />
<meta name="color-scheme" content="dark" />

<meta property="og:type" content="${meta.type}" />
<meta property="og:site_name" content="${NAME}" />
<meta property="og:locale" content="fr_FR" />
<meta property="og:title" content="${escapeAttr(meta.title)}" />
<meta property="og:description" content="${escapeAttr(meta.description)}" />
<meta property="og:url" content="${escapeAttr(meta.canonical)}" />
<meta property="og:image" content="${escapeAttr(image)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escapeAttr(meta.title)}" />
<meta name="twitter:description" content="${escapeAttr(meta.description)}" />
<meta name="twitter:image" content="${escapeAttr(image)}" />

<link rel="icon" href="/icons/icon-192.png" type="image/png" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
<link rel="manifest" href="/manifest.webmanifest" />

<style>${site.css}</style>
${meta.structured}`;
}

/** The three fanned card backs from the menu, in an anchor. */
function topbar(source: string): string {
  return `<header class="topbar">
  <a class="brand" href="/" aria-label="Cactus, l'application">
    <span class="brand__mark" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="brand__name">${NAME}</span>
  </a>
  <nav class="topbar__nav">
    <a class="topbar__link" href="${BLOG_PATH}">Blog</a>
    <a class="btn btn--accent" href="${playHref(source)}">Jouer</a>
  </nav>
</header>`;
}

function footer(): string {
  return `<footer class="foot">
  <p class="foot__links">
    <a href="/">L'application</a> ·
    <a href="${BLOG_PATH}">Tous les articles</a> ·
    <a href="${REPOSITORY}" rel="noopener">Code source</a>
  </p>
  <p class="foot__fine">${TAGLINE} À deux sur un téléphone posé à plat, ou à distance avec un code de salon. Rien à installer, aucune donnée collectée.</p>
</footer>`;
}

/**
 * The bar pinned to the bottom of the viewport on a phone.
 *
 * An article is read scrolling, and the call to action would otherwise only
 * exist above and below a two-thousand-word page. It is hidden on wide screens,
 * where the header button is always in view.
 */
function dock(source: string): string {
  return `<div class="dock">
  <span class="dock__text"><b>${NAME}</b> — gratuit, sans compte</span>
  <a class="btn btn--accent" href="${playHref(source)}">Jouer</a>
</div>`;
}

function ctaBlock(source: string, heading: string, pitch: string): string {
  return `<section class="cta cta--end" aria-labelledby="cta-titre">
  <h2 id="cta-titre">${escapeHtml(heading)}</h2>
  <p>${escapeHtml(pitch)}</p>
  <ul class="cta__points">
    <li>À deux sur un seul téléphone, posé à plat entre les joueurs</li>
    <li>Ou à distance : un code de salon à six caractères, et c'est parti</li>
    <li>Les règles au choix — pouvoirs, défausse rapide, seuil de points</li>
    <li>Gratuit, sans compte, sans publicité, et jouable hors ligne</li>
  </ul>
  <a class="btn btn--accent btn--big" href="${playHref(source)}">Ouvrir le jeu</a>
  <p class="cta__fine">Rien à installer : ça s'ouvre dans le navigateur.</p>
</section>`;
}

function layout(meta: Meta, site: Site, source: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
${head(meta, site)}
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>
${topbar(source)}
<main id="contenu">
${body}
</main>
${footer()}
${dock(source)}
</body>
</html>
`;
}

function crumbs(current: string): string {
  return `<nav class="crumbs" aria-label="Fil d'Ariane">
  <a href="/">Accueil</a><span aria-hidden="true">›</span><a href="${BLOG_PATH}">Blog</a><span aria-hidden="true">›</span><span aria-current="page">${escapeHtml(current)}</span>
</nav>`;
}

function breadcrumbList(article: Article, site: Site): unknown {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: `${site.url}/` },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${site.url}${BLOG_PATH}` },
      {
        "@type": "ListItem",
        position: 3,
        name: article.title,
        item: `${site.url}${articlePath(article.slug)}`,
      },
    ],
  };
}

function publisher(site: Site): unknown {
  return {
    "@type": "Organization",
    name: NAME,
    url: `${site.url}/`,
    logo: {
      "@type": "ImageObject",
      url: `${site.url}/icons/icon-512.png`,
      width: 512,
      height: 512,
    },
  };
}

/**
 * The table of contents.
 *
 * Worth its weight twice over: it is how a reader on a phone decides the page
 * answers their question, and the anchors are what a search engine offers as
 * jump links under the result.
 */
function toc(article: Article): string {
  const sections = article.headings.filter((heading) => heading.level === 2);
  if (sections.length < 3) return "";
  const items = sections
    .map(
      (heading) =>
        `<li><a href="#${escapeAttr(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join("\n    ");
  return `<nav class="toc" aria-labelledby="sommaire">
  <h2 id="sommaire">Sommaire</h2>
  <ol>
    ${items}
  </ol>
</nav>`;
}

function relatedBlock(article: Article, all: readonly Article[]): string {
  const bySlug = new Map(all.map((other) => [other.slug, other]));
  const picks = article.related
    .map((slug) => bySlug.get(slug))
    .filter((other): other is Article => other !== undefined && other.slug !== article.slug);

  // An article that names no neighbours still gets some: an orphan page is a
  // dead end for a reader and a leaf for a crawler.
  if (picks.length === 0) {
    picks.push(...all.filter((other) => other.slug !== article.slug).slice(0, 2));
  }

  const cards = picks
    .map(
      (other) => `<li>
      <a class="card" href="${articlePath(other.slug)}">
        <h3>${escapeHtml(other.title)}</h3>
        <p>${escapeHtml(other.description)}</p>
        <span class="card__more">Lire l'article</span>
      </a>
    </li>`,
    )
    .join("\n    ");

  return `<section class="related" aria-labelledby="a-lire">
  <h2 id="a-lire">À lire ensuite</h2>
  <ul class="cards">
    ${cards}
  </ul>
</section>`;
}

export function renderArticlePage(
  article: Article,
  all: readonly Article[],
  site: Site,
): string {
  const canonical = `${site.url}${articlePath(article.slug)}`;

  const graph: unknown[] = [
    {
      "@type": "Article",
      headline: article.title,
      description: article.description,
      datePublished: article.published,
      dateModified: article.updated,
      inLanguage: "fr-FR",
      keywords: article.keywords.join(", "),
      author: { "@type": "Organization", name: NAME, url: `${site.url}/` },
      publisher: publisher(site),
      image: [`${site.url}/icons/icon-512.png`],
      mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
      about: { "@type": "Game", name: "Cactus", url: `${site.url}/` },
    },
    breadcrumbList(article, site),
  ];

  // Only when the article really carries a question-and-answer section: a
  // FAQPage that does not match the page is a manual action waiting to happen.
  if (article.faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: article.faq.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    });
  }

  const body = `<article class="article">
${crumbs(article.title)}
  <h1>${escapeHtml(article.title)}</h1>
  <p class="byline">
    <time datetime="${escapeAttr(article.published)}">${escapeHtml(formatDate(article.published))}</time>
    <span aria-hidden="true">·</span> ${article.readingMinutes} min de lecture${
      article.updated !== article.published
        ? `\n    <span aria-hidden="true">·</span> mis à jour le ${escapeHtml(formatDate(article.updated))}`
        : ""
    }
  </p>
  <p class="lead">${renderInline(article.lead)}</p>

  <aside class="cta cta--inline">
    <p><b>Le jeu se joue tout de suite</b>, dans le navigateur : gratuit, sans compte, à deux sur un téléphone.</p>
    <a class="btn btn--accent" href="${playHref(article.slug)}">Jouer au Cactus</a>
  </aside>

${toc(article)}

  <div class="prose">
${article.html}
  </div>

${ctaBlock(article.slug, "Une manche, maintenant ?", "Le Cactus se comprend en le jouant : le téléphone se pose à plat entre vous deux, chacun voit sa moitié à l'endroit, et la première manche dure cinq minutes.")}

${relatedBlock(article, all)}
</article>`;

  return layout(
    {
      title: article.metaTitle,
      description: article.description,
      canonical,
      type: "article",
      structured: jsonLd({ "@context": "https://schema.org", "@graph": graph }),
    },
    site,
    article.slug,
    body,
  );
}

export function renderIndexPage(articles: readonly Article[], site: Site): string {
  const canonical = `${site.url}${BLOG_PATH}`;

  const cards = articles
    .map(
      (article) => `<li>
      <a class="card" href="${articlePath(article.slug)}">
        <span class="card__date"><time datetime="${escapeAttr(article.published)}">${escapeHtml(formatDate(article.published))}</time> · ${article.readingMinutes} min</span>
        <h2>${escapeHtml(article.title)}</h2>
        <p>${escapeHtml(article.description)}</p>
        <span class="card__more">Lire l'article</span>
      </a>
    </li>`,
    )
    .join("\n    ");

  const graph: unknown[] = [
    {
      "@type": "Blog",
      name: `Le blog du ${NAME}`,
      description:
        "Les règles, les variantes et la stratégie du jeu de cartes Cactus — et le jeu, jouable tout de suite.",
      url: canonical,
      inLanguage: "fr-FR",
      publisher: publisher(site),
      blogPost: articles.map((article) => ({
        "@type": "BlogPosting",
        headline: article.title,
        description: article.description,
        datePublished: article.published,
        dateModified: article.updated,
        url: `${site.url}${articlePath(article.slug)}`,
      })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Accueil", item: `${site.url}/` },
        { "@type": "ListItem", position: 2, name: "Blog", item: canonical },
      ],
    },
  ];

  const body = `<div class="index">
  <nav class="crumbs" aria-label="Fil d'Ariane">
    <a href="/">Accueil</a><span aria-hidden="true">›</span><span aria-current="page">Blog</span>
  </nav>
  <h1>Le blog du Cactus</h1>
  <p class="lead">Les règles complètes, les variantes qui changent d'une table à l'autre, et ce qu'il faut vraiment savoir pour gagner. Le jeu, lui, est à un clic.</p>

  <aside class="cta cta--inline">
    <p><b>Le jeu est là</b>, gratuit et sans compte — à deux sur un téléphone, ou à distance.</p>
    <a class="btn btn--accent" href="${playHref("blog-index")}">Jouer au Cactus</a>
  </aside>

  <ul class="cards cards--list">
    ${cards}
  </ul>

${ctaBlock("blog-index", "Le jeu, tout de suite", "Toutes les variantes décrites ici sont des réglages dans l'application : pouvoirs, défausse rapide, seuil de points, tout se change avant la partie.")}
</div>`;

  return layout(
    {
      title: "Blog du Cactus — règles, variantes et stratégie du jeu de cartes",
      description:
        "Règles du Cactus, variantes (Dutch, Tamalou, Cabo, Pablo), stratégie et conseils — par l'application gratuite qui permet d'y jouer à deux sur un téléphone.",
      canonical,
      type: "website",
      structured: jsonLd({ "@context": "https://schema.org", "@graph": graph }),
    },
    site,
    "blog-index",
    body,
  );
}

export function renderSitemap(articles: readonly Article[], site: Site): string {
  const entries = [
    { loc: `${site.url}/`, lastmod: latest(articles), priority: "1.0" },
    { loc: `${site.url}${BLOG_PATH}`, lastmod: latest(articles), priority: "0.8" },
    ...articles.map((article) => ({
      loc: `${site.url}${articlePath(article.slug)}`,
      lastmod: article.updated,
      priority: "0.7",
    })),
  ];

  const urls = entries
    .map(
      (entry) =>
        `  <url>\n    <loc>${escapeHtml(entry.loc)}</loc>\n    <lastmod>${entry.lastmod}</lastmod>\n    <priority>${entry.priority}</priority>\n  </url>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function latest(articles: readonly Article[]): string {
  return articles.reduce(
    (newest, article) => (article.updated > newest ? article.updated : newest),
    articles[0]?.updated ?? "",
  );
}

export function renderRobots(site: Site): string {
  if (!isIndexable(site.url)) {
    return `# Déploiement de développement — la version publique est ${PRODUCTION_URL}\nUser-agent: *\nDisallow: /\n`;
  }
  return `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`;
}
