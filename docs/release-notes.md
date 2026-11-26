<!-- Each `bun run release` adds its release on top (scripts/release/release-notes.ts). Fix a section by hand in a PR. -->

# Release Notes

Each release ships the engine image and the SDK under one version.
[Updating the Engine](ops/updating.md) says how to move to a new one; do what a release's
**Upgrade notes** say before it runs.


## November 2026

### 2.5.3

_26 November 2026_

**Features**

* **[PostgreSQL Backups](ops/postgres.md)**: a new Operations page covers what the Interbox database holds and what losing it costs. It also covers how to turn on point-in-time recovery on Cloud SQL, RDS and Azure, or with CloudNativePG and its Barman Cloud plugin on Kubernetes, and how to restore.

**Improvements**

* **[TLS to PostgreSQL](ops/deploy.md#tls-to-postgresql)**: the docs recommend `sslmode=verify-full` in `DATABASE_URL`, with `sslrootcert` for a private CA. A future release of the database client will stop checking the certificate under `require`. Avoid `uselibpqcompat=true&sslmode=require`, which turns the check off.
* Interbox writes one JSON line per log record and logs each fault once with its recovery. The workspace service logs a failed publish once in full, stays quiet while the same error repeats, and logs one line when a publish succeeds again.
* A metrics publisher's failed connect, failed flush and client errors log at `warn` instead of `error`. The publisher re-sends every bucket on the next flush, so none of these failures loses data.
* Senders no longer rescan held units for each item they deliver.
* The image runs the engine's scripts from bundles. Call them without `.ts`: `bun scripts/migrate` and `bun scripts/import-1x`. See [Upgrading from 1.x](ops/upgrade-from-1x.md#the-script).

**Bug fixes**

* Fixed migrations running together instead of each in its own transaction. Now a migration that cannot get a table lock during a rolling update gives way and retries. A failed migration leaves the ones before it applied, and the next start or build load continues from the failed one. See [Updating the Engine](ops/updating.md).

### 2.5.2

_25 November 2026_

**Features**

* **[Parked pipelines](ops/workspace.md#parked-pipelines)**: a pipeline whose own source, store, sender or webhook settings fail the load checks is now parked instead of refusing the whole workspace. An example is an `env()` variable the engine's environment does not set. The workspace service publishes the build, the other pipelines keep running, and the Pipelines page shows the parked one as `Parked, not running` with its error. Requests to its webhook or pull sender path get `503` with `Retry-After: 60`, so senders retry rather than drop the input.

**Improvements**

* The workspace service retries a failed publish of the same revision after 30 seconds, doubling the wait up to 10 minutes, so a git or package registry outage clears without a new commit. See [The Workspace](ops/workspace.md). A new commit, a branch switch, **Sync now**, **Publish** and **Discard and update** still retry at once. A repeat of the same error is logged as one short warning.
* A replica that has no build loaded yet shows the failed revision and its error on the Instances page.

### 2.5.1

_25 November 2026_

**Improvements**

* **[Dropping the 1.x tables](ops/upgrade-from-1x.md#once-the-cutover-is-final)**: on its first start, Interbox drops the 1.x tables `hl7v2_in`, `ingestion_queue`, `resource_hash` and `source_state` if `hl7v2_in` and `resource_hash` are both empty, and skips any that are already gone. After that, rolling back to 1.x requires a restore.
* Workers load the storage SDKs and concept maps on first use instead of at start, so a worker that never uses them does not load them.

### 2.5.0

_24 November 2026_

**Upgrade notes**

* Move the image to 2.5.0 and the Helm chart to 0.4.0 together. Chart 0.4.0 adds the [workspace service](ops/deploy.md#the-workspace-service), which builds the workspace and publishes it to PostgreSQL; every ready replica now ingests, and only the replica holding the active lease processes. A 2.5.0 engine under an older chart stays unready, and an older engine under chart 0.4.0 runs the workspace service's pod as one more engine; see [Upgrading from 2.4.x or older](ops/updating.md#upgrading-from-24x-or-older).
* Under Docker Compose, add a second service from the same image with the command `workspace`, the same environment and the same workspace mount as the main service. Set `INTERBOX_WORKSPACE_SERVICE_URL` on the main service to its port 3001. Without the workspace service no replica loads a build, and without the variable the Repository screen, workspace actions, concept maps and the assistant answer `404`; see [The workspace service](ops/deploy.md#the-workspace-service).
* Set the readiness probe's path to `/api/ready` once you run 2.5.0. The chart's readiness probe defaults to `/api/health`, so without this change a new pod takes traffic before its listeners are up; see [Readiness](ops/deploy.md#readiness).
* Plan the move as one-way: 2.5.0 drops the tables that 2.4.x replicas coordinate through, so a 2.4.x engine does not boot on the upgraded database. During the rolling update the 2.4.x pods stop their workers, MLLP listeners included, about 10 seconds after the first 2.5.0 pod migrates, and intake resumes once a 2.5.0 pod has loaded a published build; see [Upgrading from 2.4.x or older](ops/updating.md#upgrading-from-24x-or-older).
* Mount the data the workspace reads from outside its repository, and every folder a file-drop source reads, on every replica. Any replica can take the active lease, and each one runs the published build from its own cache; see [Replicas](ops/deploy.md#replicas).
* Remove `ownership` from `defineSource` calls. The SDK no longer declares it, and every `defineSource` source runs on the active replica only; see [Pipelines](concepts/pipelines.md#your-own-source).
* Remove `INTERBOX_RUNTIME_ROLLBACK_INTENT`, `INTERBOX_RUNTIME_CONFIG_DIR` and `INTERBOX_WORKSPACE_INSTANCE` from your deployment. The engine no longer reads them.

**Features**

* **[Pause a pipeline](ops/operating.md#pausing-a-pipeline)**: the **Pipelines** page has a **Pause** and a **Resume** button on each pipeline, and shows who paused it and when. While a pipeline is paused, Interbox stops its file and polled sources, its steps and its sender on every instance, and receiving sources keep accepting and storing what they receive. The pause holds across restarts and redeploys.

### 2.4.1

_23 November 2026_

**Bug fixes**

* Fixed an engine that lost its coordination session leaving that session open after it reconnected. Interbox now ends its own dropped session when it reconnects.
* Fixed sources that are slow to start being treated as failed. Interbox now gives a source two minutes to start once its worker is ready.

### 2.4.0

_19 November 2026_

**Upgrade notes**

* Stop every engine and API process of the earlier release before you start this one: use `Recreate` or scale to zero, and confirm the old containers have terminated. A new engine stays `NotReady` while an older engine still reports, and nothing detects a legacy API process. Add replicas only after this first upgrade; see [First upgrade to coordinated runtime generations](ops/updating.md).
* Replace `port` with a `path` on every `webhookSource`, point each sending system at its new URL, and set `INTERBOX_WEBHOOK_PORT` if your Service does not point at `3002`. The workspace fails to load if a source names a port, has no path, or shares a path with another source. All webhook sources now listen on that one port, told apart by path; see [webhookSource](reference/steps.md).
* Check that each MLLP feed's `MSH-18` names the character set it sends, and that feeds without `MSH-18` send valid UTF-8. Interbox now decodes each frame by `MSH-18` and answers `AE` to a frame it cannot decode, without storing it. Earlier releases stored such frames with non-ASCII characters replaced and answered `AA`. See [mllpSource](reference/steps.md#mllpsource).
* Rename any workspace state whose `defineState` name begins with `filedrop.` or `aidbox.`, and read the Aidbox sender's fingerprints through `fingerprints` from `@health-samurai/interbox/aidbox` instead. `defineState` now throws on these reserved prefixes, so such a workspace fails to load. Renaming leaves the old rows behind; see [Units and State](concepts/units-and-state.md).
* Fix any build errors in `server/actions.ts` and its imports before you update. A workspace whose actions fail to build is rejected: a reload keeps the previous workspace, and a first boot stays unready. See [Workspace actions must compile before activation](ops/updating.md).
* Set `INTERBOX_RUNTIME_ROLLBACK_INTENT` to a value not used before when you roll back to an earlier image or configuration. Without it, pods that start with a replaced image or configuration stay `NotReady`. See [Authorize the rollback](ops/updating.md).

**Features**

* **[Pull sender](concepts/pull-senders.md)**: `pullSender()` keeps the newest version of each record a pipeline produces. A system that cannot take inbound connections polls it through an Aidbox App with `receive`, `ack` and `search`. The page covers the queue API, the consumer contract and the Aidbox setup.
* **[Multiple replicas](ops/deploy.md)**: several engine pods can now share one database and use rolling updates. Each pod needs its own cache and `INTERBOX_WORKSPACE_INSTANCE`, and readiness is checked on `/api/ready`. `GET /api/runtime` shows what blocks a cutover, and [confirm-termination](ops/local-testing.md) releases a pod that is gone.
* **[Source ownership](concepts/pipelines.md#your-own-source)**: `defineSource` takes `ownership: "singleton"`, the default, or `ownership: "replica"`. A singleton source runs on one replica under a lease, and another replica takes over when it stops. A replica listener binds on every pod and calls `ctx.ready()` once bound.
* **[Ordered store](concepts/stages.md#where-a-step-runs)**: `.store(postgresStore({ codec: "json" }), { ordered: true })` maps one unit at a time across replicas. Use it for mapping that reads state written by earlier units.
* **[Guarded Aidbox writes](reference/steps.md#guarded-aidbox-writes)**: `versionGuard: true` on `aidbox()` writes with `If-Match` and `If-None-Match: *`. A late or retried request can no longer overwrite a newer version. The sender's client then needs read permission as well.
* **[Destination scope](reference/steps.md#aidbox)**: `aidbox()` takes `destinationScope` to separate tenants served by one URL. Fingerprints are now keyed by destination URL and scope, so a resource with a fingerprint from an earlier release is delivered again.
* **[Webhook secret by Basic auth](reference/steps.md)**: a `webhookSource` accepts its `secret` as the password of `Authorization: Basic`, for sending systems that cannot add the `x-interbox-secret` header.

**Improvements**

* Administrator sessions, trusted-device cookies and assistant transcripts are stored in PostgreSQL, so they survive restarts and work across API replicas. Starting with a new `INTERBOX_AUTH_ADMIN_PASSWORD` revokes earlier administrator sessions; see [Securing Dashboard Access](ops/secure-access.md).
* Workspace action runs and their results are stored in PostgreSQL, so the run history survives restarts and is the same on every replica; see [Workspace actions](ops/workspace.md#workspace-actions).
* The Repository tab's branch override now applies to every engine that shares the database and survives restarts; see [The Workspace](ops/workspace.md).
* The assistant's skills describe the 2.0 chain DSL and how to test a mapping. The `interbox assistant hl7v2-map` command is removed, since it failed on every 2.0 workspace.
* The SDK moves to fast-xml-parser 5, which clears 22 dependency security advisories.

**Bug fixes**

* Fixed workspaces built on an incompatible SDK version crash-looping workers with errors such as `ctx.x is not a function`. The engine now refuses a different major at load and warns about a newer minor; see [Keep the workspace SDK compatible](ops/updating.md#keep-the-workspace-sdk-compatible).
* Fixed MLLP ACKs having an empty `MSA-2` when a frame declared a field separator other than `|` or had a short `MSH-2`, so senders could not match the ACK to their message. The ACK now uses the sender's own delimiters.
* Fixed `getComponent(field, 1)` returning `undefined` for a field with no component separator, which made a bare `MSH-9` lose `message_type` and a bare `PID-5` lose `patient_name`; see [/hl7v2](reference/hl7v2.md).
* Fixed units that failed in a step after the store ending at `error` with empty attrs, so facets and filters on attrs such as `message_type` missed them; see [Steps](reference/steps.md).
* Fixed a step's real failure on a unit being replaced by `engine/write_failed` when its attrs could not be stored, for example a value too long for a declared index.
* Fixed approving a ConceptMap in the dashboard removing `sourceVersion`, `targetVersion`, `extension` and `id` from its groups.
* Fixed unmapped codes whose display contains `)` disappearing from the unmapped-codes queue.
* Fixed the workspace poll in `clone` mode watching the wrong branch when the remote also had a branch ending in the same name, such as `feature/main` next to a tracked `main`.
* Fixed edits under `server/` not reloading a `worktree` workspace, which left the API serving the old list of actions; see [The Workspace](ops/workspace.md).
* Fixed two engines on one host overwriting each other's workspace bundle, so one could load another checkout's workspace.
* Fixed a fractional `WEBHOOK_RETENTION_DAYS`, such as `0.4`, making every outbox sweep fail, so delivered webhook events were never removed.
* Fixed webhook egress checks letting through an IPv4 address written in IPv6 form, such as `[::ffff:169.254.169.254]`, which reached addresses they block in IPv4 form.
* Fixed a request path with malformed percent-encoding, such as `/%zz`, answering `500` instead of `404`.
* Fixed an unresolvable workspace URL, such as `file://./workspace`, emptying the dashboard's System health card. The Workspace row now reads misconfigured and gives the reason; see [Operating Pipelines](ops/operating.md).
* Fixed the System health rows showing part of a password that contains `@`.
* Fixed the image's vulnerability attestation listing only fixable CRITICAL and HIGH findings, so an image with an unfixed CRITICAL looked clean. It now lists every finding Trivy reports; see [Supply Chain Security](ops/supply-chain-security.md).

### 2.3.0

_13 November 2026_

**Features**

* **[Local and mounted folders](concepts/reading-files/local-folder.md)**: `fileDropSource` reads a feed from a folder on the engine's own filesystem with `local({ dir })`, such as a network share mounted into the container or a host folder bound into Docker. Interbox reads a file once it stops changing between polls, and `minFileAge` sets how old a file must be before Interbox reads it.

**Bug fixes**

* Fixed `@health-samurai/interbox` failing to install from npm because the package did not include its X12 toolkit.
* Fixed a failed database query logging its parameter values. Interbox now logs only the number of parameters.

### 2.2.1

_13 November 2026_

**Features**

* **X12 support in the SDK**: the `@health-samurai/interbox/x12` subpath reads and writes any X12 transaction set it has an ASC X12 XSD for. `x12Parser()` splits an interchange into one row per transaction set and fails non-conformant input with `parse/not_conformant`. The schemas are not bundled: point `INTERBOX_X12_SCHEMAS` at them. A workspace passes an `X12SetAsideRule` to set aside a sending system's deviations from the schema.
* **X12 278 mappings**: `x12/278` exports `x278RequestFromClaimBundle`, `x278ResponseFromRequest`, `x278DecisionToClaimResponse`, `x278NotificationToClaimBundle` and `x278ToExplanationOfBenefit`.
* **X12 in the dashboard**: a unit whose value starts with an ISA header opens on an X12 view. The view reads delimiters from the ISA and nests segments by HL level. It shows element names and code meanings, and puts the transaction, member and sender in the header. The Units list previews X12 one segment per line.
* **Outbound tab**: the Unit page lists the sender items that carry no FHIR resource, such as an X12 message posted to another system, and shows an X12 body in the X12 view. The body of a sent item is not kept, and the tab says so.

**Improvements**

* C-CDA conversion is no longer part of the Interbox package. `ccdaParser`, `@health-samurai/interbox/ccda`, the C-CDA reference and the C-CDA **Document** and **Raw XML** tabs on the [Unit page](ops/operating.md#the-dashboard) are gone.

**Bug fixes**

* Fixed the **Units** field panel counting `status`, `error_kind` and `error_step` over a sample, so pipelines with many units showed counts that were too low. Interbox now counts these fields over all matching units. For declared attrs, which are still sampled, the panel shows the sample size and the total. See [Units and State](concepts/units-and-state.md).

### 2.2.0

_6 November 2026_

**Upgrade notes**

* Set `retention` on every pipeline that relied on `INTERBOX_DONE_ITEMS_RETENTION_DAYS`, for example `pipeline("adt", { retention: "30d" })`, and deploy that workspace together with the engine. Interbox ignores the variable, and the first sweep after boot purges finished sender items older than 7 days. See [Updating the Engine](ops/updating.md) and [Pipelines](concepts/pipelines.md#the-chain).
* Replace the `--certificate-identity` and `--certificate-oidc-issuer` options with `--key https://storage.googleapis.com/interbox-signing-keys/cosign.pub`, or a pinned `cosign.pub`, in your image checks and admission policies. Health Samurai's CI key now signs release images, `edge` and `main-<sha>` images, and the nightly scan attestations, so a check that accepts only the workflow identity fails on them. Keep the identity check as an alternative for earlier releases, as shown in [Supply Chain Security](ops/supply-chain-security.md#release-images).

**Features**

* **[Reading files from storage](concepts/reading-files/README.md)**: `fileDropSource` from `@health-samurai/interbox/files` reads files that sending systems drop into SFTP, Amazon S3, Google Cloud Storage or Azure Blob Storage, one delivery at a time. Steps such as `unpack()`, `ndjson()`, `csvRows()` and `hl7v2Messages()` split the files into records. The [`/files`](reference/file-drop.md) reference lists every setting.
* **[Storage setup](concepts/reading-files/sftp.md)**: the [SFTP](concepts/reading-files/sftp.md), [Amazon S3](concepts/reading-files/amazon-s3.md), [Google Cloud Storage](concepts/reading-files/google-cloud-storage.md) and [Azure Blob Storage](concepts/reading-files/azure-blob-storage.md) pages cover the access each storage needs and the fields of `sftp()`, `s3()`, `gcs()` and `azure()`.
* **[Sending Files to Interbox](concepts/reading-files/sending-files.md)**: a page for the sending system. It covers folder layout, the `_READY` marker file and its file list, and the naming and upload rules.
* **[Whole deliveries](reference/file-drop.md#read-delivery)**: with `read: "delivery"`, Interbox stores all files of a delivery in Postgres as one unit. A step after the store reads them with `ctx.files.open(file)` or with `csvRows(file)`, `ndjson(file)`, `lines(file)`, `unpack(file)` and `hl7v2Messages(file)`.
* **[Config type of your own source](concepts/pipelines.md#your-own-source)**: `defineSource` takes its config type from the first parameter of `run` or `start`, and its row type from `SourceRunContext<Row>`, so no type arguments are needed.

**Improvements**

* Interbox commits an input or a unit's outputs of more than 1,000 rows or 4 MiB in parts, each in a short transaction, instead of in one long transaction. The units a copy makes are held until its last part lands. [Operating Pipelines](ops/operating.md) and [Errors](concepts/errors.md) describe `copy_pending`, `source_error` and `engine/copy_incomplete`.
* Retry, Defer and deleting waiting items remove at most 10,000 items per request. Retry leaves a unit with items still waiting as `items_left`, and deleting all waiting items answers `more` while items remain ([Deleting waiting items](ops/operating.md#deleting-waiting-items)).
* [Reference lookups](reference/steps.md#reference-lookups-definelookup-and-ctxlookup) in steps before the store run before the input's transaction opens, so a lookup no longer keeps that transaction open or the table locked.

**Bug fixes**

* Fixed 1.x `sftpSource` reading a missing `dir` as an empty directory. Each poll now fails with an error that names the directory. The source also reads a symlink that resolves to a file inside `dir` ([/builtins](reference/builtins.md)).
* Fixed a Postgres connection being left open when fetching a Databricks Lakebase credential failed.
* Fixed the Interbox image carrying Bun's OCI labels instead of its own.
* Fixed development logging losing a line logged as the process exited.

## October 2026

### 2.1.0

_29 October 2026_

**Features**

* **[Databricks Lakebase](ops/lakebase.md)**: Interbox keeps its database on a Databricks Lakebase Autoscaling project and logs in as a service principal with OAuth, fetching and renewing its own database credentials. Set `INTERBOX_DB_AUTH_METHOD` to `databricks-autoscale` along with the `INTERBOX_DB_DATABRICKS_*` variables; the page covers the settings and how to prepare the project.
* **[Connections from workspace code](ops/lakebase.md#workspace-code)**: `postgresConfig()` from `@health-samurai/interbox/postgres` builds a `pg` config that logs in the same way the engine does, for workspace actions and admin scripts. `forgetRefusedCredential()` drops a token Postgres refused.
* **[Your own source](concepts/pipelines.md#your-own-source)**: a 2.0 workspace defines its own source with `defineSource` from `@health-samurai/interbox/chain`, as a push source with `run` or a pull source with `start` and `pollIntervalMs`. Pipelines that used a `defineSource` source no longer need to stay on a 1.x engine; the 2.0 version takes `receive` in place of `writeBatch`.

### 2.0.2

_28 October 2026_

**Upgrade notes**

* Check that Aidbox and its database can take more concurrent load, or set `INTERBOX_AIDBOX_CONCURRENCY=1` to keep the earlier behaviour. Each `aidbox()` sender now splits a send of about 100 resources or more into up to `INTERBOX_AIDBOX_CONCURRENCY` (4 by default) parallel requests, per sender and per worker. A slow answer that times out counts toward `maxRetries`. See [Steps](reference/steps.md).

**Features**

* **[Workspace action results](ops/workspace.md#workspace-actions)**: an action's return value is now available as the `result` of its run, from `GET /api/workspace/actions/runs/<runId>`. `WORKSPACE_ACTION_RESULT_MAX_BYTES` sets the size cap.
* **[What a waiting unit waits for](reference/steps.md)**: a unit held by `notReady` or a thrown `NotReady` records the hold's reason and the attrs its steps set before it. The dashboard shows them.
* **[Rolling back a 1.x import without a restore](ops/upgrade-from-1x.md#running-the-import-again-after-a-rollback)**: the upgrade guide adds a sturdier import Job for Git-only deployments. The Job keeps a copy of the 1.x tables in `interbox_pre2`, so you can roll back inside the database and run the import again. The guide also covers [cleaning up once the cutover is final](ops/upgrade-from-1x.md#once-the-cutover-is-final).

**Improvements**

* The message of an Aidbox refusal lists every error Aidbox or `$validate` reported for the resource, with its path and codes, not only the first. A wait names every missing reference. A resource that has a missing reference and another error as well is rejected instead of waiting. See [Steps, Store and Senders](concepts/stages.md).

**Bug fixes**

* Fixed a retried unit keeping the `_skipped` counts from its earlier run. Retry, from the dashboard or with `retryUnits`, now clears them. See [Errors](concepts/errors.md).
* Fixed the 1.x import mapping and sending again every `processed` message, even one with no pending delivery. This could merge older content over newer in Aidbox. Such messages are now imported as `sent`, and the dry run counts them as `superseded`. See [Upgrading from 1.x](ops/upgrade-from-1x.md).

### 2.0.1

_27 October 2026_

**Upgrade notes**

* Replace every script or integration that calls the 1.x messages, sources and stats routes, such as `GET /api/messages`, `POST /api/messages/retry` or `GET /api/stats/error-kinds`. Use the pipeline and unit routes instead: `GET /api/pipelines/:name/units`, `GET /api/units/:id`, and `POST /api/pipelines/:name/units/retry` or `/defer`. Interbox no longer serves the 1.x routes, so those calls fail. The remaining routes are listed in [Securing Dashboard Access](ops/secure-access.md).

**Improvements**

* **[The dashboard](ops/operating.md#the-dashboard)** always opens on the 2.0 home, and the sidebar always lists **Pipelines** and **Instances**. The 1.x layout and message pages are gone, so the dashboard no longer falls back to the 1.x home when no pipeline has created its tables.
* The dashboard's counts and its `status` and `error_kind` filters are faster on large pipelines. Interbox adds two indexes of its own to every pipeline's units, as described in [Units and State](concepts/units-and-state.md). A pipeline that already holds units gets them in the background once its stages run. Until that build ends, its counts can be slow.
* Senders pick up items whose lease expired faster on a large delivery queue. The migration that builds the index makes the first boot after updating take longer, in proportion to the `sender_item` backlog. See [Updating the Engine](ops/updating.md).

### 2.0.0

_27 October 2026_

**Upgrade notes**

* Rewrite every pipeline in the 2.0 chain DSL from `@health-samurai/interbox/chain`, and export `ChainRegistry` instead of `PipelineRegistry` and `MapperRegistry` from the workspace's `src/index.ts`. A 2.0 engine refuses to load a workspace that still registers a pipeline or a mapper through the root `pipeline()` or `defineMapper`, and names each one. The steps are in [Upgrading from 1.x](ops/upgrade-from-1x.md).
* Replace the webhook events `parse_error`, `map_error`, `mapped`, `send_error` in each `.webhook({ on })` with the unit statuses (`received`, `processed`, `sent`, `skipped`, `error`, `deferred`) or `custom:<name>`, and update receivers for the new payload. Any other event name throws when the pipeline is declared. See [Status events](concepts/webhooks.md#status-events).

**Features**

* **[Chain pipelines](concepts/pipelines.md#the-chain)**: a pipeline is `source → steps → store → steps → sender`. You declare it with `.source()`, `.step()`, `.store(postgresStore({ codec }))` and `.sender()`, and write steps with `defineStep` over a `Batch`. The store keeps each input, and a Retry runs the steps after it again.
* **[Units and State](concepts/units-and-state.md)**: a new page on units, items, statuses and correlation across pipelines. It also covers pipeline state through `defineState` and `ctx.state`, and lookups of other units through `ctx.units`.
* **[Bridges](concepts/pipelines.md#bridges)**: one pipeline hands its items to another with `.sender(intoPipeline("b"))` and `.source(fromPipeline("a"))`. Each item becomes a unit of the second pipeline.
* **[Custom senders](concepts/stages.md#definesender)**: `defineSender` delivers items to any destination. Its `run` answers `"sent"`, `retry()`, `wait()` or `rejected()` for each item.
* **[Admin Scripts](ops/admin-scripts.md)**: `@health-samurai/interbox/admin` lets a workspace script act on a pipeline without SQL against the engine's tables. It reads units and the delivery queue, and changes them with `retryUnits`, `deferUnits`, `deleteUnitItems`, `dropPending` and `forgetDelivered`.
* **[Operating Pipelines](ops/operating.md#the-dashboard)**: the dashboard adds Pipelines, Instances, Units and Unit pages. Its home shows live per-pipeline rates of received, processed and sent units, the error rate, and the inputs refused before the store.
* **[Finished sender items](concepts/units-and-state.md#items-fan-out-after-the-store)**: Interbox keeps a record of every item that leaves the sender queue, and the Unit page's FHIR resources tab lists these records. They are kept for `INTERBOX_DONE_ITEMS_RETENTION_DAYS` days, 7 by default.
* **[Upgrading from 1.x](ops/upgrade-from-1x.md)**: Interbox moves the messages and delivered-resource fingerprints of a 1.x deployment into a 2.0 pipeline.

**Improvements**

* The dashboard shows when no workspace is linked.
* The dashboard uses dompurify 3.4.17, which fixes two sanitizer bypass advisories.
