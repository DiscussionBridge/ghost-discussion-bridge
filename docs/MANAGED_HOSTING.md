# Managed Ghost hosting boundary

The publisher uses Ghost Admin. The adapter operator uses the
[common external installation](INSTALLATION.md), whether that operator is the
publisher, a friendly host or DiscussionBridge. The same package, configuration,
preparation command, persistent state and publication engine apply in all three
cases. Hosting location does not create a different product behavior.

The external adapter has its own public HTTPS origin. Customer Ghost-server
shell access, custom routing and reverse-proxy changes are not required. A
friendly host may run the adapter beside Ghost, but it uses the same explicit
adapter origin and installation method as an independent host.

## Publisher responsibilities

- Authorize the native Ghost custom integration and signed `post.published`
  webhook pointing to the adapter address.
- Install the supplied credential-free Site Footer bootstrap through supported
  code injection, or the appropriate explicit hook in a supported custom theme.
- Deliberately opt eligible posts in with `#discussionbridge`; choose admitted
  discussion modes through the documented presentation integration.
- Keep normal content, authors, themes, membership and moderation under Ghost
  control. Deliberately disable Ghost Members comments if showing two unrelated
  discussion surfaces would be misleading.

The plan must allow the custom integration, signed webhook, external
script/code-injection or theme hook and Admin API access. The external adapter
does not bypass a hosting plan's permissions. Ghost's integration may require
manual footer installation; that is not permission to broaden its API token.

## Adapter operator responsibilities

- Operate the Node 22-or-newer runtime with `/usr/bin/flock`, a dedicated
  non-root identity and a loopback listener on the chosen Linux adapter host.
- Provide the adapter origin's DNS, trusted TLS and prepared reverse-proxy
  fragment on that host, not on the customer Ghost server.
- Protect the connection, webhook and Ghost Admin key files, and optional
  separate operator credential. Keep private files out of web/runtime roots.
- Preserve the durable state across restarts/upgrades, provide backups and
  qualify the actual native Ghost/theme/public presentation before acceptance.
- Maintain service lifecycle, monitoring, compression, reviewed package
  upgrades, credential revocation and bounded rollback.

The adapter requires no Ghost database access and does not edit Ghost Core or
its version tree. Browser public reads contain no credentials and have exact
configured-Ghost CORS handling. Operator status remains separately authenticated
on the adapter origin with exact-origin POST and anti-CSRF enforcement.

Each configuration/process is for one Ghost site and one authorized forum
connection. A hosted offering may operate separate instances using this same
installation. Shared tenancy, customer provisioning, support-provider authority,
billing and a centralized control plane are not supplied by this installer.
