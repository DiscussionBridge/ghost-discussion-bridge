# Ghost DiscussionBridge adapter

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
  loader renders that HTML into an explicit Ghost post placeholder.
- Published Ghost posts can render their exact mapped Discourse discussion.
  The same-origin loader resolves the current canonical Ghost URL through the
  adapter's nonsecret comments endpoint, then starts Discourse's standard
  comments embed with the already-recorded topic ID. No credential or topic
  identity is placed in Ghost content.
  `data-discussionbridge-comments="full"` selects standard plugin-free
  comments. `data-discussionbridge-comments="fullInteractive"` selects the
  receiving plugin's full-app reader experience with dynamic Core-owned
  height. An empty attribute remains the backwards-compatible `full` mode;
  every other value fails closed.

Bridge and webhook secrets live in root-protected files. They are never
accepted through public JSON, returned in responses, or written to the state
file. The service binds only to loopback. It does not implement edit/delete
synchronization or a generic control plane.

## Required environment

`DISCUSSIONBRIDGE_SERVER_URL`, `DISCUSSIONBRIDGE_CONNECTION_ID`,
`DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE`, `DISCUSSIONBRIDGE_GHOST_ORIGIN`,
`DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE`, and
`DISCUSSIONBRIDGE_STATE_FILE`. `DISCUSSIONBRIDGE_PORT` defaults to `8792` and
`DISCUSSIONBRIDGE_LANE` is optional.

Only posts carrying Ghost's internal `#discussionbridge` tag are eligible.
Configure only the `post.published` event; ordinary published edits are not an
implemented synchronization surface.

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
<div data-discussionbridge-comments="fullInteractive"></div>
<script defer src="/discussionbridge/assets/loader.js"></script>
```

Managed Ghost hosts do not need to expose shell access to each publisher. They
can operate the sidecar, protected credentials, persistent state and narrow
reverse-proxy routes as a supported integration. See
[`docs/MANAGED_HOSTING.md`](docs/MANAGED_HOSTING.md) for the exact boundary.
