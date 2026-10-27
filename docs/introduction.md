# Introduction

Interbox is an integration engine for healthcare data. Sending systems speak
different formats over different transports; Interbox accepts those messages,
converts them into the model your system of record wants, and delivers them —
keeping every message stored, queryable, and replayable on the way through.

The conversion itself is code you write, in your own repository. Everything
around it — transport, persistence, queueing, retries, failure classification,
delivery, the operations UI — belongs to the engine.

There is no inbound table per format. Each pipeline keeps what it receives in a
store table of its own, and every unit of work, whatever its format, is a row of
one units table. Your steps decide what a unit records about itself: the
attributes the dashboard filters on and the text it searches. Adding a format
means writing steps, not adding a table to the engine. The path that ships
complete today is HL7v2 over MLLP in, FHIR to Aidbox out.

## Ideas behind it

**An integration is code, not configuration.** It is impossible to create a
perfect config or DSL that can handle all your integration cases. We don't want
to restrict you with limited programming-language dialects. Your code executes
as a first-class citizen of the Interbox engine in the same JS runtime, loaded
from your Git repo at boot and hot-reloaded on changes.

**Nothing disappears quietly.** A message is stored before the steps after the
store touch it, and the sending side gets its acknowledgement only once it is
stored. A message that cannot be stored is refused back to the sender, which
resends it. A stored message that fails keeps its input and a classified cause,
and a Retry runs it again from the store, with your current code and concept
maps. Delivery to Aidbox is resend-aware: resources that did not change are not
sent again.

**One datastore.** Units, stored inputs, delivery queues, pipeline state and
outbound webhook delivery all live in PostgreSQL. Concept maps are JSON files
in your workspace, under `src/terminology/concept-maps/`. There is no broker or
cache to operate alongside it, and nothing that requires one.

**Typed end to end.** The SDK ships generated HL7v2 and FHIR R4 models, and the
row type flows from one step to the next, so a step reads and writes typed
structures instead of untyped JSON. A wrong field name, or a value the store
cannot hold, is a compile error rather than a 3 a.m. triage session.

**Troubleshooting is built in.** The dashboard shows each pipeline's units by
status, filters them on the attributes you declare, searches the text you choose
to make searchable, and groups failures by the step and the cause. It shows the
deliveries still waiting and what each one waits for. A built-in AI assistant
can read failing units through the same API.

## How it works

A pipeline is `source → steps → store → steps → sender`:

- A **source** accepts inputs over a transport: an MLLP listener, or an HTTP
  endpoint that takes a POST body.
- **Steps before the store** run on each input as it arrives, before it is
  acknowledged. They may split one input into many, drop or skip rows, and
  record attributes.
- The **store** is where a **unit** comes into being: each row that reaches it
  becomes one unit, stored in the pipeline's own table. Once it commits, the
  source acknowledges the input. Every retry starts from here.
- **Steps after the store** run on stored units in batches — parse, map, look
  things up. A unit's row may fan out into many **items**, such as the FHIR
  resources one message produces.
- A **sender** delivers each unit's items to the destination, item by item,
  with its own retries.

Every unit has one of six statuses: `received` at the store, `processed` once
its items are queued for the sender, then `sent`, `skipped` or `error`, or
`deferred` when an operator sets it aside. A failure records the step it
happened in and a kind such as `parse/not_hl7`, so you select problems by
cause rather than by grepping logs. Each status a unit enters can be pushed to
an external endpoint as a webhook event, beside custom events raised from your
steps; the engine owns signing and retries.

## What ships today

The engine owns the transports and the runtime; you write steps, and you may
write a sender of your own. Built in today:

- sources: `mllpSource` and `webhookSource`;
- the store: `postgresStore`;
- steps: `hl7v2Parser()` for HL7v2, `fhirItems()` and `skipUnchanged()` for
  Aidbox;
- the sender `aidbox()`, which writes FHIR resources to Aidbox.

`@health-samurai/interbox` is the authoring surface: the `pipeline()` builder and
the chain DSL in `/chain`, those built-ins, the generated domain models, the
`/admin` library for workspace scripts, the `interbox` CLI, and Claude Code
skills for working in a workspace repo. A workspace bundles none of the engine:
no worker implementation and no database driver.

## Where to go next

- [Getting Started](getting-started.md) — bring up the workspace template,
  send a first message, watch it land.
- [Concepts](concepts/pipelines.md) — the chain DSL, steps, the store and
  senders, units and state, webhooks, config/env authoring, the error
  taxonomy, and the CLI.
- [Integration Guidelines](concepts/guidelines.md) — spec-first mapping, error
  classification, terminology, resend-safety, the edit loop.
- [Operations](ops/deploy.md) — deploying, sizing, operating, securing
  dashboard access, updating the engine.
- [Reference](reference/index.md) — every exported subpath, symbol by symbol.

> Workspaces run inside the engine, on [Bun](https://bun.sh). The SDK is plain
> ESM, but parts of it call Bun's own APIs — the content hash behind
> `skipUnchanged()` is one — and the bundled `interbox` CLI requires Bun.
