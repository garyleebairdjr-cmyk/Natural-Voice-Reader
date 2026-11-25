/**
 * Turn a fetched HTML page into plain reading text.
 *
 * Uses Mozilla Readability (the Firefox Reader View engine) over a linkedom
 * DOM, which keeps the article body, drops menus and sidebars, and decodes
 * every HTML entity. Falls back to the whole <body> when Readability does
 * not find an article.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const BLOCK_CLOSE = /<\/(p|div|section|article|h[1-6]|li|blockquote|pre|tr|td|th|dd|dt|figcaption)>/gi;
const NOISE = "script, style, noscript, template, svg, nav, footer, header, aside, form, iframe, button";
/** Parts of an article that read badly aloud: data tables, footnote markers, edit links, hatnotes. */
const UNSPOKEN =
  "table, sup.reference, .reference, .mw-editsection, .hatnote, .noprint, .navbox, .infobox, .metadata, [role='note'], [aria-hidden='true']";

/** Bracketed citation markers such as [1], [a], [citation needed], or [edit]. */
const CITATION = /\[(?:\d{1,3}|[a-z]|citation needed|edit|note \d+)\]/gi;

/** Text of an HTML fragment with a line break after each block element. */
function blockText(html: string): string {
  const spaced = html.replace(/<br\s*\/?>/gi, "\n").replace(BLOCK_CLOSE, "</$1>\n");
  const { document } = parseHTML(`<!doctype html><html><body>${spaced}</body></html>`);
  return document.body?.textContent ?? "";
}

function tidy(text: string): string {
  return text
    .replace(CITATION, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type PageText = { title: string; text: string };

export function extractPageText(html: string): PageText {
  const { document } = parseHTML(html);
  const pageTitle = tidy(document.querySelector("title")?.textContent ?? "");

  try {
    // Readability changes the DOM it reads, so give it its own copy.
    const { document: copy } = parseHTML(html);
    for (const node of Array.from(copy.querySelectorAll(UNSPOKEN))) node.remove();
    const article = new Readability(copy as unknown as Document, { charThreshold: 200 }).parse();
    const body = article?.content ? tidy(blockText(article.content)) : "";
    if (body.length >= 200) {
      return { title: tidy(article?.title ?? "") || pageTitle, text: body };
    }
  } catch {
    // Fall through to the plain body text.
  }

  for (const node of Array.from(document.querySelectorAll(`${NOISE}, ${UNSPOKEN}`))) node.remove();
  const main = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  return { title: pageTitle, text: tidy(blockText(main?.innerHTML ?? "")) };
}

export const MAX_READ_TEXT = 50_000;

export type ReadPageResult =
  | { ok: true; text: string; trimmed: boolean }
  | { ok: false; error: string };

/**
 * Turn a fetched response body into a queue-ready result. Shared by the web
 * server function and the desktop app, which fetches the page in Rust.
 */
export function readableFromBody(body: string, contentType: string): ReadPageResult {
  const type = contentType.toLowerCase();
  let text = body.trim();
  if (/html|xml/.test(type) || /<html|<body|<p[\s>]/i.test(body)) {
    const page = extractPageText(body);
    // Lead with the headline unless the article already opens with it.
    const opensWithTitle = page.title && page.text.slice(0, page.title.length + 20).includes(page.title);
    const heading = /[.!?:]$/.test(page.title) ? page.title : `${page.title}.`;
    text = page.title && !opensWithTitle ? `${heading}\n\n${page.text}` : page.text;
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length < 40) {
    return {
      ok: false,
      error: "That page didn't include readable text. It may only load in a browser. Paste it on a card instead.",
    };
  }
  return { ok: true, text: collapsed.slice(0, MAX_READ_TEXT), trimmed: collapsed.length > MAX_READ_TEXT };
}
