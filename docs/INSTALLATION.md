# Install the external Ghost adapter

Self-hosters, Ghost-friendly hosts and DiscussionBridge hosting operators use
the same adapter package and preparation command. The adapter runs on a Linux
host chosen by its operator, not inside Ghost or the Discourse plugin. It may
share a server with Ghost, but does not require that arrangement.

The customer Ghost server needs no custom route or reverse-proxy change. Ghost
uses its native custom integration, signed webhook and supported Site Footer
code injection. The adapter host supplies its own public HTTPS address, Node
service and reverse proxy. Each running adapter configuration belongs to one
Ghost site and one explicitly configured forum connection; this is not a
shared multi-tenant hosting control plane.

## Obtain one immutable runtime

Select the Ghost release and its compatible DiscussionBridge core release
before installation. The forum client currently calls the core's
`/discussion-bridge/v1/bridge-records` routes. The external adapter's own
`/discussionbridge/` HTTPS prefix is a separate browser/webhook address.

Clone [the Ghost repository](https://github.com/DiscussionBridge/ghost-discussion-bridge)
and detach at the complete commit ID recorded for that release, or unpack the
matching verified release package into a new runtime directory. Record the
commit ID and package SHA-256 with the installation. Do not install a moving
branch or treat the unchanged package version as proof that local changes have
been released. This guide does not establish that a new artifact is published.

The package contains the native v1 runtime, preparation scripts, installation
documentation and prebuilt browser assets. Its `package.json` allowlist excludes
tests, local caches and nested proposal helpers. Unintegrated V2 proposal
material is preserved outside the runtime; it is not an installed API feature.
Do not copy private environment files, credentials or state into a source
checkout or release package.

Build the browser assets on the release preparation machine with the locked
development dependencies, then inspect `npm pack --dry-run --ignore-scripts`
using an explicitly selected cache. The three files under `public/` are required
runtime assets, not disposable build caches. Install the locked production
dependencies on the adapter host without lifecycle scripts, as described below.

## Before preparation

Use Node 22 or newer, executable `/usr/bin/flock` from util-linux, and the
reviewed runtime package with its prebuilt browser assets. Keep runtime files
separate from private credentials and durable state. Use a dedicated non-root
service account. State and private files need a Linux filesystem supporting
owner-only permissions; a Windows-mounted development directory reporting
mode 777 is not an acceptable private credential store.

The adapter's HTTPS origin must be reachable by Ghost's webhook sender and
readers' browsers. Its operator provides DNS, a trusted TLS certificate and
the adapter-host proxy. Do not put this proxy on the customer's Ghost server.
Restrictive site security policies must permit the adapter script, stylesheet
and public data origin, plus the existing Discourse embed origin. No bridge
secret or Ghost Admin API key belongs in a browser snippet.

Prepare an environment file using [adapter.env.example](adapter.env.example).
Use real HTTPS origins and absolute file paths, not the example values. Only
listed DiscussionBridge settings are allowed. The file contains file paths,
not secret values. Keep it and the credential files private to the preparing
user and service account. Protect the containing directories from other users
and keep them outside the runtime and any web root.

For From-Discourse native publication, select
`DISCUSSIONBRIDGE_PUBLICATION_TYPE=post` or `page` before first publication.
Omitting it retains posts. The same `sync:publications` command uses Ghost's
matching Admin API resource and envelope. The single `publications` state map
retains `ghost_native_type` beside the native ID; existing mappings and uncertain
Alpha.24 creates without that field are posts. An established type cannot be
changed by configuration: reconciliation is required before any native request,
and changing it never converts an object or creates another destination.
Resource-marker lookup checks both posts and pages to detect an existing wrong
type or duplicate before writing. Source/wiki edits, withdrawal/restore and
lost-create recovery preserve the selected type and exact native identity.
Both resource types require qualification on the actual Ghost runtime and active
theme; synthetic API checks do not prove native page behavior. Ghost documents
these resources in its [Admin API](https://docs.ghost.org/admin-api/).

Supply an already authorized connection ID and connection-secret file, the
Ghost custom integration's Admin API key file, and its webhook-secret file.
Preparation never creates credentials, enrolls a forum, generates publishing
authority or changes connection permissions. The separate operator-password
file is optional; omitting it keeps operator access disabled.

`DISCUSSIONBRIDGE_GHOST_ORIGIN` is the public content origin.
`DISCUSSIONBRIDGE_GHOST_ADMIN_ORIGIN` optionally specifies the integration's
different HTTPS Admin origin, otherwise it uses the public Ghost origin. Use
the Admin origin shown by Ghost, not an inferred host. This adapter accepts
root origins, not Ghost installations below a URL subdirectory. Ghost's
[Admin API documentation](https://docs.ghost.org/admin-api/) explains the
public/Admin domain distinction.

`DISCUSSIONBRIDGE_WEBHOOK_MAX_BYTES` optionally selects the signed webhook's
transport byte budget. Omission preserves the existing 131072-byte budget.
For large selected originals, choose enough bytes for the complete native JSON
payload (for example, `16777216` for a 16 MiB transport) and use the matching
prepared proxy setting. The body is authenticated before publishing; oversized
transport requests fail rather than truncating the native original. This is a
host resource choice, not a universal publication-size policy.

`DISCUSSIONBRIDGE_SOURCE_SYNC_INTERVAL_SECONDS` selects optional ongoing source
synchronization in this same service: `0` or omission keeps it disabled;
an integer from `60` to `86400` selects a cadence from one minute to one day.
For example, `300` selects a five-minute interval. The first scheduled sweep
occurs after that interval. Manual operator/CLI or externally selected cron
invocation remains available. The service renews the existing operation lease
for long sweeps, prevents overlapping scheduled/manual sweeps, and stops its
timer while allowing an in-flight operation to settle on clean shutdown.
Only explicitly authorized native bindings in the configured connection are
processed; selecting the interval enrolls no category or whole forum and
installs no new service, site integration or state authority. Failed sweeps
remain attention and retry at the next selected interval.

Create the private files with owner-only read/write permissions and an existing
dedicated state directory writable by the service account. An existing state
file is preserved; never replace it with an empty file during an upgrade.

## Prepare once, regardless of operator

Run from the adapter runtime on its Linux host:

```sh
npm run prepare:install -- \
  --config /srv/discussionbridge-ghost/private/adapter.env \
  --output /srv/discussionbridge-ghost/prepared-install-1 \
  --user discussionbridge_ghost
```

This command validates the selected configuration, private files, state path
and runtime prerequisites. It creates a new private output directory containing:

- `discussionbridge-ghost.service`: a unit for the exact Node runtime and
  configuration file, using the supplied non-root account.
- `adapter-nginx.conf`: a proxy fragment for the adapter's TLS server. The
  `/discussionbridge/` prefix is stripped only on the adapter host; the
  loopback service handles its existing internal routes.
- `ghost-site-footer.html`: the exact credential-free bootstrap for this Ghost
  origin and the current bundled assets.
- `INSTALL.md`: the concrete addresses and remaining operator steps.

An existing output directory is an error, not an overwrite prompt. Partial
preparation output is retained for inspection if a later write fails. The
command never starts services, edits system configuration, changes Ghost,
writes adapter state, registers a resource, sends a request to the forum or
Ghost, or deletes an installation.

## Deliberate activation

The host operator installs the locked production dependencies using `npm ci
--omit=dev --ignore-scripts --no-audit --no-fund` with an explicitly selected
cache. Do not rebuild browser assets as a production-install side effect.
Confirm the service user can read the runtime, environment and private files,
and can write its dedicated state directory. The prepared unit makes the rest
of the filesystem read-only and runs with a private temporary directory and
without new privileges. This is not a substitute for checking host permissions.

Install the service unit and include the proxy fragment in the adapter's
existing TLS server. Supply its trusted certificate, enable HTTP compression
for JavaScript/CSS and check service/proxy syntax before starting it. These
privileged operations require deliberate host-operator action; preparation
does not perform them. No public access to the Node loopback port is required.

Check the prepared public health address. For selected outbound posts, configure
signed `post.published` and `post.published.edited` webhooks using the same
prepared address and existing secret. Ghost documents both events in its
[webhook event list](https://docs.ghost.org/webhooks). Draft/unpublish/deletion
events do not authorize a To rewrite. If selecting the supplied theme integration,
paste its bootstrap into Site Footer, preserving unrelated code injection;
otherwise retain the operator's chosen equivalent integration. Ghost supports external scripts through
[code injection](https://ghost.org/tutorials/use-code-injection-in-ghost/).
The optional `install:rich-content` command preserves unrelated injection and
reports the manual Site Footer step if the integration cannot write settings;
do not expand its permissions to bypass that boundary.

The supplied theme integration recognizes `.gh-article`, `.gh-content` and
Ghost's internal-tag body classes. Confirm those hooks in the active theme;
custom themes may need the explicit presentation/comment placeholders rather
than these stock-theme hooks. This is presentation integration, not Ghost
server routing. Installing a footer does not opt ordinary posts into publishing.

When DiscussionBridge supplies the discussion, deliberately set Ghost's
native commenting policy to Nobody if needed to avoid showing a second,
unrelated Ghost Members conversation. The installer does not change membership
or commenting settings automatically.

## Transport and qualification

Browser script and stylesheet addresses point at the adapter host. The loader
captures its executing script address before asynchronous work, so public
data requests do not accidentally go to the Ghost server. They omit browser
credentials. CORS permits the exact configured Ghost origin only on public
read routes; it does not grant forum permissions. Administrative and webhook
routes have no browser cross-origin permission.

Native Discourse and Ghost Admin requests share a ten-second deadline covering
headers and complete streamed body consumption. Actual decoded bytes are bounded
during reading: 64 KiB for public Discourse JSON/chunk envelopes, 2 MiB for
negotiated source metadata, and 512 KiB for branding HTML. Ghost Admin reads use
their explicit response budget; known complete native article sizes enlarge
that transport budget for materialization/readback. Complete source bodies
have no adapter publication-size ceiling. Missing or misleading lengths cannot
bypass the selected transport budgets. Failed public requests use a fixed safe error rather than
reflecting private upstream reason text.

The service exposes only three packaged browser assets, not a filesystem
directory. It snapshots their bytes once per process, gives them content-based
identities and supports ETag/HEAD requests. A URL with the current content
identity is immutable; unversioned asset requests revalidate. Unknown asset
versions fail closed. This avoids reading/hashing multi-megabyte files for each
reader but holds one asset snapshot in process memory; no throughput or memory
benchmark is claimed. Configure proxy compression for actual transfer savings.

Before accepting an installation, test an explicitly opted-in Ghost post,
mapped comments in each admitted mode, registered public presentation, an
authorized native publication, exact replay/restart behavior and denied
requests. Verify operator authentication and same-origin anti-CSRF protection
if enabled. Confirm that unrelated Ghost content, settings, accounts and
existing adapter state are unchanged. Local unit tests are not live-host or
theme qualification, and installation preparation is not a verified publication.

The local `0.3.0-alpha.1` build candidate negotiates the centrally frozen
`core-publication-extension.json` identified in `discussionbridge-release.json`.
From transfers check exact resource, edition, offsets, byte count, SHA-256 and
final UTF-8. A source-changing 409 refreshes detail, with three total attempts.
Unchanged authorized editions reuse proven native content. Source-created and
source-updated metadata remain separate from synchronization timestamps.
The single existing service/posts/publications state remains the publishing
authority; no second queue or service is installed.

Source withdrawal requires an explicit withdrawn record and exact native
ownership; missing records and transport/authentication failures are not
withdrawal. The adapter drafts that same native post, preserving private
recovery content, native identity, unrelated properties/tags and local mode.
Restoration rehydrates the authoritative active source and updates that post.
Verify public URLs and applicable caches before recording public withdrawal.
Native Ghost HTML conversion must preserve the managed ownership boundaries;
failure to read them back is attention, never a successful publication claim.

## Upgrades and rollback

Keep the same private configuration, credentials and state directory. Prepare
the new reviewed runtime into a new output directory. Stop the service before
changing runtime files; never replace assets underneath a running process.
Refresh the Ghost footer from the new preparation because its addresses identify
the actual asset set. The footer waits for deferred authored scripts and checks
actual current-loader initialization, not an arbitrary old script marker.
It can supply the current external loader when a retained relative/hash address
is stale. It does not make an old hash serve new immutable bytes.

Then deliberately synchronize the already-authorized native publications.
The existing engine keeps each exact resource/post/canonical identity, but
reconciles its owned presentation digest separately from the source revision
and package label. A changed asset set, address or owned markup can therefore
update the same native post without creating another topic/post identity.
Success requires readback of the source and presentation tags plus the required
executable loader and native provenance elements. Missing or stripped markup
remains an attention/retry state, not a claimed usable publication. Elements
inside inert templates/noscript, raw-text or foreign-namespace contexts do not
prove executable presentation. Malformed implicit exits from unsupported
contexts fail the check; ordinary optional ends, void elements and foreign
self-closing elements remain supported. This conservative parser check is not
a complete HTML tree-builder or proof of browser CSP, Ghost normalization or
theme execution. Lookup-only
recovery counts as already current, not a write. These controls are not proof
of real theme or Ghost normalization behavior; qualify those explicitly.

Native create uncertainty is committed before the request and survives failed
responses, attention, restart and source/presentation changes. An empty lookup
does not authorize another create. Reentry remains reconciliation-only until
the exact marked destination is found; an older destination-less attention
record without explicit certainty is treated conservatively the same way.
Do not clear or reset durable state to force another create. A lookup failure
before any create was reserved remains safely retryable. Claim ownership is
checked immediately before native writes as well as at completion, so an old
owner cannot write after a successor has taken its intent. Investigating an
unresolved native outcome is separate from installation preparation.

Keep the preceding runtime and an appropriate compatible state backup for
bounded rollback. An asset rollback also requires refreshing the footer and
deliberately reconciling owned presentations with a runtime supporting this
presentation-revision capability. A preceding runtime without that capability
is not a qualified automatic rollback target. Preparation itself never rewrites
existing native Ghost posts or resets state. A new package label alone is not
proof that authored content or its browser presentation was upgraded.

Hosted plans still need the native integration, signed webhook, code-injection
or theme capability, and outbound Admin API access. Removing customer-server
routing does not bypass plan permissions. Provisioning, billing, central tenant
management and production monitoring remain separately scoped hosting work.
