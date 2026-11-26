# Deployment

Interbox ships as one all-in-one image (engine + API + dashboard). It always
needs a **PostgreSQL** database, which it does **not** bundle. An **Aidbox**
endpoint is optional: you need one only when your pipelines deliver to it (see
[System Requirements](sizing.md) for sizing). Back the database up:
[PostgreSQL Backups](postgres.md) says what losing it costs and how.

A deployment runs the image as one or more [replicas](#replicas), which take the
traffic and run the pipelines, and one [workspace service](#the-workspace-service),
which builds the workspace for them.

![Interbox deployment topology: HL7v2 over MLLP into an internal LoadBalancer, the all-in-one pod delivering FHIR to Aidbox and using a managed Postgres, dashboard reached over a VPN behind an SSO gate and TLS](../../assets/interbox-topology.svg)

*Editable source: [`interbox-topology.excalidraw`](../../assets/interbox-topology.excalidraw) — open it at [excalidraw.com](https://excalidraw.com) to update the diagram, then re-export the PNG.*

Two supported ways to run it:

- **Docker Compose** — the fastest path for a single host or evaluation. The
  workspace template's `docker-compose.yaml` brings up Interbox, Postgres, and
  Aidbox together; see [Getting Started](../getting-started.md).
- **Kubernetes (Helm)** — the production path.

## Kubernetes (Helm)

The chart lives in [`HealthSamurai/helm-charts`](https://github.com/HealthSamurai/helm-charts)
(`interbox/` directory), and **its own docs are the source of truth** — kept
current with the chart. This page does **not** re-document values, secret keys,
or per-cloud overlays; go there for the reference:

- [**Chart README**](https://github.com/HealthSamurai/helm-charts/tree/main/interbox) —
  the full values table, install command, and setup scenarios (managed PG,
  reusing Aidbox's cluster, sibling charts, locked-down PG).
- [**PREREQUISITES.md**](https://github.com/HealthSamurai/helm-charts/blob/main/interbox/PREREQUISITES.md) —
  Postgres and optional Aidbox requirements, the workspace and sign-in settings,
  the secret keys, TLS, and MLLP exposure.

The one-liner to get going:

```console
helm repo add healthsamurai https://healthsamurai.github.io/helm-charts
helm upgrade --install interbox healthsamurai/interbox \
  --namespace interbox --create-namespace \
  --values values.yaml
```

## Replicas

Every ready replica takes traffic through the Kubernetes Services and stores
what it receives. One replica, the **active replica**, also processes what the
replicas have stored. It holds the **active lease**, a row in PostgreSQL with a
30-second term that it renews every 10 seconds. The other replicas are
**standby replicas**: they ingest and serve the API, and process only after
they take the lease.

| where | what runs there |
|---|---|
| every ready replica | the dashboard and API, MLLP sources, webhook sources, and the pull-sender routes on the webhook port |
| the active replica only | the steps after the store, the senders (a pull sender's queue included), outbound [webhooks](../concepts/webhooks.md), every source written with `defineSource`, and every [file-drop source](../concepts/reading-files/README.md) |

- **A replica tries for the lease once it has loaded a build.** Until the
  [workspace service](#the-workspace-service) has published one, a replica
  waits with no listeners open and reports unready.
- **A graceful stop hands over in seconds.** On `SIGTERM` the active replica
  stops processing and releases the lease, then closes its listeners. Another
  replica takes the lease within about a second and starts processing, and the
  other replicas keep ingesting throughout. A rolling update of a single
  replica works the same way: the new pod loads the build and ingests beside
  the old one, and takes the lease when the old pod stops.
- **A crash fails over within the lease term.** Another replica takes the lease
  once its 30 seconds lapse. A restart of the same process, with the same
  `INTERBOX_INSTANCE_ID` or host name, takes the lease at once: the active
  replica keeps a PostgreSQL session named after its run, and once that
  session has ended, the restarted process takes the lease and frees the work
  its previous run held.
- **A replica that cannot renew the lease stops processing.** It stops 5
  seconds before the lease would lapse by its own clock, so two replicas never
  process at once, and it keeps ingesting. A
  [custom source](../concepts/pipelines.md#your-own-source) it still runs
  stores nothing.
- **Engines from 2.4.x and older hold back the lease.** A replica takes no
  lease while one of them runs; see
  [Updating the Engine](updating.md#upgrading-from-24x-or-older).

Replicas add availability and intake capacity, not processing throughput: only
the active replica processes, so scale it vertically
([System Requirements](sizing.md)). Give every replica the same resources and
mounts, since any of them can take the lease: mount a folder that a file-drop
source reads on each. Each replica needs its own
[workspace cache](workspace.md#cache-and-disk).

### Readiness

`/api/ready` answers `200` when the replica's listeners are up for the build it
has loaded, and while it switches to a newer build. It also answers `200` when
there is no license, so you can activate one from the dashboard. It answers
`503` while the replica has no build loaded (none is published yet, or the
published one fails to load), while sign-in is
[parked](secure-access.md#when-it-is-misconfigured-the-engine-keeps-running),
and while the replica stops. A pipeline in backoff, a
[parked pipeline](workspace.md#parked-pipelines) and the active lease do not
count, so a standby replica is ready.

Readiness steers traffic and gates rollouts: the Services send traffic only to
ready replicas, and a rolling update waits for a new pod to be ready before it
stops an old one. Use `/api/health` for startup and liveness. It answers while
the API process runs, so a replica that waits for a build is not restarted.

The Helm chart's readiness probe uses `/api/health` by default, because an
engine older than 2.5.0 also reports unready on `/api/ready` while a pipeline
is in backoff, and would drop out of every Service. On 2.5.0 or later, set the
readiness probe's path to `/api/ready`, as the chart's README describes.
Without it, a new pod takes traffic before its listeners are up.

## The workspace service

The workspace service is the one process that holds the workspace's editable
checkout: the same image, started with the argument `workspace`, listening on
port 3001. Every deployment runs exactly one. It builds the workspace and
publishes each build to PostgreSQL, and the replicas load the current build
from there. Replicas never clone, install or bundle, so until the workspace
service has published a first build, no replica runs the workspace. The Helm
chart runs it as a Deployment of its own, with one pod and a volume for its
checkout. Under Docker Compose, run it as a second service from the same image
with the command `workspace`, and set `INTERBOX_WORKSPACE_SERVICE_URL` on the
main service to its address.

- **Its checkout.** In `clone` mode it clones the branch the deployment runs
  into its cache (`/tmp/interbox-engine`), installs it and follows the
  branch: every `INTERBOX_WORKSPACE_POLL_MS`, on **Sync now**, and when the
  dashboard switches the branch. Keep the cache on a volume that outlives the
  pod, or a restart loses edits nobody has pushed. In `worktree` mode it builds
  the directory it is given in place and publishes again when any file it
  publishes changes, polled at the same interval, or when a dashboard save
  lands.
- **A changed clone is held.** While the clone has uncommitted or unpushed
  changes, the workspace service neither follows the branch nor publishes on
  its own. **Publish** on the Repository screen publishes the checkout as it
  stands, and **Discard and update** throws the changes away; both need
  `INTERBOX_WORKSPACE_ACCESS=apply`.
- **What a build holds.** The bundle, plus every workspace file that git tracks
  or would track: nothing `.gitignore` names, and no `.env`, `.npmrc` or key
  file. A build is at most 100 MB. PostgreSQL keeps the 10 newest builds, and
  the current one when it is older.
- **Data outside the repository.** A build holds only the repository's files.
  Mount data the workspace reads at run time that is not in its repository,
  such as reference files on a volume, on every replica, at a path the
  workspace reads directly: a replica runs the build from its own cache.
- **A build is checked before it is published.** The workspace service loads
  the bundle in a separate thread and runs the checks a replica runs on load.
  They need a `ChainRegistry` export, no 1.x registrations, a compatible SDK
  version, a readable `LookupRegistry`, and no webhook path that two pipelines
  share. A build that fails one of these is not published, the replicas keep
  the build they run, and the Repository screen shows the error. A pipeline
  whose own source, store, sender or webhook settings fail the checks is
  [parked](workspace.md#parked-pipelines): the build is published, and no
  replica runs that pipeline. The checks that read PostgreSQL run only on the
  replicas.
- **A failed publish is retried.** The workspace service tries the same
  revision again after 30 seconds, doubling the wait after each further
  failure up to 10 minutes, and at once on a new commit, a branch switch,
  **Sync now**, **Publish** or **Discard and update**. Until a first build is
  published, each replica names the failed revision and its error on the
  Instances page.
- **The workspace service needs the replicas' environment.** The check
  resolves `INTERBOX_WEBHOOK_PORT` and the environment variables that sources
  and pull senders read; the chart gives the workspace service the replicas'
  configuration and secrets. It does not resolve the variables the workspace's
  systems read.
- **Revisions.** A clean clone publishes under its commit. A clone published
  with changes publishes as `COMMIT+dirty.HASH`, a worktree as
  `COMMIT+files.HASH`, where the hash covers the files it publishes. A
  revision that is already the current build, published by the same Interbox
  version, is not published again. The exception is a build that parks a
  pipeline: the workspace service checks that revision again and publishes it
  when the parked pipelines change, for example after you set a missing
  variable and restart the service.
- **Its routes.** Every replica's API forwards the Repository screen, workspace
  actions, the workspace UI, concept maps, unmapped codes and the assistant to
  the workspace service at `INTERBOX_WORKSPACE_SERVICE_URL`. Without that
  variable these routes answer `404` and the dashboard shows no assistant.
  While the workspace service cannot be reached they answer `503`, and the
  Repository screen says
  the workspace service is unavailable. The running build shows either way.
- **Give it the replicas' environment.** It checks the dashboard's session
  cookie against the same PostgreSQL, so it needs the same `DATABASE_URL` and
  sign-in settings. Only the workspace service uses the workspace git
  credential and the model credentials; the replicas ignore them. Workspace
  actions run here, so the variables they read belong here too.
- **The assistant.** The dashboard assistant runs inside the workspace service
  and edits its checkout. It is optional: without a Claude sign-in the panel
  says the assistant is not available. It ends a revoked session's
  conversations within a minute; their credentials stop working at once.
- **Probes.** `/api/health` and `/api/ready` answer while the process is up,
  whether or not it can reach git; `/api/ready` answers `503` only while
  sign-in is parked. An unreachable remote or an expired key fails no rollout:
  the replicas keep the last build, and the Repository page shows the error.
  Besides these and the forwarded routes, it serves
  only the routes the assistant's own credential reaches, since the agent's
  command-line tool calls the API inside its pod.

## TLS to PostgreSQL

Put `sslmode=verify-full` in `DATABASE_URL`:

```text
postgres://interbox:<password>@db.example.com:5432/interbox?sslmode=verify-full
```

Interbox then encrypts the connection and refuses a server whose certificate
is not signed by a trusted CA or does not name the host in `DATABASE_URL`.
Use `sslmode=disable` only for a local database without TLS.

Today Interbox treats `require` as `verify-full` and logs a security warning
for it. A future release of its database client will stop checking the
certificate under `require`, so switch to `verify-full` now: a deployment that
connects with `require` connects with `verify-full` too. Do not use
`uselibpqcompat=true&sslmode=require`, which the warning also suggests: it
turns the certificate check off.

When the certificate comes from a private CA (an in-cluster operator's own CA,
or the Amazon RDS CA bundle), mount the CA's PEM file into the pod and name it
in `sslrootcert`:

```text
postgres://interbox:<password>@db.example.com:5432/interbox?sslmode=verify-full&sslrootcert=/etc/interbox/db-ca/ca.pem
```

Connect by the host name in the certificate, not by an IP address.

## What's different about deploying Interbox

The chart's defaults encode a few things that are unusual for a web app and easy
to get wrong if you treat Interbox like a generic stateless service. These come
from how the engine works, so they are documented here rather than in the chart:

- **MLLP is raw TCP, so it gets its own LoadBalancer** — HTTP ingress can't carry
  it. It's meant to be a *private* LB reached over a VPN/VNet. **Pin its IP**: a
  dynamic LB address can change on reinstall and break the firewall/VPN rules the
  sending hospital built around it. That stable address is the one networking
  detail worth agreeing with DevOps up front.
- **The dashboard is internal-only.** It's a `ClusterIP` — reach it with a
  port-forward, or an *internal* ingress class for a stable hostname. Never
  expose it publicly.
- **The workspace service builds the workspace** (clone, `bun install`,
  bundle) at start and for each new revision. That makes it memory-hungry
  while it builds, so don't set a tight memory limit on it: a tight one
  OOM-kills it mid-build. The replicas load the published build instead, so
  their start needs neither the git remote nor the npm registry.
- **Migrations run on boot.** An upgrade is a new image tag: each pod, the
  workspace service's included, migrates the database as it comes up, one pod
  at a time under a lock. A release's migrations keep the previous release
  working, because during a rolling update pods of both releases run side by
  side on the new schema. Each replica also runs the workspace's migrations and
  prepares the pipelines' storage for each build before it listens. The engine
  also self-creates its
  `interbox` database when the `DATABASE_URL` user has `CREATEDB` (otherwise
  pre-create it — see PREREQUISITES). A database that already exists is used as
  it is. On Databricks Lakebase the engine logs in as a service principal: see
  [Databricks Lakebase](lakebase.md).

How the deployment gets that workspace (which branch it tracks, how pipeline
changes reach the replicas, and what the dashboard is allowed to change) is
[The Workspace](workspace.md). Every host the pod connects to, for writing egress
rules, is in [Network Access](network.md).
