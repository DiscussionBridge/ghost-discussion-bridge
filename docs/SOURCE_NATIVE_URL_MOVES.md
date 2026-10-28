# Original Ghost source URL movement

The existing protected source URL action uses the current accepted binding, revision and same native writer. V4-28 reserves, V4-29 finalizes, V4-30 aborts only an established unapplied change, and V4-31 reads real URL history. This is separate from received From publication moves. It creates no post, discussion, policy, lease or new authority.

## Installed native integration

Set `DISCUSSIONBRIDGE_SOURCE_NATIVE_INTEGRATION_FILE` to an owner-only JSON file outside the runtime/web root. Its closed shape is:

```json
{
  "native_version": "ACTUAL INSTALLED VERSION",
  "theme_id": "ACTUAL INSTALLED THEME IDENTITY",
  "permalink": "/{slug}/",
  "article": { "tag": "section", "class": "actual-complete-article-class" },
  "title": { "tag": "h1", "class": "actual-title-class" },
  "prefix": "\n",
  "suffix": "\n"
}
```

These selectors, padding and permalink are illustrative, not a supplied theme or production default. Derive them from the actual installed routes/theme. `permalink` supports a literal path with exactly one `{slug}` and an ordinary lowercase hyphenated slug, up to191 characters. The old native URL and requested new URL must match that exact configured mapping. Date/category/dynamic route substitution is not implemented by this profile. `article` must select exactly one complete visible native article, `title` exactly one native title. Only exact configured whitespace-only wrapper padding, up to256 characters on each side, is excluded. Supply empty strings when there is none. No general theme-content trimming, selector fallback or request proxy on the Ghost host is introduced.

The existing Admin integration must read the original post as HTML plus Lexical, authors/tags and actual `updated_at`; browse cross-post/page slug collisions; and update the SAME post with only `slug`, `codeinjection_head`, and its old native `updated_at`. Ghost documents [HTML/Lexical retrieval and post fields](https://docs.ghost.org/admin-api/posts/overview) and [required updated_at collision detection for partial updates](https://docs.ghost.org/admin-api/posts/updating-a-post). No `source=html` conversion or body/title/author/tag/date replacement is used. The installed native version must enforce its expected-revision behavior. Its theme must expose the per-post head injection through ordinary native head rendering. Missing/forbidden/ambiguous integration stops with a concrete diagnostic and retains reservations. Site theme/version and actual native API semantics remain installation qualification inputs.

## Independent whole-publication proof

Component profile `ghost-to-source-article-20261015-r1` is a native proof recipe, not another Bridge codec or policy selector. The expected complete article comes independently from the actual original Admin post before movement. After the native write, a readback must preserve its complete HTML, Lexical, title, ordered author provenance/primary author, tags, status, visibility, native identity/UUID, actual creation/publication times, SEO canonical setting, unrelated head and complete foot. URL/slug and the returned real update time are observed changes. A relative `href`/`src` whose original target would change with the requested permalink is a concrete unsupported same-body operation; the adapter does not rewrite the article to hide it. Additional reference grammars are not qualified by this profile.

An issued PUBLIC inert head block binds the native/resource/external identity, move ID, receiver nonce, new source revision and new URL. It contains no credentials. Unrelated per-post injection is preserved exactly; a previous owned block can be replaced only when it matches retained same-object ancestry. A nonce or copied digest alone is never publication proof.

The public verifier anonymously fetches the exact configured canonical URL with no credentials, redirects, cache or referrer. It requires actual HTTP200 HTML, strict complete UTF-8, exactly one configured active article/title and the actual issued head challenge. The public transport budget scales with the independently known full article rather than a universal publication cap. It compares every complete article element/text/comment/directive/script/style token and attribute to the independently captured expected article. Attribute order and HTML entity spelling are canonicalized; text whitespace, content order, comments and function/data markup are retained. Duplicate attributes are rejected before DOM collapse. Partial articles, login/teaser pages, missing/tampered challenges and changed native editions cannot finalize. This structural recipe is not evidence of browser execution, playback, external provider availability, computed styles or an invented sanitizer policy.

The native publication SHA covers canonical UTF-8 JSON of `[profile,{title,article,challenge}]`; `article` is that complete token sequence and `challenge` the issued identity payload. The separately retained private ownership receipt hashes canonical UTF-8 JSON `["ghost-to-source-ownership-20261015-r1",fields]`. Object keys are recursively sorted; array order and null values are retained. Its fields bind before/after phase, public/Admin origins, native/type/UUID, connection/resource/external/topic IDs, old/new/actually observed source revision, move/nonce, old/new/actual URL, actual native update revision, complete HTML/Lexical hashes and counts, title/authorship/actual creation+publication times, unchanged prepared Source hash/count, original injection hashes, observed full native publication hash and integration-descriptor hash. Full prepared Source hash, native rendered publication hash and ownership-receipt hash remain distinct. The actual observed `checked_at` is separate from source dates.

## Durable state and recovery

The SAME `posts[key].cms_source.source_url_move` retains exact prepare request/receipt, immutable accepted prepared input, native before snapshot/public observation, exact new revision/challenge/partial native payload, dispatch state, actual after snapshot, complete public proof, ownership receipt and exact finalize or abort request. Native intent is durable before HTTP. A native timeout is lookup-only: observing the old object does not prove an unknown request cannot still apply, so no second PUT or guessed abort follows. Applied/uncertain movement retains both reservations and evidence. Exact protocol mutations replay their saved ID/tree; they are not repeated native writes. A definitive native refusal can abort only after the complete old object/public ownership is still established. Lost accepted abort/finalize responses replay their exact saved requests. A known typed `content_preservation_unavailable`29 rejection is durable and never automatically resent.

Successful29 stores its actual Record/current revision separately from immutable02 input/ResolveResult. Full article bytes/hash/count and original copied targets remain fixed; generated delivery changes only its existing owned Read More target. An unchanged exact native snapshot/current scoped Record returns the actual29 revision without re-preparing accepted bytes. A later genuine ordinary source edition uses that revision as predecessor and archives its ancestry. URL history comes from31, not guessed local retirement entries. Pending02/withdrawal/conflicting source moves retain their existing reconciliation guards; no implicit reactivation, replacement-authority repair or rollback is invented.

Before an authorized rollback, retain complete state and the exact runtime, native before/after and unrelated injection evidence. Do not reset a journal, clear reservations, blindly write the old slug/head, import another object or replay an unknown native request. Native rollback requires actual current identity/revision and its separately authorized reconciliation. This document and local loopback fixtures do not qualify a live Ghost installation.
