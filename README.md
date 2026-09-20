# DiscussionBridge for Ghost

```sh
git clone https://github.com/DiscussionBridge/ghost-discussion-bridge.git
```

This is the publishing-side Ghost adapter for the DiscussionBridge Alpha. It
runs as a small loopback-only Node service beside Ghost.

- Ghost `post.published` webhooks enter through one exact path and must carry
  Ghost's native `X-Ghost-Signature` HMAC with a current timestamp.
- The service sends bounded authenticated create-or-resolve requests to the
  receiving Discourse plugin and durably stores the returned resource/topic
  identity.
- The request carries Ghost's rendered published HTML as a bounded content
  snapshot, so the receiving topic contains the article rather than only a
  companion link. Empty or oversized source content fails before delivery.
- Ghost's stable author identities, display names, profile URLs and primary
  author are reported to the receiving connection. The forum operator still
  chooses fixed or mapped Discourse authorship in that connection's Authors
  tab; source identities never acquire forum authority by themselves.
- Explicitly registered From Discourse resources are pulled server-side and
  exposed through a same-origin Nginx route as sanitized HTML. The supplied
  loader renders that HTML into an explicit Ghost post placeholder, then adds
  the same topic's comments-only Interactive surface. The imported first
  post remains the article and is not repeated in the discussion frame; its
  replies, session and reply controls remain owned by Discourse. A validated
  topic identity is required before either presentation is exposed.
- When the connection enables forum publication, the adapter registers Ghost's
  native Posts, Pages and Tags with the receiver, then consumes the receiver's
  bounded source-topic and revocation feeds. The forum operator chooses the
  eligible categories and tags and maps them to the real Ghost destination;
  the adapter owns the cursor, native persistence, retry and failure behavior.
  `npm run sync:publications` is the explicit initial/backfill operation. It
  drafts a uniquely topic-marked Ghost item before
  reserving its Bridge Record, publishes only after the exact resource/topic/
  destination tuple is durable, and acknowledges the exact source, mapping and
  publication revisions. An unchanged rerun adopts the same native item and
  creates no duplicate. A changed first post updates it; a topic that becomes
  ineligible or unmapped is returned to draft and reported as held. The native
  item carries a source/provenance note and mapped Interactive discussion. It
  is tagged `#discussionbridge-source`, not the outbound `#discussionbridge`
  opt-in, preventing a publication loop.
  After that initial pass completes, `npm run sync:publication-work` is the
  steady-state worker: it claims at most 20 receiver-owned work items with an
  exact five-minute lease, materializes or drafts the one identified native
  item, acknowledges only against that lease, and reports bounded failures to
  the receiver for shared attention/retry handling. It does not rescan the
  whole forum. The original Discourse topic creation time becomes Ghost's
  `published_at`; later first-post changes update the same item without
  rewriting its publication date.
- Published Ghost posts can render their exact mapped Discourse discussion.
  The same-origin loader resolves the current canonical Ghost URL through the
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
  attribute remains the backwards-compatible `full` mode. The historical
  `fullInteractive` token is accepted as a compatibility alias, normalized to
  `interactive`, and never emitted by new adapter output; every other value
  fails closed.
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
edit/delete synchronization or a generic control plane.

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

For a separately hosted companion, set `DISCUSSIONBRIDGE_OPERATOR_ORIGIN` to
the operator page's public HTTPS origin. It defaults to the Ghost origin for a
same-host installation. This makes the status boundary portable without
introducing shared hosting, tenancy or a DiscussionBridge control plane.

## Required environment

`DISCUSSIONBRIDGE_SERVER_URL`, `DISCUSSIONBRIDGE_CONNECTION_ID`,
`DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE`, `DISCUSSIONBRIDGE_GHOST_ORIGIN`,
`DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE`, and
`DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE`, and
`DISCUSSIONBRIDGE_STATE_FILE`. `DISCUSSIONBRIDGE_OPERATOR_PASSWORD_FILE`
enables the protected operator surface. `DISCUSSIONBRIDGE_OPERATOR_ORIGIN` is
optional and defaults to the Ghost origin. `DISCUSSIONBRIDGE_PORT` defaults to
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

Forum publication places the Discourse topic ID, publication revision and
Bridge Record resource UUID in internal Ghost tags. The topic marker exists on
the initial draft, so a lost Ghost create response is adopted rather than
repeated. The resource and revision markers prove later updates and exact
retries. One global synchronization lease prevents concurrent runs; no marker
or multiple matching markers fails closed for operator reconciliation.

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
<script defer src="/discussionbridge/assets/loader.js"></script>
```

A To Discourse post can render its mapped replies with:

```html
<div data-discussionbridge-comments="interactive"></div>
<script defer src="/discussionbridge/assets/loader.js"></script>
```

Managed Ghost hosts do not need to expose shell access to each publisher. The
provider installs and operates the companion adapter service on the Ghost
server, together with its protected credentials, persistent state and narrow
reverse-proxy routes. Ghost Admin configures the native custom integration; it
does not install the companion service. See
[`docs/MANAGED_HOSTING.md`](docs/MANAGED_HOSTING.md) for the exact boundary.

## Demo community footer

`demo/ghost-demo-navigation.js` augments the stock Source theme at runtime; it
does not edit Ghost's upgrade-owned theme files. In addition to the demo-page
navigation, it adds one accessible footer collection for the DiscussionBridge
forum, GitHub organization, Bluesky, Discord invite, Mastodon, Reddit, X and
YouTube.

The live demo serves this exact asset at
`/discussionbridge/assets/demo-navigation.js`. Its current exact SHA-256 is
recorded after each deployed demo update.
Its root-protected rollback package is
`/var/backups/discussionbridge/ghost-social-links-pre-20260901`.
The stock Ghost defaults that linked X and Facebook to Ghost's own accounts
were cleared during this deployment; their exact prior values are preserved in
that rollback package. The dedicated DiscussionBridge footer is therefore the
only social collection on the demo.
