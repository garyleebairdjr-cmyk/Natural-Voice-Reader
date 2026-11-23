import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPageText } from "./page-text.ts";

const paragraph = (n: number) =>
  `<p>Paragraph ${n} explains the mission in plain words, with enough detail that a reader would want to hear it read aloud from start to finish.</p>`;

const ARTICLE = `<!doctype html><html><head><title>Voyager &amp; the Edge | Space News</title></head><body>
<nav><a href="/">Home</a> <a href="/subscribe">Subscribe now</a></nav>
<header><div class="logo">Space News</div></header>
<main><article>
  <h1>Voyager &amp; the Edge</h1>
  <p>Engineers said the probe&rsquo;s signal is &ldquo;faint&rdquo; &mdash; but steady. Q&amp;A follows &lt;below&gt;.</p>
  ${[1, 2, 3, 4].map(paragraph).join("\n")}
</article></main>
<aside><p>Related: ten other stories you might like to click on today.</p></aside>
<footer><p>Copyright 2026. All rights reserved.</p></footer>
<script>window.tracking = true;</script>
</body></html>`;

describe("extractPageText", () => {
  it("decodes named and numeric HTML entities", () => {
    const { text } = extractPageText(ARTICLE);
    assert.match(text, /probe’s signal is “faint” — but steady\. Q&A follows <below>\./);
    assert.doesNotMatch(text, /&amp;|&rsquo;|&mdash;|&lt;/);
  });

  it("keeps the article and drops navigation, sidebars, footers and scripts", () => {
    const { text } = extractPageText(ARTICLE);
    assert.match(text, /Paragraph 4 explains the mission/);
    assert.doesNotMatch(text, /Subscribe now|ten other stories|All rights reserved|tracking/);
  });

  it("puts paragraphs on separate lines instead of running them together", () => {
    const { text } = extractPageText(ARTICLE);
    assert.match(text, /finish\.\n+Paragraph 2/);
  });

  it("returns a decoded title", () => {
    assert.match(extractPageText(ARTICLE).title, /^Voyager & the Edge/);
  });

  it("falls back to body text for short pages", () => {
    const { text } = extractPageText("<html><body><nav>Menu</nav><p>Just a short note &amp; nothing else.</p></body></html>");
    assert.equal(text, "Just a short note & nothing else.");
  });
});
