# Introduction

`@health-samurai/interbox` is the **workspace authoring SDK** for Interbox, an
extensible healthcare integration engine. A workspace repo declares pipelines
against this package; the Interbox engine loads the resulting
`PipelineRegistry` at boot and runs the pipelines on its typed
`source → mapper → sender` runtime.

## What ships in this package

The SDK is a **declaration layer only** — the `pipeline()` DSL, the
`PipelineRegistry`, the `env()` sentinel, and the config-shape contracts for
the engine's built-in stage types. It contains **no worker implementations**;
stages are referenced by a `type` string (via typed descriptors like
`mllpSource`/`aidboxSender`/`hl7v2Parser`) and the engine owns the runtime
behavior for each.

Alongside the TypeScript surface, the package also ships:

- **Generated domain models** — HL7v2 (`/hl7v2`) and FHIR R4 (`/fhir`,
  `/fhir/4.0.1`) types, so a workspace's mappers read/write typed data instead
  of untyped JSON.
- **An `interbox` CLI** — workspace setup: `sync` and `pin`, see
  [CLI](concepts/cli.md).
- **Claude Code skills** (`skills/interbox/*`) — procedural knowledge for an
  AI assistant working in a workspace repo, mirrored into
  `.claude/skills/interbox-*` by `interbox sync`.

## The pipeline model

A pipeline is `source → mapper → sender`:

1. A **source** listens for or polls inbound messages (e.g. an MLLP TCP
   listener) and hands each one to a **parser**, which turns raw bytes into a
   typed, queryable structure (e.g. an HL7v2 segment tree).
2. A **mapper** reads the parser's output and produces the outbound domain
   model — for Interbox today, FHIR resources.
3. A **sender** delivers the mapped output to a destination (e.g. posts FHIR
   resources to Aidbox).

Each stage is configured by a workspace author through this SDK, but *run* by
the engine — the SDK never imports engine internals (no database driver, no
worker threads), which is what keeps a workspace's bundle small and portable.

## Where to go next

- [Getting Started](getting-started.md) — install the SDK, wire a workspace,
  build and test it.
- [Concepts](concepts/pipelines.md) — the pipeline DSL, stage contracts,
  config/env authoring, the error taxonomy, and the CLI.
- [Integration Guidelines](concepts/guidelines.md) — practical rules for
  building a production integration: spec-first mapping, error
  classification, terminology, resend-safety, the edit loop.
- [Reference](reference/index.md) — every exported subpath, symbol by symbol.

> The library runs in any ESM environment (Node, Bun, bundlers). The bundled
> `interbox` CLI requires [Bun](https://bun.sh).
