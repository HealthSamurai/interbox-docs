# Steps

```ts
import { env } from "@health-samurai/interbox";
import { defineLookup, defineState, defineStep, mllpSource, pipeline, postgresStore, skip, webhookSource } from "@health-samurai/interbox/chain";
import type { Batch, RowContext, StepContext } from "@health-samurai/interbox/chain";
import { fromMsh7, hl7v2Parser } from "@health-samurai/interbox/hl7v2";
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
```

A **step** is a function that takes a `Batch` of rows and returns a `Batch`. A
pipeline runs its steps in the order they are declared, on both sides of its
one `.store()`:

- **Before the store**, the steps run once for each input — an MLLP frame, an
  HTTP request body — inside the transaction that stores it, before the sending
  side is answered. Every row they produce becomes a unit at the store.
- **After the store**, the steps run on a *take*: up to the store's `batch`
  units (100 by default) taken together. Every row they produce becomes a
  sender item of its unit, or, through a bridge, a unit of the next pipeline.

See [Steps, store and senders](../concepts/stages.md) for the shape of a
pipeline, and [Units and State](../concepts/units-and-state.md) for what a unit
is and how it moves.

## `defineStep`

```ts
function defineStep<A, B>(name: string, fn: StepFn<A, B>): NamedStep<A, B>;

type StepFn<A, B> = (rows: Batch<A>, ctx: StepContext) => Batch<B> | Promise<Batch<B>>;

interface NamedStep<A, B> {
  readonly name: string;
  readonly fn: StepFn<A, B>;
}
```

`.step()` takes a `NamedStep` or a plain `StepFn`. The name is what a failed
unit records as its `error_step`, so the dashboard can say where it failed:

| you pass | the step's name |
|---|---|
| `defineStep("normalize", fn)` | `normalize` |
| a named function, `function normalize(rows) { … }`, or one assigned to a `const normalize` | `normalize` |
| an inline arrow function | its position among the pipeline's steps, counted from 1 across both sides of the store: `#3` |

A position shifts when steps are reordered, so name any step you will want to
find in an error.

```ts
const uppercase = defineStep("uppercase", (rows: Batch<string>) => rows.map((text) => text.toUpperCase()));

pipeline("lab")
  .source(webhookSource({ port: env("LAB_PORT") }))
  .store(postgresStore({ codec: "text" }))
  .step(uppercase)
  .sender(toLab);
```

**A step returns the `Batch` that its own `Batch`'s methods made.** A `Batch`
remembers which unit each row belongs to, and only its methods keep that link.
An array, or a `Batch` from another step's run, is refused with
`a step must return the Batch that the methods of its own run's Batch made`.

**A throw from the step function itself**, rather than from one row's function,
has no row to blame. Before the store it refuses the input; after the store it
fails every unit of the take, as a throw of the same kind would fail one unit
(see [Failures](#failures)).

## `StepContext`

The second argument of a step, one per input before the store and one per take
after it.

| field | what it is |
|---|---|
| `signal` | an `AbortSignal` that fires at the work's deadline and when a stop's grace period ends — see [Deadlines](#deadlines) |
| `state(handle)` | the pipeline's state under a declared handle — see [State](#state-definestate-and-ctxstate) |
| `sender.queued(keys)` | the meta of the newest queued version of each key — see [`ctx.sender.queued`](#ctxsenderqueued) |
| `units` | reads the units of this pipeline — see [Reading units](#reading-units-ctxunits) |
| `lookup(handle)` | reads a reference table by key — see [Reference lookups](#reference-lookups-definelookup-and-ctxlookup) |
| `translate(map, code)` | a concept map lookup — see [Terminology](#terminology) |
| `translateFor(context, code)` | the same, through the map bound to a sender |
| `conceptMapFor(context)` | the name of the map bound to a sender |

## `RowContext`

The second argument of every function you pass to a row method (`map`,
`flatMap`, `filter`, `skip`, `notReady` and the four `with…` methods).

| field | before the store | after the store |
|---|---|---|
| `unit` | `undefined` | `{ id: bigint, attrs, createdAt: Date }` of the row's unit |
| `source` | `undefined` | `{ id, pipeline, receivedAt }`: the unit's id as a string, the pipeline, and the unit's creation time as ISO 8601 |
| `signal` | the input's signal | the take's signal |
| `units` | as on `StepContext` | as on `StepContext` |
| `lookup` | as on `StepContext` | as on `StepContext` |
| `translate`, `translateFor`, `conceptMapFor` | as on `StepContext` | as on `StepContext` |
| `webhook(event, payload)` | emits a custom event — see [`ctx.webhook`](#ctxwebhook) | the same |

A `RowContext` has no `state` and no `sender`. A row function that needs them
uses the step's own context:

```ts
const seen = defineState<{ at: string }>("lab.seen");

const markSeen = defineStep("mark-seen", (rows: Batch<LabResult>, ctx: StepContext) =>
  rows.map(async (row) => {
    ctx.state(seen).set(row.accession, { at: new Date().toISOString() });
    return row;
  }),
);
```

## `Batch`

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

A method records what to do and runs nothing. The engine pulls the rows when
the step has returned:

- **Before the store, one row at a time.** A row passes every remaining step
  before the next one is read, so a file split by `flatMap` streams through
  without being held whole. Nothing runs in parallel inside one input.
- **After the store, method by method over the take.** Each method runs over
  all the take's rows, up to 16 at a time, before the next method starts. Do
  not rely on the order of units within a take.

| method | before the store | after the store |
|---|---|---|
| `map(fn)` | one row in, one out | the same |
| `flatMap(fn)` | each element becomes a unit of its own, inheriting the attrs, order and search text gathered so far | each element becomes an item of the row's unit |
| `filter(fn)` | `false` drops the row: no unit is written for it | `false` drops the row; a unit whose rows are all dropped closes `sent` with no item |
| `skip(fn)` | a reason drops the row and records a unit at `skipped`, with no stored value | a reason ends the unit at `skipped`; after a `flatMap` it drops only that item and counts it on the unit |
| `notReady(fn)` | not allowed: a number fails the input | a number of milliseconds leaves the unit at the store and takes it again after that delay, at least one second |
| `mapAll(fn)` | one call per part of up to 1000 rows | one call for all the take's rows that are still live |
| `withAttrs(fn)` | merged into the attrs of the unit the row becomes | merged into the attrs of the row's unit |
| `withOrder(fn)` | the unit's `order_at` | the same |
| `withSearchText(fn)` | the unit's `search_text` | the same |
| `withMeta(fn)` | has no effect | the item's `key`, and the rest of its meta |

`undefined` from `skip`'s or `notReady`'s function keeps the row as it is. Any
other answer from `notReady`'s function must be a number of milliseconds from 0
to `MAX_NOT_READY_MS`, 24 hours; a negative, `NaN`, infinite or longer delay, or
a value that is not a number, throws.

### `skip()` elements in a `flatMap`

```ts
function skip(reason: string, attrs?: Attrs): Skip;
```

A `flatMap` may yield `skip(reason, attrs)` in place of a row. Before the
store it records a skipped unit carrying the parent's attrs with `attrs` merged
over them, so one bad line of a file skips that line and the rest of the file
is stored:

```ts
const lines = defineStep("lines", (files: Batch<string>) =>
  files.flatMap(function* (file) {
    for (const [n, line] of file.split("\n").entries()) {
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line) as Record<string, unknown>;
      } catch {
        yield skip("bad json", { line: String(n + 1) });
      }
    }
  }),
);
```

After the store a `skip()` element is an item skip, counted on its unit. Item
skips, and the reason of a unit skipped whole, are written into the unit's
attrs under `_skipped`, as `{ "<reason>": <count> }`.

### Attrs, order and search text

- **Attrs merge shallowly.** A key you set replaces the value an earlier step
  set for it.
- **Rows of one unit share its attrs.** After a `flatMap` split, two items
  setting the same key leave the last value; set unit attrs before the split.
- **Attrs are untyped.** A misspelled attr name compiles, and a filter on it
  finds nothing. Filters compare an attr as text, so give a filtered attr a
  string value.
- **When they are written.** Before the store, with the unit. After the store,
  when the unit leaves the store as `processed`, `sent` or `skipped`. A unit
  that fails or waits keeps the attrs it had at the store, and every take of a
  waiting unit starts from them.
- **A waiting unit says so.** A unit held by `notReady`, or by a thrown
  `NotReady`, records the hold on its queue row, beside the wait, as
  `notReady: { reason?, attrs? }`, and the dashboard shows what the unit
  waits for: `reason` is the `NotReady`'s message when one was thrown, cut to
  1024 characters, and `attrs` holds the attrs its steps set or changed
  before the hold, left out when one of them cannot be stored. The hold is
  not in the unit's attrs, so steps never see it. It is cleared when the unit
  fails in a way that may pass or its lease expires, and it goes when the
  unit closes or fails.
- **`withOrder`** sets the time of the event the unit records. Without it a
  unit's `order_at` is the time it was created. It orders the queued versions
  of one resource, see [Units and State](../concepts/units-and-state.md).
- **`withSearchText`** sets the text the dashboard's search reads. It is
  searchable only in a pipeline that declares `search: "trgm"` on its store.

### `withMeta` and item keys

`withMeta` gives an item what its sender reads. `key` is the item's identity at
the destination, such as `Patient/123`: the engine keeps it in a column of its
own, never sends two versions of one key at once, and sends them in order. The
rest of the meta is stored beside the item. For Aidbox, `fhirItems()` writes it
for you.

### `mapAll`

`mapAll` is for one call that covers many rows, such as a bulk request to a
service. It gets the rows' values and the step's `StepContext`, and returns one
result per row, in the same order.

- An `Error` in a row's place fails only that row's unit (after the store) or
  the input (before the store).
- A throw, or a result whose length differs from the rows', fails every unit in
  the call after the store, and the input before it.

### Failures

A failure acts on the row's unit. After the store:

| what happens | the unit |
|---|---|
| a row function throws a `domainError` | ends at `error` at once, with the error's kind |
| it lets through a system's error, from a call on a `defineSystem` handle | ends at `error` at once with the kind when that is `system/…_rejected` or one of its variants; when it is `system/…_unreachable`, counts a failed attempt as in the next row |
| it throws anything else | counts a failed attempt, stays at the store, and is taken again 4 seconds after the first failed attempt, then 8, 16 and 32 seconds after the next three |
| the take runs past its deadline | counts a failed attempt the same way, and is taken alone from then on |

A fifth failed attempt ends the unit at `error`, with `engine/attempts_exhausted`
after a throw and `engine/step_timeout` after a deadline. The message of
`engine/attempts_exhausted` is the last error's, after its kind when it had one,
such as `system/epic_unreachable: …`.

Every retry, automatic or from the dashboard, starts at the store and runs every
step after it again. A unit at `error` records the step that failed in
`error_step`. See [Errors](../concepts/errors.md) for `domainError` and its
kinds.

Before the store there is no unit to fail. Any throw, a `domainError`
included, refuses the whole input: nothing of it is stored, MLLP answers `AE`
and HTTP answers `500`, and the sending side retries. A `skip` is not a
failure: it records a skipped unit, and the input is answered as stored.

### Deadlines

| work | deadline | when it passes |
|---|---|---|
| the steps before the store, for one input | 60 seconds | `ctx.signal` fires, and the input is refused and rolled back |
| the steps after the store, for one take | 60 seconds from the start of the take | `ctx.signal` fires, the engine stops waiting for the steps, and every unit of the take counts a failed attempt |

`ctx.signal` also fires when a stop's grace period ends. Pass it to anything
that can take long, such as a `fetch`, so abandoned work stops. A late result of
abandoned work is discarded.

## State: `defineState` and `ctx.state`

```ts
function defineState<V>(namespace: string): StateHandle<V>;

interface State<V> {
  get(key: string): Promise<V | null>;
  get(keys: readonly string[]): Promise<Map<string, V>>;
  set(key: string, value: V): void;
  set(entries: Iterable<readonly [string, V]>): void;
  del(keys: string | readonly string[]): void;
}
```

State is a small durable key/value store, scoped to the pipeline: each pipeline
has its own copy of every namespace, and no pipeline reads another's. Declare a
handle once, at module level, and import it wherever a step needs it:

```ts
const lastSeen = defineState<{ orderAt: string }>("adt.last-seen");

const newerOnly = defineStep("newer-only", (msgs: Batch<Admit>, ctx: StepContext) =>
  msgs.skip(async (msg) => {
    const before = await ctx.state(lastSeen).get(msg.patientId);
    if (before !== null && before.orderAt >= msg.sentAt) return "older than what we have";
    ctx.state(lastSeen).set(msg.patientId, { orderAt: msg.sentAt });
    return undefined;
  }),
);
```

- **Namespace names** use lowercase Latin letters, digits, `-` and `.`, start
  with a letter, and are at most 46 characters. `defineState` throws on any
  other. The name is what the rows are stored under: renaming it leaves the old
  rows behind.
- **Values** are JSON. A key holding the NUL character or a lone UTF-16
  surrogate, or a value JSON cannot hold, makes `set` or `del` throw.
- **A many-key `get`** is one query and answers a `Map` without the keys it did
  not find. Single-key `get`s made in the same tick are read together.
- **A `get` after a `set` or `del` in the same work reads the buffered write.**
  Other work sees only committed values.
- **No time to live.** A namespace that would grow forever is cleaned with
  `del`.

**Writes are buffered, and commit with the work they belong to:**

| where | they commit | they are dropped when |
|---|---|---|
| a step before the store | with the input's transaction | the input is refused |
| a step after the store | with the take's result, even when one of its units fails | the take passes its deadline, a stop ends it, or another worker took one of its units over; when Postgres refuses the values, their keys are deleted instead and the units' results still commit |

A `set` or `del` made after the step's work has finished, from a promise no one
awaited, is dropped without throwing, and the engine logs an error naming the
pipeline, the namespace and the key.

## Reading units: `ctx.units`

```ts
interface UnitsReader {
  count(filter?: UnitsFilter): Promise<number>;
  find(query?: UnitsQuery): Promise<UnitRow[]>;
}

interface UnitsFilter {
  readonly attrs?: Readonly<Record<string, string>>;
  readonly status?: UnitStatus | readonly UnitStatus[];
}

interface UnitsQuery extends UnitsFilter {
  readonly limit?: number;               // 1 to 1000; 100 by default
  readonly order?: "newest" | "oldest";  // by unit id; "newest" by default
}

interface UnitRow {
  readonly id: string;
  readonly status: UnitStatus;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly createdAt: string;            // ISO 8601
  readonly orderAt: string;              // ISO 8601
  readonly errorStep?: string;           // present only on a unit at "error"
  readonly errorKind?: string;
  readonly errorMessage?: string;
}

type UnitStatus = "received" | "processed" | "sent" | "skipped" | "error" | "deferred";
```

`ctx.units` reads the units of the step's own pipeline, and no other:

```ts
const priorResults = defineStep("prior-results", (msgs: Batch<Oru>, ctx: StepContext) =>
  msgs.withAttrs(async (msg) => ({
    prior: String(await ctx.units.count({ attrs: { patient_id: msg.patientId }, status: "sent" })),
  })),
);
```

- **Filters.** Each attr matches by equality on its text, `status` matches any
  one given, and every condition must hold. An attr value must be a string;
  anything else throws.
- **Indexes.** A filter on an attr the store declares in `index` reads that
  index. Any other attr is a scan of the pipeline's units.
- **Limits.** `find` answers at most `limit` rows. A `limit` outside 1 to 1000,
  or an `order` other than the two, throws.
- **Before the store**, a call runs in the input's own transaction, so it sees
  the units that input has written so far.
- **After the store**, each call is a short read-only query of its own, under a
  statement timeout of what is left of the take's deadline. Once `ctx.signal`
  has fired, a call throws.
- **No text search.** `ctx.units` does not read `search_text`.
- **A query per row adds up.** A `count` inside `map` is one query per unit;
  for a whole take, use `mapAll` and query once.
- **A Retry can see different units.** The answer depends on what is in the
  database when the step runs.

## Reference lookups: `defineLookup` and `ctx.lookup`

```ts
function defineLookup<Row = LookupRow>(name: string, spec: LookupSpec): LookupHandle<Row>;

interface LookupSpec {
  readonly table: string;               // read as reference.<table>
  readonly key: string;                 // a text column with a unique index of its own
  readonly columns: readonly string[];  // what each row answers; the key is not added
}

interface LookupReader<Row> {
  get(keys: readonly string[]): Promise<Map<string, Row>>;
}

type LookupRow = Readonly<Record<string, unknown>>;

class NotReady extends Error {
  constructor(message: string, afterMs?: number);
  readonly afterMs: number;
}

const MAX_NOT_READY_MS = 86_400_000;

function isNotReady(err: unknown): err is NotReady;
```

A lookup reads rows of a reference dataset, such as a provider registry or a
code table, by key. Declare a handle once, at module level, export it from the
workspace entry in `LookupRegistry`, and read through `ctx.lookup`:

```ts
const providers = defineLookup<{ name: string; taxonomy: string | null }>("providers", {
  table: "npi_registry",
  key: "npi",
  columns: ["name", "taxonomy"],
});

export const LookupRegistry = { providers };

const providerName = defineStep("provider-name", (claims: Batch<Claim>) =>
  claims.withAttrs(async (claim, ctx) => {
    const found = await ctx.lookup(providers).get([claim.npi]);
    return { provider: found.get(claim.npi)?.name ?? "unknown" };
  }),
);
```

- **Registered handles only.** The workspace entry, `src/index.ts`, exports
  `LookupRegistry` beside `ChainRegistry`: a plain object whose values are the
  handles its steps use, as `defineLookup` returned them. A `Map`, or a value
  that is not such a handle, fails the workspace load with an error naming the
  entry. A step may pass only a handle the registry holds, the very object,
  not another declared alike; any other throws an error naming the handle and
  `LookupRegistry`.
- **The `reference` schema, and no other.** `table` always means
  `reference.<table>`, whatever the connection's `search_path`. The engine's
  own tables and the workspace's inbound tables hold the messages pipelines
  carry, and a lookup must not become a way to read them, so reference data has
  a schema of its own. Rows are read from `reference.<table>` alone, as
  `FROM ONLY` reads them: never from a table that inherits from it, in
  whatever schema, so a partitioned table, whose rows live in its partitions,
  is never ready. The engine does not create the schema or its tables: create
  and load them yourself, readable by the role the engine connects as.
- **Names.** The lookup's name, `table`, `key` and every column use lowercase
  Latin letters, digits and `_`, start with a letter or `_`, and are at most 63
  bytes, the most Postgres keeps of a name. `defineLookup` throws on any other.
  Names are always quoted, so a column called `order` is read as it is, and
  there is no `*`: a lookup reads the columns it lists.
- **The key** is a `text` column with a unique index on that column alone:
  valid, not partial, not on an expression, with no second key column, in the
  column's own collation and with the default operator class for `text`. A
  primary key on it is such an index; an index built `COLLATE "C"` or with
  `text_pattern_ops` on a column of another collation is not. `get(keys)`
  answers a `Map` holding only the keys found. A key given twice is answered
  once, a key holding the NUL character or a lone UTF-16 surrogate matches
  nothing, and a key that is not a string throws an error naming its index.
- **Any number of keys.** The engine reads them 1000 to a query and merges the
  answers. A call per row is a round trip per row: for a whole take, gather
  the keys in `mapAll` and call once.
- **Values are JSON**, as Postgres's `row_to_json` writes them: a `date` is its
  ISO string, a `timestamptz` an ISO string with the offset of the session's
  time zone, a `char(n)` is padded to n, a `text` comes back unchanged, and a
  `bigint` or `numeric` is a JavaScript number, a numeric `NaN` the string
  `"NaN"`. A number past 2^53, or one with more than 15 significant digits,
  can come back rounded, and nothing reports it. Keep identifiers, such as
  account or member numbers, in `text` columns.

### Where a lookup runs

- **After the store**, each call is a read-only transaction of its own, under a
  statement timeout of what is left of the take's deadline and a lock timeout
  of 2 seconds. Once `ctx.signal` has fired, a call throws.
- **Before the store**, a call runs in the input's own transaction, inside a
  savepoint with a lock timeout of 2 seconds, and the savepoint is rolled back
  when the call ends. A failed lookup never leaves the input's transaction
  unusable, and the table is not kept locked for the rest of the input. The
  input's own writes, and its commit, wait until no call is running, so a call
  a step did not await cannot roll them back.

### Not ready

A table is ready when `reference.<table>` exists, holds at least one row, has
its key as above, and has every listed column. Until then a call throws
`NotReady`, and so does a call that waits on a lock past its 2-second lock
timeout:

| where | a lookup that is not ready |
|---|---|
| after the store | leaves its unit at the store, taken again a second later, counting no attempt, however long the table takes to load |
| before the store | refuses the input with the code `not_ready`: MLLP answers `AE`, HTTP `500`, and the sending side retries |

No table is checked when the workspace loads, so a table not loaded yet never
stops the engine. The first call of a handle in each worker checks the
table, and a call checks it again whenever Postgres answers from a different
table under that name, as after a swap. Whether the table is empty is read on
every call.

A step may catch `NotReady` to go on without the rows. Tell it with
`isNotReady(error)`, not `instanceof`: the workspace bundle carries its own
copy of the class, and the error comes from the engine's. A step may also throw
a `NotReady` of its own, with a delay in milliseconds, and the engine treats it
the same way, waiting at least one second. The delay must be from 0 to
`MAX_NOT_READY_MS`, 24 hours: the constructor throws on any other.

### Loading a new version

Load it beside the table in use, then swap the two by rename:

```sql
CREATE TABLE reference.npi_registry__loading (LIKE reference.npi_registry INCLUDING ALL);
COPY reference.npi_registry__loading FROM STDIN;
ANALYZE reference.npi_registry__loading;
BEGIN;
ALTER TABLE reference.npi_registry RENAME TO npi_registry__old;
ALTER TABLE reference.npi_registry__loading RENAME TO npi_registry;
COMMIT;
DROP TABLE reference.npi_registry__old;
```

The load runs before the swap's transaction, so the renames hold their locks
only for a moment, and no lookup sees the table half-loaded or missing. A
lookup made during the swap waits for its commit and then reads the new table.
One that waits past its 2-second lock timeout is not ready: its unit waits, or
its input is refused.

## `ctx.sender.queued`

```ts
ctx.sender.queued(keys: readonly string[]): Promise<Map<string, Readonly<Record<string, unknown>>>>;
```

For each key that has items waiting in this pipeline's sender queue, the meta
of its newest queued version, newest by the items' `order_at`, then unit, then
item. A key with nothing queued is not in the map. `skipUnchanged()` uses it to
compare a resource with the version already waiting to go out.

## `ctx.webhook`

```ts
ctx.webhook(eventType: `custom:${string}`, payload: unknown): void;
```

On a row function's context. Emits a custom event to the pipeline's webhooks
that subscribe to it in `.webhook({ on })`. The payload must be JSON, or the
call throws.

- **Before the store**, the event is written with the input's commit.
- **After the store**, it is written with the unit's result when the unit
  closes `processed`, `sent` or `skipped`, and dropped when the unit fails or
  waits.

See [Webhooks](../concepts/webhooks.md) for subscriptions and delivery.

## `ctx.source` and `provenanceId`

After the store, `ctx.source` names the unit a row belongs to:

```ts
interface RowSource {
  readonly id: string;          // the unit's id
  readonly pipeline: string;
  readonly receivedAt: string;  // the unit's creation time, ISO 8601
}
```

Prefer `receivedAt` or `ctx.unit.createdAt` over `new Date()` for anything you
put in an output. They do not move when the unit is retried, so a Retry
produces the same output, and `skipUnchanged()` can skip what is already
delivered.

To record in the destination which unit produced a set of resources, add a
`Provenance` whose id comes from the unit:

```ts
import { provenanceId } from "@health-samurai/interbox";

function provenanceOf(ctx: RowContext, targets: readonly Resource[]): Provenance {
  const unit = ctx.unit;
  if (unit === undefined) throw new Error("provenance is built after the store");
  return {
    resourceType: "Provenance",
    id: provenanceId(unit),
    recorded: unit.createdAt.toISOString(),
    agent: [{ who: { display: "Interbox" } }],
    target: targets.map((r) => ({ reference: `${r.resourceType}/${r.id}` })),
  };
}
```

`provenanceId(unit)` is `ib-<unit id>-<created time in base-36 milliseconds>`,
at most 32 characters. A Retry of the unit gives the same id, so its
Provenance is updated rather than duplicated.

## Terminology

```ts
translate(map: string, code: string): Promise<ConceptMapMatch | undefined>;
translateFor(context: ConceptMapContext, code: string): Promise<ConceptMapMatch | undefined>;
conceptMapFor(context: ConceptMapContext): string;

interface ConceptMapContext {
  type: string;
  sendingApplication: string;
  sendingFacility: string;
}

interface ConceptMapMatch {
  targetCode?: string;      // absent when the equivalence is unmatched or disjoint
  targetDisplay?: string;
  targetSystem?: string;
  equivalence: string;
  sourceDisplay?: string;
}
```

The lookups read the concept maps under `src/terminology/concept-maps/` in the
workspace. `translate` looks a code up in the map with that id; `undefined`
means the map has no entry for the code, or there is no such map.
`translateFor` looks it up in the map bound to a sender's context, and
`conceptMapFor` names that map: the bound one, or, when none is bound, a name
derived from the context, `hl7v2-<application>-<facility>-<type>`. A lookup
that misses reads the map files again when they changed since they were last
loaded.

```ts
const loincOf = defineStep("loinc-of", (codes: Batch<string>) =>
  codes.withAttrs(async (code, ctx) => ({ loinc: (await ctx.translate("lab-codes", code))?.targetCode ?? null })),
);
```

## Sources: `mllpSource` and `webhookSource`

```ts
import { mllpSource, webhookSource } from "@health-samurai/interbox/chain";

function mllpSource(config: MllpSourceConfig): ChainSource<string>;
function webhookSource(config: WebhookSourceConfig): ChainSource<string>;

interface MllpSourceConfig {
  port: Num;
  host?: Str;
  maxBytes?: number;
  idleTimeoutSeconds?: number;
}

interface WebhookSourceConfig {
  port: Num;
  secret?: Str;
  maxBytes?: number;
}
```

A source listens on a port of its own and turns each input into one row, a
`string` decoded as UTF-8: an MLLP frame, or the body of an HTTP `POST`. The
steps before the store run on that row, and the sending side is answered once
the input commits or is refused. A pipeline fed by another pipeline has no
source of its own; it reads [`fromPipeline`](../concepts/pipelines.md#bridges).

`port`, `host` and `secret` may be `env()` references. The engine checks every
field when it loads the workspace, so an unset variable with no default, or a
value out of range, refuses the load. It reads them again when the source
starts.

### `mllpSource`

| field | default | what it does |
|---|---|---|
| `port` | — | the TCP port to listen on |
| `host` | `0.0.0.0` | the address to listen on |
| `maxBytes` | 16 MiB | the largest frame, in bytes; at most 64 MiB |
| `idleTimeoutSeconds` | 300 | closes a connection that has sent nothing for this long; `0` keeps idle connections open. At most 86 400, a day |

- **Each frame is one input**, answered `AA` once it commits, and `AE` with the
  reason when it is refused (see [Failures](#failures)). The frames of one
  connection are answered in the order they arrived.
- **A frame over `maxBytes`** gets no answer: the connection is closed, and the
  refusal is counted as `too_large` (see
  [Errors](../concepts/errors.md#refusals-before-the-store)).
- **On a stop**, the source takes no new frame. A frame whose steps have not
  started when the stop begins is neither stored nor answered, and idle
  connections are closed. An input already in its steps has until the stop's
  grace period ends to commit and get its `AA`; after that it is abandoned,
  nothing of it is stored, no answer goes out, and its connection is closed.
  The sender resends.

### `webhookSource`

| field | default | what it does |
|---|---|---|
| `port` | — | the TCP port to listen on |
| `secret` | none | when set, a request must carry it in the `x-interbox-secret` header. An empty string is refused at load |
| `maxBytes` | 16 MiB | the largest request body, in bytes; at most 64 MiB |

Each `POST` body, on any path, is one input. The source answers:

| answer | when |
|---|---|
| `200` | the input committed |
| `401` | `secret` is set, and the request's `x-interbox-secret` header is missing or different |
| `405` | the method is not `POST` |
| `413` | the body is over `maxBytes`; counted as a `too_large` refusal |
| `500` | the input was refused, with the reason in the body (see [Failures](#failures)); or a stop's grace period ended before it committed |
| `503` | the source is stopping |

- **A client that disconnects abandons its input.** The `ctx.signal` of the
  steps before the store fires, nothing of the input is stored, and it is not
  counted as a refusal.
- **On a stop**, the source takes no new request: one that still reaches it is
  answered `503`, without running a step. An input already in its steps has
  until the stop's grace period ends to commit and get its `200`; after that it
  is abandoned, nothing of it is stored, and it is answered `500`. The sending
  side resends either.

## HL7v2: `hl7v2Parser()` and `fromMsh7`

```ts
import { fromMsh7, hl7v2Parser } from "@health-samurai/interbox/hl7v2";

function hl7v2Parser(options?: { skipZSegments?: boolean }): NamedStep<string, HL7v2Message>;
function fromMsh7(msg: HL7v2Message, timeZone: string): Date;
```

`hl7v2Parser()` is the step `hl7v2.parse`. It parses each raw message, and sets
these attrs on its unit:

| attr | from |
|---|---|
| `message_type` | MSH-9.1 |
| `event_type` | MSH-9.2 |
| `patient_id` | PID-3 |
| `patient_name` | PID-5, given then family name |
| `sending_application` | MSH-3 |
| `sending_facility` | MSH-4 |
| `send_time` | MSH-7, read as UTC unless it carries an offset |

A message that does not parse fails its unit with `parse/missing_msh` when the
text has segment lines, and `parse/not_hl7` when it has none.
`skipZSegments: true` drops every Z segment. The parser does not set
`order_at`.

`fromMsh7(msg, timeZone)` reads MSH-7 as an instant. A time without an offset
is read in `timeZone`, an IANA zone such as `America/New_York`, because only you
know the sender's clock. It throws `field/missing_msh7`,
`field/malformed_msh7` or `field/unknown_time_zone`, so the unit ends at
`error` rather than retrying. Use it to order a feed's messages by their own
time:

```ts
pipeline("adt")
  .source(mllpSource({ port: env("MLLP_PORT") }))
  .store(postgresStore({ codec: "text" }))
  .step(hl7v2Parser())
  .step((msgs) => msgs.withOrder((m) => fromMsh7(m, "America/New_York")))
  .step(adtToFhir)
  .step(fhirItems())
  .step(skipUnchanged())
  .sender(toAidbox);
```

Storing the raw message and parsing after the store, as above, lets a Retry
after a parser fix parse the original again. Parsing before the store stores the
parsed form instead, and a parse failure then refuses the input with `AE`.

## Aidbox: `fhirItems()`, `skipUnchanged()` and `aidbox()`

```ts
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
```

The mapping from your input to FHIR resources is a step of your own, usually a
`flatMap` after the store that turns each unit into its resources. The SDK
ships no HL7v2-to-FHIR mapping step. `adtToFhir` above stands for yours:

```ts
const adtToFhir = defineStep("adt-to-fhir", (msgs: Batch<HL7v2Message>) =>
  msgs.flatMap((msg, ctx) => {
    const patient = patientOf(msg);
    const encounter = encounterOf(msg, patient);
    return [patient, encounter, provenanceOf(ctx, [patient, encounter])];
  }),
);
```

### `fhirItems()`

```ts
function fhirItems(): NamedStep<Resource, FhirItem>;
```

The step `aidbox.fhir-items`. It gives each resource the item meta the Aidbox
sender reads: `key` (`Type/id`), `refs` (the `Type/id` references the resource
holds) and `hash` (a hash of its content, ignoring `meta` and key order). A
resource with no string `resourceType` or `id`, or whose key holds the NUL
character or a lone surrogate, fails its unit with `mapper/exception`.

Put it after every step that changes a resource, because the hash it stores is
what `skipUnchanged()` compares. `aidbox()` takes only `FhirItem`s, so a
pipeline that leaves it out does not compile.

### `skipUnchanged()`

```ts
function skipUnchanged(): NamedStep<FhirItem, FhirItem>;
```

The step `aidbox.skip-unchanged`. It skips, with the reason `unchanged`, a
resource identical to the newest version of its key already queued in this
pipeline, or, when none is queued, to the version this pipeline last
delivered. A unit whose resources are all unchanged closes `sent` without
sending anything, so a resend of the same message, or a Retry, costs nothing at
Aidbox.

It cannot see a version queued by another unit of the same take: a resource
that goes A → B → A within one take can end at B.

### `aidbox()`

```ts
function aidbox(cfg: AidboxConfig): Sender<FhirItem>;

interface AidboxConfig {
  readonly id?: string;
  readonly url: Str;
  readonly auth: { kind: "basic"; user: Str; password: Str } | { kind: "bearer"; token: Str };
  readonly batch?: number;
  readonly maxRetries?: number;    // default 10
  readonly retryDelayMs?: number;  // default 30 000
  readonly runTimeoutMs?: number;  // default 300 000
  readonly validateFirst?: boolean;
}
```

```ts
const toAidbox = aidbox({
  url: env("AIDBOX_URL"),
  auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID"), password: env("AIDBOX_CLIENT_SECRET") },
});
```

A sender that writes `fhirItems()` output to `<url>/fhir` in batch bundles,
each seed with the resources it references that are still queued.

| field | what it does |
|---|---|
| `id` | an optional name, kept in the pipeline's definition; same rule as a pipeline name |
| `url`, `auth` | read from the environment as each send starts, so an unset `env()` fails that send rather than the load |
| `batch` | how many items one send picks to start from; 100 by default |
| `maxRetries` | after this many errors an item's unit ends at `error` |
| `retryDelayMs` | the fixed wait before an item's next try |
| `runTimeoutMs` | how long one send may take before every item in it counts an error |
| `validateFirst` | runs `$validate` on the batch before sending it |

How it answers for each resource:

| Aidbox answers | outcome | kind |
|---|---|---|
| 2xx | delivered | — |
| a reference to a resource that does not exist | waits, and counts no error | `sender/reference_missing` |
| 409 with an edit conflict | waits, and counts no error | `sender/edit_conflict` |
| 5xx, no answer, or a 408, 425, 429 or redirect to the whole request | an error, tried again after `retryDelayMs` | `sender/aidbox_unreachable` |
| any other refusal | the unit ends at `error` at once | `sender/aidbox_rejected` |

A refusal's message holds every error issue Aidbox, or `$validate`, reported for
the resource: `<n> errors: <path>: <diagnostics> [<codes>]; …`, or the one line
alone, cut at 2,000 characters with `… and <n> more`. A resource waits for a
missing reference only when that is all that is wrong with it, and the wait's
message names every missing reference, the first ten and a count of the rest.

A resource whose content matches what this pipeline last delivered is answered
delivered without being sent. A resource this pipeline has not delivered before
is a `PUT`; one that changed since it was delivered is a `PATCH`. To remove an
element from a resource delivered before, map it as `null`: a `PATCH` removes
it, and the first send, a `PUT`, drops nulls. A `PATCH` that Aidbox answers
`404` or `410`, because the resource was deleted there, is sent again at once
as a `PUT` in a request of its own. A wait has no limit: a unit whose resource
waits for a reference that never comes stays `processed`, and is closed from the
dashboard (see [Operating Pipelines](../ops/operating.md)).

These environment variables tune every `aidbox()` sender in the engine:

| variable | default | what it bounds |
|---|---|---|
| `INTERBOX_AIDBOX_MAX_BODY_BYTES` | 8 MiB | the body of one request |
| `INTERBOX_AIDBOX_MAX_ENTRIES_PER_REQUEST` | none | the entries of one request |
| `INTERBOX_AIDBOX_CONCURRENCY` | 4 | requests in flight within one send |
| `INTERBOX_AIDBOX_REQUEST_TIMEOUT_MS` | none | one request; the send's own deadline still applies |

One send of n resources splits them over
min(`INTERBOX_AIDBOX_CONCURRENCY`, n / 50 rounded down) requests that go out at
the same time, about n / `INTERBOX_AIDBOX_CONCURRENCY` each and at least 50
where the send allows it: 500 resources with no reference between them are four
requests of 125, 120 are two of 60, and fewer than 100 are one request.
Resources joined by a reference stay in one request, or in requests sent one
after another, with the referenced resource first, so a request can come out
smaller or larger than the others. `INTERBOX_AIDBOX_MAX_BODY_BYTES` and
`INTERBOX_AIDBOX_MAX_ENTRIES_PER_REQUEST` split a request further. Set
`INTERBOX_AIDBOX_CONCURRENCY` to 1 to send one request at a time.

> **Upgrade note.** Earlier engines sent a whole send as one request unless a
> cap split it, so `INTERBOX_AIDBOX_CONCURRENCY` rarely had anything to overlap.
> Now a send of about 100 resources or more goes out as up to
> `INTERBOX_AIDBOX_CONCURRENCY` (4 by default) parallel requests, per sender and
> per worker, which raises the load on Aidbox and its database. A slow answer
> that times out counts toward `maxRetries`. Set `INTERBOX_AIDBOX_CONCURRENCY=1`
> to keep the earlier behaviour.

`contentHash` and `extractRefs`, the two functions behind `fhirItems()`, are
exported from `/aidbox` as well.

### `fingerprints`

```ts
const fingerprints: StateHandle<{ hash: string }>;
```

The state handle of the namespace `aidbox.fingerprints`: for each resource
`aidbox()` delivered, keyed `Type/id`, the content hash of the version Aidbox
holds. Like all state it is per pipeline. `aidbox()` writes it after each
delivery and reads it to choose between `PUT`, `PATCH` and skipping;
`skipUnchanged()` reads it; and the admin library's `deliveredKeys`,
`deliveredSummary` and `forgetDelivered` list, count and clear it (see
[Admin Scripts](../ops/admin-scripts.md)). A step may read it with
`ctx.state(fingerprints)`. Leave the writes to the sender: a wrong hash turns
the next send of that resource into a `PUT` that replaces it, or skips a change.
To force a resource out again, use `forgetDelivered`. The 1.x import fills it
from 1.x's resource hashes (see [Upgrading from 1.x](../ops/upgrade-from-1x.md)).
