# Interbox Documentation

This repository holds the published documentation for Interbox, served at
`https://www.health-samurai.io/docs/interbox` by the Health Samurai website's docs engine.
It uses Health Samurai's `docs-tools` for linting and image optimization.

All documentation is written in **English**.

## ⚠️ This repo is a generated mirror — do not edit content here

The docs **content** (`SUMMARY.md`, `docs/`, `assets/`) is generated from the Interbox
engine repository (`packages/interbox/docs/src`) and pushed here by a release job. Any hand
edit to those paths is **overwritten on the next engine release**. To change the docs, edit
them in the engine repo (they ship in the SDK and are read offline by `interbox assistant
docs`, so they must live there).

What you MAY edit here (never touched by the mirror): this file, `README.md`,
`package.json`, `docs-lint.yaml`, `redirects.yaml`, and `.github/`.

## Structure

```
docs/           — markdown files (documentation pages)
assets/         — images and downloadable files
SUMMARY.md      — table of contents and navigation
docs-lint.yaml  — linter configuration
redirects.yaml  — URL redirects
```

## docs-tools

Run `bun install` once after cloning — installs docs-tools and sets up git hooks.
`docs-tools` is intentionally unpinned (`github:HealthSamurai/docs-tools`); `bun install`
installs the version locked in `bun.lock` without modifying it.

```
bun lint          — fix lint issues automatically
bun lint:check    — check for issues without fixing
bun images:check  — find unoptimized images
bun images:optimize — convert images to AVIF format
```

### SUMMARY.md format

```markdown
# Table of contents

## Section Name

* [Page Title](page-file.md)
```

- Page title in SUMMARY.md should match the `# H1` in the file (title-mismatch is warn-only here).
- Every `.md` file in `docs/` must be listed in SUMMARY.md.

### Markdown rules

- Exactly one `# H1` per file; don't skip heading levels.
- Internal links must point to existing files; referenced images must exist in `assets/`.
- Images use meaningful alt text and a path relative to the page, e.g. `![alt](../assets/x.svg)`.
