# Operating Pipelines

What an operator sees and does once pipelines are running: the dashboard's
pages for them, the actions it offers on units, the engine instances behind
it, and the inputs refused before they were stored. For units, statuses and
items themselves, see [Units and State](../concepts/units-and-state.md). For
the same actions from a script, see [Admin Scripts](admin-scripts.md).

## The dashboard

**Dashboard** opens on the home, **Sources** shows the pipelines' sources, and
**Pipelines** and **Instances** are listed in the sidebar. **Reference** is one
entry for the HL7v2 and C-CDA references, with a switch between the two in the
page header. **Code mappings** lists the codes the pipelines' units wait on.
**Units** and **Unit** open from the Pipelines page, the Dashboard and the
Sources page.

A page that refreshes gives up on a read that has no answer within 20 seconds,
or within two of its refresh intervals when that is longer, and shows it as a
read that failed until a later one succeeds.

### Dashboard

The 2.0 home covers every pipeline. Its live rates refresh every second, its
counts every 10 seconds, and its top error kinds every minute:

| part | what it shows |
|---|---|
| Received, Processed, Sent | one tile each: the units per second that were created, moved on from `received`, and reached `sent`, labelled `units/s`, each averaged over the last 5 seconds. Processed also gives the sender items queued per second, and Sent the items delivered per second, labelled `items/s` |
| Error rate | the units at `error` as a percent of all units, of every status, summed over the pipelines that were counted, with a note such as `1 pipeline not counted` saying how many were left out (see below) |
| Throughput | the last 60 seconds, one point a second, in four lines labelled inbound, mapped, sent and errors: the three rates of the tiles, and the units that reached `error` per second |
| Queue depths | the units at `received`, `processed`, `sent` and `error` now, from the same totals, each as a count and a bar that fills at 50,000 |
| Top error kinds · 24h | the most frequent `error_kind`s among the units at `error` created in the last 24 hours, one row per pipeline and kind. A row opens its pipeline's units at `error` of that kind created in those same 24 hours, so the list matches the count. The row of units with no kind opens all the units at `error` instead, as no filter selects a missing kind. **All pipelines** opens the Pipelines page, which gives every pipeline's errors and error kinds side by side |
| System health | Postgres, Aidbox, the engine, naming any stage that is not running or crashed in the last 5 minutes, code mapping coverage, and the workspace |

Each tile also draws its last 60 seconds and gives the change from the first
half of that minute to the second. On Error rate both are of the units that
reached `error` per second, not of the percent.

- **The rates count units as the engine moves them.** Each stage of a pipeline
  counts a unit once the transaction that moved it commits, and the counts of
  every engine instance are summed:
  - **Received**: the units ingest created, at `received` or `skipped`, and the
    units a bridge created in the pipeline it feeds;
  - **Processed**: the units whose steps closed them out of `received`, to
    `processed`, `skipped` or `sent`, or on through a bridge. A unit that fails
    counts as an error instead. Its `items/s` is the sender items those units
    queued;
  - **Sent**: the units that reached `sent`, whether the sender closed them,
    they had nothing to send, or a bridge passed them on. Its `items/s` is the
    items the sender delivered;
  - **errors**, the chart's fourth line and Error rate's sparkline: the units
    that reached `error`, from a step or from the sender. A unit counts once
    however many of its items were rejected.

  Nothing is counted for a `notReady()`, an item answered `wait`, or a failure
  that is retried, until the retries run out and the unit reaches `error`. Nor
  are an operator's Retry, Defer and item deletion: the API makes those moves,
  and only the engine counts.
- **The rates keep no history.** Each engine holds the last few minutes of its
  counts in memory and writes them every second. Anything that restarts the
  pipeline workers — an engine restart, a reload after a new commit, or a worker
  restarted after a crash — starts them from zero, and the chart fills again over
  its minute. When the rates cannot be read, the three rate tiles read `—` and
  say `live rates unavailable`, and the chart and the sparklines stay empty until
  the rates can be read again.
- **Error rate and the queue depths count every unit, so they cost a full
  count.** Each pipeline's units are counted in full at most once every 15
  seconds, so a total can be that old when it is shown. A pipeline's count is
  given up after 2 seconds and then not tried again for a minute, and all the
  counts together are given up after half the request's time budget,
  `INTERBOX_API_READ_TIMEOUT_MS`. The rest of the page still loads. Both then
  add up the pipelines that were counted and say how many were not, such as
  `1 pipeline not counted`, and read `—` only when none was.
- **Each pipeline counts its own units.** An input a bridge passes on becomes a
  unit in each pipeline it reaches, so the rates, the error rate and the queue
  depths count it once per pipeline.
- **When Postgres cannot be reached**, System health reads Postgres and the
  engine down and the mapping coverage unknown.

### Pipelines

One row per pipeline. Its run status and its graph refresh every 5 seconds, the
other columns every 10 seconds:

| column | what it shows |
|---|---|
| pipeline | its run status, `running`, `degraded` or `stopped`, then its name |
| last 5 min | a graph of the units received per second over the last 5 minutes, with the units that reached `error` per second drawn over it in the error colour, and the received rate now beside it, such as `2.0/s`. Hovering the graph gives the run status and both rates now |
| created in last 24 h, by status | the units created in the last 24 hours, counted by the status each is at now |
| queued | units resting at the store, waiting to be taken or being worked on |
| errors, all time | units at `error` now, of any age; it exceeds the `error` count in the 24-hour column when errors older than 24 hours are still waiting for a retry or a defer |
| sender items | items waiting in the sender queue |
| error kinds, last 24 h | the most frequent `error_kind` among the units at `error` created in the last 24 hours, with its count and how many other kinds there are; hovering the cell lists the kinds with their counts, up to 50 |
| refused at ingest | inputs refused before the store, with the last reason and its time — see [Refused inputs](#refused-inputs) |

- **The run status comes from the engine instances' heartbeats.** A pipeline
  runs as up to three stages, `chain-source:`, `chain-segment:` and
  `chain-sender:` followed by its name. A pipeline fed by another through a
  bridge has no source stage, and one that bridges on into another has no sender
  stage. Only fresh, licensed instances count — see
  [Engine instances](#engine-instances):
  - `running`: every instance that runs any of the pipeline's stages runs all of
    them, each `running`;
  - `degraded`: an instance has one of its stages `starting`, in `backoff` or
    `exited`, or runs some of its stages but not all;
  - `stopped`: no instance runs any of its stages, because the engine is
    stopped, parked after a failed load, or not licensed.
- **The graph comes from the engine's live counters**, the ones behind the
  Dashboard's rates, drawn as one point per 5 seconds. A pipeline fed by a
  bridge counts as received the units the bridge created in it. Like the
  Dashboard's rates, the graph keeps no history: anything that restarts the
  pipeline workers — an engine restart, a reload after a new commit, or a worker
  restarted after a crash — starts them from zero, and the graph fills again over
  its 5 minutes.
- **When the live status cannot be read**, the row shows no status and its graph
  reads `—` until it can be read again, rather than the last one drawn.

**Units** opens the pipeline's units. **Sender** opens its sender backlog under
the table, refreshed every 5 seconds:

| field | what it counts |
|---|---|
| Items | every item in the queue |
| not tried yet | items no send has tried |
| waiting | items whose last try answered `wait`, which counts no error, such as a reference not yet at the destination |
| retrying | items whose last try was an error, which counts toward the sender's retry limit |
| Oldest waiting since | when the oldest waiting item was queued |
| Next try at | the earliest next try still to come |

Below them the items are grouped by outcome and kind, such as
`wait · sender/reference_missing`, so you can see what a backlog waits for.

### Units

The units of one pipeline, newest first, 50 at a time. The newest page refreshes
every 4 seconds; loading older pages with **Load more** pauses that until you go
**Back to live**. When a refresh fails, the list keeps the rows it last read and
says what time they are from and why the refresh failed, and the field counts
do the same, until a refresh succeeds.

- **The field list** counts the units by `status`, `error_kind`, `error_step`
  and each attr the store declares in `index`. Click a value to filter by it,
  and negate a filter to exclude it. The counts come from the newest 10,000
  matching units, and say so when they reach that.
- **Search** appears when the store declares `search: "trgm"`. It finds units
  whose search text contains every word typed; each word needs at least three
  letters or digits.
- **The time window** bounds the units by when they were created.
- **The filters, the search, the time window, the bounds of a `created_at` or
  `order_at` chip and the similar-error filter are kept in the page's
  address**, so opening that address again opens the list the same way. A chip
  read back from the address is labelled with its bounds. A link from the
  Dashboard's top error kinds sets the
  `created_at` bounds to the 24 hours its count covers, with the time window at
  All.
- **Click a row** to expand it in place:
  - its error, if it has one. An error that carries a FHIR `OperationOutcome`
    shows its diagnostics under the request that failed, with the whole message
    one click away;
  - its fields as chips. Click `status`, `error_kind`, `error_step` or a declared
    attr to filter by its value. The `created_at` and `order_at` chips filter to
    within 1, 5 or 30 minutes of the unit's own time, or to before or after it;
  - the first 20 lines of its value, loaded when the row opens. JSON is shown
    indented, and a value over 1 MiB or stored as bytes is shown by its size.
    When the store declares a search index, clicking a token of an HL7v2 value
    adds it to the search, or takes it out again, and so does selecting text
    in it;
  - **Code mapping** on a unit that failed on an unmapped observation code, as
    on the Unit page.
- **Similar errors.** The `~ error_message` chip of an expanded unit at
  `error` keeps the units at `error` whose message is at least 50% similar to
  it, as trigram similarity rates it over the first 512 characters of each
  message. It applies together with every other filter. It looks only among the
  newest 5,000 units at `error` in the time range, and when there are more, the
  list says that older matches are not listed.
- **The row menu** offers **Retry** and **Defer** when the unit can take them,
  **Open details**, **Filter to this patient** when the store declares
  `patient_id` in `index`, **Filter to this sender** when it declares
  `sending_facility`, and **Copy unit id**.
- **Selecting.** Click a row's checkbox to select it. Shift-click another to
  select every row between the two, or drag over the checkboxes to select, or
  unselect, every row you pass.
- **Retry** and **Defer** act on the selected units. Each appears when at least
  one selected unit can take it. The rows that moved flash, and the result says
  how many units moved and lists those left unchanged by reason (see
  [Operator actions](#operator-actions)).
- **Ask assistant** appears beside Retry and Defer while the assistant is closed.
  The selected units go to the assistant as their id, pipeline, status,
  `error_kind` and `message_type` attr, never their value or error message.
- **Columns** chooses which columns show. **Views** offers All, Errors and
  Deferred, and **Save** keeps the current filters, search, time chips and
  similar-error filter as a view of your own. Both are kept per pipeline, in
  your browser only.

### Unit

One unit, opened from the Units page or by id, in one inspector: a top bar,
the unit's error under it, and tabs.

The top bar names the unit, such as `Unit #1042`, then gives its status and
type, its patient, MRN, sender and creation time, each when it is known, and
its actions. Its back and close buttons return to the pipeline's Units page:
to the list the unit was opened from, with its filters, search, time window,
time chips and similar-error filter, or to the whole list for a unit opened any
other way.

- **Type** is an HL7v2 message's MSH-9 type and trigger event, such as
  `ADT^A01`. Any other unit, and an HL7v2 message with an empty MSH-9, takes
  its `message_type` attr, joined to its `event_type` attr with `^` when it has
  one.
- **Patient** is PID-5's given and family name, and **sender** the first
  component of MSH-4, both read from an HL7v2 value's text. **MRN** is the
  first component of PID-3, or else the `patient_id` attr.
- **Code mapping** appears on a unit that failed on an unmapped observation
  code, and opens that code's concept map on the
  [Code mappings](#code-mappings) page at that code.
- **Reprocess** runs Retry and **Defer** runs Defer (see
  [Operator actions](#operator-actions)), each when the unit's status allows it.

**Ask assistant**, in the page header, opens the assistant with this unit as
its context, shared as on the Units page. **Refresh** reads the unit again.

A unit that holds an error shows it in a strip under the top bar: at `error`,
and at `deferred`, which keeps the error it was deferred at. It names the
`error_kind` and `error_step`, and gives the message. The result of Reprocess,
Defer or an item deletion appears in the same strip.

- **An Aidbox rejection** is shown as its status line and the diagnostics of
  its issues, each once. **raw response** opens the whole message as stored.
- **An unmapped observation code** (`code/unmapped_observation_code`) names the
  code, its display and system, and the concept map.
- **Any other error** is shown as its message.

The tabs, in this order:

| tab | what it shows |
|---|---|
| the value's own | for an HL7v2 message, **Raw HL7v2** and **Parsed**; for a C-CDA document, **Document** and **Raw XML**; for JSON, **Message**. Any other value gets **Raw** — see below |
| FHIR resources | the FHIR resources the unit's sender items carry, a `resourceType` in their payload, both the items still waiting and the finished ones: the resources grouped by type in item order, from the first 500 waiting and the first 500 finished items by id. Each says it is waiting to be sent, or how it finished and when. Pick one for its summary and, where its body is kept, its JSON; a payload over 1 MiB gives no JSON. The tab is locked while there are none, and says why |
| Details | the cards below: the unit's fields, its queue state, its sender items and its lineage |

The value's own tabs follow what it holds. A value over 1 MiB gets **Raw**,
whatever it holds.

- **An HL7v2 message**, text that starts `MSH|`. **Raw HL7v2** shows its
  segments, each field with its spec, its table's meaning and the spec
  warnings; **Parsed** shows the parsed value with its TypeScript accessor.
- **A C-CDA document**, XML whose root element is `ClinicalDocument`.
  **Document** shows its document tree, parsed on read; **Raw XML** the text.
- **JSON**, a `json` value or text holding a JSON object or array. **Message**
  shows it pretty-printed.
- **Anything else** gets **Raw**: the stored value, a `bytes` value as the
  start of its base64, and a value over 1 MiB as its size only.

**The FHIR resources are read from the unit's sender items, the waiting ones
and a record of the finished ones.** A waiting item shows its JSON. Once the
sender is done with an item, the record of it shows how it finished:

- **sent**: a summary, its type, id and when it was sent, and no JSON, as the
  body of a sent resource is not kept. **Open it in Aidbox** links to the
  resource in Aidbox, when its id or its key names it and Aidbox's address is
  one your browser can reach.
- **rejected**: its JSON as it was, and the reason as an error, its kind and
  message. An item is rejected by the sender, and this is the only finished
  item whose body is kept.
- **dropped**: a summary and no JSON, and the reason as an error, its kind and
  message. An item is dropped when its unit was rejected or deferred before it
  was sent. Its body is not kept: the unit's stored value still holds the input
  it came from, and Reprocess sends the unit again.
- **deleted**: a summary and no JSON, and a plain note, not an error, that an
  operator action deleted it — deleting waiting items, Reprocess or Defer —
  with the reason recorded, if any.

An item listed as waiting that has finished by the time you pick it is shown
as finished.

Finished items are kept for `INTERBOX_DONE_ITEMS_RETENTION_DAYS` days, 7 by
default, and then purged. It takes from one hour, `0.042`, to `36500` days, and
`0` keeps them for good. A unit at `sent` or `error`
with no item left says that no record of its resources is kept any more: they
were purged after the retention period, or it never had any. When the items
cannot be read the tab says so, and when the inspector itself cannot load it
asks you to reload the page.

The cards of the Details tab:

| card | what it shows |
|---|---|
| Unit | pipeline, created, order at, updated, error step and kind, origin unit, correlation, and every attr |
| Queue | while the unit rests at the store, its failed attempts and when it may be taken next; otherwise "Not in the queue" |
| Sender items | the first 100 of the unit's waiting items and their total, each with its key, `order_at`, tries, next try, the older version of its key it waits behind, and its last error. Open an item for its payload and meta; one that has finished since the list was read shows how and when it finished, its reason, and its payload where it is kept |
| Lineage | the units that share this unit's correlation id, across pipelines: the first 50 by id, and the total |

On a unit at `processed`, the Sender items card offers **Delete selected** and
**Delete all waiting items**.

### Sources

A tree of the pipelines' sources, in the order of the Pipelines page, each
followed by its senders, refreshed every 10 seconds. A source's row shows its
kind — `mllp` or `webhook` for a pipeline that listens, `bridge` for one fed by
`fromPipeline()` — its address or upstream, how many senders its breakdown lists
(see below), and its health:

| health | when |
|---|---|
| up | a fresh instance runs its source stage, or reports a bridge, which has no source stage of its own |
| down | fresh instances report it, but none of them runs it: each is `starting`, `backoff` or `exited` |
| unreported | no fresh instance reports it |

Collapse a source to hide its senders. Selecting a source, or one of its
senders, opens the source's detail. With a sender selected, its Status mix and
Volume are that sender's own:

| part | what it shows |
|---|---|
| Kind | `mllp`, `webhook` or `bridge` |
| Format | `HL7v2` for an MLLP source, MLLP being HL7v2's framing, or for one whose store declares the `message_type` and `event_type` attrs `hl7v2Parser()` sets; otherwise `—` |
| Listens on / Fed from | the host and port the source listens on, or the pipeline a bridge is fed from |
| Instances | each fresh instance that runs the source, with the state of its source stage (`starting`, `running`, `backoff`, `exited`). A bridge's instances carry no state |
| Refused at ingest | the same line as on the Pipelines page — see [Refused inputs](#refused-inputs) |
| Status mix | the units created in the last 24 hours, counted by the status each is at now, and each status's share of them |
| Volume | of those units: the total, those created in the last minute and the last hour, and those at `error`. **Last received** is when the pipeline's newest unit was created, however old |
| Senders | the sender breakdown, below |

The address is the source's configuration with its `env()` values resolved. A
webhook source takes no host and listens on every interface, shown as `[::]`.
No secret is shown. **Units** opens the pipeline's units.

**The sender breakdown** appears for a pipeline whose store declares a `btree`
index on `sending_facility` in `index`; without one there is none. It lists the
50 senders with the most units created in the last 24 hours, busiest first,
and says so when there are more; the sender count in the page header then
reads "top". Each sender has the same counts as the source, and is `active`
with a unit in the last minute, `recent` with one in the last hour, and `idle`
otherwise. Units with no `sending_facility` count under **(not set)**.
**Units** on a sender opens the pipeline's units filtered to that sender.

A source's volume or sender breakdown that cannot be counted in time is shown as
not counted, never as zero: its figures read `—` and say `not counted in time`,
its tree row reads `— snd`, and the page header says some senders were not
counted. When the indexes a pipeline's store declares cannot be read in time
either, its breakdown is shown as not counted too, whether or not it declares
one on `sending_facility`.

Until the volume has loaded, and while its latest read is failing, the detail
shows it the same way rather than as zero or as the last figures read: the
Status mix and the Volume read `—`, and Senders says the breakdown has not
loaded. A failed read also says `not read: the latest read failed`, and the
page header says `volume unavailable`.

**Simulate ingest** sends messages to an MLLP source the way a sender would, and
shows the ACK each one got. Paste them, or add or drop files; a line starting
`MSH|` starts a new message, and blank lines are dropped. Up to 100 messages and
4 MiB in all go in one request. They are framed one at a time over one
connection, each waiting up to 10 seconds for its ACK. A message answered `AE`
or `AR` shows the ACK's text. When the connection fails or an ACK does not come,
that message shows the reason and the messages after it are not sent.

The connection is made from the API to the address the source's instance
reports, never to one given in the request, and only ever over the loopback,
so the API must run on the same host as the engine:

| the source is bound to | the API connects to |
|---|---|
| a wildcard address: `0.0.0.0`, `::` (also written `::0` or in full), or an empty host | `127.0.0.1` |
| a loopback address: anything in `127.0.0.0/8`, or `::1` | that address, as written |
| `localhost` | the first loopback address the name resolves to on the API's host; if it resolves to none, nothing, and the request answers `400` |
| anything else, such as a network address or another host name | nothing: the request answers `400` |

A port outside 1 to 65535, `0` included, also answers `400`, and so does a
webhook or bridge source: a webhook's secret never leaves the engine, and a
bridge listens on nothing. A source whose instance does not report it
`running` answers `409`; try again once it runs. A refused request sends
nothing.

Who may simulate follows the login. With it on, that is a signed-in dashboard
session. With `INTERBOX_AUTH_ENABLED=false` it is anyone who can reach the
dashboard, within the Host allowlist and cross-site rules that stay on — see
[Turning it off](secure-access.md#turning-it-off). A service token cannot
simulate either way. Each API process runs at most four simulations at once,
each ending within about a minute of starting; another answers `429` until one
ends.

The messages are ingested like any other, so they become real units. Each
simulation request that gets past the login and the cross-site checks writes
an audit line to the API's log, whether it was answered, refused, aborted or
failed. It records the session's short reference (none with the login off),
the route, the client's `agent` and `forwardedFor` when it sends them, and
under `simulation` the pipeline, how many messages and bytes, the outcome, the
HTTP status (`499` when the client went away) and how many messages were
answered `AA`, `AE`, `AR` or not at all. A refused or failed request adds its
reason. The line never holds a message or an ACK's text:

```json
{"at":"2026-10-01T12:00:00.000Z","audit":"source-simulated",
 "route":"POST /api/pipelines/adt-feed/source/test","session":"3f9a1c2e",
 "simulation":{"pipeline":"adt-feed","outcome":"exchanged","status":200,
  "messages":3,"bytes":1536,"acks":{"AA":2,"AE":1,"AR":0,"none":0}}}
```

### Instances

One row per engine instance seen in the last hour, fresh ones first, refreshed
every 5 seconds: its id, whether it is fresh or stale, its version, whether it
is licensed, when it was last seen and started, its stages by state
(`starting`, `running`, `backoff`, `exited`), the inputs it refused, and its
reload error. See [Engine instances](#engine-instances) below for what these mean.

### Code mappings

The concept maps under `src/terminology/concept-maps/` in the workspace, and
the codes the pipelines' units wait on, refreshed every 4 seconds. A unit waits
on a code when a step failed it with `domainError("code",
"unmapped_observation_code", …)` and a message laid out as

```
unmapped code "<code>" (<display>) · system <system> · map <concept map id>
```

where `(<display>)` may be left out and `(none)` stands for no system, such as
`unmapped code "NA" (SODIUM) · system (none) · map hl7v2-lab-hosp-observation-code-loinc`.

- **The queue** lists each code once per concept map, with its display and
  how many units wait on it: the units at `error` of that kind whose message
  names it, from every pipeline, counted together. A code the map already holds
  is not listed, nor is a message laid out any other way, nor a unit at
  `deferred`. `GET /api/unmapped-codes` answers the same list, and adds when
  the first of those units was created and, as `pipeline:<name>` origins, how
  many wait in each pipeline.
- **Each pipeline is read within 2 seconds**, and all of them within the
  request's budget, `INTERBOX_API_READ_TIMEOUT_MS`. A pipeline whose units take
  longer, or that is reached once the budget is spent, is left out of that
  refresh, and the others are still listed.
- **A sender is named only by the map.** The page labels a concept map with its
  title, or else with the part of its id between `hl7v2-` and the mapping type,
  so `hl7v2-lab-hosp-observation-code-loinc` reads *Lab Hosp*. The step builds
  that id from the sending application and facility, and the page shows neither
  on its own.
- **A map no file holds yet** reads *no file yet* where the others show how
  many codes they map. It is listed only because units wait on its codes, and
  approving one of them creates its file.
- **Approve** writes the code's target into the concept map's file, and
  creates the file when the map has none yet, with no `useContext`: a step
  finds the map by its id. It then retries, in every pipeline, every unit at
  `error` whose message names that map and that code, as
  [Retry](#retry-and-defer) does and in runs of 1000, and says how many it
  re-queued. Each run takes only the units still at `error` on that code when
  it starts, so a unit another retry has moved on is not sent again. Nothing
  has to be reloaded first: a step's `ctx.translate` that misses reads the map
  files again when they changed, so a retried unit finds the new mapping.
- **When Approve fails after writing the mapping**, for example when the units
  cannot be read within the budget, the mapping stays written and the code
  leaves the queue, but units not yet retried stay at `error`. Find them on the
  pipeline's Units page by `error_kind` `code/unmapped_observation_code` and
  retry them there.
- **Approve needs a `worktree` workspace**, the directory the engine bundles in
  place. A `clone` workspace is reset by the engine on its next reload, so
  Approve refuses it with `409`: add the element to the concept map in the
  workspace repository and push it instead, then retry the units once the
  engine has reloaded.

## Operator actions

Three actions change units: **Retry**, **Defer**, and **deleting waiting items**.
Each runs in one short transaction and answers at once.

### Retry and Defer

| action | takes a unit at | the unit becomes |
|---|---|---|
| Retry | `error`, `deferred` or `sent` | `received`, with its error cleared, and a fresh place at the store: no attempts counted, due at once |
| Defer | `error` | `deferred`, keeping its error. Nothing happens to it until it is retried |

A Retry runs every step after the store again, with the workspace's current
code. The Aidbox sender does not send again a resource it already delivered
unchanged, so retrying a unit that partly reached Aidbox sends only what is
missing or changed.

- **Up to 1000 units per request.** The dashboard sends a larger selection in
  parts of 1000.
- **Leftover items are cleared first.** A unit the sender rejected may still
  have items that another send held at that moment. Both actions delete those
  before they change the unit. An item a send still holds stays, and the unit is
  left unchanged as `item_in_flight`.

Each answers the units it moved, and the units it left unchanged with a reason:

| reason | means |
|---|---|
| `status` | the unit is at a status this action does not take; the answer names it |
| `busy` | another transaction holds the unit, or its place at the store: the engine is working on it, or another action is. Try again |
| `item_in_flight` | a send holds one of the unit's items. Try again once it settles |
| `not_found` | no unit with that id in this pipeline |

### Deleting waiting items

A unit at `processed` stays there until its last item is delivered. An item that
waits counts no error and has no limit, so a unit whose resource waits for a
reference that will never arrive stays `processed` until someone acts. Deleting
its waiting items closes it.

- **Only a unit at `processed`.** Any other status is refused with
  `unit is not processed` and the unit's status.
- **All, or the ones you name**, up to 1000 item ids.
- **Items a send holds right now are `kept`.** A named item already gone,
  delivered or deleted meanwhile, is `missing`. The rest are deleted.
- **When no item is left, the unit becomes `sent`.**
- A named item of another unit refuses the request, and so does a unit another
  transaction holds (`busy`).

The answer lists the items `deleted`, `kept` and `missing`, and the unit's
status after it.

### They never wait on the engine

The actions do not wait for a lock. A unit the engine is working on is in work,
and an operator does not change it underneath; waiting could also deadlock
against the engine, and would spend the request's time. So a unit another
transaction holds is answered `busy` at once, and the action can simply be
repeated.

Every statement of an action, and of the reads behind the Dashboard's totals and
error kinds and the Pipelines, Units and Unit pages, runs within one time budget
for the whole request,
`INTERBOX_API_READ_TIMEOUT_MS`. A request that spends it answers `504`, and
changes nothing.

A unit an action moves enters a new status, so a pipeline that subscribes to
`received`, `deferred` or `sent` gets that event, delivered by the engine shortly
after the action — see [Webhooks](../concepts/webhooks.md).

Retry and Defer are also open to the dashboard assistant's grant; deleting items
is not — see
[Securing Dashboard Access](secure-access.md#what-reaches-the-api-without-a-browser).

## Engine instances

Every engine instance writes a heartbeat row of its own every 2 seconds, keyed
by its id: `INTERBOX_INSTANCE_ID`, or the host name when that is unset. The row
carries its version, license state, CPU and memory, the state of each of its
stages, its pipelines' sources, the inputs it refused, and its reload error.

- **Fresh or stale.** An instance seen within the last 6 seconds is fresh. A
  stale one has stopped, crashed, or cannot reach the database. Rows not seen
  for an hour are deleted, so an instance that is gone for good, such as one
  that restarted under a new host name, drops off within the hour.
- **One id, one instance.** Two live engines with the same id write one row, and
  the dashboard shows them as one. When an instance finds its row written by
  another live process, it logs one error naming the duplicate
  `INTERBOX_INSTANCE_ID`. Give each engine its own.
- **Reload error.** The instance's current workspace load failure:
  `{ at, ref, message }`, with credentials in URLs removed. It is set when the
  workspace fails to load, at boot or on a hot reload, and cleared when a load
  succeeds. A failed hot reload leaves the previous workspace running. A failed
  boot leaves the engine parked: the dashboard stays up, no stage runs, and the
  instance keeps beating with no stages. Either way the engine loads the
  workspace again when a new commit arrives, on **Sync now**, or on `SIGHUP` —
  see [The Workspace](workspace.md).

## Refused inputs

An input refused before the store left nothing behind: no unit, no stored value.
The sending side was told, and retries on its own. Each refusal is counted, so
a feed whose every input is refused can be told apart from one that went quiet.

| code | the input | the sending side gets |
|---|---|---|
| `too_large` | was an MLLP frame or a request body over the source's `maxBytes` | MLLP: the connection is dropped. HTTP: `413` |
| `store_misfit` | produced a row the store's codec cannot hold | MLLP `AE`, HTTP `500` |
| `step_error` | made a step before the store throw, or answer `notReady` | MLLP `AE`, HTTP `500` |
| `not_ready` | made a step before the store read a reference table that is not ready, or throw `NotReady` | MLLP `AE`, HTTP `500` |
| `timeout` | passed its deadline, in a step or in a statement | MLLP `AE`, HTTP `500` |
| `db_error` | was refused by Postgres, or Postgres could not be reached | MLLP `AE`, HTTP `500` |

- **Per pipeline, per instance, since its source started.** Each instance keeps
  its counts in memory and writes them with its heartbeat. A restart starts from
  zero, and the refusals of the last seconds before a crash are lost.
- **The Pipelines page sums the fresh instances**, with the reason and time of
  the latest refusal. The Instances page shows each instance's total.
- **Only the code is counted.** The refusal itself, with its message, is in the
  engine's log, naming the pipeline.
- **Not counted:** an input abandoned before its commit by a stop or by an HTTP
  client that disconnected, and a request refused for its method or its secret.

## Environment

2.0 adds these variables:

| variable | default | what it sets |
|---|---|---|
| `INTERBOX_DONE_ITEMS_RETENTION_DAYS` | `7` | how many days the record of finished sender items is kept, see [Unit](#unit). Unset or blank uses the default. A plain decimal number of days from one hour, `0.042`, to `36500` is taken as given, a fraction included. `0` keeps the record forever and logs a warning saying so. Any other value, such as one under an hour or over `36500`, a negative one, an exponent like `1e3`, a hex number or text, uses the default and logs a warning |
| `INTERBOX_API_READ_TIMEOUT_MS` | `10000` | the time budget, in milliseconds, of one request behind the Dashboard's totals and error kinds and the Pipelines, Units and Unit pages, and of one action. Past it the request answers `504`. A value that is not a whole number above zero uses the default. The dashboard waits 20 seconds for most of these reads, so above that a slow read shows there as failed rather than as `504` |
| `INTERBOX_INSTANCE_ID` | the host name | the instance's id on the Instances page. Give each engine its own |
| `INTERBOX_STOP_GRACE_MS` | see [Updating the Engine](updating.md) | how long a stop lets started work finish; [The Workspace](workspace.md) covers it during a hot reload |
