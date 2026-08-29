# Ghost DiscussionBridge adapter

This is the publishing-side Ghost adapter for the DiscussionBridge Alpha. It
runs as a small loopback-only Node service beside Ghost.

- Ghost `post.published` webhooks enter through a protected, unguessable path.
- The service sends bounded authenticated create-or-resolve requests to the
  receiving Discourse plugin and durably stores the returned resource/topic
  identity.
- Explicitly registered From Discourse resources are pulled server-side and
  exposed through a same-origin Nginx route as sanitized HTML. The supplied
  loader renders that HTML into an explicit Ghost post placeholder.

Bridge and webhook secrets live in root-protected files. They are never
accepted through public JSON, returned in responses, or written to the state
file. The service binds only to loopback. It does not implement edit/delete
synchronization or a generic control plane.

## Required environment

`DISCUSSIONBRIDGE_SERVER_URL`, `DISCUSSIONBRIDGE_CONNECTION_ID`,
`DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE`, `DISCUSSIONBRIDGE_GHOST_ORIGIN`,
`DISCUSSIONBRIDGE_GHOST_WEBHOOK_TOKEN_FILE`, and
`DISCUSSIONBRIDGE_STATE_FILE`. `DISCUSSIONBRIDGE_PORT` defaults to `8792` and
`DISCUSSIONBRIDGE_LANE` is optional.

Register a From Discourse resource without exposing credentials:

```text
node src/register-presentation.mjs RESOURCE_UUID
```

The Ghost post contains an HTML card such as:

```html
<div data-discussionbridge-resource="RESOURCE_UUID"></div>
<script defer src="/discussionbridge/assets/loader.js"></script>
```
