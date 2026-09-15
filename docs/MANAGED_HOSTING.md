# Managed Ghost hosting boundary

DiscussionBridge for Ghost has two installation parts: a Ghost-native custom
integration configured in Ghost Admin, and a small companion adapter service
installed on the Ghost server. Ghost Admin remains the publisher-facing
surface. The companion service is not installed by Ghost Admin and does not run
inside Ghost Core.

On a self-hosted Ghost installation, the server operator installs the companion
service. On managed Ghost hosting, the hosting provider must install and
operate it as a supported integration; the publisher does not need shell
access. A hosting plan that permits only Ghost Admin, theme upload or code
injection cannot provide the complete two-direction DiscussionBridge profile.

## What the publisher does in Ghost

1. Creates or authorizes one custom integration named **DiscussionBridge**.
2. Opens **Settings → Membership** and sets **Who can comment on posts?** to
   **Nobody** when DiscussionBridge owns the article discussion surface. This
   prevents Ghost Members comments from appearing below the Discourse frame.
3. Opts a post into publication with the internal `#discussionbridge` tag.
4. Uses an explicit resource placeholder when presenting a From Discourse
   record.
5. Manages ordinary Ghost content, authors and themes normally.

## What the server operator or managed host operates

- the packaged `ghost-discussion-bridge` companion Node 22 service under a
  dedicated, non-Ghost operating-system identity;
- a loopback listener or private Unix socket;
- an exact public webhook proxy route and credential-free presentation/loader
  routes beneath `/discussionbridge/`;
- protected files containing the Bridge connection secret and Ghost webhook
  secret, readable only by the adapter identity;
- durable adapter state outside Ghost's versioned application tree;
- service lifecycle, logs, health monitoring, package upgrades and rollback;
- a dedicated operator-password file and the protected status/synchronization
  routes, with exact-origin POST enforcement;
- backup coverage for the adapter state and configuration; and
- one non-built-in Ghost theme or supported code-injection boundary for the
  credential-free loader when From Discourse presentation is enabled.

The adapter does not need Ghost database access. It does not modify Ghost Core,
the active Ghost version tree, membership, authentication, newsletters or
mail. A Ghost upgrade must preserve the custom integration, webhook, adapter
service, state and presentation hook.

The operator page is part of the companion service rather than Ghost Admin.
For a same-host install it is exposed at
`/discussionbridge/operator/` on the Ghost origin. A remote companion may use a
different HTTPS origin declared through `DISCUSSIONBRIDGE_OPERATOR_ORIGIN`.
The same adapter runtime, protected credential files, durable state and
synchronization logic are used in either arrangement. Multi-tenant hosting,
account provisioning and billing remain outside the current Alpha boundary.

Ghost's custom-integration API token may be unable to write Code Injection.
When `npm run install:rich-content` reports `manual_required: true`, the host or
publisher pastes the returned bootstrap into **Ghost Admin → Settings →
Advanced → Code injection → Site Footer**. This is a Ghost permission boundary,
not permission to broaden the Admin API key or edit an upgrade-owned theme.

## Required routing

The public origin exposes only:

- `POST /discussionbridge/webhooks/ghost` to the loopback adapter;
- `GET /discussionbridge/presentation/{resource-id}` for registered public
  presentations;
- `GET /discussionbridge/assets/loader.js`; and
- authenticated `GET /discussionbridge/operator/` plus exact-origin `POST
  /discussionbridge/operator/synchronize`; and
- an optional provider-only health probe that is not presented as a public
  administrative API.

All other requests continue to Ghost. The webhook requires Ghost's native
`X-Ghost-Signature` HMAC over the exact raw body and a current timestamp. The
presentation and loader responses contain no Bridge or Ghost credential.

## Provider enablement questions

A managed host evaluating support needs to answer only concrete operational
questions:

1. Can it create and preserve a Ghost custom integration and signed
   `post.published` webhook?
2. Can it install and run the packaged companion Node 22 service alongside the
   hosted Ghost site?
3. Can it route the exact `/discussionbridge/` paths without changing Ghost's
   remaining routes?
4. Can it store four protected values: Bridge connection secret, Ghost
   webhook secret, Ghost Admin API key and the separate operator password?
5. Can it persist and back up the adapter state across Ghost upgrades?
6. Can it install a supported custom theme or code-injection loader for From
   Discourse presentation?
7. Can it report the installed adapter version and provide bounded rollback?

If the answer to the companion-service or routing questions is no, the current
complete two-direction profile is not installable on that hosting plan. Theme
upload and code injection alone can provide presentation assets, but they
cannot safely hold the Bridge credential, receive and verify publishing
webhooks, or make authenticated server-side requests to The Bridge.
