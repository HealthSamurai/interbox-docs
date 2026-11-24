# Network Access

This page lists every connection an Interbox deployment makes, so you can write
egress rules for it. Each destination comes from a setting. Where the setting
points at a service inside your network, the connection never leaves it, and the
few that default to a public host can be pointed inside too.

## Outbound from the pod

| Destination | Port | Used for | When | Setting |
|---|---|---|---|---|
| PostgreSQL | from `DATABASE_URL`, usually 5432 | All Interbox state. At start the engine also creates its database and applies migrations. | Always | `DATABASE_URL` |
| Aidbox | from the URL | The Aidbox sender; health and licence status on the dashboard; the assistant's Aidbox queries | Whenever a pipeline sends; every few seconds while a dashboard tab is open; when the assistant queries Aidbox | The `url` the workspace passes to `aidbox()`, by convention `env("AIDBOX_URL")`; `AIDBOX_URL` for the dashboard and the assistant |
| Workspace git remote, from the workspace service only | from the URL: SSH 22 or HTTPS 443 | Clone, fetch on every sync, `git ls-remote` to notice a moved ref. The Repository screen lists branches and loads older history. Push only at `INTERBOX_WORKSPACE_ACCESS=push` or `apply`. | At start, on every sync, every `INTERBOX_WORKSPACE_POLL_MS` (30 s by default; the Helm chart sets 5 s) | `INTERBOX_WORKSPACE_GIT_URL` |
| npm registry, `registry.npmjs.org` by default, from the workspace service only | HTTPS 443 | `bun install` of the workspace's dependencies | Clone mode: at start and on every sync. A workspace mounted at `/workspace`: every start of the workspace service's container. | `BUN_CONFIG_REGISTRY` or `NPM_CONFIG_REGISTRY`, or the workspace's own `.npmrc` / `bunfig.toml` |
| Terminology server, `https://tx.fhir.org/r4` by default | HTTPS 443 | LOINC `$expand` and `$lookup` | When someone searches LOINC on the dashboard, or the dashboard assistant looks a code up | `TERMINOLOGY_URL`; `TERMINOLOGY_AUTH` is sent as the `Authorization` header as written |
| Licence portal, `aidbox.app` | HTTPS 443 | After "Activate" on the dashboard: exchanges the sign-in code and requests a development licence | Only when someone activates | Supply the licence in `INTERBOX_LICENSE` and this is never called |
| Your OIDC identity provider | HTTPS 443 | Discovery, signing keys, token, userinfo | Discovery on the first sign-in after start, the rest on sign-ins | `INTERBOX_AUTH_ISSUER` — see [Securing Dashboard Access](secure-access.md) |
| Model API for the dashboard assistant, `api.anthropic.com` by default, from the workspace service only | HTTPS 443 | The assistant | The agent starts when someone opens the assistant panel, and calls the model on every prompt | `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` |
| Endpoints the workspace declares | from the workspace's config | FHIR systems (generic, Aidbox, Epic, Paragon) and their token endpoints, outbound webhooks | Whenever a pipeline uses them | Workspace code. A webhook is only sent to a host listed in `WEBHOOK_EGRESS_ALLOWLIST` — see [Webhooks](../concepts/webhooks.md). |
| DNS | UDP and TCP 53 | Name resolution | Always | — |

The node, not the pod, pulls the image: `healthsamurai/interbox` from Docker Hub.
To pull it from a mirror, set the chart's `image.repository`, plus `image.digest`
and `imagePullSecrets` as needed.

Aidbox, when you run it beside Interbox, has egress of its own. Its terminology
engine, for one, defaults to an external server
([System Requirements](sizing.md)).

## What each one is needed for

Without PostgreSQL nothing runs. In clone mode, a git remote or npm registry that
the workspace service cannot reach stops it from publishing: the replicas keep
running the build already published, and with none published yet they stay
unready and run no pipeline. The workspace service tries again on its next poll.
A workspace mounted at `/workspace` is stricter, because the workspace service's
container exits when its install fails.

Everything else is needed only by the feature that uses it. Without the
terminology server, LOINC search fails and the rest of the dashboard works.

## Keeping traffic inside your network

**Aidbox.** Keep `AIDBOX_URL` and the workspace's Aidbox sender URL on the
internal address, such as the in-cluster Service name. An Aidbox public hostname
sends the traffic out of the network and back in.

**The git remote.** An internal forge works over either transport. SSH to a host
the image does not already know needs its host key, as
[Host keys are checked](workspace.md#host-keys-are-checked) explains. If your
firewall only lets HTTPS out, use the repository's `https://` URL with a token in
place of an SSH key ([The credential](workspace.md#the-credential)). It then
needs only port 443, and a hostname rule can match it.

**The npm registry.** Set `BUN_CONFIG_REGISTRY` to an internal mirror. In clone
mode the image supplies the Interbox SDK itself (`INTERBOX_WORKSPACE_LINK_SDK=1`,
the default) and every other dependency comes from the registry. A workspace
mounted at `/workspace` still downloads the SDK before the image links its own,
so the mirror has to carry `@health-samurai/interbox` too. A dependency the
workspace names by git URL, or from another registry in its `.npmrc`, is fetched
from that host. In clone mode the workspace's own install scripts run, and so do
those of the dependencies Bun trusts; a script that downloads something reaches
the host it downloads from.

**No clone and no install by the replicas.** A replica loads the build the
[workspace service](deploy.md#the-workspace-service) publishes to PostgreSQL, so
the git remote, the npm registry and the model API need to be reachable from
the workspace service's pod alone. In `worktree` mode the workspace service
builds a directory that is already there and does not clone it
([clone or worktree](workspace.md#clone-or-worktree)). The image's entrypoint
still runs `bun install` for a workspace mounted at `/workspace` in the
workspace service's container, and the Repository screen still contacts the
checkout's `origin` if it has one.

**The assistant.** It runs Anthropic's Claude Code, which has traffic of its own
beyond the model API: updates, telemetry, error reporting and feature flags.
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns that off, and
`CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` the plugin marketplace
auto-install it leaves out
([Claude Code environment variables](https://code.claude.com/docs/en/env-vars)).
The agent also runs shell commands inside the workspace service's pod, so it
reaches whatever that pod's egress allows, and it reads the workspace's `.mcp.json` and
`.claude/settings.json`, so an MCP server or hook configured there is one more
destination.

## What Interbox does not call

Interbox sends no telemetry of its own and does not check for updates. The one
exception is licence activation: the licence request carries page metadata
flagged for tracking. It makes no call to the Kubernetes API (the chart sets
`automountServiceAccountToken: false`) and downloads no FHIR packages at runtime.

Code in the workspace runs inside Interbox: steps, senders, dashboard actions
and, in clone mode, install scripts. It can call anything it is written
to call, so review it as part of the same exercise.

## Inbound

The API and the dashboard listen on TCP 3001 (`API_PORT`). Every `mllpSource`
the workspace declares listens on its own port. Every `webhookSource` listens
on one port, `INTERBOX_WEBHOOK_PORT` (3002 when unset), and sources are told
apart by their `path`. A `pullSender` answers its consumer's App on that port
too, at its own path (see [A Queue Consumers Poll](../concepts/pull-senders.md)).
The engine binds that port in one thread and passes each request to its
pipeline, and the engine image exposes 3002. The Helm chart exposes MLLP on 2575
through its own LoadBalancer and creates no Service for the webhook port.

## From the user's browser

These requests come from the browser, so the pod's egress rules do not cover
them:

- Google Fonts from `fonts.googleapis.com` and `fonts.gstatic.com` on every page.
- The licence portal's sign-in page during activation.
- Your identity provider's sign-in page.
- Aidbox's public URL, `AIDBOX_PUBLIC_URL`. Without it, a link to Aidbox goes to
  the issuer Aidbox advertises, and activating Aidbox from the dashboard goes to
  the dashboard's own hostname on the port of `AIDBOX_URL` (8080 if it names
  none).
- Workspace UI pages, which load whatever they reference.
