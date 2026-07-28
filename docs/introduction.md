# Introduction

Interbox is an integration engine for healthcare data. Sending systems speak
different formats over different transports; Interbox accepts those messages,
converts them into the model your system of record wants, and delivers them —
keeping every message stored, queryable, and replayable on the way through.

The conversion itself is code you write, in your own repository. Everything
around it — transport, persistence, queueing, retries, failure classification,
delivery, the operations UI — belongs to the engine.

Ingestion is format-agnostic by construction: every inbound format gets its own
table over one shared skeleton (`hl7v2_in`, `x12_in`, `ccda_in`, …), and the
source writer fills that skeleton without knowing the format. A parser decides
which fields get promoted to columns for querying. Adding a format means adding
a parser and its table, not reworking the engine. The path that ships complete
today is HL7v2 over MLLP in, FHIR to Aidbox out.

## Ideas behind it

**An integration is code, not configuration.** It is impossible to create a
perfect config or DSL that can handle all your integration cases. We don't want
to restrict you with limited programming-language dialects. Your code executes
as a first-class citizen of the Interbox engine in the same JS runtime, loaded
from your Git repo at boot and hot-reloaded on changes.

**Nothing disappears quietly.** A message is persisted before any work happens
to it. If a stage fails, the row keeps its payload and a classified cause. If
the blocker is fixable — a local code with no mapping yet — the message is
parked rather than dropped, and reprocessed once you resolve it. Delivery is
resend-aware, so replay doesn't mean duplicates.

**One datastore.** Queues, message history, mapped output, concept maps, and
outbound webhook delivery all live in PostgreSQL. There is no broker or cache
to operate alongside it, and nothing that requires one.

**Typed end to end.** The SDK ships generated HL7v2 and FHIR R4 models, so a
mapper reads and writes typed structures instead of untyped JSON, and a wrong
field name is a compile error rather than a 3 a.m. triage session.

**Troubleshooting is built in.** The dashboard gives live throughput and queue
depth, faceted search over every message received, failures grouped by cause,
and unmapped codes resolved into a terminology mapping that reprocesses parked
messages. A built-in AI assistant reads a failing message and drafts the
mapping change.

## How it works

A pipeline is `source → mapper → sender`:

- A **source** accepts inbound messages over some transport and hands each to
  its **parser**, which turns raw bytes into a typed structure and determines
  which inbound table the message lands in.
- A **mapper** — the stage you write — reads that structure and returns the
  outbound model, today FHIR resources.
- A **sender** delivers the result to its destination.

Every hop moves through a Postgres-backed queue, so no message exists only in
memory. Rows carry a status (received, processed, sent, error, deferred), and
failures carry a `<group>/<specific>` error kind, which is what lets you select
problems by cause family rather than by grepping logs. Pipelines can also push
events — parse errors, map errors, deliveries, or custom ones raised from
mapper code — to external endpoints; the engine owns signing and retries.

## What ships today

The engine implements sources, parsers, and senders; you implement mappers. The
built-in stages available now are an MLLP listener, an HL7v2 parser, and an
Aidbox FHIR sender — configured through typed descriptors from the SDK. New
stage types arrive with engine releases rather than with your workspace code.

`@health-samurai/interbox` is the authoring surface: the `pipeline()` builder, those
descriptors, the generated domain models, the `interbox` CLI, and Claude Code
skills for working in a workspace repo. It only declares: it holds no worker
implementations and no database driver.

## Where to go next

- [Getting Started](getting-started.md) — bring up the workspace template,
  send a first message, watch it land.
- [Concepts](concepts/pipelines.md) — the pipeline DSL, stage contracts,
  webhooks, config/env authoring, the error taxonomy, and the CLI.
- [Integration Guidelines](concepts/guidelines.md) — spec-first mapping, error
  classification, terminology, resend-safety, the edit loop.
- [Operations](ops/deploy.md) — deploying, sizing, securing dashboard access,
  updating the engine.
- [Reference](reference/index.md) — every exported subpath, symbol by symbol.

> The SDK runs in any ESM environment (Node, Bun, bundlers). The bundled
> `interbox` CLI requires [Bun](https://bun.sh).
