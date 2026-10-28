# Steps, store and senders

A pipeline is `source → steps → store → steps → sender`. The engine owns the
sources and runs everything; you write the steps, pick a store, and pick or
write a sender. This page covers what each of those does and what it may rely
on. [Pipelines](pipelines.md) covers the chain itself and the methods of a
`Batch`.

## Steps

A step is a function from a `Batch` of rows to a `Batch`. Pass it to `.step()`
as it is, or give it a name with `defineStep`:

```ts
import { defineStep, type Batch } from "@health-samurai/interbox/chain";
import type { Resource } from "@health-samurai/interbox/fhir";
import type { HL7v2Message } from "@health-samurai/interbox/hl7v2";

export const v2ToFhir = defineStep("v2-to-fhir", (msgs: Batch<HL7v2Message>) =>
  msgs.flatMap((msg, ctx): Resource[] => toResources(msg, ctx)),
);
```

The name is what a unit that fails in this step records as its `error_step`.
The SDK's own steps are named the same way: `hl7v2Parser()` is
`hl7v2.parse`, `fhirItems()` is `aidbox.fhir-items`, and `skipUnchanged()` is
`aidbox.skip-unchanged`.

### Where a step runs

A pipeline runs on its own threads: a **source** thread that accepts inputs and
runs the steps before the store, a **segment** thread that runs the steps after
it, and a **sender** thread. A pipeline fed through a bridge has no source
thread, and one that ends in a bridge has no sender thread.

**Steps before the store** run on each input as it arrives, before the sending
side gets its answer:

- **Their time counts against the input's deadline,** 60 seconds, and against
  whatever the sending side waits for an answer before it resends. Keep I/O
  here short, with timeouts of its own.
- **They must be safe to run again.** If the engine stops before the input
  commits, nothing of it is kept: MLLP sends no answer, and the webhook source
  answers `500` or `503` (see
  [Sources](../reference/steps.md#sources-mllpsource-and-webhooksource)). The
  sender resends, and the steps run again.
- **A failure is not stored.** A throw, a `notReady`, a deadline passed, or a
  row the store's codec cannot hold refuses the whole input: MLLP answers `AE`,
  the webhook source answers `500`, and nothing of the input is kept. The
  engine counts these refusals per pipeline; see
  [Operating Pipelines](../ops/operating.md).

**Steps after the store** run on a take of stored units — up to the store's
`batch` option, 100 by default:

- **The take's units run concurrently,** so a step must not depend on the order
  of units within a take.
- **The take has 60 seconds.** At that deadline the engine fires `ctx.signal`,
  stops waiting, and counts an attempt for each unit of the take; from then on
  each of those units is taken on its own, so one slow unit cannot hold back
  its neighbours twice.
- **A failure acts on its unit.** A `domainError` ends the unit at `error`; any
  other throw leaves it at the store to be tried again later. See
  [Errors](errors.md).
- **The results commit together.** Each unit's new status, attributes and
  items, the take's state writes and its custom events are written in one
  short transaction after the steps finish. No transaction is open while a
  step runs.

### The step's context

A step gets a `StepContext` as its second argument, and each function passed to
a `Batch` method gets the `RowContext` of its row. The table of which context
has what is in [Pipelines](pipelines.md#row-context-and-step-context).

#### `ctx.translate` — terminology

`ctx.translate(map, code)` looks a code up in one of the workspace's concept
maps and answers the match, or `undefined`. `ctx.translateFor(context, code)`
does the same with the map bound to a sending application and facility, and
`ctx.conceptMapFor(context)` names that map. The engine loads the concept maps
from the workspace checkout into every source and segment thread, and a map
changed in the checkout is read again by the running workers.

```ts
const LAB_CODES = "lab-codes";

const loincOf = defineStep("loinc-of", (codes: Batch<string>) =>
  codes.withAttrs(async (code, ctx) => ({ loinc: (await ctx.translate(LAB_CODES, code))?.targetCode ?? null })),
);
```

#### `ctx.unit` and `ctx.source` — the row's unit

After the store, a row's context names its unit: `ctx.unit` is
`{ id, attrs, createdAt }`, with `id` a `bigint`, and `ctx.source` is
`{ id, pipeline, receivedAt }`, with the unit's id as a string and its creation
time as an ISO string. Before the store there is no unit yet, and both are
`undefined`.

A resource that should point back at the unit it came from can take its id from
`provenanceId(unit)`, exported by `@health-samurai/interbox`:
`ib-<unit id>-<creation time in base-36 milliseconds>`. Pass it `ctx.unit`
once you have checked that it is not `undefined`, as the example in
[Steps](../reference/steps.md#ctxsource-and-provenanceid) does. A Retry of the
unit gives the same id, so its Provenance is updated rather than duplicated.

#### `ctx.state` and `defineState` — pipeline state

State is a small key/value store for markers, cursors and caches. You declare a
namespace once, as a typed handle, and any step holding the handle reads and
writes it:

```ts
import { defineState } from "@health-samurai/interbox/chain";

const lastSeen = defineState<{ at: string }>("last-seen");

const markLastSeen = defineStep("mark-last-seen", (msgs: Batch<HL7v2Message>, ctx) =>
  msgs.map((msg) => {
    const patient = getComponent(findSegment(msg, "PID")?.fields[3]);
    if (patient !== undefined) ctx.state(lastSeen).set(patient, { at: new Date().toISOString() });
    return msg;
  }),
);
```

- `get(key)` answers the value or `null`; `get(keys)` answers a `Map` that
  leaves out the keys it did not find. `set` and `del` take one key or many.
- State belongs to the pipeline: each pipeline has its own copy of a
  namespace, and no pipeline sees another's.
- Writes are buffered and committed with the work they belong to: before the
  store, with the input; after it, with the take. A take abandoned at its
  deadline writes none of them. A take's writes are the take's, not one
  unit's: they land even when the unit that made them fails.

A namespace name uses lowercase Latin letters, digits, `-` and `.`, and starts
with a letter. See [Units and state](units-and-state.md) for the rest.

#### `ctx.units` — other units of the pipeline

`ctx.units.count(filter)` and `ctx.units.find(query)` read the pipeline's own
units by attributes and status, for questions such as "the last messages for
this patient":

```ts
msgs.map(async (msg, ctx) => {
  const patient = getComponent(findSegment(msg, "PID")?.fields[3]) ?? "";
  const earlier = await ctx.units.find({ attrs: { patient_id: patient }, status: "sent", order: "newest", limit: 10 });
  return earlier.length === 0 ? markFirstVisit(msg) : msg;
});
```

Each attribute matches by equality, and every condition must hold. `find`
answers at most `limit` units, 100 by default and 1000 at most, newest first
unless `order` is `"oldest"`. A lookup by an attribute the store declares in
`index` reads that index; any other attribute scans the pipeline's units, and a
lookup per row is one query per row. See [Units and state](units-and-state.md).

#### `ctx.sender.queued` — what is waiting to be sent

`ctx.sender.queued(keys)` answers, for each of the keys that has an item
waiting in this pipeline's sender queue, the meta of its newest waiting
version. `skipUnchanged()` uses it to compare a resource with the version
already on its way.

#### `ctx.webhook` — custom events

A row function may raise an event of its own with
`ctx.webhook("custom:<name>", payload)`. It is written with its unit's result,
and dropped if the unit fails. See [Webhooks](webhooks.md).

#### `ctx.signal`

An `AbortSignal` the engine fires at the deadline of the work, and when a
stop's grace period ends: `INTERBOX_STOP_GRACE_MS` after the stop begins, 10
seconds by default (see [Updating the Engine](../ops/updating.md)). Pass it to
anything slow, such as `fetch`.

External APIs are reached through systems declared with `defineSystem`, called
from steps on either side of the store. See [Systems](systems.md).

## The store

```ts
.store(postgresStore({ codec: "text" }))
```

The store is the one point in a pipeline where work becomes durable:

- **Units are created there.** Each row that reaches the store becomes a unit,
  status `received`, and its value is written to the pipeline's store table in
  the same transaction.
- **The sending side is answered after it commits.** For MLLP that commit is
  the `AA`; for the webhook source, the `200`. A failure before it leaves
  nothing behind, so the sender's resend starts clean.
- **A unit's retries start from it.** An automatic retry of a unit whose step
  failed, and the operator's Retry, run the steps after the store again, on
  the stored value, with the current code. A sender that tries an item again
  sends the item as it was queued, without running the steps.
- **It keeps what it holds.** There is no retention: the store keeps every
  value, so a Retry always has its input.

A pipeline has exactly one store. Its table is `interbox.store__<pipeline>`,
with hyphens in the name turned into underscores, created by the engine when
it first loads the pipeline. The codec picks the column a value lives in —
`"text"` for strings such as HL7v2 or CSV, `"json"` for JSON values, `"bytes"`
for binary — and decides at compile time what may reach the store.

**What is stored** is the output of the last step before the store. Store the
raw input, as the template does, and a Retry after a parser fix parses the
original again; store the parsed form, and the raw input is gone. A unit
skipped before the store has no stored value, and cannot be retried.

**Changing the codec** of a pipeline that already holds units fails those
units with `engine/codec_mismatch` when they are next taken, because their
values sit in another column.

The store's options — attribute indexes, the search index and the take size —
are in [Pipelines](pipelines.md#the-store-and-its-options).

## Senders

`.sender()` ends the chain with one of three things: the built-in `aidbox()`, a
sender of your own from `defineSender()`, or `intoPipeline()`, which hands the
items to another pipeline (see [Bridges](pipelines.md#bridges)).

### From the steps to the sender

When a unit's steps finish, every row left becomes an **item** of that unit, in
the sender's queue, and the unit becomes `processed` — in the same transaction.
`withMeta` gives an item its `key`, its identity at the destination such as
`Patient/123`, and any other meta the sender reads. A unit with no item left
closes as `sent` at once.

The pipeline's sender thread then picks the items that are due, in the order
they became due, up to the sender's `batch`, and passes them to the sender's
`run` as **seeds**. Two rules hold for items that share a key:

- **Versions go out oldest first.** An item is not picked while an older item of
  the same key is waiting. Older means an earlier `order_at` of its unit — the
  event time a step set with `withOrder`, or else its arrival — then the lower
  unit id, then the lower item id.
- **One worker holds a key at a time.** The engine leases each seed's key while
  `run` works on it.

A declared sender is code and configuration: several pipelines may end in the
same sender value, and each still has its own queue, its own sender thread and
its own state.

### `defineSender`

```ts
import { defineSender, drainFifo, rejected, retry } from "@health-samurai/interbox/chain";

export const postJson = (url: string) =>
  defineSender<unknown>({
    id: "post-json",
    retryDelayMs: 10_000,
    run: (ctx, seeds) =>
      drainFifo(seeds, async (seed) => {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]);
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(seed.payload),
          signal,
        });
        if (res.ok) return "sent";
        const message = `HTTP ${res.status}`;
        if (res.status >= 500) return retry({ kind: "sender/http_unavailable", message });
        return rejected({ kind: "sender/http_rejected", message });
      }),
  });
```

| option | default | what it sets |
|---|---|---|
| `id` | none | an optional name, kept in the pipeline's definition and checked like a pipeline name |
| `run(ctx, seeds)` | — | one delivery cycle: send the seeds and answer an outcome for each |
| `batch` | 100 | the most seeds one cycle gets |
| `maxRetries` | 10 | the `retry` outcome that brings an item to this many tries rejects it |
| `retryDelayMs` | 30 000 | the fixed delay before an item answered `retry` or `wait` is tried again |
| `runTimeoutMs` | 60 000 | how long one `run` may take |

`run` gets the seeds and a context:

- each seed has `id` (the item's id), `unitId`, `key`, `payload` (the row) and
  `meta`;
- `ctx.signal` fires at `runTimeoutMs` and when a stop's grace period ends;
- `ctx.items.oldest(keys)` takes the oldest waiting version of other keys, for
  a sender that sends related items together, and lists the keys another
  worker holds as `busy`;
- `ctx.state(handle)` reads and writes pipeline state, committed with the
  cycle's result.

`run` answers `{ items: [{ id, outcome }] }`, one entry per seed.
`drainFifo(seeds, send)` builds that answer for the common case: it sends the
seeds one at a time, in id order, and turns a throw from `send` into a `retry`
of kind `sender/send_failed`.

### Sender outcomes

| outcome | write it as | what the engine does |
|---|---|---|
| sent | `"sent"` | deletes the item. When none of the unit's items is left, the unit becomes `sent` |
| retry | `retry({ kind, message })` | an error, such as a 5xx or a timeout: counts one try, and tries again after `retryDelayMs`. The try that reaches `maxRetries` rejects the item with this error |
| wait | `wait({ kind, message })` | not an error, such as a reference not at the destination yet: tries again after `retryDelayMs`, counting nothing and with no limit |
| rejected | `rejected({ kind, message })` | a permanent refusal: deletes the item and the unit's other waiting items that no worker holds, and ends the unit at `error` with `error_step` `sender`, the outcome's kind, and the message prefixed with the item's key |

What was delivered stays delivered; a Retry of a failed unit starts again from
the store. An item answered `retry` or `wait` whose unit has meanwhile reached
`error` or been deferred is dropped.

The engine also answers for `run` when it cannot:

| when | every affected seed gets |
|---|---|
| `run` throws | `retry`, kind `engine/run_failed` |
| `run` is still running at `runTimeoutMs` | `retry`, kind `engine/run_timeout`, and `ctx.signal` fires |
| a seed has no outcome in the answer | `retry`, kind `engine/no_outcome` |
| a seed has two outcomes | `retry`, kind `engine/duplicate_outcome` |
| an outcome is none of the four shapes above | `retry`, kind `engine/invalid_outcome` |

So return `rejected` for a refusal you know to be permanent instead of
throwing: a throw retries every seed of the cycle. The items waiting in each
pipeline's queue, and what each one waits for, are on the dashboard; see
[Operating Pipelines](../ops/operating.md).

## The Aidbox sender

`aidbox()` from `@health-samurai/interbox/aidbox` writes FHIR resources to
Aidbox. It goes with two steps from the same module:

```ts
  .step(v2ToFhir)
  .step(fhirItems())
  .step(skipUnchanged())
  .sender(aidbox({ url: env("AIDBOX_URL"), auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") } }));
```

- **`fhirItems()`** gives each resource its item key, `Type/id`, the `Type/id`
  references it holds, and a hash of its content. `aidbox()` accepts only its
  output, so leaving it out is a compile error. Put it after every step that
  changes the resources. A resource with no `resourceType` or `id` fails its
  unit.
- **`skipUnchanged()`** skips, as `unchanged`, a resource identical to the
  newest version of its key already waiting to be sent, or, when none is
  waiting, to the version last delivered. The units of one take do not see
  each other's versions, so a resource that changes A → B → A within one take
  can end at B.

| option | default | |
|---|---|---|
| `url` | — | Aidbox's base URL; resources go to `<url>/fhir` |
| `auth` | — | `{ kind: "basic", user, password }` or `{ kind: "bearer", token }` |
| `id` | none | an optional name, as for `defineSender` |
| `batch` | 100 | seeds per cycle |
| `maxRetries` | 10 | tries before an item that keeps failing is rejected |
| `retryDelayMs` | 30 000 | delay before the next try |
| `runTimeoutMs` | 300 000 | how long one cycle may take |
| `validateFirst` | off | check the resources with `$validate` before sending them |

`url` and the `auth` fields may be `env()` references. They are read as each
cycle starts, so an unset variable fails that cycle and retries its seeds.

### What one cycle does

1. **It takes each seed's references along.** For every `Type/id` a seed refers
   to that is also waiting in the queue, the oldest waiting version comes into
   the same cycle, and so on for what that refers to. A seed whose references
   reach a key another worker holds waits, with `sender/reference_busy`.
2. **It skips what Aidbox already has.** The sender keeps a fingerprint, the
   content hash, of every resource Aidbox accepted, in the pipeline's state.
   A resource whose hash matches is answered `sent` without a request. One with
   a fingerprint is sent as `PATCH`, one without as `PUT`. To remove an element
   from a resource delivered before, map it as `null`: a `PATCH` removes it,
   and the first send, a `PUT`, drops nulls. A `PATCH` that Aidbox answers
   `404` or `410`, because the resource was deleted there, is sent again at once
   as a `PUT`.
3. **It sends batch bundles,** grouping resources that refer to each other,
   and records the fingerprint of each resource Aidbox accepts.

Each entry of Aidbox's answer becomes the item's outcome:

| Aidbox answers | outcome | kind |
|---|---|---|
| `2xx` | sent | — |
| a reference to a resource it does not have | wait | `sender/reference_missing`; the message names every missing reference |
| `409` with an edit conflict | wait | `sender/edit_conflict` |
| `5xx` | retry | `sender/aidbox_unreachable` |
| any other refusal | rejected | `sender/aidbox_rejected` |

The message of a refusal lists every error Aidbox reported for the resource,
not only the first, each as `<path>: <diagnostics> [<codes>]`, where the codes
are Aidbox's issue type and schema, for example
`3 errors: Patient.gender: Invalid type for the field. Expected 'code', but got 'decimal' [invalid-type, schema-id:Patient]; Patient.foo: Unrecognized property 'foo' [unknown-key]; …`.
The list is cut at 2,000 characters, and then ends
`… and <n> more`. A resource waits for a missing reference only when every
error is a missing reference; one with another error as well is rejected, since
the reference arriving would not fix it.

A request that fails as a whole — a timeout, a network error, a redirect, a
`5xx`, `408`, `425` or `429` — answers `retry` with `sender/aidbox_unreachable` for its
items; any other `4xx`, such as `401`, answers `rejected` with
`sender/aidbox_rejected`. The requests after a failed one in the same group are
not sent, and their items wait with `sender/not_attempted`. With
`validateFirst`, a resource `$validate` rejects is rejected, with every error
`$validate` reported for it in the same form, and the other resources of its
unit wait with `sender/unit_rejected`.

A reference that Aidbox does not have yet only waits: the item is tried again
every `retryDelayMs` until the referenced resource arrives, counting nothing.
Such items keep their unit at `processed`. The dashboard's sender panel counts
the waiting items by kind, and a unit's page shows each item's last error,
whose message names every missing reference.

To send a resource again even though it did not change, forget its fingerprint
and retry the unit that produces it — `forgetDelivered` and `retryUnits` in
[Admin Scripts](../ops/admin-scripts.md).

Four environment variables tune the requests: `INTERBOX_AIDBOX_MAX_BODY_BYTES`
(8 MiB by default), `INTERBOX_AIDBOX_MAX_ENTRIES_PER_REQUEST`,
`INTERBOX_AIDBOX_CONCURRENCY` (4 by default) and
`INTERBOX_AIDBOX_REQUEST_TIMEOUT_MS` (none by default; the cycle's deadline
still stops a request that hangs). A cycle's resources are split over up to
`INTERBOX_AIDBOX_CONCURRENCY` requests sent at the same time, about the same
size and at least 50 resources each where the cycle allows it; resources joined
by a reference stay in order.
