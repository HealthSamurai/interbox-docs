# Updating the Engine

Interbox releases two artifacts cut from the same commit and versioned in
lockstep: the **engine image** (`healthsamurai/interbox` on Docker Hub) and the
**SDK** (`@health-samurai/interbox` on npm) your workspace is built against.
Updating means moving the image to a new tag and keeping the workspace's SDK in
a compatible range. Database migrations run automatically on boot; one that
builds an index on a large delivery queue (`sender_item`) makes that boot take
longer, in proportion to the backlog. Moving to the per-pipeline `retention`
rebuilds the index of finished sender items (`sender_item_done`) the same way; it
holds at most the retention window (7 days by default) of items, and it blocks
inserts into that table for the build, which only an older engine still running during a
rolling deploy would notice.

`INTERBOX_DONE_ITEMS_RETENTION_DAYS` is removed and ignored. Every pipeline keeps
finished items and stored delivery files for 7 days unless it sets `retention`. A
deployment that relied on a longer value must declare `retention` on its
pipelines and deploy that workspace with the engine, because the first sweep after
boot applies 7 days.

Before updating, read the
[release notes](https://github.com/HealthSamurai/interbox-workspace/releases) of
every version between yours and the target: a change you must act on first, such
as a new required Postgres extension or environment variable, is listed at the
top of its release under **Upgrade Notes**.

> Updating the **engine** (this page) is separate from updating your
> **pipelines**. Pipeline changes are a workspace edit the running engine picks
> up on its own by re-cloning and rebuilding — no image change. See
> [Getting Started](../getting-started.md).

> Moving a **1.x installation to 2.0** is a cutover of its own: the workspace is
> rewritten, and a one-off script moves the 1.x message history and Aidbox
> fingerprints into a 2.0 pipeline while every engine is stopped. Follow
> [Upgrading from 1.x](upgrade-from-1x.md) for it.

## First upgrade to coordinated runtime generations

**Stop every legacy engine and API before starting a coordinated release.**
Legacy processes do not register with the coordinator, so it cannot wait for
their workers. Use `Recreate` or scale to zero and confirm all old containers
have terminated. Deleting a pod object on an unreachable node is insufficient.

A coordinated engine will not publish a generation while an engine from an earlier
release has reported a heartbeat in the last few seconds. It stays `NotReady`, names
that engine's instance and version in an ERROR log line and in its reload error, and
retries on its own once the old engine stops. Legacy API processes report no
heartbeat, so nothing detects them: stopping them is up to you.

Enable replicas after this first upgrade. Later coordinated releases support
rolling updates; a missing old process may require
[confirmed termination](local-testing.md#a-cutover-blocked-by-a-missing-pod).

**Set `ownership: "replica"` on custom listeners before adding replicas.** A
custom source without `ownership` runs on one replica at a time. A listener left
that way binds its port on one pod only, while the other pods stay ready and
refuse the connections routed to them. Declare `ownership: "replica"` on each
listener that must accept connections on every pod, and call `ctx.ready()` once
it is bound; see [source ownership](../concepts/pipelines.md#your-own-source).
While more than one replica runs, the engine logs an error for each source
still without `ownership`. Declare `ownership: "singleton"` on a source meant to
run on one replica to silence it.

## Workspace actions must compile before activation

Fix build errors in `server/actions.ts` and its static imports before updating.
A failed actions build rejects the candidate workspace: reload keeps the old
generation, while first boot stays unready. Workspaces without actions are
unaffected. See [Workspace actions](workspace.md#workspace-actions).

## Move the image tag

The image tag *is* the engine version. Pre-GA the default is the moving `edge`
tag; for production pin a released semver (e.g. `1.4.1`).

**Docker Compose** — set `INTERBOX_VERSION` in `.env`, then pull and recreate:

```sh
# .env
INTERBOX_VERSION=1.4.1
```

```sh
docker compose pull
docker compose up -d
```

**Kubernetes (Helm)** — bump `image.tag` (or the chart's `appVersion`) and
upgrade:

```sh
helm upgrade --install interbox healthsamurai/interbox \
  -n interbox --reuse-values --set image.tag=1.4.1
```

Use `Recreate` for the first transition from an uncoordinated release. Later
coordinated releases can use a reviewed rolling strategy; the operating
requirements are in [Deployment](deploy.md#running-multiple-replicas). The value
keys and pinning options (digest pin, `pullPolicy`) live in the
[chart's README](https://github.com/HealthSamurai/helm-charts/tree/main/interbox).

## Keep the workspace SDK compatible

This is the one update step unique to Interbox. Keep the workspace's SDK in the
**same npm caret (`^`) bucket** as the engine image: the same major version, or
— while on `0.x` — the same minor. So `1.3.0` ↔ `1.9.2` are compatible; `1.x` ↔
`2.x`, or `0.4` ↔ `0.5`, are not.

The engine checks this every time it loads a workspace, at boot and on reload,
by comparing its own version with the `SDK_VERSION` on the `ChainRegistry` your
workspace's entry exports:

- **Different bucket:** the workspace is refused, with a message naming both
  versions and the `interbox pin` or `INTERBOX_VERSION` change that fixes it. A
  version that cannot be parsed is refused the same way. A refused boot does not
  start; a refused reload leaves the previous pipelines running.
- **Same bucket, workspace SDK on a newer minor than the engine:** the workspace
  loads, and the engine logs one warning per load naming both versions. A feature
  the newer SDK added can still fail when it is first used, so move the engine up
  or pin the SDK down.
- **Same bucket, workspace SDK older or equal:** the workspace loads.

An SDK release whose `ChainRegistry` has no `SDK_VERSION` cannot be compared. Such
a workspace loads, and the engine logs a warning on each load until the SDK is
upgraded.

The engine's own version is shown on the dashboard's Instances page. A workspace
written for 1.x, whose pipelines and mappers come from the package root's
`pipeline()` and `defineMapper`, fails to load with a message that names each of
them:

```text
the workspace registers pipeline "adt" and mapper "v2-to-fhir" with the 1.x DSL,
the package root's `pipeline()` and `defineMapper`, which this 2.0 engine does
not run: it runs only chain pipelines, declared with `pipeline` from
"@health-samurai/interbox/chain" and exported from the workspace entry as
`ChainRegistry`. See concepts/pipelines.md
```

So does a workspace that already exports `ChainRegistry` but still declares a
pipeline or a mapper the 1.x way. Rewrite them in the chain DSL, as
[Pipelines](../concepts/pipelines.md) describes, before you move to 2.0, and see
[Upgrading from 1.x](upgrade-from-1x.md) for the rest of that move.

A workspace that fails to load at boot leaves the engine parked: the API and
the dashboard come up, and no pipeline runs. One that fails on a reload leaves
the pipelines already running in place.

Within a compatible bucket (a patch or minor bump on `1.x`) the workspace needs
no change — just move the image tag. When you cross the boundary, align the
workspace's SDK and redeploy it:

```sh
interbox pin 1.4.1      # rewrites @health-samurai/interbox to ^1.4.1 in package.json
bun install
```

The template's `bun.lock` needs Bun 1.4 or newer for that `bun install`; see
[Getting Started](../getting-started.md).

`interbox pin` with no argument reads `$INTERBOX_VERSION`, so one variable can
pin both the image tag and the SDK dependency — see [CLI](../concepts/cli.md).

## Track upstream workspace releases

Your workspace began as a copy of the public
[interbox-workspace](https://github.com/HealthSamurai/interbox-workspace) template. The template's
releases are tagged `v<engine version>+<N>`. Every engine release comes with a `+0` release, and a
higher `N` is a template-only change on the same engine. The CLI compares your copy with these
releases and prepares an upgrade pull request:

```sh
interbox workspace status            # where the copy is, what is newer, what breaks
interbox workspace sync --dry-run    # build the branch, push nothing, print the plan and body
interbox workspace sync              # push the upstream-sync branch, print the pull request link
```

Run them from a clone of your copy. `origin` is where the branch is pushed. Pass `--into <branch>`
when your default branch is not `main`, and `--upstream <url>` (or set `INTERBOX_UPSTREAM_URL`) to
point at a mirror of the template.

The base of the comparison is the newest upstream release your branch already contains, and the
target is the newest release. The sync fetches upstream tags under `refs/interbox-upstream/tags/`,
so it does not touch your own tags. It needs full history and refuses a shallow clone.

The `upstream-sync` branch is a merge of the target into your branch. A conflict only in `bun.lock`
is resolved by starting from upstream's lock and running `bun install --lockfile-only`, unless the
merge also changes `.npmrc`, `bunfig.toml` or an `.env` file. A conflict only in the `version` line
of `package.json` takes upstream's version. Any other conflict leaves the branch at the upstream
release itself, so the pull request shows the conflicts and its description lists the commands
that resolve them.

A release with an **Upgrade Notes** section in its notes makes the pull request a draft titled
`chore!:` and labelled `breaking-change`, with those notes listed. If the notes cannot be checked
(they failed to load or the upstream is not on github.com), the pull request is a labelled draft
with a warning. Once a later run reads them and finds nothing breaking, the label comes off and the
description says the draft can be marked ready.

When the target moves the engine version, the description says so. Move the image to that version
or newer before merging, as above.

Merge the pull request with a merge commit, not a squash or rebase, because the next sync uses
that merge to find where the last one left off. If a sync pull request was squashed, the next
scheduled run stops and says how to record the release in your history without changing a file,
through a pull request if your branch is protected.

If `upstream-sync` holds a commit the sync did not make, including the merge commit from GitHub's
**Update branch** button or a sync commit someone amended, the sync does not reset it. Work on the
release that the open pull request targets, such as resolving its conflicts, is left alone. When a
newer release appears, the sync comments once on that pull request.
Closing that pull request does not delete the branch. To move on, either merge it or close it and
delete `upstream-sync`. Until then, a scheduled run with no open pull request opens an issue on
GitHub or fails on Azure Pipelines. Otherwise, a pull request closed without merging is left alone
until a newer release appears.

### Scheduled runs

The template ships daily jobs for GitHub Actions and Azure Pipelines that run the sync with the
token each platform gives its runs. The template's README lists the repository
settings they need. They install your copy's dependencies with
`bun install --frozen-lockfile --ignore-scripts` and run
`./node_modules/.bin/interbox workspace sync --platform ...`, so the CLI is the version your
`bun.lock` pins and only moves when you merge a sync pull request.

GitHub starts no workflows for a pull request that the workflow token opens or pushes to. On
GitHub the job therefore opens its pull request as a draft, and CI starts when a person marks it
ready for review. If you replace the template's CI workflow, keep its `ready_for_review` trigger.
A later run that pushes a new `upstream-sync` head makes the pull request a draft again, so mark it
ready once more after that push. Without a push, a run changes the draft state only when it newly
finds Upgrade Notes or cannot check the release notes, as described above. In a repository that
does not allow draft pull requests, the pull request opens ready, and you close and reopen it to
start CI. The description says which of the two applies.

Some changes need a run by hand, with your own git credentials:

- On GitHub the workflow token cannot push changes under `.github/workflows/`, and the sync does
  not push changes under `.github/actions/` or to an `action.yml` anywhere with it either. When a
  release touches any of them or the copy shares no history with the template, the workflow opens
  an issue instead of a pull request.
- On Azure Pipelines the pipeline does not push a release that changes a pipeline definition, and
  it does not adopt a copy that shares no history with the template. A pipeline definition is
  anything under `azure-pipelines/` or `.azure-pipelines/`, a root `azure-pipelines.yml`, and any
  other YAML file outside `.github/` with a top-level `trigger`, `pr`, `schedules`, `stages`,
  `jobs`, `steps`, `extends`, `variables`, `parameters` or `pool` key. A YAML file that does not
  parse counts too. The run fails and says so.

Run it by hand with a one-off command pinned to an exact version. The same command is a copy's
first sync, before the copy has these jobs. The issue or the failed run prints it:

```sh
bunx @health-samurai/interbox@<version> workspace sync
```

It pushes the branch and prints the link that opens the pull request. When you run it locally,
the sync also warns before pushing if the branch changes CI definitions. Once the branch is pushed
by hand, scheduled runs on either platform open or update its pull request and leave the branch as
it is. On Azure, delete that branch once its pull request completes: the pipeline can only rebuild
a branch it created.

On GitHub, a scheduled run closes the issue it opened once it opens or updates the pull request
for the target release, or finds the copy up to date. Its closing comment links the pull request
or says the copy is up to date.

### What the sync trusts

CI on `upstream-sync` runs upstream code. Review the CI-definition changes that the description
lists before merging.

The sync regenerates the lockfile in an empty directory that holds only the merged `package.json`
files, upstream's `bun.lock`, and the `.npmrc` and `bunfig.toml` committed on your branch. It reads
no `.env` file, and any version it has to resolve must be at least three days old. An upstream
change to `.npmrc`, `bunfig.toml` or an `.env` file stops the regeneration. A dependency that
upstream's `package.json` gives as a URL or a git address is fetched from that address during the
regeneration.

A copy with no shared history, such as one made from a ZIP download, is adopted from its
`package.json` `version`. The first commit records upstream history at the release that `version`
names, without changing a file. A hand-edited version picks the wrong starting point and can
silently skip upstream changes, so check it before the first sync. If the merge that follows
conflicts, the branch holds only the adopt commit and the description says how to finish the
merge.

## What happens on boot

Every start — an update included — the container:

1. ensures its `interbox` database exists (unless you've told it the database is
   pre-created);
2. applies any new **migrations** — idempotent, and forward-only;
3. builds the workspace bundle and loads the pipelines its `ChainRegistry`
   declares;
4. starts the engine and API.

A 2.0 engine that finds rows left in the 1.x tables `interbox.hl7v2_in` or
`interbox.resource_hash` logs a warning naming `bun scripts/import-1x.ts`: 2.0
does not process them. See [Upgrading from 1.x](upgrade-from-1x.md).

Coordinated updates pause processing until old workers and actions finish;
pods may become unready during the handoff. MLLP sending systems must reconnect
and retry when a listener closes. In-flight messages have the stop grace below
to persist and ACK. After a lost ACK, a resend is a new input unless the upstream
protocol or workspace supplies a durable duplicate identity.

On a stop the engine takes no new work and gives what it has started a grace
period to finish: 10 seconds by default, set in milliseconds by
`INTERBOX_STOP_GRACE_MS`. Work still running when it ends is abandoned without
counting as a failed attempt, and is picked up again after the restart. A
worker stuck in a long synchronous step cannot be interrupted: it is killed
instead, and its work counts one failed attempt.

The container forwards `SIGTERM` and `SIGINT` to the engine and API and waits
for both processes to exit. If either process exits on its own, the container
stops the other and preserves the first process's exit status.

The engine's whole stop takes the grace period, then a 2-second margin for
workers to release what they hold, then up to 1 second to close them. So the
orchestrator's termination grace period (`terminationGracePeriodSeconds` in
Kubernetes, `stop_grace_period` in Docker Compose) must exceed
`INTERBOX_STOP_GRACE_MS` plus about 5 seconds: at least 15 seconds with the
default. Shorter, and the engine is killed before it has released what it
held.

## Rolling back

Interbox migrations are **forward-only**: the chain holds only up-migrations
and there is no rollback command, so there are no down-migrations to run. If
an update applied a schema change, moving the image
tag back runs the older engine against the newer schema, which it may not
expect. So:

- **Prefer rolling forward** — deploy a newer image tag that fixes the problem
  rather than reverting to the old one. A forward move keeps migrations additive;
  reverting fights the schema.
- Roll the image tag back only when the version gap applied no migration (e.g. a
  same-series revert), or restore the database from backup alongside it.
- Test upgrades in staging first — especially across a major version, where the
  workspace SDK moves too.
- After a 1.x import, a 1.x image no longer sees the moved rows: going back to
  1.x means restoring the backup taken before the cutover. See
  [Upgrading from 1.x](upgrade-from-1x.md#rolling-back).

### Authorize the rollback

Once a newer image or a changed configuration value has started processing,
Interbox retires the one it replaced. Pods that start with a retired image or a
retired configuration stay `NotReady`, and the pods already running keep
processing. This stops a pod left over from the previous release from switching
the deployment back during a rolling update.

To roll back on purpose, add `INTERBOX_RUNTIME_ROLLBACK_INTENT` to the same
rollout, with a value this deployment has not used before, such as a timestamp:

```sh
INTERBOX_RUNTIME_ROLLBACK_INTENT=rollback-2026-11-12T10:40
```

Keep the value until that rollout finishes. Each value works once, so the next
rollback needs a new one. `helm rollback` and a reverted ConfigMap value both
need it. The value can sit in the ConfigMap next to the other settings: it is not
part of the business configuration, so removing it later is not a configuration
change.

A pod that waits for this says so in its engine log and in the `reload error`
column of the dashboard's Instances page:

```text
prepared runtime cannot replace the current intent: this engine image was
replaced by a newer one; to roll back to it, deploy it with a new
INTERBOX_RUNTIME_ROLLBACK_INTENT value
```

Workspace code is different: a new Git commit that restores earlier content
needs no rollback intent.
