# CLI

The package ships an `interbox` bin (`bunx interbox …`, or `bun run
interbox-cli …` in the workspace template, which aliases it).

## `interbox sync`

```sh
# mirror skills/interbox/* -> .claude/skills/interbox-*
interbox sync
```

Mirrors the Claude Code skills shipped in this package into the workspace's
`.claude/skills/`. The template runs it from `postinstall`, so `bun install`
keeps the skills in step with the installed SDK version. It prunes any
`interbox-*` skill directory the installed version no longer ships and never
touches skills outside that namespace.

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

## The `assistant` namespace

The CLI also has an `interbox assistant …` namespace of read-only and
dry-run subcommands (spec lookups, message parsing, error-queue access).
These exist as tooling for the bundled AI skills and the dashboard's
assistant — they're not part of the workspace-authoring workflow this book
documents. The human-facing equivalents are the dashboard (error queue,
message inspection, "Simulate message") and your editor working against the
SDK's generated types.

## Reaching a dashboard that requires a sign-in

Interbox requires a login by default, and the CLI is not a browser. The only
credential it can carry is the short-lived grant the dashboard mints for an
assistant conversation, which that conversation's environment already holds as
`INTERBOX_SERVICE_TOKEN` — so these commands work from inside the dashboard
assistant. There is no deployment-wide token to set: a value put in that variable
by hand is not a credential the API knows, and every command fails with a `401`.

A grant reaches only the routes the CLI calls — see
[Securing Dashboard Access](../ops/secure-access.md). The CLI refuses to send it
to a plain-`http` `INTERBOX_API_URL` that is not loopback, since that would put
the credential on the network in cleartext.
