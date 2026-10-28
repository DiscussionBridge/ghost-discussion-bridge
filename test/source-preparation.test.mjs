import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "htmlparser2";
import { prepareGhostSourceHtml } from "../src/source-preparation.mjs";

// Authored unit fixtures only. These are not captures from an installed Ghost
// renderer, and this file starts no native process, service, observer or worker.
const articleUrl = "https://ghost.example/articles/original/";
const nativeId = "0123456789abcdef01234567";

function freezeTree(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function captureFor(html, { lexical = null, context = {} } = {}) {
  return freezeTree({
    native_id: nativeId, article_url: articleUrl, html, lexical,
    context: { visibility: "public", codeinjection_head: null, codeinjection_foot: null, ...context },
  });
}

function elements(node, name) {
  const found = [];
  if (node.name === name) found.push(node);
  for (const child of node.children ?? []) found.push(...elements(child, name));
  return found;
}

function one(node, name) {
  const found = elements(node, name);
  assert.equal(found.length, 1, `Expected one preserved ${name}`);
  return found[0];
}

function textOf(node) {
  return node.type === "text" ? node.data : (node.children ?? []).map(textOf).join("");
}

async function prepared(html, options) {
  const capture = captureFor(html, options), before = structuredClone(capture);
  const output = await prepareGhostSourceHtml(html, capture);
  assert.equal(typeof output, "string", "Preparation must produce a complete HTML representation");
  assert.deepEqual(capture, before, "Preparation changed its original capture/context");
  return { output, document: parseDocument(output, { decodeEntities: true }), capture };
}

async function unavailable(html, patterns, options, forbiddenPattern) {
  const capture = captureFor(html, options), before = structuredClone(capture);
  await assert.rejects(async () => prepareGhostSourceHtml(html, capture), (error) => {
    assert.ok(error instanceof Error, "A preparation limitation must have a diagnostic");
    for (const pattern of patterns) assert.match(error.message, pattern);
    if (forbiddenPattern) assert.doesNotMatch(error.message, forbiddenPattern);
    assert.doesNotMatch(error.message, /native_source_html_unqualified/u, "A specific facility must not become a blanket recipe gate");
    return true;
  });
  assert.deepEqual(capture, before, "A limitation changed its original capture/context");
}

test("unformatted Unicode text remains meaningful without requiring Lexical or an HTML tag", async () => {
  const html = "Plain source 雪 — no markup. Words such as script, audio, toggle and kg-card remain ordinary prose.";
  const { document } = await prepared(html);
  assert.equal(textOf(document), html);
});

test("image-only source preserves the image, alt text, dimensions and captured target", async () => {
  const html = '<figure class="kg-card kg-image-card kg-width-wide"><img src="../media/photo.jpg?x=1&amp;y=2#crop" alt="Snow over a bridge" width="640" height="480"></figure>';
  const { document } = await prepared(html);
  const figure = one(document, "figure"), image = one(figure, "img");
  assert.equal(image.attribs.src, "https://ghost.example/articles/media/photo.jpg?x=1&y=2#crop");
  assert.equal(image.attribs.alt, "Snow over a bridge");
  assert.equal(image.attribs.width, "640");
  assert.equal(image.attribs.height, "480");
  assert.equal(textOf(document), "", "This fixture must exercise nontext meaning without visible fallback text");
});

test("unfamiliar inert classes and attributes remain data rather than a blanket rejection trigger", async () => {
  const html = '<section class="kg-custom-presentation reader-layout" data-reader-note="Keep this metadata" aria-label="Reading note" custom-annotation="source-owned"><p>Ordinary explanation.</p><a href="urn:example:reading:42">Reference identifier</a></section>';
  const { document } = await prepared(html), section = one(document, "section");
  assert.deepEqual(section.attribs.class.split(/\s+/u), ["kg-custom-presentation", "reader-layout"]);
  assert.equal(section.attribs["data-reader-note"], "Keep this metadata");
  assert.equal(section.attribs["aria-label"], "Reading note");
  assert.equal(section.attribs["custom-annotation"], "source-owned");
  assert.equal(one(section, "a").attribs.href, "urn:example:reading:42");
  assert.ok(textOf(section).includes("Ordinary explanation."));
});

test("rich text, numbered-list meaning and table relationships survive preparation", async () => {
  const html = '<section><h2 id="section-a">Results</h2><p>A <strong>strong</strong> and <em>careful</em> result with <sup>2</sup> and <sub>n</sub>.</p><ol start="4" type="I" reversed><li value="9">Ninth</li><li>Next</li></ol><table><caption>Measurements</caption><thead><tr><th colspan="2" scope="colgroup">Observed values</th></tr></thead><tbody><tr><td rowspan="2">North</td><td>10</td></tr><tr><td>11</td></tr></tbody></table></section>';
  const { document } = await prepared(html);
  assert.equal(one(document, "h2").attribs.id, "section-a");
  assert.equal(textOf(one(document, "strong")), "strong");
  assert.equal(textOf(one(document, "em")), "careful");
  assert.equal(textOf(one(document, "sup")), "2");
  assert.equal(textOf(one(document, "sub")), "n");
  const list = one(document, "ol");
  assert.equal(list.attribs.start, "4");
  assert.equal(list.attribs.type, "I");
  assert.ok(Object.hasOwn(list.attribs, "reversed"));
  const items = elements(list, "li");
  assert.deepEqual(items.map(textOf), ["Ninth", "Next"]);
  assert.equal(items[0].attribs.value, "9");
  const table = one(document, "table"), header = one(table, "th"), cells = elements(table, "td");
  assert.equal(textOf(one(table, "caption")), "Measurements");
  assert.equal(header.attribs.colspan, "2");
  assert.equal(header.attribs.scope, "colgroup");
  assert.equal(cells[0].attribs.rowspan, "2");
  assert.deepEqual(cells.map(textOf), ["North", "10", "11"]);
});

test("relative, root-relative, fragment and absolute links retain their original captured targets", async () => {
  const html = '<p><a href="../reference?q=1&amp;b=2#part" title="Reference">Reference</a> <a href="/about/#team">Team</a> <a href="#section-a">Section</a> <a href="https://other.example/exact?x=1&amp;y=2#there">External</a></p>';
  const { document } = await prepared(html), links = elements(document, "a");
  assert.deepEqual(links.map((link) => link.attribs.href), [
    "https://ghost.example/articles/reference?q=1&b=2#part",
    "https://ghost.example/about/#team",
    "https://ghost.example/articles/original/#section-a",
    "https://other.example/exact?x=1&y=2#there",
  ]);
  assert.deepEqual(links.map(textOf), ["Reference", "Team", "Section", "External"]);
  assert.equal(links[0].attribs.title, "Reference");
});

test("ordinary responsive image srcset width and density candidates retain descriptors and captured targets", async () => {
  const html = '<figure class="kg-image-card"><img src="../small.jpg" srcset="../small.jpg 480w, /content/images/large.jpg 960w" sizes="(max-width: 600px) 100vw, 600px" alt="Width choices"><img src="../normal.png" srcset="../normal.png 1x, ../retina.png 2x" alt="Density choices"></figure>';
  const { document } = await prepared(html), images = elements(document, "img");
  assert.equal(images.length, 2);
  const candidates = (image) => image.attribs.srcset.split(",").map((entry) => entry.trim().split(/\s+/u));
  assert.deepEqual(candidates(images[0]), [["https://ghost.example/articles/small.jpg", "480w"], ["https://ghost.example/content/images/large.jpg", "960w"]]);
  assert.deepEqual(candidates(images[1]), [["https://ghost.example/articles/normal.png", "1x"], ["https://ghost.example/articles/retina.png", "2x"]]);
  assert.equal(images[0].attribs.src, "https://ghost.example/articles/small.jpg");
  assert.equal(images[0].attribs.sizes, "(max-width: 600px) 100vw, 600px");
  assert.deepEqual(images.map((image) => image.attribs.alt), ["Width choices", "Density choices"]);
});

test("ordinary gallery wrappers and presentation class names do not reject or erase image order and caption", async () => {
  const html = '<figure class="kg-card kg-gallery-card kg-width-wide ordinary-presentation"><div class="kg-gallery-container"><div class="kg-gallery-row"><div class="kg-gallery-image"><img src="/content/images/first.jpg" alt="First" width="600" height="400"></div><div class="kg-gallery-image"><img src="../second.jpg" alt="Second" width="400" height="600"></div></div></div><figcaption>First, then second</figcaption></figure>';
  const { document } = await prepared(html), figure = one(document, "figure"), images = elements(figure, "img");
  assert.deepEqual(images.map((image) => image.attribs.src), ["https://ghost.example/content/images/first.jpg", "https://ghost.example/articles/second.jpg"]);
  assert.deepEqual(images.map((image) => image.attribs.alt), ["First", "Second"]);
  assert.deepEqual(images.map((image) => [image.attribs.width, image.attribs.height]), [["600", "400"], ["400", "600"]]);
  assert.equal(textOf(one(figure, "figcaption")), "First, then second");
});

test("passive bookmark, anchor-button and callout descendants preserve text and link meaning", async () => {
  const html = '<figure class="kg-card kg-bookmark-card"><a class="kg-bookmark-container" href="https://other.example/article/"><div class="kg-bookmark-title">A useful article</div><div class="kg-bookmark-description">Why the bridge matters</div><div class="kg-bookmark-metadata"><span class="kg-bookmark-author">Ana</span><span class="kg-bookmark-publisher">Journal</span></div><img class="kg-bookmark-thumbnail" src="../thumb.jpg" alt="Article thumbnail"></a></figure><div class="kg-card kg-button-card"><a class="kg-btn" href="/join/">Join the discussion</a></div><div class="kg-card kg-callout-card"><div class="kg-callout-emoji">💡</div><div class="kg-callout-text">Keep <strong>this</strong> explanation.</div></div>';
  const { document } = await prepared(html), links = elements(document, "a"), text = textOf(document);
  assert.deepEqual(links.map((link) => link.attribs.href), ["https://other.example/article/", "https://ghost.example/join/"]);
  assert.equal(one(document, "img").attribs.src, "https://ghost.example/articles/thumb.jpg");
  assert.equal(one(document, "img").attribs.alt, "Article thumbnail");
  for (const value of ["A useful article", "Why the bridge matters", "Ana", "Journal", "Join the discussion", "💡", "Keep this explanation."]) assert.ok(text.includes(value), `Lost card content: ${value}`);
  assert.equal(elements(document, "button").length, 0, "An anchor card must not be fabricated into an active button");
});

test("escaped displayed code containing scripts, media and data is preserved as code", async () => {
  const html = '<pre><code class="language-html">&lt;script type="application/ld+json"&gt;{"name":"Example"}&lt;/script&gt;\n&lt;audio src="sample.mp3"&gt;&lt;/audio&gt;</code></pre>';
  const { document } = await prepared(html), code = one(document, "code");
  assert.equal(textOf(code), '<script type="application/ld+json">{"name":"Example"}</script>\n<audio src="sample.mp3"></audio>');
  assert.equal(elements(document, "script").length, 0);
  assert.equal(elements(document, "audio").length, 0);
});

test("empty inert placeholders do not invent script-data or handler-function loss", async () => {
  const html = '<p onclick="">Static content</p><script> </script>';
  const { output } = await prepared(html); assert.equal(output, html);
});

test("unsupported native audio names playback rather than silently retaining only its title", async () => {
  await unavailable('<div class="kg-card kg-audio-card"><audio src="../audio/interview.mp3" preload="metadata"></audio><div class="kg-audio-title">Interview</div><button class="kg-audio-play-icon">Play</button></div>', [/audio/iu, /playback|player|media/iu]);
});

test("unsupported native video retains its original poster/data and reports playback limitation", async () => {
  await unavailable('<figure class="kg-card kg-video-card"><video src="../video/demo.mp4" poster="../video/poster.jpg" playsinline preload="metadata"></video><figcaption>Demonstration</figcaption></figure>', [/video/iu, /playback|player|media/iu]);
});

test("unsupported native toggle names disclosure rather than silently flattening its body", async () => {
  await unavailable('<div class="kg-card kg-toggle-card" data-kg-toggle-state="close"><div class="kg-toggle-heading"><h4 class="kg-toggle-heading-text">Question</h4><button class="kg-toggle-card-icon">Expand</button></div><div class="kg-toggle-content">Complete answer</div></div>', [/toggle|disclosure|expand|collapse/iu]);
});

test("inert JSON script data has a data limitation distinct from source execution", async () => {
  await unavailable('<p>Article</p><script type="application/ld+json">{"name":"Retained structured meaning"}</script>', [/script/iu, /data|json/iu], undefined, /source script execution/iu);
});

test("formula-bearing script data is not silently deleted or mislabeled executable JavaScript", async () => {
  await unavailable('<script type="math/tex">x^2 + y^2 = z^2</script>', [/script|math|formula/iu, /data|math|formula/iu], undefined, /source script execution|javascript execution/iu);
});

test("actual executable source scripts and handlers receive execution-specific limitations", async () => {
  await unavailable('<p>Article</p><script>window.example = 1;</script>', [/script/iu, /execution|executable/iu]);
  await unavailable('<a href="/next/" onclick="window.example = 1">Next</a>', [/onclick|handler/iu]);
});

test("an execution-bearing URI receives a specific reference limitation without a guessed scheme whitelist", async () => {
  await unavailable('<a href="javascript:window.example=1">Open</a>', [/javascript|script|execution/iu, /href|reference|target|scheme/iu]);
});

test("understood scalar CSS URLs are anchored while inert style remains", async () => {
  const html = '<figure class="kg-image-card" style="background-image:url(\'../poster.jpg?x=1&amp;y=2#crop\');color:rebeccapurple"><img src="../photo.jpg" alt="Photograph"></figure>';
  const { document } = await prepared(html), style = one(document, "figure").attribs.style;
  const targets = [...style.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gu)].map((match) => match[1] ?? match[2] ?? match[3]);
  assert.deepEqual(targets, ["https://ghost.example/articles/poster.jpg?x=1&y=2#crop"]);
  assert.match(style, /color\s*:\s*rebeccapurple/iu);
});

test("unparsed CSS escaped target grammar receives an exact reference limitation", async () => {
  await unavailable('<figure class="kg-image-card" style="background-image:url(&quot;\\2e\\2e /hidden.png&quot;)"><img src="../photo.jpg" alt="Photograph"></figure>', [/css|style/iu, /escape|reference|grammar/iu]);
});

test("valid original Lexical and HTML capture remain untouched during passive preparation", async () => {
  const html = "<p>Original text</p>";
  const lexical = JSON.stringify({ root: { type: "root", version: 1, format: "", direction: "ltr", indent: 0, children: [{ type: "paragraph", version: 1, format: "", direction: "ltr", indent: 0, children: [{ type: "extended-text", version: 1, detail: 0, format: 0, mode: "normal", style: "", text: "Original text" }] }] } });
  const { document, capture } = await prepared(html, { lexical });
  assert.equal(textOf(document), "Original text");
  assert.equal(capture.html, html);
  assert.equal(capture.lexical, lexical);
});

test("actual Lexical card visibility without an established audience gets a context-specific limitation", async () => {
  const html = "<p>Paid-member analysis</p>";
  const lexical = JSON.stringify({ root: { type: "root", version: 1, format: "", direction: "ltr", indent: 0, children: [{ type: "html", version: 1, html, visibility: { web: { nonMember: false, memberSegment: "status:-free" }, email: { memberSegment: "status:-free" } } }] } });
  await unavailable(html, [/visibility|audience/iu, /card|context|lexical/iu], { lexical });
});

test("malformed supplied Lexical is a capture/context diagnostic, while absent Lexical is not a universal gate", async () => {
  await unavailable("<p>Ordinary source</p>", [/lexical/iu, /capture|context|malformed|json|invalid/iu], { lexical: '{"root":' });
  const { document } = await prepared("<p>Ordinary source</p>", { lexical: null });
  assert.equal(textOf(document), "Ordinary source");
});
