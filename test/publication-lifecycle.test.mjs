import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";
import sanitizeHtml from "sanitize-html";
import { Parser } from "htmlparser2";
import { browserDeployment } from "../src/browser-deployment.mjs";
import { isInteractiveCommentsMode, normalizeCommentsMode } from "../src/comments-mode.mjs";
import { nativePublication, syncPublications } from "../src/publication-sync.mjs";
import { browserLoaderUrl } from "../src/browser-assets.mjs";
import { commentsBootstrap } from "../src/install-rich-content.mjs";
import { PRODUCT_VERSION } from "../src/version.mjs";
import { sourceTime } from "../src/source-time.mjs";

const config = { adapterOrigin: "https://adapter.example", ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example" };
const record = {
  resource_id: "11111111-1111-4111-8111-111111111111", direction: "from_discourse", state: "healthy", topic_id: 42,
  title: "Native publication", content_html: "<p>Owned native body</p>",
  source: { platform: "discourse", origin: config.serverUrl, topic_id: 42, topic_url: `${config.serverUrl}/t/native/42`, post_id: 99,
    post_number: 1, post_version: 1, revision: "post:99:version:1", author: { name: "Source author", profile_url: `${config.serverUrl}/u/author` } },
  bindings: [{ role: "presentation", state: "active", canonical_url: `${config.ghostOrigin}/native/`, native_materialization: true }],
};
const bridge = { records: async () => ({ bridge_records: [record], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };

async function sourceBody(name, expectedImports) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .*? from "([^"]+)";|^import "([^"]+)";/gmu)].map((match) => match[1] ?? match[2]);
  assert.deepEqual(imports, expectedImports);
  return source.replace(/^import .*?;\r?\n/gmu, "").replace(/^export /gmu, "");
}

async function loaderScript() {
  // Execute the actual loader source in a synthetic DOM; only import resolution
  // and rich renderers are substituted. This is not a live browser/theme gate.
  return new vm.Script(`(() => { "use strict"; ${await sourceBody("browser-loader.mjs", ["katex", "katex/dist/katex.min.css", "mermaid", "./comments-mode.mjs", "./browser-deployment.mjs"])} })()`);
}

function browserContext(document, window, fetcher) {
  return vm.createContext({ document, window, URL, NodeFilter: { SHOW_TEXT: 4 }, fetch: fetcher,
    browserDeployment, isInteractiveCommentsMode, normalizeCommentsMode,
    katex: { render() {} }, mermaid: { initialize() {}, async run() {} } });
}

function memoryStore(prior) {
  const state = { publications: prior ? { [record.resource_id]: structuredClone(prior) } : {}, posts: {}, presentations: {} };
  return { state, read: async () => structuredClone(state), update: async (callback) => callback(state) };
}

async function publicationCandidate(loaderUrl) {
  const source = await sourceBody("publication-sync.mjs", ["./version.mjs", "sanitize-html", "./browser-assets.mjs", "node:crypto", "node:timers/promises", "htmlparser2", "./source-time.mjs"]);
  return new Function("PRODUCT_VERSION", "browserLoaderUrl", "createHash", "randomUUID", "delay", "sanitizeHtml", "Parser", "sourceTime", `"use strict"; ${source}; return { nativePublication, syncPublications };`)(
    PRODUCT_VERSION, loaderUrl, createHash, randomUUID, delay, sanitizeHtml, Parser, sourceTime);
}

function remoteGhost(publication, { staleAddress, loseResponse = false, noPersist = false } = {}) {
  const post = { id: "a".repeat(24), title: publication.title, slug: publication.slug, url: publication.destination,
    html: staleAddress ? publication.html.replace(/https:\/\/adapter\.example\/discussionbridge\/assets\/loader\.js\?v=[a-f0-9]{64}/u, staleAddress) : publication.html,
    tags: [{ name: publication.resourceTag }, { name: publication.revisionTag }], updated_at: "2026-10-01T00:00:00.000Z" };
  if (!staleAddress && publication.presentationTag) post.tags.push({ name: publication.presentationTag });
  return { post, updates: 0, creates: 0,
    findByResource: async () => [structuredClone(post)],
    create() { this.creates += 1; throw new Error("Must never create a second identity"); },
    async update(id, payload) {
      assert.equal(id, post.id); this.updates += 1;
      if (!noPersist) Object.assign(post, structuredClone(payload), { updated_at: "2026-10-01T00:01:00.000Z" });
      if (loseResponse) throw new Error("Synthetic lost update response");
    },
  };
}

for (const adapterVersion of [PRODUCT_VERSION, "0.1.0-alpha.99"]) {
  for (const staleAddress of ["/discussionbridge/loader.js?v=0.1.0-alpha.99", `https://adapter.example/discussionbridge/assets/loader.js?v=${"0".repeat(64)}`]) {
    test(`owned presentation reconciliation replaces retained address at ${adapterVersion}: ${staleAddress}`, async () => {
      const publication = nativePublication(record, config);
      const store = memoryStore({ state: "complete", ghost_post_id: "a".repeat(24), canonical_url: publication.destination,
        revision: publication.revision, adapter_version: adapterVersion });
      const ghost = remoteGhost(publication, { staleAddress, loseResponse: true });
      const first = await syncPublications(config, store, bridge, ghost);
      assert.equal(first.failed, 0); assert.equal(first.updated, 1); assert.equal(ghost.updates, 1); assert.equal(ghost.creates, 0);
      assert.equal(ghost.post.html.includes(staleAddress), false);
      assert.ok(ghost.post.html.includes(browserLoaderUrl(config)));
      assert.equal(ghost.post.url, publication.destination); assert.equal(ghost.post.id, "a".repeat(24));
      assert.equal(store.state.publications[record.resource_id].presentation_revision, publication.presentationRevision);
      assert.equal((await syncPublications(config, store, bridge, ghost)).unchanged, 1);
      assert.equal(ghost.updates, 1);
    });
  }
}

test("revision-only acknowledgments cannot claim a persisted presentation update", async () => {
  const publication = nativePublication(record, config);
  const ghost = remoteGhost(publication, { staleAddress: "/discussionbridge/loader.js?v=old", noPersist: true });
  const store = memoryStore({ state: "complete", ghost_post_id: ghost.post.id, canonical_url: publication.destination, revision: publication.revision, adapter_version: PRODUCT_VERSION });
  const result = await syncPublications(config, store, bridge, ghost);
  assert.equal(result.failed, 1); assert.equal(result.updated, 0); assert.equal(ghost.updates, 1);
  assert.equal(store.state.publications[record.resource_id].state, "attention");
});

test("changed asset bytes reconcile separately from source and product labels, including rollback", async () => {
  // The actual publication source is consumed with only its asset-address
  // dependency substituted in memory. No packaged asset is edited by this test.
  const versions = ["synthetic asset bytes one", "synthetic asset bytes two"].map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  let assetVersion = versions[0];
  const candidate = await publicationCandidate((deployment) => `${deployment.adapterOrigin}/discussionbridge/assets/loader.js?v=${assetVersion}`);
  const original = candidate.nativePublication(record, config);
  const ghost = remoteGhost(original);
  const store = memoryStore({ state: "complete", ghost_post_id: ghost.post.id, canonical_url: original.destination,
    revision: original.revision, adapter_version: PRODUCT_VERSION, presentation_revision: original.presentationRevision });
  for (const version of [versions[1], versions[0]]) {
    assetVersion = version;
    const current = candidate.nativePublication(record, config);
    const summary = await candidate.syncPublications(config, store, bridge, ghost);
    assert.equal(summary.failed, 0); assert.equal(summary.updated, 1);
    assert.ok(ghost.post.html.includes(`?v=${version}`));
    assert.equal(store.state.publications[record.resource_id].presentation_revision, current.presentationRevision);
    assert.equal(store.state.publications[record.resource_id].revision, original.revision);
    assert.equal((await candidate.syncPublications(config, store, bridge, ghost)).unchanged, 1);
  }
  assert.equal(ghost.updates, 2); assert.equal(ghost.creates, 0); assert.equal(ghost.post.id, "a".repeat(24));
});

function element(attributes = {}, className = "") {
  return { attributes: { ...attributes }, className, dataset: {}, children: [], textContent: "Source author and revision", innerHTML: "",
    getAttribute(name) { return this.attributes[name] ?? null; }, setAttribute(name, value) { this.attributes[name] = value; },
    matches(selector) { return selector === ".discussionbridge-publication" && this.className === "discussionbridge-publication"; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }, before() {}, after() {},
  };
}

test("footer refresh qualifies current execution, not stale loader markers, and retries failed loading", async () => {
  for (const staleAddress of ["/discussionbridge/loader.js?v=old", `https://adapter.example/discussionbridge/assets/loader.js?v=${"0".repeat(64)}`]) {
    const appended = [], stale = { src: staleAddress };
    const body = element(); body.classList = { contains: (value) => value === "tag-hash-discussionbridge-source" };
    body.appendChild = (node) => appended.push(node);
    const document = { body, readyState: "complete", querySelector: (selector) => selector === 'script[data-discussionbridge-loader]' ? stale : null,
      createElement: () => { const node = element(); node.addEventListener = (name, listener) => { node[name] = listener; }; return node; } };
    const window = { location: { origin: config.ghostOrigin } };
    const code = commentsBootstrap(config).replace(/^<script[^>]*>/u, "").replace(/<\/script>$/u, "");
    vm.runInNewContext(code, { window, document });
    assert.equal(appended.length, 1); assert.equal(appended[0].src, browserLoaderUrl(config));
    vm.runInNewContext(code, { window, document }); assert.equal(appended.length, 1);
    appended[0].error();
    vm.runInNewContext(code, { window, document }); assert.equal(appended.length, 2);
  }
});

test("producer provenance remains separate from presentation mounts, including retained legacy markup", async () => {
  const publication = nativePublication(record, config);
  const browser = await loaderScript();
  for (const legacy of [false, true]) {
    for (const registered of [false, true]) {
      const aside = /<aside ([^>]+)>/u.exec(publication.html)[1];
      const attributes = Object.fromEntries([...aside.matchAll(/([a-z-]+)="([^"]*)"/gu)].map((match) => [match[1], match[2]]));
      if (legacy) { delete attributes["data-discussionbridge-publication-resource"]; attributes["data-discussionbridge-resource"] = record.resource_id; }
      const provenance = element(attributes, "discussionbridge-publication");
      const document = { currentScript: { src: browserLoaderUrl(config) }, body: { classList: { contains: () => false } },
        querySelector: () => null, querySelectorAll: (selector) => selector === "[data-discussionbridge-resource]" && attributes["data-discussionbridge-resource"] ? [provenance] : [],
        head: element(), createElement: () => element(), createTreeWalker: () => ({ nextNode: () => false }) };
      let requests = 0;
      const context = browserContext(document, {}, async () => { requests += 1; return { ok: registered, text: async () => "<p>Presentation</p>" }; });
      browser.runInContext(context);
      await new Promise((resolve) => setImmediate(resolve));
      browser.runInContext(context);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 0); assert.equal(provenance.textContent, "Source author and revision"); assert.equal(provenance.innerHTML, "");
    }
  }
});

test("an attention state with the new digest retries rather than claiming unchanged", async () => {
  const publication = nativePublication(record, config);
  const ghost = remoteGhost(publication, { staleAddress: "/discussionbridge/loader.js?v=old", noPersist: true });
  const store = memoryStore({ state: "complete", ghost_post_id: ghost.post.id, canonical_url: publication.destination, revision: publication.revision, adapter_version: PRODUCT_VERSION });
  assert.equal((await syncPublications(config, store, bridge, ghost)).failed, 1);
  assert.equal(store.state.publications[record.resource_id].presentation_revision, publication.presentationRevision);
  assert.equal((await syncPublications(config, store, bridge, ghost)).failed, 1);
  assert.equal(ghost.updates, 2); assert.equal(ghost.creates, 0);
});

test("a new presentation tag without usable retained markup is not acknowledgment", async () => {
  const publication = nativePublication(record, config);
  const ghost = remoteGhost(publication, { staleAddress: "/discussionbridge/loader.js?v=old", noPersist: true });
  ghost.post.tags.push({ name: publication.presentationTag });
  const result = await syncPublications(config, memoryStore(), bridge, ghost);
  assert.equal(result.failed, 1); assert.equal(result.updated, 0); assert.equal(ghost.updates, 1);
});

test("loader URLs in non-executable markup cannot acknowledge a presentation", async () => {
  const publication = nativePublication(record, config);
  const script = /<script[^>]*>[\s\S]*?<\/script>/u.exec(publication.html)[0];
  for (const replacement of [`<img src="${publication.loaderUrl}">`, `<!-- ${script} -->`, script.replace("<script ", '<script type="application/json" '), script.replace("<script ", "<script nomodule ")]) {
    const ghost = remoteGhost(publication, { noPersist: true });
    ghost.post.html = publication.html.replace(script, replacement);
    const result = await syncPublications(config, memoryStore(), bridge, ghost);
    assert.equal(result.failed, 1); assert.equal(result.updated, 0); assert.equal(ghost.updates, 1);
  }
});

test("inert, raw-text and foreign loader or provenance contexts cannot acknowledge presentation", async () => {
  const publication = nativePublication(record, config);
  const script = /<script[^>]*>[\s\S]*?<\/script>/u.exec(publication.html)[0];
  const aside = /<aside[^>]*>[\s\S]*?<\/aside>/u.exec(publication.html)[0];
  const variants = [
    `<template>${publication.html}</template>`,
    publication.html.replace(script, `<template>${script}</template>`),
    publication.html.replace(script, `<noscript>${script}</noscript>`),
    publication.html.replace(aside, `<template>${aside}</template>`),
    publication.html.replace(aside, `<noscript>${aside}</noscript>`),
    ...["svg", "math", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext", "select"].map((tag) => publication.html.replace(script, `<${tag}>${script}</${tag}>`)),
    publication.html.replace(script, `<svg><foreignObject>${script}</foreignObject></svg>`),
  ];
  for (const html of variants) {
    const ghost = remoteGhost(publication, { noPersist: true });
    ghost.post.html = html;
    const store = memoryStore();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await syncPublications(config, store, bridge, ghost);
      assert.equal(result.failed, 1, html);
      assert.equal(result.unchanged + result.updated + result.created, 0);
      assert.equal(store.state.publications[record.resource_id].state, "attention");
    }
    assert.equal(ghost.post.html, html); assert.equal(ghost.creates, 0);
  }
});

for (const [name, wrap] of [
  ["outside div close through template", (html) => `<div><template></div>${html}</template>`],
  ["outside section close through template and paragraph", (html) => `<section><template><p></section>${html}</template>`],
  ["outside ancestor through nested template descendants", (html) => `<div><template><section></div>${html}</section></template>`],
  ["another explicit template after the implied close", (html) => `<div><template></div><template>Inert decoy</template>${html}</template>`],
  ["unclosed template after an outside close", (html) => `<div><template></div>${html}`],
  ["outside ancestor through two unsupported contexts", (html) => `<div><template><noscript></div>${html}</noscript></template>`],
  ["outside ancestor through noscript", (html) => `<div><noscript></div>${html}</noscript>`],
  ["outside ancestor through select", (html) => `<div><select></div>${html}</select>`],
  ["loader script implicitly closed at end of input", (html) => html.replace("</script>", "")],
]) {
  test(`ambiguous presentation context refuses success across serialized reentry: ${name}`, async () => {
    const publication = nativePublication(record, config);
    const ghost = remoteGhost(publication, { noPersist: true });
    ghost.post.html = wrap(publication.html);
    let prior;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const store = memoryStore(prior);
      const result = await syncPublications(config, store, bridge, ghost);
      assert.equal(result.failed, 1, name);
      assert.equal(result.created + result.updated + result.unchanged, 0, name);
      assert.equal(store.state.publications[record.resource_id].state, "attention", name);
      assert.equal(store.state.publications[record.resource_id].ghost_post_id, ghost.post.id);
      prior = JSON.parse(JSON.stringify(store.state.publications[record.resource_id]));
    }
    assert.equal(ghost.updates, 0); assert.equal(ghost.creates, 0);
  });
}

test("ordinary executable markup accepts legitimate implied and void closes beside inert lookalikes", async () => {
  const publication = nativePublication(record, config);
  for (const html of [
    `<section>${publication.html}</section>`,
    `<template>${publication.html}</template>${publication.html}`,
    `<template><p>First<p>Second</template>${publication.html}`,
    `<noscript>${publication.html}</noscript>${publication.html}`,
    `<img src="/unrelated"><br>${publication.html}`,
    `<p>First paragraph<p>Second paragraph${publication.html}`,
    `<ul><li>One<li>Two</ul>${publication.html}`,
    `<dl><dt>Term<dd>Meaning</dl>${publication.html}`,
    `<select><optgroup label="A"><option>One<option>Two<optgroup label="B"><option>Three</select>${publication.html}`,
    `<svg/>${publication.html}`,
    `<math/>${publication.html}`,
    `<svg><path d="M0 0"/></svg>${publication.html}`,
    `<svg><foreignObject>${publication.html}</foreignObject></svg>${publication.html}`,
  ]) {
    const ghost = remoteGhost(publication, { noPersist: true }); ghost.post.html = html;
    const store = memoryStore();
    const result = await syncPublications(config, store, bridge, ghost);
    assert.equal(result.failed, 0, html); assert.equal(result.unchanged, 1, html);
    assert.equal(store.state.publications[record.resource_id].state, "complete", html);
    assert.equal(ghost.updates + ghost.creates, 0);
  }
});

test("an ambiguous retained template requires operator correction before usable owned readback", async () => {
  const publication = nativePublication(record, config);
  const ghost = remoteGhost(publication);
  ghost.post.html = `<div><template></div>${publication.html}</template>`;
  const store = memoryStore();
  const result = await syncPublications(config, store, bridge, ghost);
  assert.equal(result.failed, 1); assert.equal(result.updated, 0); assert.equal(result.unchanged, 0);
  assert.equal(ghost.updates, 0); assert.equal(ghost.creates, 0);
  assert.equal(ghost.post.html, `<div><template></div>${publication.html}</template>`);
  assert.equal(store.state.publications[record.resource_id].state, "attention");
  ghost.post.html = publication.html;
  assert.equal((await syncPublications(config, store, bridge, ghost)).unchanged, 1);
  assert.equal(ghost.updates, 0);
});

test("unknown create recovery stays lookup-only over repeated attention reloads", async () => {
  const publication = nativePublication(record, config);
  let prior = { state: "pending", operation_id: "lost-create", pending_until: 0, canonical_url: publication.destination, revision: publication.revision };
  let creates = 0;
  const ghost = { findByResource: async () => [], create: async () => { creates += 1; throw new Error("Synthetic unknown create response"); } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const store = memoryStore(prior);
    const result = await syncPublications(config, store, bridge, ghost);
    assert.equal(result.failed, 1); assert.match(result.errors[0].reason, /requires reconciliation/u);
    assert.equal(creates, 0);
    // Serialized state, not a shared object, models reentry after restart.
    prior = JSON.parse(JSON.stringify(store.state.publications[record.resource_id]));
    assert.equal(prior.state, "attention"); assert.equal(prior.create_outcome_uncertain, true);
  }
});

test("legacy attention without a destination remains reconciliation-only", async () => {
  const store = memoryStore({ state: "attention", failure_reason: "Earlier unknown result", canonical_url: record.bindings[0].canonical_url });
  let creates = 0;
  const ghost = { findByResource: async () => [], create: async () => { creates += 1; } };
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await syncPublications(config, store, bridge, ghost)).failed, 1);
  assert.equal(creates, 0); assert.equal(store.state.publications[record.resource_id].create_outcome_uncertain, true);
});

test("lost first-create response stays uncertain until the exact marker becomes visible", async () => {
  const publication = nativePublication(record, config), store = memoryStore();
  let remote, visible = false, creates = 0;
  const ghost = {
    findByResource: async () => visible && remote ? [structuredClone(remote)] : [],
    async create(payload) {
      creates += 1;
      assert.equal(store.state.publications[record.resource_id].create_outcome_uncertain, true);
      remote = { ...structuredClone(payload), id: "b".repeat(24), url: publication.destination, updated_at: "2026-10-01T00:00:00.000Z" };
      throw new Error("Synthetic lost create response");
    },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await syncPublications(config, store, bridge, ghost)).failed, 1);
    assert.equal(creates, 1); assert.equal(store.state.publications[record.resource_id].create_outcome_uncertain, true);
  }
  visible = true;
  const recovered = await syncPublications(config, store, bridge, ghost);
  assert.equal(recovered.unchanged, 1); assert.equal(recovered.created, 0); assert.equal(recovered.failed, 0);
  assert.equal(creates, 1); assert.equal(store.state.publications[record.resource_id].ghost_post_id, remote.id);
  assert.equal(store.state.publications[record.resource_id].state, "complete");
  assert.notEqual(store.state.publications[record.resource_id].create_outcome_uncertain, true);
});

test("source, destination and asset changes cannot erase an unresolved create", async () => {
  let assetVersion = "0".repeat(64), creates = 0;
  const candidate = await publicationCandidate((deployment) => `${deployment.adapterOrigin}/discussionbridge/assets/loader.js?v=${assetVersion}`);
  const initial = candidate.nativePublication(record, config);
  let prior = { state: "attention", create_outcome_uncertain: true, canonical_url: initial.destination, revision: initial.revision, presentation_revision: initial.presentationRevision };
  const ghost = { findByResource: async () => [], create: async () => { creates += 1; throw new Error("Must not create"); } };
  for (const version of [1, 2, 3]) {
    assetVersion = String(version).repeat(64);
    const changed = { ...record, source: { ...record.source, post_version: version, revision: `post:99:version:${version}` }, bindings: [{ ...record.bindings[0], canonical_url: `${config.ghostOrigin}/native-${version}/` }] };
    const changedBridge = { records: async () => ({ bridge_records: [changed], pagination: { page: 1, pages: 1, total: 1, snapshot: "changed" } }) };
    const store = memoryStore(prior);
    assert.equal((await candidate.syncPublications(config, store, changedBridge, ghost)).failed, 1);
    assert.equal(creates, 0);
    prior = JSON.parse(JSON.stringify(store.state.publications[record.resource_id]));
    assert.equal(prior.create_outcome_uncertain, true);
  }
});

test("a pre-create lookup failure can retry a genuine first create", async () => {
  const publication = nativePublication(record, config), store = memoryStore();
  let lookups = 0, creates = 0, remote;
  const ghost = {
    async findByResource() { lookups += 1; if (lookups === 1) throw new Error("Synthetic lookup failure before any write"); return remote ? [structuredClone(remote)] : []; },
    async create(payload) { creates += 1; remote = { ...structuredClone(payload), id: "c".repeat(24), url: publication.destination }; },
  };
  assert.equal((await syncPublications(config, store, bridge, ghost)).failed, 1);
  assert.equal(store.state.publications[record.resource_id].create_outcome_uncertain, false);
  assert.equal((await syncPublications(config, store, bridge, ghost)).created, 1);
  assert.equal(creates, 1);
});

test("marked-object adoption retains its destination even when presentation updates fail", async () => {
  const publication = nativePublication(record, config);
  const ghost = remoteGhost(publication, { staleAddress: "/discussionbridge/loader.js?v=old", noPersist: true });
  const store = memoryStore({ state: "attention", create_outcome_uncertain: true, canonical_url: publication.destination });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await syncPublications(config, store, bridge, ghost)).failed, 1);
    const retained = store.state.publications[record.resource_id];
    assert.equal(retained.ghost_post_id, ghost.post.id);
    assert.equal(retained.create_outcome_uncertain, false);
  }
  assert.equal(ghost.updates, 3); assert.equal(ghost.creates, 0);
});

test("a replaced intent owner cannot update or overwrite a completed successor", async () => {
  const publication = nativePublication(record, config), store = memoryStore();
  const ghost = remoteGhost(publication, { staleAddress: "/discussionbridge/loader.js?v=old" });
  let releaseFirst, lookupStarted, lookups = 0;
  const waiting = new Promise((resolve) => { lookupStarted = resolve; });
  const heldLookup = new Promise((resolve) => { releaseFirst = resolve; });
  ghost.findByResource = async () => {
    const snapshot = structuredClone(ghost.post);
    lookups += 1;
    if (lookups === 1) { lookupStarted(); await heldLookup; }
    return [snapshot];
  };
  const first = syncPublications(config, store, bridge, ghost);
  try {
    await waiting;
    await store.update(async (state) => { state.publications[record.resource_id].pending_until = 0; });
    const second = await syncPublications(config, store, bridge, ghost);
    assert.equal(second.updated, 1); assert.equal(second.failed, 0);
  } finally { releaseFirst(); }
  assert.equal((await first).failed, 1);
  assert.equal(ghost.updates, 1); assert.equal(ghost.creates, 0);
  assert.equal(store.state.publications[record.resource_id].state, "complete");
  assert.equal(store.state.publications[record.resource_id].ghost_post_id, ghost.post.id);
});

test("a replaced intent owner cannot issue a native create or erase the successor's uncertainty", async () => {
  const store = memoryStore();
  let releaseFirst, lookupStarted;
  const waiting = new Promise((resolve) => { lookupStarted = resolve; });
  const heldLookup = new Promise((resolve) => { releaseFirst = resolve; });
  let lookups = 0, creates = 0;
  const ghost = {
    async findByResource() { lookups += 1; if (lookups === 1) { lookupStarted(); await heldLookup; } return []; },
    async create() { creates += 1; throw new Error("Synthetic uncertain successor create"); },
  };
  const first = syncPublications(config, store, bridge, ghost);
  try {
    await waiting;
    await store.update(async (state) => { state.publications[record.resource_id].pending_until = 0; });
    const second = await syncPublications(config, store, bridge, ghost);
    assert.equal(second.failed, 1);
    assert.equal(creates, 1);
    assert.equal(store.state.publications[record.resource_id].create_outcome_uncertain, true);
  } finally { releaseFirst(); }
  assert.equal((await first).failed, 1);
  assert.equal(creates, 1);
  assert.equal(store.state.publications[record.resource_id].state, "attention");
  assert.equal(store.state.publications[record.resource_id].create_outcome_uncertain, true);
  assert.equal((await syncPublications(config, store, bridge, ghost)).failed, 1);
  assert.equal(creates, 1);
});

test("registered presentation loading remains correct and initializes only once", async () => {
  for (const success of [true, false]) {
    const target = element({ "data-discussionbridge-resource": record.resource_id });
    const discussion = element({ "data-topic-id": "42", "data-topic-url": record.source.topic_url, "data-forum-origin": config.serverUrl });
    target.querySelector = (selector) => selector === "[data-discussionbridge-presentation-comments]" ? discussion : null;
    const document = { currentScript: { src: browserLoaderUrl(config) }, body: { classList: { contains: () => false } },
      querySelector: () => null, querySelectorAll: (selector) => selector === "[data-discussionbridge-resource]" ? [target] : [],
      head: element(), createElement: () => element(), createTreeWalker: () => ({ nextNode: () => false }) };
    let requests = 0;
    const window = {};
    const browser = await loaderScript();
    const context = browserContext(document, window, async (url, options) => {
      requests += 1; assert.equal(url, `${config.adapterOrigin}/discussionbridge/presentation/${record.resource_id}`);
      assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
      return { ok: success, text: async () => "<section>Native presentation</section>" };
    });
    browser.runInContext(context);
    await new Promise((resolve) => setImmediate(resolve));
    browser.runInContext(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.equal(document.head.children.filter((child) => child.src === `${config.serverUrl}/javascripts/embed.js`).length, success ? 1 : 0);
    if (success) { assert.equal(window.DiscourseEmbed.topicId, 42); assert.equal(target.innerHTML, "<section>Native presentation</section>"); }
    else assert.equal(target.textContent, "Discussion is temporarily unavailable.");
  }
});

test("footer defers qualification until authored scripts execute and keeps active discussion intact", () => {
  const listeners = [], appended = [], window = { location: { origin: config.ghostOrigin } };
  const body = element(); body.classList = { contains: (value) => value === "tag-hash-discussionbridge-source" }; body.appendChild = (node) => appended.push(node);
  const document = { body, readyState: "loading", addEventListener: (name, listener, options) => { assert.equal(name, "DOMContentLoaded"); assert.equal(options.once, true); listeners.push(listener); },
    querySelector: () => null, createElement: () => { const node = element(); node.addEventListener = () => {}; return node; } };
  const code = commentsBootstrap(config).replace(/^<script[^>]*>/u, "").replace(/<\/script>$/u, "");
  vm.runInNewContext(code, { window, document }); assert.equal(appended.length, 0);
  window.__discussionBridgeGhostLoader = browserLoaderUrl(config);
  listeners[0](); assert.equal(appended.length, 0);
});
