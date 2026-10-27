# CLI

The package ships an `interbox` bin (`bunx interbox …`, or `bun run
interbox-cli …` in the workspace template, which aliases it).

## `interbox pin`

```sh
# pin @health-samurai/interbox in package.json (or $INTERBOX_VERSION)
interbox pin <version>
```

Rewrites the `@health-samurai/interbox` dependency in the current directory's
`package.json`. A bare `X.Y.Z` is written as `^X.Y.Z`; anything else (a
moving tag like `edge`, or an explicit range) is written verbatim. With no
argument it reads `$INTERBOX_VERSION` — the same knob the template's
docker-compose uses for the engine image tag, so one variable pins both.

The engine (Docker image) and the SDK (npm package) are versioned in
lockstep — pin both to the same number to guarantee they came from the same
commit.

## `interbox workspace`

```sh
interbox workspace status [--upstream <url>] [--into <branch>] [--json]
interbox workspace sync   [--platform github|azure] [--upstream <url>] [--into <branch>] [--dry-run]
```

Compares a workspace copy with the upstream template's releases and builds the upgrade pull
request from an `upstream-sync` branch. `--platform` is for the scheduled CI runs, which run the
version the copy's `bun.lock` pins and use the platform's API to open the pull request. Without it,
`sync` pushes with your own git credentials and prints the link that opens the pull request. For a
one-off run, use `bunx @health-samurai/interbox@<version> workspace sync` with an exact version.
See [Track upstream workspace releases](../ops/updating.md#track-upstream-workspace-releases).

## The `assistant` namespace

The CLI also has an `interbox assistant …` namespace of subcommands: spec
lookups, message parsing and error-queue access. Most only read; `errors retry`,
`errors defer`, `errors resolve`, `errors triage --apply-safe` and `reload`
change what the deployment holds or runs.
These exist as tooling for the bundled AI skills and the dashboard's
assistant — they're not part of the workspace-authoring workflow this book
documents. The human-facing equivalents are the dashboard (error queue,
message inspection) and your editor working against the SDK's generated
types.

## Reaching a dashboard that requires a sign-in

Interbox requires a login by default, and the CLI is not a browser. The only
credential it can carry is the short-lived grant the dashboard mints for an
assistant conversation, which that conversation's environment already holds as
`INTERBOX_SERVICE_TOKEN` — so these commands work from inside the dashboard
assistant. There is no deployment-wide token to set: a value put in that variable
by hand is not a credential the API knows, and every command fails with a `401`.

A grant reaches only the routes the CLI calls — see
[Securing Dashboard Access](../ops/secure-access.md). The CLI refuses to send it
to a plain-`http` `INTERBOX_API_URL` whose host is not `localhost`, an IPv4
address in `127.0.0.0/8` or `[::1]`, since that would put the credential on the
network in cleartext.
