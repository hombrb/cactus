// An article: one markdown file in content/blog/, parsed into everything the
// page template and the structured data need.
//
// The front matter is a deliberately small key/value format rather than YAML —
// same reasoning as the markdown subset next door. Lists are comma-separated,
// values are single-line, and an unknown key is ignored rather than fatal.

import { plainText, renderMarkdown, slugify, type Heading } from "./markdown";

/** One `### question` under the FAQ heading, and the answer below it. */
export interface FaqEntry {
  readonly question: string;
  /** Plain text: this is what goes into the FAQPage JSON-LD. */
  readonly answer: string;
}

export interface Article {
  readonly slug: string;
  readonly title: string;
  /** The `<title>`, when it should differ from the H1 — usually shorter. */
  readonly metaTitle: string;
  readonly description: string;
  /** The standfirst, in markdown. Also the paragraph the first CTA follows. */
  readonly lead: string;
  readonly published: string;
  readonly updated: string;
  readonly keywords: readonly string[];
  /** Slugs of the articles shown under "À lire ensuite". */
  readonly related: readonly string[];
  readonly html: string;
  readonly headings: readonly Heading[];
  readonly faq: readonly FaqEntry[];
  readonly readingMinutes: number;
}

interface FrontMatter {
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
}

const DELIMITER = /^---\s*$/;

export function parseFrontMatter(source: string): FrontMatter {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const fields = new Map<string, string>();

  if (!DELIMITER.test(lines[0] ?? "")) return { fields, body: source.trim() };

  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (DELIMITER.test(line)) {
      i += 1;
      break;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    // Only the first colon separates: descriptions contain them too.
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
    if (key.length > 0) fields.set(key, value);
  }

  return { fields, body: lines.slice(i).join("\n").trim() };
}

function list(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * The FAQ block, read back out of the body.
 *
 * Keeping the questions in the prose rather than in the front matter means the
 * page a reader sees and the FAQPage a search engine reads cannot disagree —
 * there is only one copy. The section is found by heading id, so it is whatever
 * `##` slugifies to `faq` or starts with `questions-`.
 */
export function extractFaq(body: string): FaqEntry[] {
  const lines = body.split("\n");
  const entries: FaqEntry[] = [];
  let inFaq = false;
  let question: string | null = null;
  let answer: string[] = [];

  const flush = () => {
    if (question !== null && answer.length > 0) {
      entries.push({ question, answer: plainText(answer.join(" ")) });
    }
    question = null;
    answer = [];
  };

  for (const line of lines) {
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "").length;
      const text = (heading[2] ?? "").trim();
      if (level === 2) {
        flush();
        const id = slugify(text);
        inFaq = id === "faq" || id.startsWith("questions-");
        continue;
      }
      if (inFaq) {
        flush();
        question = plainText(text);
        continue;
      }
    }
    if (inFaq && question !== null && line.trim() !== "") answer.push(line.trim());
  }
  flush();

  return entries;
}

/** 200 words a minute, the figure every reading-time widget agrees on. */
function readingMinutes(body: string): number {
  const words = plainText(body).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

/** "2026-08-12" → "12 août 2026". Written out rather than left to Intl, which
 *  needs an ICU build to be there and is a build-time surprise when it is not. */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = MONTHS[Number(month) - 1];
  if (name === undefined || year === undefined || day === undefined) return iso;
  return `${Number(day)} ${name} ${year}`;
}

/**
 * `fileName` is the source file's basename; it is the slug unless the front
 * matter overrides it, which keeps the URL visible in the repository listing.
 */
export function parseArticle(fileName: string, source: string): Article {
  const { fields, body } = parseFrontMatter(source);
  const get = (key: string): string => fields.get(key) ?? "";

  const title = get("title");
  const rendered = renderMarkdown(body);

  return {
    slug: get("slug") || fileName.replace(/\.md$/, ""),
    title,
    metaTitle: get("metaTitle") || title,
    description: get("description"),
    lead: get("lead"),
    published: get("published"),
    updated: get("updated") || get("published"),
    keywords: list(get("keywords")),
    related: list(get("related")),
    html: rendered.html,
    headings: rendered.headings,
    faq: extractFaq(body),
    readingMinutes: readingMinutes(`${get("lead")} ${body}`),
  };
}

/** Newest first — the order the index lists them in. */
export function byDateDesc(articles: readonly Article[]): Article[] {
  return [...articles].sort((a, b) => b.published.localeCompare(a.published));
}
