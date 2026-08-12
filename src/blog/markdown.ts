// A markdown subset, rendered once at build time.
//
// The blog is a handful of files and one renderer, and none of it ships to the
// browser — pulling in a CommonMark implementation would give the project its
// first dependency for code that never leaves `npm run build`. So the subset is
// written here, kept to exactly what the articles use, and tested
// (tests/blog.test.ts) rather than trusted.
//
// Supported: ##/###/#### headings, paragraphs, `-` and `1.` lists, `|` tables,
// `>` callouts, `---` rules, and inline `**bold**`, `*italic*`, `` `code` ``
// and [links](…). Anything else is not markdown here.

/** A heading the article can build a table of contents from. */
export interface Heading {
  readonly level: 2 | 3;
  readonly id: string;
  readonly text: string;
}

export interface RenderedMarkdown {
  readonly html: string;
  /** In document order, h2 and h3 only — h4 is too deep to navigate by. */
  readonly headings: readonly Heading[];
}

/**
 * Text-position escaping: `&`, `<` and `>` only.
 *
 * Quotes are deliberately left alone. French prose is one long apostrophe
 * parade, and turning every one of them into `&#39;` would triple the noise in
 * the emitted HTML for no gain — they are only dangerous inside an attribute,
 * which is what `escapeAttr` is for.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Attribute-position escaping: everything `escapeHtml` does, plus the double
 * quote that would end the value. Every attribute this generator writes is
 * double-quoted, so an apostrophe is just a character — and a French meta
 * description full of `&#39;` is a description that reads badly in the search
 * result and counts its length wrong.
 */
export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * "Défausse rapide" → "defausse-rapide".
 *
 * Accents are stripped rather than percent-encoded: these ids end up in
 * anchors that get copied into chat messages and search results, and
 * `#d%C3%A9fausse` reads like a bug.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Markdown stripped down to what a person would read aloud — for JSON-LD. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Only schemes that cannot execute, and nothing that could close the attribute. */
function isSafeHref(href: string): boolean {
  if (/["'<>]/.test(href)) return false;
  return /^(https?:\/\/|\/|#|mailto:)/.test(href);
}

// Code spans are lifted out before anything else runs, so that a `*` or a
// `[` inside one is never read as markup. The sentinel is a NUL, built rather
// than typed so the source file itself stays free of control characters.
const MARK = String.fromCharCode(0);

export function renderInline(source: string): string {
  const codes: string[] = [];
  const lifted = source.replace(/`([^`]+)`/g, (_whole, code: string) => {
    codes.push(code);
    return `${MARK}${codes.length - 1}${MARK}`;
  });

  const html = escapeHtml(lifted)
    // Runs on already-escaped text, so an `&` in a query string is `&amp;`
    // by the time it reaches the attribute — which is what HTML wants.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) =>
      isSafeHref(href)
        ? `<a href="${href}"${href.startsWith("http") ? ' rel="noopener"' : ""}>${label}</a>`
        : whole,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  // Split rather than match: the sentinel always comes in pairs, so every odd
  // slice is exactly one code span's index and nothing needs escaping.
  return html
    .split(MARK)
    .map((part, index) =>
      index % 2 === 1 ? `<code>${escapeHtml(codes[Number(part)] ?? "")}</code>` : part,
    )
    .join("");
}

const HEADING = /^(#{2,4})\s+(.+)$/;
const BULLET = /^[-*]\s+(.+)$/;
const NUMBER = /^\d+[.)]\s+(.+)$/;

/** True for any line that starts a block other than a paragraph. */
function startsBlock(line: string): boolean {
  return (
    line.trim() === "" ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBER.test(line) ||
    line.startsWith(">") ||
    line.startsWith("|") ||
    /^---+$/.test(line)
  );
}

function renderTable(rows: readonly string[]): string {
  const cells = (row: string): string[] =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const [head, , ...body] = rows;
  const header = cells(head ?? "")
    .map((cell) => `<th scope="col">${renderInline(cell)}</th>`)
    .join("");
  const lines = body
    .map(
      (row) =>
        `<tr>${cells(row)
          .map((cell) => `<td>${renderInline(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");

  // The wrapper is what lets a wide table scroll sideways on a phone instead
  // of widening the whole page (blog.css).
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${lines}</tbody></table></div>`;
}

export function renderMarkdown(source: string): RenderedMarkdown {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const headings: Heading[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? "").length;
      const text = (heading[2] ?? "").trim();
      const id = slugify(text);
      if (level === 2 || level === 3) headings.push({ level, id, text: plainText(text) });
      out.push(`<h${level} id="${escapeAttr(id)}">${renderInline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^---+$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        rows.push(lines[i] ?? "");
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }

    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        quoted.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote class="callout"><p>${renderInline(quoted.join(" "))}</p></blockquote>`);
      continue;
    }

    const ordered = NUMBER.test(line);
    if (ordered || BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = (ordered ? NUMBER : BULLET).exec(lines[i] ?? "");
        if (!item) break;
        items.push(`<li>${renderInline((item[1] ?? "").trim())}</li>`);
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // A paragraph runs until a blank line or the start of another block, so a
    // long sentence can be wrapped in the source without splitting in two.
    const paragraph: string[] = [];
    while (i < lines.length && !startsBlock(lines[i] ?? "")) {
      paragraph.push((lines[i] ?? "").trim());
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return { html: out.join("\n"), headings };
}
