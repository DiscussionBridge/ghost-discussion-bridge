# DiscussionBridge for Ghost

```sh
git clone https://github.com/DiscussionBridge/ghost-discussion-bridge.git
git -C ghost-discussion-bridge checkout --detach FULL_RELEASE_COMMIT_ID
```

Replace `FULL_RELEASE_COMMIT_ID` with the complete commit ID from the selected
release record. Install from that immutable checkout or its verified package;
a branch checkout or the version string alone does not identify these files.

This is the publishing-side Ghost adapter for the DiscussionBridge Alpha. It
runs as an external, loopback-only Node service on the adapter operator's Linux
host. Every operator uses the same essential installation, without custom
routing on the customer's Ghost server. Start with
[the common installation guide](docs/INSTALLATION.md).

- Selected Ghost `post.published` and `post.published.edited` webhooks enter through one exact path and must carry
  Ghost's native `X-Ghost-Signature` HMAC with a current timestamp.
- The service sends bounded authenticated create-or-resolve requests to the
  receiving Discourse plugin and durably stores the returned resource/topic
  identity.
- The request carries the complete portable HTML digest and authoritative
  native dates. Large content uses a bounded valid-HTML excerpt with a canonical
  Read More link; the native original is never truncated. The existing posts
  state retains the exact source revision, compare-and-swap operand and receipt
  so an ambiguous retry cannot erase an accepted update.
- Ghost's stable author identities, display names, profile URLs and primary
  author are reported to the receiving connection. The forum operator still
  chooses fixed or mapped Discourse authorship in that connection's Authors
  tab; source identities never acquire forum authority by themselves.
- Explicitly registered From Discourse resources are pulled server-side and
  exposed through the adapter's public HTTPS route as sanitized HTML. The supplied
  loader renders that HTML into an explicit Ghost post placeholder, then adds
  the same topic's comments-only Interactive surface. The imported first
  post remains the article and is not repeated in the discussion frame; its
  replies, session and reply controls remain owned by Discourse. A validated
  topic identity is required before either presentation is exposed.
- A From Discourse binding may separately authorize **native
  materialization**. `npm run sync:publications` then creates or updates a
  genuine Ghost post or page through Ghost's Admin API. Select
  `DISCUSSIONBRIDGE_PUBLICATION_TYPE=post|page` before first publication;
  omission retains posts. Existing mappings are posts and changing their type
  requires reconciliation. Presentation-only records are ignored.
  The one publication state map stores coherent source editions, native type and ID,
  so source/wiki body, title, dates and author/forum-name changes update the same
  post. Owned body boundaries and precise managed-field evidence preserve
  unrelated native content/tags and local Simple/Full/Interactive selections;
  conflicting local managed edits require attention. The native post carries
  generic source/provenance metadata and its selected discussion; it is tagged `#discussionbridge-source`,
  not the outbound `#discussionbridge` opt-in, preventing a publication loop.
- An explicit source withdrawal drafts only the exactly owned native post and
  removes public presentation access. Protected state retains identity/metadata;
  native Ghost retains the private body for recovery. Restoration uses the same
  post. Public URL/cache withdrawal is not claimed without verification.
- Published Ghost posts can render their exact mapped Discourse discussion.
  The external loader resolves the current canonical Ghost URL through the
  adapter's nonsecret comments endpoint, then starts Discourse's standard
  comments embed with the already-recorded topic ID. No credential or topic
  identity is placed in Ghost content.
  `data-discussionbridge-comments="full"` selects standard plugin-free
  comments. `data-discussionbridge-comments="simple"` selects native bounded
  reply cards with an initial five comments, a **Show more comments** disclosure,
  and a hard 50-reply ceiling before continuing on The Bridge.
  `data-discussionbridge-comments="interactive"` selects the
  receiving plugin's full-app reader experience in a bounded application
  viewport. The 800px frame and 360px minimum are explicit DiscussionBridge
  defaults shared with the Astro adapter; `dynamicHeight` is disabled so long
  discussions scroll inside the frame instead of growing the host page without
  bound. Ghost does not inherit Discourse's otherwise implicit 600px embed
  default. An empty
  attribute selects `full` mode. Only `simple`, `full` and `interactive` are
  accepted; every other value fails closed, without an alias or conversion.
  The stock Ghost demo's theme-level integration selects the per-post mode from
  internal tags: `#discussionbridge-simple`, `#discussionbridge-full`, or the
  default `#discussionbridge` Interactive path. The mode marker belongs to
  the theme integration rather than authored article HTML.
  The loader renders a native page-level `Discussion` heading and an
  `Open discussion` link from the validated stored topic URL before the
  comments surface.
- The credential-free loader builds an **On this page** navigation from two or
  more `h2`/`h3` headings. For To Discourse articles it uses the native Ghost
  article headings; for From Discourse pages it waits for the sanitized forum
  content and builds the same navigation from that content.
- The same locally bundled loader renders Mermaid diagrams and inline or block
  math in both directions. No browser request to a third-party renderer or CDN
  is required; the companion stylesheet and font data ship with the adapter.

Bridge and webhook secrets live in root-protected files. They are never
accepted through public JSON, returned in responses, or written to the state
file. The service binds only to loopback. It does not implement Ghost-to-forum
edit/delete synchronization, forum deletion propagation, or a generic control
plane.

## Operator status

Set `DISCUSSIONBRIDGE_OPERATOR_PASSWORD_FILE` to a root-managed credential file
readable by the adapter service. The reverse proxy may then expose the exact
`/discussionbridge/operator/` and
`/discussionbridge/operator/synchronize` routes over HTTPS. Sign in with the
fixed username `discussionbridge` and the separate operator password.

The protected page shows the latest durable synchronization totals, current
Ghost-to-Discourse mappings, Discourse-to-Ghost publications, attention states,
bounded failure reasons and source/destination links. Its synchronization
button is an exact-origin POST and shares the same durable operation path as
`npm run sync:publications`. The page never displays the receiver credential,
Ghost Admin API key, webhook secret or operator password.

Operator access defaults to `DISCUSSIONBRIDGE_ADAPTER_ORIGIN`, never the Ghost
origin. The common installer uses that same adapter address for every operator.
`DISCUSSIONBRIDGE_OPERATOR_ORIGIN` remains an explicit advanced override for an
operator's separately configured HTTPS surface. This keeps status portable without
introducing shared hosting, tenancy or a DiscussionBridge control plane.

## Required environment

`DISCUSSIONBRIDGE_SERVER_URL`, `DISCUSSIONBRIDGE_CONNECTION_ID`,
`DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE`, `DISCUSSIONBRIDGE_GHOST_ORIGIN`,
`DISCUSSIONBRIDGE_ADAPTER_ORIGIN`,
`DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE`, and
`DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE`, and
`DISCUSSIONBRIDGE_STATE_FILE`. `DISCUSSIONBRIDGE_OPERATOR_PASSWORD_FILE`
enables the protected operator surface. `DISCUSSIONBRIDGE_OPERATOR_ORIGIN` is
optional and defaults to the adapter origin. `DISCUSSIONBRIDGE_GHOST_ADMIN_ORIGIN`
optionally selects a separate Ghost Admin HTTPS origin; it otherwise uses the
public Ghost origin. `DISCUSSIONBRIDGE_PORT` defaults to
`8792` and `DISCUSSIONBRIDGE_LANE` is optional.

Only posts carrying Ghost's internal `#discussionbridge` tag are eligible.
Configure only the `post.published` event; ordinary published edits are not an
implemented synchronization surface.

When DiscussionBridge supplies the article discussion, open Ghost Admin at
**Settings → Membership** and set **Who can comment on posts?** to **Nobody**.
Otherwise Ghost's separate Members comment section is rendered alongside the
DiscussionBridge/Discourse discussion and incorrectly suggests that Ghost
membership participates in the Bridge identity or reply flow.

Run `npm run install:rich-content` after the service is configured. Ghost 6.59
allows a custom-integration token to read Code Injection but denies the write.
When that boundary is encountered, the command returns
`manual_required: true`, the exact Ghost Admin Site Footer location and the
versioned bootstrap to paste. It does not report the denial as an unexplained
generic installation failure.

On Linux, the adapter requires executable `/usr/bin/flock` from `util-linux`
and its current Node runtime. Service and command entry points verify those
exact paths before doing work and fail closed with a direct diagnostic when a
prerequisite is absent. The process holding the kernel lock also owns the whole
durable transaction: it reads state, accepts one bounded replacement over a
local pipe, writes and fsyncs a private temporary file, performs the atomic
rename, fsyncs the state directory, and only then acknowledges commit. The
adapter process never publishes that file. Helper death before rename therefore
cannot commit; helper death after rename means the commit completed while lock
ownership still existed and a retry remains idempotent. On non-Linux
development hosts, the portable hard-link fallback preserves mutual exclusion
but intentionally does not reclaim locks after a process crash.

Native From Discourse publication uses a durable local intent before calling
Ghost and places the Bridge Record resource UUID and hashed source revision in
internal Ghost tags. The readable source revision remains in the generated
article provenance, but Ghost normalizes that authored HTML and the internal
tags are the machine identity. A lost create or update response is
reconciled by that exact marker, canonical URL, slug and source revision before
local completion is recorded. Concurrent workers wait on the current intent.
After a crashed create intent expires, exactly one marked Ghost post may be
adopted; no marker requires operator reconciliation and multiple markers fail
closed. The adapter never repeats an uncertain create merely because its local
completion record is missing.

Simple mode presents the forum-controlled official Discourse attribution and
the independent **Connected by DiscussionBridge** credit as separate lines.
The latter remains present regardless of the forum-wide Discourse branding
setting.

Register a From Discourse resource without exposing credentials:

```text
node src/register-presentation.mjs RESOURCE_UUID
```

The Ghost post contains an HTML card such as:

```html
<div data-discussionbridge-resource="RESOURCE_UUID"></div>
```

Use the prepared Site Footer bootstrap for the script. For a manually placed
loader, use the exact absolute asset URL from that preparation, not a relative
Ghost-server URL. The stock footer recognizes connected/source internal tags;
an explicit placeholder on another page needs its explicitly placed loader.

A To Discourse post can render its mapped replies with:

```html
<div data-discussionbridge-comments="interactive"></div>
```

Managed Ghost hosts do not need to expose shell access to each publisher. The
operator installs and operates the external adapter on its chosen Linux host,
together with protected credentials, persistent state and that host's HTTPS
proxy. The customer Ghost server needs no custom route. Ghost Admin configures
the native custom integration and supported Site Footer hook; it
does not install the companion service. See
[`docs/MANAGED_HOSTING.md`](docs/MANAGED_HOSTING.md) for the exact boundary.

## Demo community footer

`demo/ghost-demo-navigation.js` augments the stock Source theme at runtime; it
does not edit Ghost's upgrade-owned theme files. In addition to the demo-page
navigation, it adds one accessible footer collection for the DiscussionBridge
forum, GitHub organization, Bluesky, Discord invite, Mastodon, Reddit, X and
YouTube.

This is an optional demo/theme sample. The adapter's browser-asset endpoint
serves only `loader.js`, `loader.css` and `rich-content.js`; it does not serve
the demo navigation script. An operator using the sample supplies its own
supported theme or code-injection hook and static asset address. Normal adapter
installation does not change Ghost's social links or theme settings.
