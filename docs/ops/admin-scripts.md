# Admin Scripts

Sooner or later a pipeline needs a hand: a batch of units to retry after a fix,
a resource Aidbox lost that has to go out again, a queue of deliveries that
should never leave. On Interbox 2.0 a workspace script does this through
`@health-samurai/interbox/admin` instead of running SQL of its own against the
engine's tables.

```ts
import { retryUnits, units } from "@health-samurai/interbox/admin";
```

The library ships with the SDK and is versioned with it, so a script built
against a compatible SDK keeps working when a release changes the tables
underneath. See [Updating the Engine](updating.md) for what compatible means.

## The client

Every function takes a **client** first: any object with
`query(text, values?)` that resolves to `{ rows }` and behaves as `pg` does: it
sends a JavaScript array as a Postgres array and parses `jsonb` into objects. A
`pg` `Client`, or a `PoolClient` checked out with `pool.connect()`, is one as it
is. The library imports no database driver, opens no connection and never
closes the one you hand it.

The client must be **one connection**. A call that changes anything sends
`BEGIN`, its statements and `COMMIT` on it, or `ROLLBACK` when a statement
fails, and those only mean something on a single connection. A `pg` `Pool` is
refused with an error before any statement, by the reads as well: its `query`
may send each statement over a different connection. A client that is already
inside a transaction is refused too, before `BEGIN`: pass `inTransaction: true`
to run the call in that transaction. When the `ROLLBACK` itself fails, the call
still throws the error that made it roll back, with the `ROLLBACK`'s error in
its `rollbackError` property.

The third argument takes two options:

| option | what it does |
|---|---|
| `inTransaction: true` | the call runs inside a transaction you have already opened on the client, in a savepoint of its own, and sends no `BEGIN`, `COMMIT` or `ROLLBACK`. A call that fails rolls back to its savepoint, so your transaction keeps none of it; one that succeeds is kept by your `COMMIT` and undone by your `ROLLBACK` |
| `beforeStatement` | a function the call runs before each statement it sends. An error it throws ends the call with that same error, so it suits a time budget or a log line. It does not run before the `ROLLBACK`, or `ROLLBACK TO SAVEPOINT`, a failed call sends |

A pipeline name is checked by the same rule `pipeline()` declares by, and a
name no pipeline can have is refused before any statement.

**Nothing waits on a lock.** A unit, item or queue row the engine is working on
at that moment is left alone and reported as such — `busy`, `kept` or
`item_in_flight` — so the call never stalls behind the engine and never
deadlocks with it. Run the call again once the engine has moved on.

### Connecting

```ts
import { Client } from "pg";
import { units } from "@health-samurai/interbox/admin";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const page = await units(client, { pipeline: "adt-feed", status: "error" });
  for (const unit of page.rows) console.log(unit.id, unit.errorKind, unit.errorMessage);
} finally {
  await client.end();
}
```

From a pool, check out one client and release it after:

```ts
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await units(client, { pipeline: "adt-feed" });
} finally {
  client.release();
}
```

To make several calls one change, open the transaction yourself:

```ts
await client.query("BEGIN");
try {
  await forgetDelivered(client, { pipeline: "adt-feed", keys: ["Patient/p-1"] }, { inTransaction: true });
  await retryUnits(client, { pipeline: "adt-feed", ids: ["1042"] }, { inTransaction: true });
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
}
```

The examples below assume a connected `client` like this one.

## Reading

Reads send one statement each. Ids — of units, of items, and the cursors over
them — are strings, because they are Postgres `bigint`s. Times are ISO 8601
strings in UTC.

The paged reads answer `{ rows, nextCursor }`: pass `nextCursor` back as
`cursor` for the next page, until it is `null`. Their `limit` is 1 to 500, and
100 by default.

### `units`

A pipeline's units, newest first, narrowed by `status` and `errorKind`. Each row
carries `id`, `status`, `attrs`, `createdAt`, `orderAt`, `updatedAt`, and
`errorStep`, `errorKind` and `errorMessage`, which are `null` on a unit with no
error.

```ts
let cursor: string | undefined;
do {
  const page = await units(client, { pipeline: "adt-feed", status: "error", errorKind: "map/bad_segment", cursor });
  for (const unit of page.rows) console.log(unit.id, unit.errorMessage);
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

It replaces the 1.x retry scripts' reads of inbound rows whose delivery failed.

### `pendingItems`

The pipeline's delivery queue, item by item in id order, narrowed by `key` or
`unitId`, without the payload. Each item carries `id`, `unitId`, `key`,
`orderAt`, `retryCount`, `availableAt`, `lastError`, `createdAt`, `meta` (which
holds `refs` and `hash`) and `heldBy`: the older queued version of the same key
this one waits behind, or `null`.

```ts
const { rows } = await pendingItems(client, { pipeline: "adt-feed", key: "Patient/p-1" });
for (const item of rows) console.log(item.id, item.retryCount, item.lastError, item.heldBy);
```

It replaces reading the delivery queue and its pending view directly. With
`unitId`, it lists what one source message is still waiting to deliver.

### `pendingSummary`

The queue in one answer: `total`, `byType` (the queued items counted by the
`Type` of their `Type/id` key), `oldestCreatedAt`, and `unresolvedRefs` — up to
500 `{ itemId, ref }` where an item refers to a resource that is neither queued
in the pipeline nor delivered by it, so the reference will not resolve until
something sends it.

```ts
const summary = await pendingSummary(client, { pipeline: "adt-feed" });
console.log(summary.total, summary.byType, summary.oldestCreatedAt);
for (const { itemId, ref } of summary.unresolvedRefs) console.log(`item ${itemId} waits for ${ref}`);
```

It replaces counting the delivery queue by hand.

### `deliveredKeys`

What the Aidbox sender has delivered: each resource's key, the content hash it
sent, and when, as `{ key, hash, updatedAt }`, in key order. Narrow it with
`keys`, or with a `prefix` matched literally, so `%` and `_` are plain
characters. It pages like the reads above, by key.

```ts
const { rows, nextCursor } = await deliveredKeys(client, { pipeline: "adt-feed", prefix: "Patient/", limit: 500 });
```

It replaces reading the table of delivered resource hashes.

### `deliveredSummary`

The same delivered state in one answer: `total`, `byType` by the `Type` of each
key, and `lastUpdatedAt`, the latest delivery, or `null` when nothing was
delivered.

```ts
const { total, byType, lastUpdatedAt } = await deliveredSummary(client, { pipeline: "adt-feed" });
```

## Changing

Every change runs in one transaction. A unit a call moves into another status
reaches the pipeline's webhooks that subscribe to that status, with the stage
`operator`, as when the dashboard moves it. The calls that take a list take at
most 1000 entries.

### `retryUnits`

Returns units at `error`, `deferred` or `sent` to `received`, with their error
cleared and a fresh place in the queue; the pipeline runs them again from the
store. Items a unit left in the delivery queue are deleted first. It answers
`{ retried, unchanged }`, and each unchanged unit names its reason: `status`
(with the unit's status), `busy`, `item_in_flight` — one of its items is being
delivered right now — or `not_found`.

```ts
const { retried, unchanged } = await retryUnits(client, { pipeline: "adt-feed", ids: ["1042", "1043"] });
for (const { id, reason, status } of unchanged) console.log(id, reason, status ?? "");
```

It replaces the 1.x retry scripts that cleared a message's send state so the
engine would pick it up again.

### `deferUnits`

Moves units at `error` to `deferred`, keeping their error, to set them aside.
The rules and reasons are those of `retryUnits`; it answers
`{ deferred, unchanged }`.

```ts
await deferUnits(client, { pipeline: "adt-feed", ids: ["1042"] });
```

### `deleteUnitItems`

Deletes the queued items of one unit at `processed`: all of them, or the
`itemIds` named. An item being delivered right now is `kept`; a named item that
is already gone is `missing`. When no item is left, the unit closes `sent`. It
answers `{ deleted, kept, missing, status }`.

Where it cannot act at all it changes nothing and throws an `AdminRefused`,
whose `reason` is `not_found`, `busy`, `not_processed` (with the unit's status
in `unitStatus`) or `item_of_other_unit`:

```ts
import { AdminRefused, deleteUnitItems } from "@health-samurai/interbox/admin";

try {
  await deleteUnitItems(client, { pipeline: "adt-feed", unitId: "1042" });
} catch (error) {
  if (!(error instanceof AdminRefused)) throw error;
  console.log(error.reason, error.unitStatus ?? "");
}
```

### `dropPending`

Deletes queued items across units, picked by exactly one of `itemIds`, `keys`
(every queued version of each key) or `unitIds`. It deletes at most 1000 items
a call and answers `more: true` when more are left. A unit the engine holds is
`busy` and keeps its items; an item being delivered is `kept`; a named item id
the pipeline does not hold is `missing`; and a unit at `processed` left with no
item closes `sent`. It answers `{ deleted, kept, missing, busy, closed, more? }`.

A call that deletes nothing while `more` is set looked only at items the engine
holds right now, and the next call would look at the same ones, so stop there
rather than call again at once:

```ts
for (;;) {
  const answer = await dropPending(client, { pipeline: "adt-feed", keys: ["Patient/test-1", "Patient/test-2"] });
  console.log(`dropped ${answer.deleted.length}, kept ${answer.kept.length}, busy ${answer.busy.length}`);
  if (!answer.more) break;
  if (answer.deleted.length === 0) {
    console.log("no progress: the engine holds every item this call looked at; run the script again later");
    break;
  }
}
```

It replaces deleting rows from the delivery queue, and, with `unitIds`, the
reprocess scripts that removed a source message's queued output.

### `forgetDelivered`

Deletes the Aidbox sender's record of delivering each of `keys` and answers
`{ forgotten, busy }`: the keys whose record it deleted, and the keys whose
record was being written at that very moment and was left alone; call again for
those.

The next send of a forgotten key is a `PUT`, and `skipUnchanged()` no longer
holds it back. The call sends nothing itself: retry the units that
produce those resources to send them.

```ts
const { forgotten, busy } = await forgetDelivered(client, { pipeline: "adt-feed", keys: ["Patient/p-1"] });
await retryUnits(client, { pipeline: "adt-feed", ids: ["1042"] });
```

It replaces deleting stored resource hashes to force a resend.
