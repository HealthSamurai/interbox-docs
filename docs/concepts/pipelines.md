# Pipelines

A pipeline is a chain: one source, any number of steps, one store, any number
of steps, one sender.

```ts
import { env } from "@health-samurai/interbox";
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
import { mllpSource, pipeline, postgresStore } from "@health-samurai/interbox/chain";
import { hl7v2Parser } from "@health-samurai/interbox/hl7v2";
import { v2ToFhir } from "../../mappers/v2-to-fhir/index.ts";

pipeline("adt")
  .source(mllpSource({ port: env("MLLP_PORT") }))
  .store(postgresStore({ codec: "text" }), { index: { patient_id: "btree" } })
  .step(hl7v2Parser())
  .step(v2ToFhir)
  .step(fhirItems())
  .step(skipUnchanged())
  .sender(aidbox({ url: env("AIDBOX_URL"), auth: { kind: "bearer", token: env("AIDBOX_TOKEN") } }));
```

`pipeline(name)` declares the pipeline and registers it in one call; the calls
chained on it complete the declaration. The names in the examples below come
from `@health-samurai/interbox/chain`, except the HL7v2 helpers, from `/hl7v2`,
and the Aidbox ones, from `/aidbox`.

The `pipeline()` and `defineMapper` that the package root,
`@health-samurai/interbox`, exports are the 1.x DSL. A 2.0 engine runs only
the pipelines in `ChainRegistry`, and refuses to load a workspace that
registers a pipeline or a mapper through them, naming each one.

## The chain

| method | what it adds |
|---|---|
| `.source(source)` | where inputs come from: `mllpSource`, `webhookSource`, your own `defineSource()` (see [Your own source](#your-own-source)), or `fromPipeline` (see [Bridges](#bridges)) |
| `.step(step)` | a step, before or after the store. Repeatable |
| `.store(postgresStore({ codec }), options?)` | the store, exactly once. See [The store](#the-store-and-its-options) |
| `.sender(sender)` | the sender, which ends the chain: `aidbox()`, your own `defineSender()`, or `intoPipeline()` |
| `.webhook({ url, secret?, on })` | an event subscription, at any point of the chain. Repeatable. See [Webhooks](webhooks.md) |

The rules:

- **One source, one store, one sender, no branching.** Each call returns the
  next stage of the builder, and a builder that has already moved on refuses a
  second call: `p.step(a); p.step(b)` throws `pipeline branching is not
  supported`. A second destination is a second pipeline.
- **The chain must end in `.sender()`.** A pipeline without one stops the
  workspace from loading, with `pipeline "<name>" has no sender`.
- **Row types flow down the chain.** Each step's input type is the previous
  step's output, the store's codec must fit the rows that reach it, and the
  sender's item type must match the last step's output. A mismatch is a compile
  error at the call that breaks it.
- **Names are checked when declared.** A pipeline name uses lowercase Latin
  letters, digits and `-`, starts with a letter, and has at most 46
  characters. `engine` is reserved, and a name declared twice throws
  `duplicate pipeline name`.
- **The name is the pipeline's identity in storage.** The pipeline's tables are
  named after it. Renaming a pipeline starts it on new, empty tables; the old
  ones are kept and reported in the engine log as orphaned, never dropped.

## Steps

A step takes the rows as a `Batch` and returns a `Batch`:

```ts
type StepFn<A, B> = (rows: Batch<A>, ctx: StepContext) => Batch<B> | Promise<Batch<B>>;
```

Pass a function to `.step()`, or name it with `defineStep(name, fn)`. The name
is what a failure records as its step: the name given to `defineStep`, else the
function's own name, else `#` and the step's position in the pipeline counted
from 1, such as `#3`. A position shifts when steps are reordered, so name the
steps whose failures you want to find again.

```ts
const tagProcessingId = defineStep("tag-processing-id", (msgs: Batch<HL7v2Message>) =>
  msgs.withAttrs((msg) => ({ processing_id: getComponent(findSegment(msg, "MSH")?.fields[11]) ?? "unknown" })),
);
```

A `Batch` remembers which unit each row belongs to, so the engine knows which
unit to write attributes to, which unit an item belongs to, and which unit to
blame for a failure. A step changes rows only through the methods below, and
must return the `Batch` they made: a collection the step builds on its own
carries no units, and the engine refuses it.

A `Batch` is lazy. A method records what to do; the engine pulls the rows
through the whole chain when it needs them.

### The methods of a `Batch`

| method | what it does |
|---|---|
| `map(fn)` | one row in, one row out |
| `flatMap(fn)` | one row in, any number out: `fn` returns an array, any iterable, or an async iterable. An element may be `skip(reason, attrs?)` in place of a row |
| `filter(fn)` | keeps the rows for which `fn` returns `true` and drops the rest, leaving no trace |
| `skip(fn)` | drops a row with a trace: `fn` returns a reason, or `undefined` to keep the row |
| `notReady(fn)` | `fn` returns a delay in milliseconds to try the row's unit again later, or `undefined` to go on. After the store only |
| `mapAll(fn)` | one call for all the rows: `fn` gets them as an array and returns one result per row, in order. An `Error` in a row's place fails that row's unit alone |
| `withAttrs(fn)` | merges the attributes `fn` returns into the row's unit |
| `withOrder(fn)` | sets the time of the event the unit records, its `order_at` |
| `withSearchText(fn)` | sets the text the dashboard searches for the unit |
| `withMeta(fn)` | sets the row's item meta for the sender: `key`, and anything else the sender reads |

Each function gets the row and the row's context, `RowContext`; `mapAll`'s
function gets the rows and the step's context, `StepContext`. Every function
may be `async`; `mapAll`'s must return a `Promise`.

```ts
interface Batch<T> {
  map<U>(fn: (row: T, ctx: RowContext) => U | Promise<U>): Batch<U>;
  flatMap<U>(fn: (row: T, ctx: RowContext) => Children<U> | Promise<Children<U>>): Batch<U>;
  filter(fn: (row: T, ctx: RowContext) => boolean | Promise<boolean>): Batch<T>;
  skip(fn: (row: T, ctx: RowContext) => string | undefined | Promise<string | undefined>): Batch<T>;
  notReady(fn: (row: T, ctx: RowContext) => number | undefined | Promise<number | undefined>): Batch<T>;
  mapAll<U>(fn: (rows: T[], ctx: StepContext) => Promise<(U | Error)[]>): Batch<U>;
  withAttrs(fn: (row: T, ctx: RowContext) => Attrs | Promise<Attrs>): Batch<T>;
  withOrder(fn: (row: T, ctx: RowContext) => Date | Promise<Date>): Batch<T>;
  withSearchText(fn: (row: T, ctx: RowContext) => string | Promise<string>): Batch<T>;
  withMeta(fn: (row: T, ctx: RowContext) => ItemMeta | Promise<ItemMeta>): Batch<T>;
}

type Children<U> = Iterable<U | Skip> | AsyncIterable<U | Skip>;
type Attrs = Record<string, unknown>;
type ItemMeta = { key?: string } & Record<string, unknown>;
```

### Before the store and after it

Every row has a unit. After the store it is the unit the row came from. Before
the store it is the unit the row will become when it reaches the store. The
methods mean the same on both sides; what differs is how rows are fed and what
a failure does.

| | before the store | after the store |
|---|---|---|
| rows | one input at a time, as a `Batch` of one row; rows pass every step one at a time, in order | a take of up to `batch` stored units, run concurrently: do not rely on the order of units in a take |
| `flatMap` | each element becomes a unit of its own | each element becomes an **item** of the same unit |
| a throw | fails the whole input: nothing of it is stored, and the sending side gets an error and resends | fails the row's unit only |
| `skip` | records a `skipped` unit with its attributes and no stored value; the input is still acknowledged | ends the unit at `skipped`; after a `flatMap` split, counts a skipped item and the unit goes on |
| `notReady` | not allowed: fails the input, like a throw | the unit stays at the store and is taken again after the delay, at least a second; each take starts from its stored attrs, and its queue row records the hold's reason for display |
| `mapAll` | called once per part of up to 1000 rows; an `Error` in any row's place fails the input | called once for the take's rows; a throw, or a result of the wrong length, fails every unit in the call |

A throw inside a method's function after the store is classified: a
`domainError` ends the unit at `error`, and any other throw is retried. A throw
from the step function itself, outside the methods, fails every unit of the
take in that step. See [Errors](errors.md).

Skips are counted on the unit, in the attribute `_skipped`: a skipped unit
carries `{ "_skipped": { "<reason>": 1 } }`, and a unit whose items were
skipped counts each reason, such as `{ "_skipped": { "unchanged": 12 } }`. A
`skip(reason, attrs)` element of a `flatMap` before the store merges its
`attrs` into the skipped unit's; after the store only its reason is counted.

A unit whose rows were all filtered or skipped as items has nothing to send,
and closes as `sent` at once.

### Row context and step context

The step's second argument is its `StepContext`, one for the whole take or
input. A method's function gets a `RowContext`, which is its row's.

| | `StepContext` | `RowContext` |
|---|---|---|
| `translate(map, code)`, `translateFor(context, code)`, `conceptMapFor(context)` | yes | yes |
| `signal` | an `AbortSignal` fired at the work's deadline and when a stop's grace period ends | the same |
| `units.count(filter?)`, `units.find(query?)` | yes | yes |
| `state(handle)` | yes | — |
| `sender.queued(keys)` | yes | — |
| `unit` | — | `{ id, attrs, createdAt }`; `undefined` before the store |
| `source` | — | `{ id, pipeline, receivedAt }`, where `id` is the unit's id; `undefined` before the store |
| `webhook(event, payload)` | — | yes: a custom event, see [Webhooks](webhooks.md) |

A row function that needs `state` or `sender.queued` uses the step's context,
which it closes over:

```ts
const seenControlIds = defineState<{ unit: string }>("seen-control-ids");

const markSeen = defineStep("mark-seen", (msgs: Batch<HL7v2Message>, ctx: StepContext) =>
  msgs.map((msg, rowCtx) => {
    const controlId = getComponent(findSegment(msg, "MSH")?.fields[10]);
    if (controlId !== undefined && rowCtx.unit !== undefined) {
      ctx.state(seenControlIds).set(controlId, { unit: String(rowCtx.unit.id) });
    }
    return msg;
  }),
);
```

[Steps, store and senders](stages.md) covers what each of these does, and
[Units and state](units-and-state.md) covers `ctx.units` and `ctx.state`.

## Attributes and search text

**Attributes** are the facts a unit records about itself: its message type, its
patient, the file it came from. A step sets them with `withAttrs`; the
dashboard filters on them, and `ctx.units` finds units by them.

- **Shallow merge.** The keys `fn` returns replace earlier values of the same
  keys.
- **Inherited before the store.** A row that `flatMap` produces before the
  store starts with its parent's attributes, and adds its own.
- **One value per unit after a split.** The items of one unit share its
  attributes, so two items setting one key leave the last value. Set unit
  attributes before the split.
- **Untyped.** Attributes are `Record<string, unknown>`. A misspelled name
  compiles, and finds nothing.
- **Visible.** Attributes show in the dashboard. Record identifiers, not names
  or other PHI you do not want on screen.

`withOrder` and `withSearchText` follow the same rules. **Search text** is kept
in a column of its own, apart from the attributes, so attribute filters never
read it. `ctx.units` does not search it; the dashboard does.

## The store and its options

```ts
.store(postgresStore({ codec: "text" }), {
  index: { message_type: "btree", patient_id: "btree" },
  search: "trgm",
  batch: 100,
})
```

`postgresStore({ codec })` stores each unit's value in a table of the
pipeline's own. The codec says what the store holds — `"text"` a string,
`"json"` a JSON value, `"bytes"` a `Uint8Array` — and the rows that reach the
store must fit it, or the chain does not compile. Why the store exists and what
it does is in [Steps, store and senders](stages.md#the-store).

| option | what it does |
|---|---|
| `index` | a `btree` index on each named attribute, on this pipeline's units only. The dashboard filters and facets on these attributes and no others, and `ctx.units` lookups by them read the index |
| `search` | `"trgm"`: a trigram index on the search text. The dashboard's free-text search needs it, and refuses a search on a pipeline that does not declare it |
| `batch` | how many stored units the steps after the store take at once. 100 by default |

The engine creates declared indexes when it loads the pipeline: in place on a
new pipeline, concurrently on one that already holds units. It never drops one,
so removing an attribute from `index` leaves its index in place.

## Your own source

When the input is neither MLLP nor an HTTP POST, define the source yourself
with `defineSource` from `@health-samurai/interbox/chain`. It returns a
function that takes the source's config, and a pipeline reads it like any
other source:

```ts
import { env, type Str } from "@health-samurai/interbox";
import { defineSource, defineState, pipeline, postgresStore } from "@health-samurai/interbox/chain";

interface LabFeedConfig {
  url: Str;
  pollIntervalMs: number;
}

const cursor = defineState<string>("lab-feed.cursor");

const labFeed = defineSource<"lab-feed", LabFeedConfig, string>({
  type: "lab-feed",
  kind: "pull",
  start: async ({ url }, { receive, state, signal }) => async () => {
    const after = (await state(cursor).get("last")) ?? "";
    const res = await fetch(`${url}?after=${encodeURIComponent(after)}`, { signal });
    for (const result of (await res.json()) as { id: string; message: string }[]) {
      state(cursor).set("last", result.id);
      await receive(result.message);
    }
  },
});

pipeline("lab-results")
  .source(labFeed({ url: env("LAB_FEED_URL"), pollIntervalMs: 60_000 }))
  .store(postgresStore({ codec: "text" }))
  .sender(/* ... */);
```

A source is one of two kinds:

| kind | you give | the engine |
|---|---|---|
| push, the default | `run(config, ctx)`, which listens or loops until `signal` aborts | runs it once. When `run` returns on its own, the source has finished: it shows as `exited` and is not restarted until the next workspace reload. A listener that only opens a socket must still await `signal` before it returns |
| `"pull"` | `start(config, ctx)`, which returns a `poll` function | calls `start` once, then `poll` at once and again every `pollIntervalMs` of the config: 30 s when the config sets none, never more often than every second. Prefer it to a loop in `run` for anything that polls |

The context:

- **`receive(input)`** runs the steps before the store on one input and
  commits the units they make, in one transaction. It resolves with
  `{ received, skipped }` once they are stored, and that is the moment to
  acknowledge the input upstream. It rejects when the input is refused, for
  instance when a step throws, and then nothing of it is stored; the refusal
  counts in the pipeline's refusals like a refused MLLP or webhook input.
- **`state(handle)`** is the pipeline's [state](units-and-state.md). Its
  `set` and `del` are buffered and written by the next `receive`, in that
  input's transaction, so a cursor set before `receive` advances only if the
  input is stored. A refused `receive` drops them.
- **`signal`** aborts when the engine stops the source, at shutdown or on a
  workspace reload. Pass it to `fetch` and stop listening when it aborts. An
  error the source throws after the stop ends it as stopped; an error thrown
  before is a crash, and the engine restarts the source after a backoff.

The config may hold `env()` references; `run` and `start` get it with them
resolved, and an unset variable stops the workspace from loading. `type` names
the source in the dashboard and follows the pipeline name rules.

The engine runs one copy of each source per engine instance. Run a single
instance for a pipeline whose source polls, or two instances read the same
input twice.

## Bridges

A pipeline has one store, so work in two stages is two pipelines joined by a
bridge: the first ends in `.sender(intoPipeline("b"))`, and the second starts
with `.source(fromPipeline("a"))`.

```ts
pipeline("bulk-files")
  .source(webhookSource({ port: env("BULK_PORT") }))
  .store(postgresStore({ codec: "text" }))
  .step((files) => files.flatMap((file) => file.split("\n").filter((line) => line.trim() !== "")))
  .sender(intoPipeline("bulk-resources"));

pipeline("bulk-resources")
  .source(fromPipeline<string>("bulk-files"))
  .store(postgresStore({ codec: "text" }))
  .step((lines) => lines.map((line): Resource => JSON.parse(line)))
  .step(fhirItems())
  .step(skipUnchanged())
  .sender(aidbox({ url: env("AIDBOX_URL"), auth: { kind: "bearer", token: env("AIDBOX_TOKEN") } }));
```

Here an NDJSON file of FHIR resources is kept whole in the first store, and
each line becomes a unit of the second pipeline, so a bad line fails and is
retried on its own.

- **Each item of the first pipeline becomes a unit of the second.** When a unit
  of `bulk-files` finishes its steps, its items are written into the store of
  `bulk-resources` as new `received` units, and the unit of `bulk-files`
  becomes `sent`, all in one transaction. Each item's value must fit the second store's codec;
  if one does not, the first pipeline's unit ends at `error` with
  `engine/codec_mismatch`.
- **The second pipeline has no steps before its store.** Nothing could run
  them: the bridge writes straight into the store, so the builder after
  `fromPipeline` offers only `.store()` and `.webhook()`.
- **The new units start clean, with a link back.** They carry no attributes of
  the first unit, but keep its event time (`order_at`), the id of the unit that
  created them, and its correlation id, which names the unit the work started
  from.
- **Both ends must agree.** Loading fails unless `intoPipeline("b")` in `a` is
  matched by `fromPipeline("a")` in `b`. The row type written in
  `fromPipeline<Row>` is not checked against what the first pipeline sends; the
  codec is checked when the units are written.
- **Size.** The new units are written in the one transaction that finishes the
  first unit, so one unit that fans out into a very large number of items makes
  one very large transaction.

## `ChainRegistry`

`ChainRegistry` holds every pipeline the workspace declares. The workspace
entry re-exports it, and the engine reads the pipelines from that export:

```ts
export { ChainRegistry } from "@health-samurai/interbox/chain";
```

| member | what it does |
|---|---|
| `defs()` | every declared pipeline as a `PipelineDef`, the serialisable shape the engine plans its workers from. Throws on a pipeline with no sender, and on a bridge whose two ends do not match |
| `handlers(name)` | the functions of one pipeline: its steps, in order, and its sender's `run`. A worker calls it after importing the bundle, because functions do not cross threads |
| `legacy()` | `{ pipelines, mappers }`: the names of the 1.x pipelines and mappers that the root `pipeline()` and `defineMapper` of the same SDK copy registered. The engine refuses to load a workspace for which either is not empty |
| `clear()` | forgets every declaration; for tests |

```ts
interface PipelineDef {
  readonly name: string;
  readonly source: SourceDef | BridgeSourceDef;
  readonly steps: readonly StepDef[];
  readonly store: StoreDef;
  readonly sender: SenderDef;
  readonly webhooks: readonly WebhookDef[];
}

interface StepDef {
  readonly name: string;
  readonly position: number;
  readonly side: "before" | "after";
}
```

See [Reference → steps](../reference/steps.md) for every exported type.
