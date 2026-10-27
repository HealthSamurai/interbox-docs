# Upgrading from 1.x

Interbox 2.0 runs only chain pipelines. It does not read the 1.x tables, so on its
own a 1.x installation that moves to 2.0 starts with no message history, and the
Aidbox sender forgets which version of each resource Aidbox already holds. The
2.0 image ships a one-off script, `scripts/import-1x.ts`, that **moves** both into
one 2.0 pipeline. You run it once, with every engine stopped, between the 2.0
migrations and the first start of the 2.0 engine.

This page is the whole cutover, in order. Read it to the end before you start;
the parts that need preparing (the workspace, a rehearsal, the outage window)
come first.

## What moves, and what does not

The script moves the rows of two 1.x tables into the pipeline you name:

- **Every message in `interbox.hl7v2_in`** becomes a unit of the pipeline, with
  its raw HL7v2 text in the pipeline's store.
- **Every row of `interbox.resource_hash`** becomes one of the pipeline's Aidbox
  fingerprints, keyed `Type/id`.

Each 1.x status lands on a 2.0 status:

| 1.x status | 2.0 status | what the 2.0 engine does with it |
|---|---|---|
| `received` | `received` | parses, maps and sends it, as a new message |
| `processed` | `received` | the same: its pending 1.x deliveries are not carried, so the 2.0 engine maps and sends it again |
| `sent` | `sent` | nothing: history the dashboard shows and searches |
| `error` | `error` | nothing until you retry it, from the dashboard or with [`retryUnits`](admin-scripts.md); an unmapped-code error waits in the unmapped-code queue under the pipeline |
| `deferred` | `deferred` | nothing until you retry it |

Each unit keeps what the 1.x row knew:

- **Its times.** The unit is created and ordered at the 1.x message's receipt,
  and keeps its last update. Units are numbered in the order the 1.x messages
  arrived.
- **Its attributes**, read from the 1.x columns: `message_type`, `event_type`,
  `patient_id`, `patient_name`, `sending_application`, `sending_facility` and
  `send_time`, the same keys and formats `hl7v2Parser()` sets. A column 1.x left
  empty sets no attribute.
- **Its error**, kind and message, when it lands on `error` or `deferred`, as a
  unit 2.0 defers keeps its error. The step that failed is not recorded, because
  1.x did not record one. A unit landing on `received` or `sent` has no error,
  as no 2.0 unit there has one, even when the 1.x row still carried an earlier
  failure.
- **Its search text**, the raw message, when you pass `--search-text message`.

**Why the fingerprints matter.** The Aidbox sender sends a resource it holds no
fingerprint for as a `PUT`, which replaces the whole resource, and one whose
fingerprint differs as a `PATCH`, which merges. Without the 1.x fingerprints, the
first 2.0 send of every resource already in Aidbox would be a `PUT`, wiping the
fields other messages merged into it. The script therefore moves the
fingerprints before any message. Where the pipeline already holds a fingerprint
for a resource, that one is kept, unless an earlier run of the same unfinished
import wrote it: a 1.x row still there on a later run was written after that run
moved its first one, so it replaces it.

**What is not moved:**

- `interbox.ingestion_queue`, the 1.x deliveries still pending. The messages
  they came from are `received` or `processed`, and the 2.0 engine maps and sends
  those again.
- `interbox.ccda_in`. C-CDA documents stay where they are; the script logs a
  warning when the table holds any.
- A 1.x message's hash, its channel and its `extra` column.

**What the target pipeline must be.** Name the one pipeline of the rewritten
workspace that both stores the raw HL7v2 text and sends with
`.sender(aidbox(…))`, and that is the only pipeline sending to that Aidbox. Pass
its name exactly as it is written in `pipeline("…")`.

- **The fingerprints belong to the pipeline that sends.** They are kept per
  pipeline, so they help only the pipeline that sends to Aidbox. Moved into any
  other pipeline, they are never read, and the sending pipeline sends every
  resource it meets for the first time as a `PUT`.
- **A name the workspace does not declare stops the engine.** If the target is
  not one of the workspace's pipelines, such as a typo, the 2.0 engine refuses to
  start any pipeline and says why (see [Recovering](#recovering)).
- **Not supported by this version:** a workspace that stores the raw message in
  one pipeline and bridges it with `intoPipeline(…)` into another pipeline that
  sends to Aidbox, and a workspace where several pipelines send to one Aidbox.

The script writes each raw message into the pipeline's store as text, so the
pipeline must declare `postgresStore({ codec: "text" })` and parse the message
*after* the store, the way the workspace template's `hl7-to-aidbox` pipeline
does:

```ts
pipeline("hl7-to-aidbox")
  .source(mllpSource({ host: env("MLLP_HOST"), port: env("MLLP_PORT") }))
  .step((raws) => raws.withSearchText((raw) => raw))
  .store(postgresStore({ codec: "text" }), { index: { message_type: "btree" }, search: "trgm" })
  .step(hl7v2Parser())
  // …
```

A pipeline that stores the raw message and declares `search: "trgm"` takes
`--search-text message`; one that sets no search text takes `--search-text none`.

`hl7v2_in` must hold messages from **one 1.x channel** (one 1.x source). With
two or more, the script refuses and moves nothing.

**It is a move.** Each row is deleted from its 1.x table in the transaction that
writes it to 2.0. A run that stops part-way keeps what it moved, and running it
again moves the rest. A 1.x image started afterwards no longer sees the moved
rows, which is why the backup in the next section is not optional.

## Before the cutover

1. **Rewrite the workspace in the chain DSL**, as
   [Updating the Engine](updating.md#keep-the-workspace-sdk-compatible) and
   [Pipelines](../concepts/pipelines.md) describe, and push it to the branch or
   ref the 2.0 engine will run. A 2.0 engine refuses a 1.x workspace.
2. **Rehearse on a copy of the database.** Restore a recent backup into a scratch
   database and run the whole cutover against it: the migrations, the import, and
   a 2.0 engine on the rewritten workspace. Time each step; the outage window is
   their sum.
3. **Look at the counts.** `--dry-run` prints what would move, per 1.x status,
   and the number of fingerprints, and changes nothing. It also reports a refusal
   the data itself would cause: messages from several channels, or a store that
   is not text. It checks neither for running engines nor for leases, so you may
   point it at the copy or at the live database while 1.x still runs. On the live
   database it costs a full read of `hl7v2_in`, every message included, so run it
   there at a quiet hour.
4. **Plan the outage.** The MLLP listener is down from the moment 1.x stops until
   the 2.0 engine is ready. Confirm that every sender queues and retries when its
   connection is refused; most interface engines do.
5. **Check the disk.** Leave free at least twice the size of `hl7v2_in`, plus room
   for the WAL the import writes. Every message is written again, into the
   pipeline's store and, with `--search-text message`, into its search text, and
   the first 2.0 boot builds a trigram index over that search text. The 1.x rows'
   space comes back only at the end, when a complete run truncates the emptied
   1.x tables. `hl7v2_in` is partitioned, so measure it with:

   ```sql
   SELECT pg_size_pretty(sum(pg_total_relation_size(relid)))
     FROM pg_partition_tree('interbox.hl7v2_in');
   ```
6. **Plan the backup.** Back up the production database as late as you can.
   With cluster access, take it after the engine has stopped and before the
   import runs, so it holds every message 1.x accepted. With Git access only, the
   engine stops and the import starts in the same reconcile, so the backup comes
   before the first pull request merges, and messages 1.x accepts between the
   backup and its stop are not in it.

As a sizing guide, on a laptop's local Postgres the script moved about 19,000
messages a second (100,000 messages of about 400 bytes, with search text, and
100,000 fingerprints in 5 seconds), and the first 2.0 boot then built the
template's four indexes over those units in 4 seconds. That first boot builds
the pipeline's declared indexes over every imported unit **before any stage
starts**, so on a large history it lengthens the outage. A very large import
makes that first boot's index build long, minutes rather than seconds, so time
the first boot in the rehearsal along with the import. Use your rehearsal's
numbers, not these.

## The script

Run it from `apps/engine` in the 2.0 image (`/app/apps/engine`), with
`DATABASE_URL` set, after `scripts/migrate.ts`:

```sh
cd /app/apps/engine
bun scripts/migrate.ts
bun scripts/import-1x.ts --pipeline hl7-to-aidbox --search-text message
```

| option | what it does |
|---|---|
| `--pipeline <name>` | the 2.0 pipeline that receives the rows. Required. |
| `--search-text message\|none` | `message` fills each unit's search text with its raw message; `none` leaves it empty. Required. |
| `--dry-run` | prints what would move, per 1.x status, the fingerprints and any import marks, and changes nothing |
| `--wait-for-engines <d>` | how long to wait for running engines to stop before refusing, such as `30s`, `5m` or `1h`, up to `24h`. Default `0`: refuse at once |
| `--lease-minutes <n>` | how long the run holds the pipeline's lease (below). Default `60`, at most `1440` |
| `--batch-size <n>` | rows moved per transaction. Default `1000`, at most `10000`. It counts rows, not bytes: when messages carry large embedded documents, such as base64 PDFs in OBX, pass a smaller value so a batch stays a short transaction |
| `-h`, `--help` | prints the options |

It exits `0` when everything moved, when nothing was left to move, or when a dry
run found nothing to refuse; `1` when it refused, stopped or failed; and `2` on a
bad argument.

The script creates the pipeline's tables itself, so it runs before any 2.0
engine has loaded the pipeline. It leaves the pipeline's declared indexes to the
engine's first boot.

### Its fences

The script must be the only thing touching these tables, and it checks:

- **No engine is running.** Every engine, 1.x or 2.0, writes a heartbeat every 2
  seconds. The script counts an engine as running while its last heartbeat is
  under 6 seconds old, and refuses. A stopped engine leaves its heartbeat behind,
  so the row goes stale on its own: a 1.x engine exits as soon as it is told to
  stop, and a 2.0 engine stops beating as soon as it is told to. With
  `--wait-for-engines`, the script waits for the heartbeats to go stale instead
  of refusing at once, and starts as soon as they have.
- **The pipeline is held.** For the whole run the script holds the pipeline's
  DDL lease, the lease a 2.0 engine takes before it loads the pipeline, and a
  lease of its own, which it takes before anything else. A 2.0 engine that loads
  the target pipeline waits for the DDL lease, for up to 10 minutes; one whose
  workspace does not declare the target does not wait: it sees the import's own
  lease, from the moment the import starts, and starts no pipeline.
- **The import is marked.** In the transaction of the first batch that moves a
  row, the script records, in the target pipeline's state, that an import into
  it is running, and when every row has moved it records that the import is
  done, with the counts. A run that stops after moving a row leaves it running;
  one that stops before leaves no mark, so a run into another pipeline, after a
  mistyped `--pipeline`, is not refused. Every 2.0 engine checks the mark each time it loads
  its pipelines, after it has the pipeline's lease and before any stage starts:
  - an import still running anywhere keeps the engine from starting any
    pipeline, so no engine works on a half-moved history;
  - an import done into a pipeline the workspace does not declare does the
    same, because the declared pipelines hold none of the fingerprints, and so
    does one done into a declared pipeline whose store is not text, or that hands
    its rows on with `intoPipeline(…)` instead of sending;
  - an import done into any other declared pipeline is confirmed, and is not
    checked again, so renaming the pipeline later does not stop the engine.

  The engine stays up with the API and the dashboard, and the reason shows where
  a workspace that fails to load shows its error. An engine that waited 10
  minutes for the DDL lease without getting it stops the same way. It does not
  try again on its own: restart it, send it `SIGHUP`, or press **Sync now** on
  the dashboard once the cause is gone. See [Recovering](#recovering).
- **An engine that appears mid-run does not stop the run.** Before every batch
  the script checks the heartbeats again, and warns once for each engine that
  has started beating. A 2.0 engine starts no pipeline while the import runs,
  then loads normally if the import completed and it is retried, or stays stopped
  on the mark if the import did not complete. A 1.x engine must be stopped at
  once: its mapper and sender work on the 1.x tables the script is moving. **Keep
  every engine stopped until the script has exited `0`.**
- **Nothing may write to the 1.x tables meanwhile.** After the last batch the
  script checks that both 1.x tables are empty before it marks the import done.
  A row written during the run, such as by a 1.x engine that was still working,
  stops the run as `rows_written`: the mark stays running, so no 2.0 engine
  starts, and running the script again moves the row.
- **One import at a time, into one pipeline.** The script also holds a lease of
  its own, whatever pipeline it moves into, so two runs never overlap. A run into
  another pipeline is refused, as `other_target`, while an import into the first
  is unfinished, or once it is done while 1.x rows are left, so the history and
  the fingerprints are never split between two pipelines.
- **Leases are not renewed**, so `--lease-minutes` must cover the whole run; the
  script stops before a batch that would outlive it.
- **No batch waits long for a lock.** A batch that waits more than 10 seconds for
  a row something else holds fails, and the run stops; something is still using
  the 1.x tables.
- **It can be stopped.** On `SIGTERM` or `SIGINT`, as when its Job is deleted,
  the script finishes the batch in flight, releases its leases and exits `1`. A
  second signal exits at once: the batch in flight rolls back, and the leases
  stay held until their term runs out.

### When it refuses or stops

Every refusal and stop is logged as an error with a `reason`. Nothing moved
after a refusal; after a stop, what moved stays moved, the log line says how
much, and running the script again resumes.

| reason | it means | what to do |
|---|---|---|
| `engine_alive` (refused) | an engine beat within the last 6 seconds; the message names its instance id | stop that engine, or pass `--wait-for-engines` |
| `other_target` (refused) | an import into another pipeline is unfinished, or is done while 1.x rows are left; the message names that pipeline | run the script with `--pipeline` set to the pipeline it names |
| `target_has_units` (refused) | the target already holds 2.0 units and has no unfinished import of its own, so 2.0 has run it: the 1.x messages would be numbered after its live units, and older data sent over newer | restore the backup taken before 2.0 first ran, and import then |
| `lease_held` | the pipeline's lease or the import's own lease is held; the message names the holder and its expiry | an engine is loading the pipeline, or another import is running: stop it. A holder `<host>/import-1x#<run id>` that is no longer running is an import that was killed outright; its lease comes free at the time shown |
| `several_channels` | `hl7v2_in` holds messages from more than one 1.x channel, all named | the script supports one channel; nothing moved |
| `store_not_text` | the pipeline's store already holds values that are not text | the target pipeline must declare `postgresStore({ codec: "text" })` |
| `bad_pipeline_name` | the name is not one `pipeline()` accepts | fix `--pipeline` |
| `lease_term` (stopped) | the lease was about to run out | run again with a longer `--lease-minutes` |
| `lease_lost` (stopped) | a lease expired and another holder took it | stop that holder, run again with a longer `--lease-minutes` |
| `interrupted` (stopped) | the script got `SIGTERM` or `SIGINT` | run again |
| `rows_written` (stopped) | `hl7v2_in` or `resource_hash` gained rows during the run, so something still writes to them; the message names the table | find and stop the writer, such as a 1.x engine, then run again |
| `failed` (stopped) | a batch, or a step before the first one such as creating the pipeline's tables, failed, such as on a lost connection or a lock it waited on too long; the error follows | fix the cause, run again |

A dry run lists the import marks it finds, with their pipeline, state and counts.

### Recovering

Stopping an engine means scaling it to zero (`kubectl scale … --replicas=0`).
With Git access only, it means a pull request that sets `replicaCount: 0` in
the release's values; starting it again is the pull request that restores it.

- **An engine that will not start because a 1.x import is running.** It found
  the import's own lease. Let the import finish, then restart the engine, send it
  `SIGHUP`, or press **Sync now**.
- **An engine that will not start because an import is unfinished.** Its error
  names the pipeline and says the 1.x import into it is unfinished. Stop the
  engine, run the script again with the same `--pipeline` to move the rest, and
  start the engine. A run that finds every row already moved marks the import
  done and exits `0`.
- **An engine that will not start because the import went into the wrong
  pipeline**: one the workspace does not declare, such as a misspelled
  `--pipeline`, or one whose store is not text, or that hands its rows on with
  `intoPipeline(…)`. The rows are in the wrong pipeline, and its fingerprints
  help no pipeline that sends. Restore the backup taken before the cutover, and
  run the import again into the right pipeline. Only as a last resort, if you
  accept the consequence, delete the mark so that the engine starts:

  ```sql
  DELETE FROM interbox.pipeline_state
   WHERE pipeline = '<the name the import used>'
     AND namespace = 'interbox:import-1x'
     AND key = '1x';
  ```

  The consequence: the declared pipelines hold none of the 1.x fingerprints, so
  they send every resource they meet for the first time to Aidbox as a `PUT`,
  replacing what Aidbox holds, and the 1.x history stays in a pipeline no one
  reads.
- **`other_target`.** The script names the pipeline the earlier import used.
  Every 1.x row goes to that one pipeline, so run it with that `--pipeline`. If
  that name was the mistake, recover as above.
- **`target_has_units`.** 2.0 has already run the target pipeline, so the 1.x
  history can no longer go in front of what it received. Restore the backup
  taken before 2.0 first ran, and run the import before starting 2.0.

## The cutover on Kubernetes

The Helm chart names its Deployment, and labels its pod `app=`, with the chart's
full name: `interbox`, unless you set `fullnameOverride`. Its Secret holding
`DATABASE_URL` is `interbox-secrets`, or the one `secrets.existingSecretName`
names. The examples below use those defaults.

### With cluster access

1. **Suspend the reconciler** if a GitOps tool manages the release, so it does
   not scale the engine back up mid-cutover. With Flux:

   ```sh
   flux suspend helmrelease <release> -n <namespace>
   ```

2. **Stop the engine** and wait for its pod to be gone:

   ```sh
   kubectl -n <namespace> scale deployment/interbox --replicas=0
   kubectl -n <namespace> wait --for=delete pod -l app=interbox --timeout=5m
   ```

3. **Back up the database** now, with the engine stopped, so the backup holds
   every message 1.x accepted.

4. **Run the migrations and the import** as a one-off Job from the 2.0 image.
   Copy `imagePullSecrets` from the release, and the container `securityContext`
   (the chart sets one on its container) if your cluster's policies require it.

   ```yaml
   apiVersion: batch/v1
   kind: Job
   metadata:
     name: interbox-import-1x
     namespace: <namespace>
   spec:
     backoffLimit: 0
     template:
       spec:
         restartPolicy: Never
         terminationGracePeriodSeconds: 300
         containers:
           - name: import-1x
             image: healthsamurai/interbox:<2.0 version>
             command: ["bash", "-c"]
             args:
               - >-
                 cd /app/apps/engine &&
                 bun scripts/migrate.ts &&
                 exec bun scripts/import-1x.ts --pipeline <pipeline> --search-text message
                 --wait-for-engines 1m --lease-minutes 60
             envFrom:
               - secretRef:
                   name: interbox-secrets
   ```

   ```sh
   kubectl apply -f import-1x-job.yaml
   kubectl -n <namespace> logs -f job/interbox-import-1x
   kubectl -n <namespace> wait --for=condition=complete job/interbox-import-1x --timeout=10s
   ```

   `logs -f` follows the run to its end. The last line is either
   `every 1.x row moved`, with the counts, or the refusal or stop and its
   `reason`. `wait --for=condition=complete` succeeds only for a run that exited
   `0`. The image's own entrypoint is not used: `command` replaces it, so the Job
   starts neither the engine nor the API. The long
   `terminationGracePeriodSeconds` is there because the script stops on `SIGTERM`
   only between steps: before its first batch it counts `hl7v2_in` in one full
   read, which on a large table takes minutes, and a `SIGKILL` at the end of a
   short grace period would leave both of its leases held until their term runs
   out. The `exec` makes the script the
   container's main process, so deleting the Job sends `SIGTERM` to the script
   itself and it stops cleanly.

5. **Start 2.0.** In the release's values, set the image to the 2.0 version and
   point the engine at the rewritten workspace (`INTERBOX_WORKSPACE_GIT_REF`, see
   [The Workspace](workspace.md)), then resume the reconciler:

   ```sh
   flux resume helmrelease <release> -n <namespace>
   ```

   The upgrade sets the replicas back to `replicaCount`, and the chart's
   `Recreate` strategy brings up one 2.0 pod. Without a GitOps tool, run the same
   upgrade with `helm upgrade`. Delete the Job once you have read its log:

   ```sh
   kubectl -n <namespace> delete job interbox-import-1x
   ```

### With Git access only

When every change reaches the cluster through a reconciler and you have no
`kubectl`, the cutover is two commits, each its own pull request.

**First pull request: stop the engine and run the import.**

- In the HelmRelease values, set `replicaCount: 0`.
- Add the Job manifest above to a path the reconciler applies, with
  `--wait-for-engines 10m`.

Once it merges, the reconciler scales the engine down and starts the Job, in the
same pass and in no set order. The Job can start before the old pod has even been
told to stop, which is what `--wait-for-engines` covers: the script waits until
the old engine's heartbeat goes stale, about 6 seconds after it is told to stop,
and starts then. Ten minutes leaves room for a slow pod deletion and costs
nothing when the engine stops quickly. `migrate.ts` runs before the wait, which
is safe: the 2.0 migrations add tables a 1.x engine does not use, and drop only
one that a 1.x engine creates in its development mode.

Leave out `ttlSecondsAfterFinished`: a reconciler re-creates a Job that the TTL
deleted, and runs the import again.

**Second pull request, once the Job has completed:**

- Remove the Job manifest. A reconciler that prunes deletes the Job; one that
  does not leaves it for someone with cluster access.
- Set the image to the 2.0 version and point the engine at the rewritten
  workspace.
- Restore `replicaCount`.

Read the Job's outcome through whatever your platform offers without `kubectl`,
such as its log viewer or the reconciler's health checks, before you merge: the
last log line says what moved or why the run stopped.

Two things to plan for:

- **A Job's spec cannot be changed.** To run the import again, after a refusal or
  a stop, rename the Job (`interbox-import-1x-2`) in a new commit; editing the
  existing manifest does not start a new run.
- **The outage spans both pull requests.** MLLP is down from the moment the first
  one reconciles until the 2.0 pod is ready after the second. Line up the
  reviewers who must approve the second pull request before the first one merges.

## The cutover on Docker Compose

The workspace template names its engine service `interbox`.

```sh
docker compose stop interbox
```

Set `INTERBOX_VERSION` in `.env` to the 2.0 version and pull it. Then run the
migrations and the import as a one-off container of the same service, which
reads the service's `DATABASE_URL` and publishes no ports:

```sh
docker compose pull interbox
docker compose run --rm --no-deps --entrypoint bash interbox -c \
  "cd /app/apps/engine && bun scripts/migrate.ts && exec bun scripts/import-1x.ts --pipeline hl7-to-aidbox --search-text message"
```

With the workspace checkout on the rewritten pipelines, start 2.0:

```sh
docker compose up -d
```

## Verify

- **The counts.** The script's last line lists what moved, per 1.x status, and
  the fingerprints moved and kept. Compare them with the dry run.
- **The 1.x tables are empty.** A 2.0 engine that still finds rows in
  `hl7v2_in` or `resource_hash` logs a warning at boot naming the script. The
  first 2.0 boot should log none.
- **The units.** On the dashboard's Units page, filter the pipeline by status:
  the counts match the table above, and the imported `received` units move on to
  `sent` as the engine works through them.
- **The fingerprints.** `deliveredSummary` from the
  [admin library](admin-scripts.md) counts the pipeline's fingerprints. Its
  `total` is the fingerprints moved, less those kept because the pipeline already
  held one for that resource, plus every fingerprint the pipeline held before the
  import, plus any the 2.0 sender has written since. For a pipeline that held none
  before, that is the number moved, until 2.0 sends.
- **A test message end to end.** Send one through the MLLP listener and follow
  it to `sent` and into Aidbox.

## Rolling back

After the import, the moved rows are no longer in the 1.x tables. A 1.x image
started against the database finds an empty `hl7v2_in` and `resource_hash`, and
does not see anything 2.0 received. There is no command that moves rows back.

To return to 1.x, restore the backup taken before the cutover and redeploy the
1.x image and workspace. Everything received after the cutover is in 2.0's
tables only, so it is lost with the restore unless the senders send it again.
So are messages 1.x accepted between the backup and its stop, which is why, with
cluster access, the backup is taken after the engine has stopped.
