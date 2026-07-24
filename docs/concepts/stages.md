# Stages: source, parser, mapper, sender

A pipeline has three stage kinds plus a parser bound to each source. Each is
identified by a `type` string; the SDK carries the **config shape** and a
handful of **built-in descriptors** — the engine owns every actual
implementation, looked up by `type` at runtime. This is what keeps a
workspace's bundle free of database drivers, worker-thread code, and network
clients.

Who implements what:

| stage | who writes it | you configure it with |
|---|---|---|
| source | engine | `mllpSource({ id, host, port, parser })` |
| parser | engine | `hl7v2Parser({ skipZSegments })`, bound to a source |
| mapper | **you** | `defineMapper({ type, parser, map })` |
| sender | engine | `aidboxSender({ url, auth, batchSize, maxRetries })` |

## Source + parser

A source produces raw messages (e.g. an MLLP TCP listener); its bound parser
turns each one into a typed structure and determines which inbound table it
lands in — the table is derived from the parser, never configured separately.

You never implement a source or parser; you pick a built-in descriptor and
configure it — see [/builtins](../reference/builtins.md).

## Mapper

A mapper reads a parser's output and produces the outbound domain model (FHIR
resources, for Interbox today). This is the one stage kind meant to hold your
business logic — the whole point of a workspace repo:

```ts
defineMapper({
  type: "v2-to-fhir",
  // by descriptor — types `input` below and ties the mapper to that
  // parser's output table
  parser: hl7v2Parser,
  // input: ParserOutputMap["hl7v2"], ctx: MapperContext
  map(config, input, ctx) {
    // ... return a FHIR resource, an array of them, or undefined to skip
  },
});
```

See [Mapper authoring](../reference/mapper.md) for the full `defineMapper`/
`MapperRegistry` reference, and [Errors](errors.md) for how a mapper reports
a failure the engine can classify.

## Sender

A sender delivers mapped output to a destination (e.g. posts FHIR to Aidbox).
Delivery, batching, and retries are engine-owned; you tune them through the
sender's config:

- `batchSize` — max rows claimed per delivery loop.
- `maxRetries` — consecutive *transient* failures (destination unreachable,
  5xx) to retry before the batch is recorded as errored. Permanent rejections
  (e.g. Aidbox validation errors) don't retry — they land in the error queue
  as `aidbox_rejected` for triage.

## Why the split

The engine implements the stages; the SDK's `builtins/*` module supplies
typed **descriptors** (`mllpSource`, `aidboxSender`, `hl7v2Parser`) so a
workspace references a built-in stage by value, with full type-checking on
its config, instead of by a bare string. The only stage a workspace
implements itself is the mapper, via `defineMapper`. (The underlying
engine-side contracts live in [`/core`](../reference/core.md) — you'll
rarely need them.)
