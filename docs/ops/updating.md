# Updating the Engine

Interbox releases two artifacts cut from the same commit and versioned in
lockstep: the **engine image** (`healthsamurai/interbox` on Docker Hub) and the
**SDK** (`@health-samurai/interbox` on npm) your workspace is built against.
Updating means moving the image to a new tag and keeping the workspace's SDK in
a compatible range. Database migrations run automatically on boot.

> Updating the **engine** (this page) is separate from updating your
> **pipelines**. Pipeline changes are a workspace edit the running engine picks
> up on its own by re-cloning and rebuilding — no image change. See
> [Getting Started](../getting-started.md).

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

The rollout behavior (single replica, `Recreate` → a brief stop-then-start) is
covered in [Deployment](deploy.md); the value keys and pinning options (digest
pin, `pullPolicy`) live in the
[chart's README](https://github.com/HealthSamurai/helm-charts/tree/main/interbox).

## Keep the workspace SDK compatible

This is the one update step unique to Interbox. At boot the engine loads your
workspace and **refuses to start if the workspace was built against an
incompatible SDK** — before it runs any pipeline, so you get a clear error up
front instead of a confusing failure deeper in.

Compatible means the **same npm caret (`^`) bucket**: the same major version, or
— while on `0.x` — the same minor. So `1.3.0` ↔ `1.9.2` are compatible; `1.x` ↔
`2.x`, or `0.4` ↔ `0.5`, are not.

Within a compatible bucket (a patch or minor bump on `1.x`) the workspace needs
no change — just move the image tag. When you cross the boundary, align the
workspace's SDK and redeploy it:

```sh
interbox pin 1.4.1      # rewrites @health-samurai/interbox to ^1.4.1 in package.json
bun install
```

`interbox pin` with no argument reads `$INTERBOX_VERSION`, so one variable can
pin both the image tag and the SDK dependency — see [CLI](../concepts/cli.md).

You will know you got it wrong because the engine stops at boot with a message
like:

```text
engine/SDK version mismatch: this workspace is built against
@health-samurai/interbox 1.3.0, but this engine ships 2.0.0. They must share
the same major version (or the same minor while 0.x). Run `interbox pin 2.0.0`
and reinstall, or set INTERBOX_VERSION to an image matching SDK 1.3.0.
```

## What happens on boot

Every start — an update included — the container:

1. ensures its `interbox` database exists (unless you've told it the database is
   pre-created);
2. applies any new **migrations** — idempotent, and forward-only;
3. builds the workspace bundle and runs the SDK compatibility check above;
4. starts the engine and API.

Because deployments run a single replica with a `Recreate` rollout, an update is
a brief full stop-then-start, not a rolling one. MLLP senders reconnect and
retry once the listener is back, and in-flight messages get the termination
grace period to persist and ACK.

## Rolling back

Interbox uses Drizzle Kit, which is **forward-only**: `drizzle-kit generate`
emits only up-migrations and there is no rollback command, so there are no
down-migrations to run. If an update applied a schema change, moving the image
tag back runs the older engine against the newer schema, which it may not
expect. So:

- **Prefer rolling forward** — deploy a newer image tag that fixes the problem
  rather than reverting to the old one. A forward move keeps migrations additive;
  reverting fights the schema.
- Roll the image tag back only when the version gap applied no migration (e.g. a
  same-series revert), or restore the database from backup alongside it.
- Test upgrades in staging first — especially across a major version, where the
  workspace SDK moves too.
