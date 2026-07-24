# Interbox Documentation

Documentation for [Interbox](https://www.health-samurai.io/interbox) — an extensible
healthcare integration engine. Published at **https://www.health-samurai.io/docs/interbox**.

> **This repository is a generated mirror.** The docs are authored in the Interbox engine
> repository (`packages/interbox/docs/src`) so they ship inside the SDK and stay
> version-matched with the engine (`interbox assistant docs` reads them offline). A release
> job converts them to this GitBook layout and pushes `SUMMARY.md`, `docs/`, and `assets/`
> here. **Do not edit those by hand — changes are overwritten on the next engine release.**
> Edit the docs in the engine repo instead.
>
> The tooling scaffold in this repo (`package.json`, `docs-lint.yaml`, `.github/`,
> `CLAUDE.md`, `redirects.yaml`) IS maintained here and is never touched by the mirror.

## Prerequisites

- [Bun](https://bun.sh) installed

## Setup

```bash
bun install
```

This installs [docs-tools](https://github.com/HealthSamurai/docs-tools) and sets up a
pre-push git hook that runs lint before every push.

## Commands

```bash
bun lint                       # run all doc checks
bun lint:check broken-links    # run a single check
bun images:check               # find unoptimized images
bun images:optimize            # convert to AVIF + update refs
```

## Structure

```
docs/           # Markdown documentation files
assets/         # Images and other assets
SUMMARY.md      # Navigation structure
redirects.yaml  # URL redirects
```
