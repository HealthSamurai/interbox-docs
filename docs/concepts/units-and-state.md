# Units and State

A pipeline turns each input into **units** at its store, turns each unit into
**items** for its sender, and remembers what it needs between inputs in
**state**. This page describes those three, and what a step can and cannot
reach. For the methods a step uses, see [Steps](../reference/steps.md).

## Units

A **unit** is one row that reaches a pipeline's `.store()`. Steps before the
store may split an input into many rows; each of them becomes a unit. Anything
before the store is transient: a unit exists from the moment the store commits
it, and the sending side is answered only after that commit.

```ts
pipeline("lab-batch")
  .source(webhookSource({ port: env("LAB_PORT") }))
  .step((files) => files.flatMap(splitBatch).withAttrs((m) => ({ msg_id: controlIdOf(m) })))
  .store(postgresStore({ codec: "text" }), { index: { msg_id: "btree" } })
  .step(hl7v2Parser())
  .step(labToFhir)
  .step(fhirItems())
  .sender(toAidbox);
```

One HTTP request holding a batch of lab messages becomes one unit per message.
`splitBatch` and `controlIdOf` stand for functions of your own: the first
splits the request body into raw messages, the second reads a raw message's
MSH-10. The rows stay strings up to the store, which keeps each message as
text for `hl7v2Parser()` to parse after it.

- **A unit is identified by its id alone.** One sequence numbers the units of
  every pipeline, so an id names one unit and, through it, its pipeline.
- **Every arrival is a new unit.** Nothing deduplicates at the store: an MLLP
  message resent after a lost ACK becomes a second unit. For Aidbox that is
  harmless, because `skipUnchanged()` skips resources that have not changed.
- **The store keeps what the last step before it produced**, in the codec the
  store declares: `text`, `json` or `bytes`. Put `.store()` right after
  `.source()` to keep the raw input, which a Retry then processes again from
  the start. The store keeps every value; there is no retention yet.
- **A unit skipped before the store has no stored value**, and cannot be
  retried.

A unit carries:

| field | what it holds |
|---|---|
| `id` | its identity |
| `pipeline` | the pipeline it belongs to |
| `status` | one of six, below |
| `attrs` | the facets steps recorded for it, a JSON object |
| `search_text` | the text the dashboard searches, when a step set one |
| `order_at` | the time of the event it records, or its creation time when no step set one |
| `error_step`, `error_kind`, `error_message` | where and why it failed |
| `origin_unit_id` | the unit of the previous pipeline it came from through a bridge; empty for a unit a source created |
| `correlation_id` | the unit the whole chain of work started from |
| `created_at`, `updated_at` | when it was stored, and last changed |

## Items: fan-out after the store

Units are created only at the store. A `flatMap` after it splits a unit's row
into **items**, which stay the unit's. When the steps after the store finish,
the engine writes each item into the pipeline's sender queue, in the order the
`Batch` holds them, and the unit becomes `processed`.

- **The unit is the unit of retry.** If a step fails for one item, the whole
  unit fails, with `error_step` naming that step. A Retry runs the unit again
  from the store, for all its items. Only the sender retries per item.
- **An item's `key`**, set with `withMeta` or by `fhirItems()`, is its identity
  at the destination, such as `Patient/123`. The sender never holds two
  versions of one key at once, and sends them in the order of their units'
  `order_at`, then the order the units were created in.
- **Skipped items are counted on the unit**, under `attrs._skipped`, as
  `{ "unchanged": 12 }`. A unit whose items were all skipped or filtered closes
  `sent` at once, with nothing to send.
- **A finished item leaves a record for a retention window.** Every item that
  leaves the sender queue keeps a summary record: its key, its resource type
  and id, how it finished and why, and when. Only an item the sender rejected
  keeps its body as well; a delivered, dropped or deleted one does not. The
  record is purged after `INTERBOX_DONE_ITEMS_RETENTION_DAYS` days, 7 by
  default, from one hour up to `36500`, or never at `0` (see
  [Operating Pipelines](../ops/operating.md#environment)). The Unit page lists
  the items still waiting, each with its tries, its next try and its last
  error, and its FHIR resources tab lists both the waiting and the finished
  items carrying a FHIR resource, each finished one with how and when it
  finished. A rejected item is also named in its unit's error message, such as
  `Patient/123: …`.
- **A unit's items are held in memory for the take**, because they are written
  with the take's result. Fan-out after the store is for the resources of one
  message or document, not for millions of rows.
- **Through a bridge**, each item becomes a unit of the next pipeline instead
  (see [Correlation and lineage](#correlation-and-lineage)).

## Statuses

A unit has one of six statuses. Steps name none of them: the engine sets each at
a durable point, never between two steps.

| status | the unit… |
|---|---|
| `received` | rests at the store, waiting for or being run through the steps after it |
| `processed` | has items in the sender queue |
| `sent` | has nothing left to send: its last item was delivered, it produced none, or it went on through a bridge |
| `skipped` | was skipped by a step |
| `error` | failed; nothing more happens to it until an operator acts |
| `deferred` | was set aside by an operator from `error` |

How a unit moves between them:

| from | to | when |
|---|---|---|
| — | `received` | the store commits it, from a source's input or from a bridge |
| — | `skipped` | a step before the store skipped its row; nothing is stored |
| `received` | `received` | a step answered `notReady`, a [reference lookup](../reference/steps.md#reference-lookups-definelookup-and-ctxlookup) was not ready, or a step failed in a way that may pass; the unit is taken again later |
| `received` | `processed` | the steps after the store produced at least one item |
| `received` | `sent` | they produced no item, or the pipeline sends into a bridge |
| `received` | `skipped` | a step after the store skipped its row before any split |
| `received` | `error` | a step threw a `domainError`; failures that may pass used up five attempts; the take kept passing its deadline; the stored value is missing or held in another codec; the result could not be written |
| `processed` | `sent` | its last item was delivered, or an operator deleted the items left |
| `processed` | `error` | the sender rejected one of its items, or one used up its retries; its other waiting items that no send holds are deleted |
| `error` | `deferred` | an operator deferred it |
| `error`, `deferred`, `sent` | `received` | an operator retried it |

Each status a unit enters is also a webhook event of the same name, for a
pipeline that subscribes to it — see [Webhooks](webhooks.md).

**`error_step` says where a unit failed:** the name of the step that threw (see
[`defineStep`](../reference/steps.md#definestep) for how steps are named),
`sender` when the sender rejected it, `store` when its stored value could not be
read, or `engine` when no single step is to blame. A Defer keeps the error
fields; a Retry clears them. Every retry, automatic or an operator's, starts at
the store and runs every step after it again, with the code the workspace has
then.

## Correlation and lineage

Work in several stages is several pipelines joined by a bridge: pipeline A ends
in `.sender(intoPipeline("b"))`, and pipeline B starts with
`.source(fromPipeline("a"))`. Each item A's steps produce is written straight
into B's store as a unit of B, in the transaction that closes A's unit as
`sent`.

```ts
pipeline("deliveries")
  .source(webhookSource({ port: env("DELIVERY_PORT") }))
  .store(postgresStore({ codec: "text" }))
  .step(splitDelivery)
  .sender(intoPipeline("practitioners"));

pipeline("practitioners")
  .source(fromPipeline("deliveries"))
  .store(postgresStore({ codec: "json" }))
  .step(buildPractitioner)
  .step(fhirItems())
  .sender(toAidbox);
```

- **B has no steps before its store**, since nothing would run them; the
  builder after `fromPipeline` offers only `.store()` and `.webhook()`. Each
  of A's items must fit B's codec, or A's unit fails with
  `engine/codec_mismatch`.
- **The two must name each other.** A pipeline that sends into, or reads from,
  a pipeline that does not answer in kind refuses the workspace load.
- **`origin_unit_id`** on each unit of B names the unit of A it came from.
- **`correlation_id`** is the id of the unit the work started from. A unit a
  source creates takes its own id, and a bridge copies it unchanged, so
  everything one delivery produced, across pipelines, shares one correlation
  id. The Unit page lists the units that share it.
- **B's units start with A's `order_at`**, so the versions of a resource B sends
  keep the order of A's events. They start with no attrs of their own.

**Lineage lasts while an item is in flight.** A delivered item's row is gone,
so the lasting record of what a unit delivered is in the destination, when a
step emits one: a `Provenance` with an id from
[`provenanceId`](../reference/steps.md#ctxsource-and-provenanceid). What was
sent can also be produced again by retrying the unit, since the store keeps its
input.

## Attrs and declared indexes

`attrs` holds a unit's facets: the dimensions the dashboard filters and counts
on, and that steps look units up by. A step sets them with `withAttrs`; before
the store a row inherits the attrs of the row it was split from.

The store declares which attrs are indexed:

```ts
.store(postgresStore({ codec: "text" }), {
  index: { patient_id: "btree", message_type: "btree" },
  search: "trgm",
  batch: 100,
})
```

| option | what it does |
|---|---|
| `index` | a `btree` index on each named attr, in this pipeline's units only |
| `search` | `"trgm"` indexes `search_text` for the dashboard's substring search |
| `batch` | how many units one take holds; 100 by default |

- **The engine builds the indexes when it loads the pipeline**, without
  blocking writes to a pipeline that already has units. A pipeline gets new
  facets with no migration.
- **The dashboard filters and counts on declared attrs only**, beside
  `status`, `error_kind` and `error_step`. A step's `ctx.units` may filter on
  any attr, but an undeclared one reads every unit of the pipeline.
- **Every index costs a write per status change.** A unit changes status about
  three times, and each change rewrites each of its indexes. Declare the attrs
  you filter on, not every attr you set.
- **Attrs are untyped.** A misspelled attr name compiles, and its filter finds
  nothing.
- **Attrs are shown to anyone who can read the dashboard.** Record what an
  operator needs to find a unit.

### `search_text`

`withSearchText` sets the text the dashboard's search reads. It is kept apart
from `attrs`, so the facets never read it. With `search: "trgm"` declared,
the Units page finds units whose text contains every word typed, each word at
least three letters or digits long; without it, the pipeline has no search. A
step's `ctx.units` does not read it.

## Pipeline state

State is a small durable key/value store a pipeline keeps between inputs: a
cursor, a "seen this already" marker, a cached lookup, a fingerprint of what the
destination holds. It is declared as a typed handle, and any step that imports
the handle can use it:

```ts
const lastSeen = defineState<{ orderAt: string }>("adt.last-seen");
```

- **One scope, the pipeline.** Each pipeline has its own copy of every
  namespace, and no pipeline reads another's.
- **Writes commit with the work.** A step's writes commit with its input or its
  take, and nothing of an input refused or a take abandoned is written. Other
  work sees only committed values. See
  [State](../reference/steps.md#state-definestate-and-ctxstate) for the exact
  rules.
- **A sender keeps state too.** The Aidbox sender records a fingerprint of each
  resource it delivered, which `skipUnchanged()` reads. The
  [admin library](../ops/admin-scripts.md) reads and clears them.
- **No time to live.** A namespace that would grow forever is cleaned with
  `del`.
- **One writer per key is your convention.** Two steps writing one key race, and
  the last write wins. State is for markers, cursors and caches, not for
  coordinating work.
- **Names are what the rows are stored under.** Renaming a namespace, or the
  pipeline, leaves the old rows behind. The engine logs pipelines whose stored
  data no declared pipeline names, and never drops them.

## Why steps get no database handle

A step reaches the outside world through what its context offers —
`ctx.state`, `ctx.units`, `ctx.lookup`, `ctx.sender.queued`, terminology — and
through [systems](systems.md) for external APIs. Reference data you load into
the database, such as a provider registry or a code table, is read by key
through [`ctx.lookup`](../reference/steps.md#reference-lookups-definelookup-and-ctxlookup),
from tables of the `reference` schema only. A step gets no database connection,
by decision:

- **Retries and deadlines stay safe.** Steps may run more than once: every retry
  starts at the store, and a take that passes its deadline is abandoned and
  taken again. The engine writes a unit's status, its items, its state and its
  events in one transaction with the result, so abandoned work writes nothing.
  A step's own writes would be repeated by a retry, and kept by work that was
  abandoned.
- **The engine's tables are not an interface.** SQL a workspace runs against
  them breaks, with no compile error, on the release that changes them.
  `ctx.units` and `ctx.state` are versioned with the SDK, and so is the
  [admin library](../ops/admin-scripts.md) that scripts use.
- **A read-only handle could not be held to reads.** Raw SQL on the same
  connection could write, and a database driver in the SDK would ride in every
  workspace bundle.

For the same reasons a sender's `run` gets no database handle: it returns an
outcome for each item, and the engine records them.
