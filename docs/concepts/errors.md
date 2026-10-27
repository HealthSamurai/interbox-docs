# Errors

A failure is recorded on the unit that failed. Before the store there is no
unit yet, so a failure there is refused back to the sending side instead, and
counted. This page covers both, and what Retry and Defer do about the first.

## A failed unit

A unit that fails ends at `status = error`, with three fields beside it:

| field | what it holds |
|---|---|
| `error_step` | where it failed: the name of the step, `sender` when the sender rejected one of its items, `store` when its stored value could not be read, or `engine` when no step is to blame |
| `error_kind` | why, as `<group>/<specific>`, such as `parse/not_hl7` or `sender/aidbox_rejected` |
| `error_message` | the human-readable detail; for a sender rejection, prefixed with the resource's key, such as `Patient/123: …` |

The dashboard groups failures by step and by kind, `ctx.units.find` returns
them as `errorStep`, `errorKind` and `errorMessage`, and the `error` webhook
event carries them. A step's name is the one it was given with `defineStep`, or
its function's name, or its position, such as `#3` — see
[Pipelines](pipelines.md#steps).

## How a step fails a unit

After the store, what a step throws is classified:

- **A `domainError` is permanent.** The unit ends at `error` at once, with the
  error's kind.
- **A system's error follows its kind.** A call through a `defineSystem` handle
  that fails with `system/…_unreachable` — no answer, a timeout, a 5xx — is
  transient, as below. One that fails with `system/…_rejected`, or another of
  its variants, is permanent, as a `domainError` is. See
  [Systems](systems.md#errors).
- **Any other throw is transient.** The unit stays at the store and is tried
  again later, from the first step after the store: 4 seconds after the first
  failure, then 8, 16 and 32. A unit that fails a fifth time ends at `error`
  with `engine/attempts_exhausted` and the last error's message, after that
  error's kind when it had one: `system/aidbox_unreachable: …`.

A throw fails only the unit of the row it was thrown for. A throw from the step
function itself, outside the `Batch` methods, fails every unit of the take.

```ts
import { domainError } from "@health-samurai/interbox";

throw domainError("unsupported", "message_type", "no mapping for ORU^R01 with this OBX pattern");
```

```ts
function domainError(group: ErrorGroup, kind: string, message: string): Error;
```

The result is an `Error` whose `name` is `"InterboxException"` and whose
`kind` is `"<group>/<kind>"` — here `unsupported/message_type`. The engine
recognises it by that `name`, not with `instanceof`, because your bundle and
the engine may load different copies of the SDK.

Throw a `domainError` for anything the step can anticipate: a message that will
fail the same way however often it is retried. A plain `throw` spends five
attempts and about a minute before the unit fails, and then says only
`engine/attempts_exhausted`.

### Groups

`domainError` takes its group from `ERROR_GROUPS`:

```ts
const ERROR_GROUPS = [
  "parse",
  "structure",
  "field",
  "type",
  "code",
  "unsupported",
  "source",
  "mapper",
  "system",
  "sender",
  "internal",
] as const;

type ErrorGroup = (typeof ERROR_GROUPS)[number];
```

The engine does not interpret the group: it stores the whole kind. The groups
are a shared vocabulary, so that failures facet by cause family across
pipelines.

| group | meaning |
|---|---|
| `parse` | the input is not the format at all: not HL7, no MSH header |
| `structure` | message shape: a required segment absent or unusable |
| `field` | segment present, but a required field is empty or unusable |
| `type` | field present, but its value violates its declared datatype |
| `code` | a coded value outside its value set, or with no concept mapping |
| `unsupported` | a valid message the pipeline has no mapping for |
| `source` | kept from 1.x, where a parser that threw was blamed with it; the SDK's steps do not use it |
| `mapper` | the mapping produced something it must not, such as a resource with no `resourceType` or `id` |
| `system` | a read a step made against an external system failed — the message is fine |
| `sender` | a write to the destination failed — the message is fine |
| `internal` | an invariant broke — a bug, not bad data |

`system` and `sender` name the direction rather than a fault in the data. A
workspace that reads Aidbox from a step and writes Aidbox through the sender
can see `system/aidbox_rejected` and `sender/aidbox_rejected`: the same words
for opposite directions, which only the group tells apart. An Aidbox that is
down shows differently on each side. The sender ends its units at
`sender/aidbox_unreachable` once its tries are spent. The step's units are tried
again and end at `engine/attempts_exhausted`, with a message that begins
`system/aidbox_unreachable: `.

The SDK's own steps raise these kinds:

| step | kind | when |
|---|---|---|
| `hl7v2Parser()` | `parse/not_hl7` | the text has no HL7 segment line at all |
| | `parse/missing_msh` | it has segment lines, but does not parse as a message, typically for want of a usable MSH |
| `fromMsh7()` | `field/missing_msh7`, `field/malformed_msh7` | MSH-7 is empty, or not an HL7 date and time from 1900 to 2200 |
| | `field/unknown_time_zone` | the time zone given is not an IANA zone |
| `fhirItems()` | `mapper/exception` | a resource has no `resourceType` or `id`, or a key Postgres text cannot hold |

### The engine's own kinds

Some failures come from the engine, not from your code. Their kinds start with
`engine/`:

| kind | `error_step` | when |
|---|---|---|
| `engine/attempts_exhausted` | the step | a transient failure happened a fifth time |
| `engine/step_timeout` | the step running, or `engine` | the take's steps passed their 60-second deadline, or the unit's lease kept running out because its worker died, a fifth time |
| `engine/codec_mismatch` | `store`, or the last step | the stored value is in another codec's column, after a codec change; or an item does not fit the store of the pipeline a bridge hands it to |
| `engine/store_missing` | `store` | the unit has no stored value |
| `engine/item_unserializable` | the last step | an item or its meta cannot be stored as JSON |
| `engine/write_failed` | `engine` | Postgres refused to write the unit's result |

### Failures at the sender

The sender fails a unit when it rejects one of the unit's items, or when an
item has used up its tries: `error_step` is `sender`, and the kind is the
rejection's or the last try's, such as `sender/aidbox_rejected` or
`sender/aidbox_unreachable`. An item that waits — for a reference, say — never
fails its unit. See [Sender outcomes](stages.md#sender-outcomes).

## Retry and Defer

An operator acts on failed units from the dashboard, or from a script through
`retryUnits` and `deferUnits` in the [admin library](../ops/admin-scripts.md).

**Retry** takes a unit at `error`, `deferred` or `sent` back to the store: its
status returns to `received`, its error fields are cleared, its attempt count
starts over, and every step after the store runs again on the stored value,
with the code and concept maps the workspace has now. For Aidbox, the resources
already delivered and unchanged are not sent again. Retry is how a failure is
re-run after a fix, and how a delivered unit is sent once more.

**Defer** takes a unit at `error` to `deferred`, and keeps its error fields.
It sets aside a failure that will not be fixed, so it no longer counts among
the errors to look at. A deferred unit can still be retried.

Neither touches a unit the engine is working on:

- a unit in another status is left unchanged, reported with its `status`;
- a unit another transaction holds at that moment is `busy`;
- a unit with an item still being sent is `item_in_flight`;
- an id that is not a unit of that pipeline is `not_found`.

Run the action again once the engine has moved on. A `skipped` unit cannot be
retried.

Each action is a status change, and emits its webhook event: `received` for a
Retry, `deferred` for a Defer — see [Webhooks](webhooks.md#operator-actions).
The dashboard side of both is in [Operating Pipelines](../ops/operating.md).

## Refusals before the store

A failure before the store leaves no unit and stores nothing. The input is
refused, and the sending side is expected to send it again:

- MLLP answers `AE`, with the reason;
- the webhook source answers `500`, with the reason in the body, or `413` for a
  body over its `maxBytes`;
- an MLLP frame over `maxBytes` closes the connection.

A permanently broken input is therefore refused every time it is resent. To
keep a bad input instead, skip it: a `skip()` before the store records a
`skipped` unit with its reason and attributes, and the input is acknowledged.

The engine counts refusals per pipeline, with the code of the last reason and
its time — never the text of the input or of its error:

| code | the input was refused because |
|---|---|
| `too_large` | an MLLP frame or a request body was over the source's `maxBytes` |
| `store_misfit` | a row did not fit the store's codec |
| `step_error` | a step before the store threw, or asked for `notReady` |
| `not_ready` | a step before the store found a [reference lookup](../reference/steps.md#reference-lookups-definelookup-and-ctxlookup) not ready, or threw `NotReady` |
| `timeout` | the input's deadline passed, in a step or in a statement Postgres cancelled at it |
| `db_error` | Postgres refused the input, or could not be reached |

An input abandoned before its commit — by a stop, or by a client that
disconnected — is not a refusal and is not counted. Each engine instance keeps
its counts in memory and reports them with its heartbeat, so a restart starts
from zero. The dashboard shows them per pipeline, which tells a channel whose
every input is refused apart from one that went quiet; see
[Operating Pipelines](../ops/operating.md).
