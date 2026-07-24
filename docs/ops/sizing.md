# System Requirements

Interbox is not a single process. A deployment is **three parts**, sized
separately:

- **The Interbox container** — the engine (MLLP ingest + pipeline workers) and
  the API (which also serves the dashboard). Two Bun processes in one image.
- **PostgreSQL** — a separate service. The message store, the work queue, and
  the search index all live here.
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

1. **Disk grows without bound.** There is no time-based retention and no
   partition rotation — processed history piles up in the cold partitions
   forever. Disk, not CPU or RAM, is the first thing you will run out of. Size
   it for your retention horizon (see [Disk](#disk-the-first-limit)).
2. **The trigram search index is the write cost.** Every inbound message
   maintains GIN trigram indexes on the raw message body and the patient name.
   That is what makes the free-text search in the dashboard instant, and it is
   the dominant per-insert cost on the Postgres side. It also needs an SSD.
3. **Autovacuum runs hot on purpose.** The hot queue partitions are tuned to
   vacuum aggressively (`autovacuum_vacuum_cost_delay = 0`), which keeps the
   working set lean but spends IO and CPU to do it. Give Postgres IO headroom.
4. **The dashboard facet rail is a RAM burst.** Opening the messages view fires
   six parallel `GROUP BY` queries, each allowed up to `FACET_WORK_MEM`
   (default `128MB`) of `work_mem`. One dashboard load can therefore ask for
   ~768 MB of transient sort/hash memory on top of the connection baseline.

## Component budgets

### Interbox container (Bun)

Light, and not the bottleneck. Baseline is roughly 50–150 MB RSS per Bun
process; the engine adds one OS worker thread per pipeline stage (the reference
`source → mapper → sender` pipeline is three). At the ~1 msg/s a "busy feed"
implies, CPU is idle most of the time — batches are 100 rows in the mapper and
500 in the sender.

Two things to account for beyond steady state:

- **Boot does real work.** For a remote workspace the engine does a shallow
  `git clone` + `bun install` + `bun build` on startup (and on every reload).
  That is a transient CPU spike, a few hundred MB, and requires **outbound
  network** plus a writable temp dir.
- **The image carries the dashboard assistant SDK.** Factored into the ~1 GB
  image size, not into steady-state RAM.

**Budget: 0.5–1 GB RAM, 1–2 vCPU.**

### PostgreSQL

The scaling axis for both CPU and disk. Cost centers: trigram GIN index
maintenance on insert, aggressive autovacuum on the hot partitions, and the
facet rail's parallel aggregates. Connection load is the API pool (`max: 16`)
plus a cancel pool (`max: 4`) plus one connection per engine worker plus the
heartbeat — comfortably under the default `max_connections = 100` for a single
node.

The template ships only `max_wal_size = 4GB`, `wal_compression = on`, and
`pg_stat_statements`; **`shared_buffers` is left at the Postgres default of
128 MB, which is too low for production.** Tune it per tier below.

**Budget: 4–8 GB RAM, 2–4 vCPU** at moderate load, on SSD.

### Aidbox

The dominant RAM consumer: a JVM FHIR server doing resource validation on every
transaction Bundle the sender posts. Its footprint is set by the Aidbox image,
not configured by Interbox.

**Budget: 4 GB+ RAM, 2 vCPU** minimum.

> Aidbox defaults its terminology engine to the **external** server
> `tx.health-samurai.io`. That is an outbound network dependency at runtime
> unless you switch it to a local terminology engine.

## Disk: the first limit

There is no retention job. Plan disk for how long you keep history, not for a
steady state. As a planning figure, budget **~8 KB per stored message** — the
raw HL7v2 body plus its trigram GIN index plus the btree indexes.

| Sustained feed rate   | Messages / year | Disk / year @ ~8 KB |
| --------------------- | --------------- | ------------------- |
| 0.1 msg/s (light)     | ~3.2M           | ~25 GB              |
| 1 msg/s ("busy feed") | ~31.5M          | ~250 GB             |
| 10 msg/s (high)       | ~315M           | ~2.5 TB             |

For reference, a **100M-row** history is roughly 800 GB — a realistic
prod-scale figure to plan around. Use SSD: the trigram search and the aggressive
autovacuum both punish spinning disk.

## Sizing tiers

Whole-node figures, assuming all three parts share a host (split them across
hosts for the larger tiers).

| Tier            | Use                                     | App    | Postgres | Aidbox | Node total            | Disk       |
| --------------- | --------------------------------------- | ------ | -------- | ------ | --------------------- | ---------- |
| **Dev / eval**  | One laptop, all-in-one, poke it         | 0.5 GB | 1 GB     | 4 GB   | **8 GB / 4 vCPU**     | 20 GB      |
| **Small prod**  | One busy feed, ~1 msg/s                 | 1 GB   | 4 GB     | 4 GB   | **12 GB / 4–6 vCPU**  | 250 GB+/yr |
| **Medium prod** | Several feeds, large searchable history | 1–2 GB | 8–16 GB  | 6–8 GB | **24–32 GB / 8 vCPU** | 1 TB+ SSD  |

Bottleneck order, worst first: **disk (unbounded) → Postgres CPU (GIN +
autovacuum + facets) → Aidbox RAM → the Bun container.**

## PostgreSQL tuning per tier

The template sets `max_wal_size`, `wal_compression`, and
`shared_preload_libraries` on the server, and the API sets facet `work_mem` per
query via the `FACET_WORK_MEM` environment variable. Everything else is a
Postgres default you should raise for production.

Set `effective_cache_size` to roughly 75% of the RAM you give Postgres (it is a
planner hint, not an allocation), and keep `FACET_WORK_MEM × 6 × concurrent
dashboard loads` comfortably under free RAM — that product is the facet rail's
peak transient memory.

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
autovacuum room — it is deliberately uncapped on the hot partitions.

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
disk size and a retention/archival plan up front from the
[disk table](#disk-the-first-limit); treat everything else as adjustable.

## Once it's running: signals and levers

You find your real numbers in production, from the dashboard and Postgres — not
from a load test nobody has time to run. Watch these; when one goes red, turn
the matching knob.

| You see (dashboard / Postgres)                 | Most likely means                            | Knob to turn                                     |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Queue depth (pending + received) climbing      | ingest outpaces processing                   | more engine CPU — but check Aidbox latency first |
| Aidbox Bundle POST latency or heap high        | the FHIR server downstream is the bottleneck | give Aidbox RAM/CPU; lower the sender batch size |
| Dashboard search / facets slow                 | `work_mem` too low, or history is huge       | raise `FACET_WORK_MEM`; keep the 24h window      |
| Postgres writing temp files (sort/hash spills) | `work_mem` too low for the query             | raise `work_mem` / `FACET_WORK_MEM`              |
| Disk filling up                                | history piling up — there is no retention    | add disk now; start a retention/archival plan    |
| Postgres CPU high, dead tuples rising          | autovacuum can't keep up                     | more Postgres CPU/IO (already tuned aggressive)  |

The single most telling signal is **queue depth**: if the pending and received
row counts stay flat you are keeping up; if they climb, processing cannot match
ingest — and the cause is almost always Aidbox downstream, not the engine.

## Caveats

- Estimates, not benchmarks — size from the tiers above, then adjust from the
  live signals once real traffic arrives.
- The Helm chart lives in a separate `helm-charts` repository and currently
  ships `replicas = 1`; HA is not yet available.
- Disk figures assume ~8 KB/message — a wide message body or extra indexes
  moves it. Measure your own average once you have real traffic.
