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
