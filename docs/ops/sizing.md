# System Requirements

Interbox is not a single process. A deployment is **three parts**, sized
separately:

- **The Interbox container** — the engine (the sources and every pipeline's
  workers) and the API (which also serves the dashboard). Two Bun processes in
  one image.
- **PostgreSQL** — a separate service. The pipelines' stores, the units, the
  delivery queues and the search indexes all live here.
- **Aidbox** — a separate JVM service, the FHIR destination the reference
  pipeline sends to.

PostgreSQL and Aidbox are the resource-heavy parts; the Bun container is light.

> **These are code-derived estimates, not published benchmarks** — from the
> engine's batch/queue constants and the Postgres tuning shipped in the
> template. You will not know your real message volume before go-live, and that is
> fine: [pick a starting tier](#picking-a-starting-point), then watch a few
> signals and turn a knob when one goes red ([signals & levers](#once-its-running-signals-and-levers)).

## What drives the numbers

Before the tables, the four things that actually move the needle:

1. **Disk grows without bound.** There is no retention: each pipeline's store
   keeps every value it received, and every unit stays in the units table, so
   that a Retry always has its input. Disk, not CPU or RAM, is the first thing
   you will run out of. Size it for your retention horizon (see
   [Disk](#disk-the-first-limit)).
2. **The trigram search index is the write cost.** A pipeline that declares
   `search: "trgm"` on its store keeps a GIN trigram index on its units' search
   text. That is what makes the dashboard's free-text search fast, and it is
   the most expensive index to maintain: every status change of a unit writes
   new index entries for its whole search text, and a unit is written at the
   store and again at each later status, typically `processed` and `sent`. It
   also needs an SSD. A pipeline without
   `search` pays none of this; each attribute declared in `index` is a plain
   btree index, far cheaper.
3. **Autovacuum runs hot on purpose.** The units waiting at the store, the items
   waiting for the sender, and the leases on both are rows inserted and deleted
   all the time. Each pipeline's partitions of those tables are tuned to vacuum
   aggressively (`autovacuum_vacuum_cost_delay = 0`), which keeps the working
   set lean but spends IO and CPU to do it. Give Postgres IO headroom.
4. **The dashboard facet rail is a RAM burst.** A facet request sets `work_mem`
   to `FACET_WORK_MEM` (default `128MB`) for its own queries, which read at
   most the newest 10,000 matching units of one pipeline. Each sort or hash in
   them may use up to that much, on top of the connection baseline.

## Component budgets

### Interbox container (Bun)

Light, and not the bottleneck. Baseline is roughly 50–150 MB RSS per Bun
process. The engine runs each pipeline on its own OS worker threads: a source
thread, a segment thread that runs the steps after the store, and a sender
thread — three for the reference `source → steps → store → steps → sender`
pipeline. A pipeline fed through a bridge has no source thread, and one that
ends in a bridge has no sender thread. One more thread per workspace drains
webhook events. At the ~1 msg/s a "busy feed" implies, CPU is idle most of the
time — by default a take is 100 units after the store, and a sender cycle 100
items.

Two things to account for beyond steady state:

- **Boot does real work.** For a remote workspace the engine does a shallow
  `git clone` + `bun install` + `bun build` on startup (and on every reload).
  That is a transient CPU spike, a few hundred MB, and requires **outbound
  network** plus a writable temp dir ([Network Access](network.md) lists the
  hosts).
- **The image carries the dashboard assistant SDK.** Factored into the ~1 GB
  image size, not into steady-state RAM.

**Budget: 0.5–1 GB RAM, 1–2 vCPU.**

### PostgreSQL

The scaling axis for both CPU and disk. Cost centers: trigram GIN index
maintenance where a pipeline declares search, aggressive autovacuum on the
queue partitions, and the facet rail's aggregates. Connection load is the API
pool (`max: 16`) plus a cancel pool (`max: 4`), plus a pool for each engine
thread, at the Postgres driver's default of up to 10 connections each. A pool
opens a connection only when its thread needs one, so that ceiling is reached
only under load. On top of its pool, each source, segment and sender thread
holds one connection of its own open for as long as it runs, to publish its
live metrics: three for the reference pipeline, held even when no message
arrives. Count both against the default `max_connections = 100` as you add
pipelines.

The template ships only `max_wal_size = 4GB`, `wal_compression = on`, and
`pg_stat_statements`; **`shared_buffers` is left at the Postgres default of
128 MB, which is too low for production.** Tune it per tier below.

**Budget: 4–8 GB RAM, 2–4 vCPU** at moderate load, on SSD.

### Aidbox

The dominant RAM consumer: a JVM FHIR server doing resource validation on every
batch Bundle the sender posts. Its footprint is set by the Aidbox image,
not configured by Interbox.

**Budget: 4 GB+ RAM, 2 vCPU** minimum.

> Aidbox defaults its terminology engine to the **external** server
> `tx.health-samurai.io`. That is an outbound network dependency at runtime
> unless you switch it to a local terminology engine.

## PostgreSQL extensions

Interbox needs two extensions and Aidbox needs two, with `pg_trgm` common to
both. Aidbox can use several more beyond those. Some managed services also make
you allowlist each one before anything can create it.

| Extension            | Needed by | Required?                      | What for                                                       |
| -------------------- | --------- | ------------------------------ | -------------------------------------------------------------- |
| `pg_trgm`            | both      | required                       | trigram indexes — in Interbox, a pipeline's free-text search   |
| `btree_gist`         | Interbox  | required                       | GiST operator classes for plain column types                   |
| `unaccent`           | Aidbox    | required                       | accent-insensitive search                                      |
| `pgcrypto`           | Aidbox    | optional                       | cryptographic functions                                        |
| `pg_stat_statements` | Aidbox    | optional                       | query statistics for performance monitoring                    |
| `fuzzystrmatch`      | Aidbox    | optional, MDM module only      | string-similarity functions                                    |
| `postgis`            | Aidbox    | optional, `Location.near` only | geographic search                                              |

If a required extension is missing and cannot be created, the app does not
start: Interbox stops before it migrates, and Aidbox refuses to boot. Aidbox
starts without an optional one and logs a warning, but whatever uses it — the
MDM module, `Location.near` search, query statistics — is unavailable. Aidbox's
own [PostgreSQL Extensions](https://www.health-samurai.io/docs/aidbox/database/postgresql-extensions)
page has its full list, including the ones left out here, and wins wherever it
disagrees with this table.

**Who creates them.** Interbox creates its two in its first migration on boot
(`CREATE EXTENSION IF NOT EXISTS`, as the `DATABASE_URL` role). Aidbox creates
its own on boot unless `BOX_DB_INSTALL_PG_EXTENSIONS=false`. With that set it
installs nothing but still refuses to start until the required ones exist. An
admin can create any of them beforehand instead. Extensions are per database, so
create them in the database the app connects to. For Interbox, use a schema on
its role's `search_path` — `public` by default — because its migrations name
`gin_trgm_ops` unqualified. Aidbox looks for them in the schema
`BOX_DB_EXTENSION_SCHEMA` names; see its
[managed PostgreSQL guide](https://www.health-samurai.io/docs/aidbox/deployment-and-maintenance/deploy-aidbox/run-aidbox-on-managed-postgresql).

**Which role can.** `pg_trgm`, `btree_gist`, `unaccent`, `pgcrypto` and
`fuzzystrmatch` are *trusted*: any role with `CREATE` on the database, such as
its owner, can create them. `pg_stat_statements` and `postgis` are not, and
need a superuser — on a managed service, usually the provider's admin role (on
Azure, a member of `azure_pg_admin`). If Aidbox's own role cannot create
`pg_stat_statements`, an admin creates it in Aidbox's database, or Aidbox starts
without it and logs a warning. `pg_stat_statements` also works only when it is
loaded through `shared_preload_libraries`, which takes a restart to change.
Azure preloads it on every flexible server.

**Allowlisting.** Azure Database for PostgreSQL flexible server refuses
`CREATE EXTENSION` for any extension not named in the `azure.extensions` server
parameter. That is one value for the whole server, so a server Interbox and
Aidbox share has to list both:

| Server holds        | `azure.extensions`                                        |
| ------------------- | --------------------------------------------------------- |
| Interbox only       | `pg_trgm,btree_gist`                                      |
| Aidbox only         | `pg_trgm,unaccent,pgcrypto,pg_stat_statements`            |
| Interbox and Aidbox | `pg_trgm,btree_gist,unaccent,pgcrypto,pg_stat_statements` |

The Aidbox values are what Aidbox creates on boot — `pg_trgm`, `unaccent`,
`pgcrypto` — plus `pg_stat_statements`. The minimum it starts with is
`pg_trgm,unaccent`. Add `fuzzystrmatch` for Aidbox's MDM module and `postgis`
for `Location.near`.

The value replaces the whole list. If the server already allows extensions for
something else, keep them in the list and add these. `SHOW azure.extensions;`
prints the current value. Set it on the server's **Parameters** page or with the
CLI ([Microsoft's guide](https://learn.microsoft.com/en-us/azure/postgresql/extensions/how-to-allow-extensions)),
and always pass `--value` — without it, the command resets the parameter to its
default:

```sh
az postgres flexible-server parameter set \
  --resource-group <resource-group> --server-name <server> \
  --name azure.extensions --value pg_trgm,btree_gist
```

Other managed services gate extensions their own way; check your provider's list
of supported extensions.

**What Interbox checks.** Before it migrates, Interbox checks that it can create
each extension it still lacks: the server ships it, `azure.extensions` lists it
where that parameter exists, and its role has `CREATE` on the database. If not,
it logs one error naming every missing extension and every reason, and exits
without migrating. When `azure.extensions` is what blocks it, the error gives
the exact value to set — the current list plus what is missing — and when
`CREATE` is, the `GRANT` to run.

## Disk: the first limit

There is no retention job for units or stored values. Plan disk for how long you
keep history, not for a steady state. What one unit costs depends on what its
pipeline keeps:

- **its stored value**, in the pipeline's store table — for the template's
  HL7v2 pipeline, the raw message as text;
- **its row** in the units table, with its attributes, and an entry in the
  btree index of each attribute the store declares;
- **its search text**, if a step sets one, and with `search: "trgm"` its
  trigram index entries, usually the largest part. The template's pipeline
  makes the whole raw message its search text, so the message is stored twice
  and indexed once;
- **a record of each of its sender items once it is finished**, in
  `interbox.sender_item_done`: a short row for an item that was sent, dropped
  or deleted, and the item's payload as well only for one the sender rejected.
  Interbox purges these rows on its own, after
  `INTERBOX_DONE_ITEMS_RETENTION_DAYS` days — 7 by default, anything from one
  hour (`0.042`) to `36500`, or `0` to keep them for good — so they cost a few
  days of items, not your whole history. It also purges delivered webhook
  outbox rows on its own, after `WEBHOOK_RETENTION_DAYS` days (see
  [Webhooks](../concepts/webhooks.md#retention)).

Measure your own figure once real traffic has run for a few days. For a
pipeline named `hl7-to-aidbox`, whose tables carry the name with hyphens turned
into underscores:

```sql
SELECT pg_size_pretty(
         (pg_total_relation_size('interbox.store__hl7_to_aidbox')
          + pg_total_relation_size('interbox.processing_unit__hl7_to_aidbox'))
         / greatest(count(*), 1)) AS bytes_per_unit
  FROM interbox.processing_unit__hl7_to_aidbox;
```

Then multiply by your volume:

| Sustained feed rate   | Units / year |
| --------------------- | ------------ |
| 0.1 msg/s (light)     | ~3.2M        |
| 1 msg/s ("busy feed") | ~31.5M       |
| 10 msg/s (high)       | ~315M        |

Use SSD: the trigram search and the aggressive autovacuum both punish spinning
disk.

## Sizing tiers

Whole-node figures, assuming all three parts share a host (split them across
hosts for the larger tiers).

| Tier            | Use                                     | App    | Postgres | Aidbox | Node total            | Disk                             |
| --------------- | --------------------------------------- | ------ | -------- | ------ | --------------------- | -------------------------------- |
| **Dev / eval**  | One laptop, all-in-one, poke it         | 0.5 GB | 1 GB     | 4 GB   | **8 GB / 4 vCPU**     | 20 GB                            |
| **Small prod**  | One busy feed, ~1 msg/s                 | 1 GB   | 4 GB     | 4 GB   | **12 GB / 4–6 vCPU**  | SSD, from [Disk](#disk-the-first-limit) |
| **Medium prod** | Several feeds, large searchable history | 1–2 GB | 8–16 GB  | 6–8 GB | **24–32 GB / 8 vCPU** | SSD, from [Disk](#disk-the-first-limit) |

Bottleneck order, worst first: **disk (unbounded) → Postgres CPU (GIN +
autovacuum + facets) → Aidbox RAM → the Bun container.**

## PostgreSQL tuning per tier

The template sets `max_wal_size`, `wal_compression`, and
`shared_preload_libraries` on the server, and the API sets facet `work_mem` per
query via the `FACET_WORK_MEM` environment variable. Everything else is a
Postgres default you should raise for production.

Set `effective_cache_size` to roughly 75% of the RAM you give Postgres (it is a
planner hint, not an allocation), and keep `FACET_WORK_MEM` times the number of
facet requests running at once well under free RAM, with room to spare: one
facet query may sort or hash more than once.

**Small prod** (Postgres with ~4 GB):

```conf
shared_buffers = 1GB
effective_cache_size = 3GB
maintenance_work_mem = 512MB
max_wal_size = 4GB            # already set by the template
# FACET_WORK_MEM env var: 128MB (default) is fine
```

**Medium prod** (Postgres with ~8–16 GB):

```conf
shared_buffers = 4GB
effective_cache_size = 12GB
maintenance_work_mem = 1GB
max_connections = 200         # headroom for more engine workers
max_wal_size = 8GB
# FACET_WORK_MEM env var: 128–256MB
```

For write-heavy feeds, put the WAL on a separate volume from the data and give
autovacuum room — it is deliberately uncapped on the queue partitions.

## Picking a starting point

You will not know your real message volume before go-live. Don't try to — HL7
feeds are low-rate (even a busy hospital ADT feed is single-digit messages per
second), so for a single feed CPU and RAM are almost never the constraint. Pick
by feed count, over-provision a little because it is cheap, and tune the rest
reactively once real traffic shows you where it pinches:

- **Just evaluating** → Dev / eval.
- **One feed, no heavy history search** → Small prod.
- **Several feeds, or heavy dashboard search over large history** → Medium prod.

The one thing you cannot wing is **disk**. It grows forever — there is no
retention — and under-sizing it is the painful mistake to fix late. Decide the
disk size and a retention/archival plan up front from
[Disk](#disk-the-first-limit), measuring a unit's cost on your own messages
before go-live if you can; treat everything else as adjustable.

## Once it's running: signals and levers

You find your real numbers in production, from the dashboard and Postgres — not
from a load test nobody has time to run. Watch these; when one goes red, turn
the matching knob.

| You see (dashboard / Postgres)                 | Most likely means                            | Knob to turn                                     |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Units at `received` or `processed` climbing    | ingest outpaces processing or delivery       | more engine CPU — but check Aidbox latency first |
| Aidbox Bundle POST latency or heap high        | the FHIR server downstream is the bottleneck | give Aidbox RAM/CPU; lower the sender's `batch`  |
| Dashboard search / facets slow                 | `work_mem` too low, or history is huge       | raise `FACET_WORK_MEM`; narrow the time window   |
| Postgres writing temp files (sort/hash spills) | `work_mem` too low for the query             | raise `work_mem` / `FACET_WORK_MEM`              |
| Disk filling up                                | history piling up — there is no retention    | add disk now; start a retention/archival plan    |
| Postgres CPU high, dead tuples rising          | autovacuum can't keep up                     | more Postgres CPU/IO (already tuned aggressive)  |

The single most telling signal is **queue depth**: if the counts of units at
`received` (waiting for their steps) and `processed` (waiting for delivery) stay
flat you are keeping up; if they climb, processing or delivery cannot match
ingest — and the cause is usually Aidbox downstream, not the engine. The
dashboard's sender panel shows how many items wait for delivery, and why.

## Caveats

- Estimates, not benchmarks — size from the tiers above, then adjust from the
  live signals once real traffic arrives.
- The Helm chart lives in a separate `helm-charts` repository and currently
  ships `replicas = 1`; HA is not yet available.
- A unit's disk cost depends on what its pipeline stores, the search text it
  sets and the indexes it declares — measure your own average once you have
  real traffic.
