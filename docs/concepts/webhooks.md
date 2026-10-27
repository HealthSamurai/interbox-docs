# Webhooks

A pipeline can notify an external HTTP(S) endpoint when its units change
status — a message is stored, fails, is delivered — or when one of your steps
raises an event of its own. You declare webhooks on the pipeline; the engine
handles delivery, signing, and retries.

```ts
pipeline("adt")
  .source(mllpSource({ port: env("MLLP_PORT") }))
  .store(postgresStore({ codec: "text" }))
  .step(hl7v2Parser())
  .step(v2ToFhir)
  .step(fhirItems())
  .sender(aidbox({ url: env("AIDBOX_URL"), auth: { kind: "bearer", token: env("AIDBOX_TOKEN") } }))
  .webhook({ url: env("ERRORS_HOOK_URL"), secret: env("HOOK_SECRET"), on: ["error", "deferred"] })
  .webhook({ url: env("DELIVERY_HOOK_URL"), secret: env("HOOK_SECRET"), on: ["sent", "custom:reconciled"] });
```

`.webhook(cfg)` may be called at any point of the chain, and as many times as
you need: group endpoints by concern. It takes:

| field | type | notes |
|---|---|---|
| `url` | `Str` | endpoint that receives the POST. Use `env("NAME")`. Must be allowlisted (see below). |
| `secret` | `Str?` | HMAC signing key, as `env("NAME")` — the **env var name** is stored, never the value. A literal string is ignored, with a warning in the log, and delivery is unsigned. Omit for unsigned delivery. |
| `on` | `ChainEvent[]` | which events this endpoint receives: at least one, each a status below or `custom:<name>`. Any other name throws when the pipeline is declared. |

## How it works — the outbox

Delivery is decoupled from your pipeline. When the engine changes a unit's
status, it writes the event row **in the same database transaction** — so an
event exists if and only if the change committed: no lost events, no phantom
events. A separate dispatcher drains those rows and POSTs them. A slow or down
endpoint never holds up ingestion or delivery.

## Status events

Each status a unit enters is an event of the same name:

| event | the unit… |
|---|---|
| `received` | was stored: by its source, by a bridge from another pipeline, or by the operator's Retry, which returns it to the store |
| `processed` | had its items queued for the sender |
| `sent` | had its last item delivered; or had nothing to deliver; or was handed on through a bridge; or had its last waiting items deleted by an operator |
| `skipped` | was skipped by a step, before or after the store |
| `error` | failed: in a step, in the engine, or by the sender's rejection |
| `deferred` | was set aside by the operator's Defer |

A failure the engine will try again leaves the unit at the store, so it is no
event. An input refused before the store never becomes a unit, so it is no
event either.

The payload names the unit and its status; for `error` it adds where and why.
It carries no attributes: a webhook URL is outside the deployment, and
attributes may hold patient identifiers.

```
POST <url>
content-type: application/json
x-interbox-id: 918273            # stable event id — dedupe on this
x-interbox-timestamp: 1780480000 # unix seconds (present when signed)
x-interbox-signature: <hex>      # HMAC-SHA256 (present when signed)

{
  "id": 918273,
  "event": "error",
  "pipeline": "adt",
  "unit": {
    "id": "501",
    "status": "error",
    "correlationId": "501",
    "createdAt": "2026-07-13T12:00:00.000Z",
    "orderAt": "2026-07-13T11:59:58.000Z",
    "errorStep": "hl7v2.parse",
    "errorKind": "parse/not_hl7",
    "errorMessage": "…"
  },
  "occurredAt": "2026-07-13T12:00:01.250Z"
}
```

`errorStep`, `errorKind` and `errorMessage` are present on `error` events only.
`correlationId` names the unit the work started from: a unit's own id, or, for
a unit a bridge created, the id carried over from the pipeline before it.

## Operator actions

The dashboard's Retry, Defer and item delete, and the same calls from the
[admin library](../ops/admin-scripts.md), change units without the engine.
They write no event themselves. Each records the status the unit entered, in
the transaction of the change, and the engine turns those records into events
when it next drains them — usually within a second or two. In
`interbox.webhook_outbox` these events carry the stage `operator`.

| action | event |
|---|---|
| Retry | `received` |
| Defer | `deferred` |
| deleting a unit's last waiting items | `sent` |

An operator event's `occurredAt` is when the action committed, not when the
engine wrote the event. That is what keeps the order straight: after a Retry,
the engine may already have processed the unit again, and written its
`processed` or `sent`, before it writes the `received` of the Retry.

See [Operating Pipelines](../ops/operating.md) for the actions themselves.

## Custom events from a step

A step can raise its own events with `ctx.webhook()` — useful for domain
milestones such as "patient reconciled" or "duplicate suppressed":

```ts
const reconcile = defineStep("reconcile", (patients: Batch<Patient>) =>
  patients.map((patient, ctx) => {
    if (isReconciled(patient)) ctx.webhook("custom:reconciled", { patientId: patient.id });
    return patient;
  }),
);
```

`ctx.webhook` is on the row's context, the second argument of a `Batch`
method's function. Subscribe with `.webhook({ on: ["custom:reconciled"] })`.

- **After the store,** the event is written with its unit's result, in the same
  transaction, and its payload names the unit. If the unit fails, is tried
  again later, or waits on `notReady`, the event is dropped with the result.
- **Before the store,** the event is written with the input's commit, and its
  payload names no unit, since there is none yet. If the input is refused, the
  event is dropped.
- **The payload must be JSON.** It is copied at the call. A value that cannot be
  stored as JSON, such as a `bigint`, throws a plain `Error` at the call. After
  the store that is a failure that may pass: the unit is tried again, and ends
  at `error` with `engine/attempts_exhausted` after its fifth attempt. Before
  the store it refuses the input.
- **The payload is yours.** Around it the engine adds only the event's id, name,
  pipeline, unit id and time; whatever you put in the payload leaves the
  deployment.
- An event no webhook of the pipeline subscribes to is not written.

```
{ "id": 918274, "event": "custom:reconciled", "pipeline": "adt",
  "unit": { "id": "502" }, "payload": { "patientId": "p-12345" },
  "occurredAt": "2026-07-13T12:00:02.000Z" }
```

## Scope — per pipeline

A `.webhook()` fires only for **its own pipeline's** events. When one pipeline
hands its items to another through a bridge, the `received` events of the new
units belong to the receiving pipeline, and its webhooks get them.

## Delivery guarantees

- **At least once.** A row is retried until delivered or parked; your endpoint
  may see the same event more than once. Dedupe on the `X-Interbox-Id` header
  (the stable event id, also the payload's `id`).
- **No ordering guarantee — order by `occurredAt`.** Independent per-row
  backoff means events can arrive out of order. `X-Interbox-Id` is not an
  order either: it is assigned when the event row is written, and an operator's
  event is written later than the action it records. `occurredAt` is when the
  status was set — for the engine's events, the engine's clock as it writes
  them; for the operator's, the database's clock at the action.
- **Retries.** `2xx` = delivered. `5xx`/`429`/network errors retry with
  exponential backoff. Other `4xx` are permanent — the row is parked (kept for
  inspection, not retried). Transient retries are also parked once exhausted.
  Redirects (`3xx`) are **not followed** (that would bypass the egress guard) and
  are treated as a permanent failure.

### Parked deliveries (operator)

A parked row is undelivered and no longer retried (`delivered_at IS NULL`,
`next_attempt_at = 'infinity'`), with the reason in `last_error`. Every park is
also logged (at `error`, with the event, target, and reason), so a dead delivery
shows up in the engine logs — you don't have to poll the table to notice one.
After a downstream endpoint recovers, re-drive them — this resets parked rows to
due with a fresh attempt budget and the dispatcher picks them up:

```sql
UPDATE interbox.webhook_outbox
   SET next_attempt_at = NULL, attempts = 0, last_error = NULL
 WHERE delivered_at IS NULL AND next_attempt_at = 'infinity';
```

### Retention

The outbox grows with traffic, so the dispatcher runs an hourly sweep that
deletes **delivered** rows older than `WEBHOOK_RETENTION_DAYS` (unset or blank ⇒
default `30`; an explicit `0` disables the sweep). Parked and pending rows are
never swept — a failed delivery stays until you redrive it or remove it by
hand.

## Verifying the signature

When you set `secret`, the engine signs `"<timestamp>.<raw-body>"` with
HMAC-SHA256. Recompute it over the raw request body and reject on mismatch — and
reject a stale `x-interbox-timestamp` (e.g. older than 5 minutes) to defeat
replays:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, rawBody: string, headers: Record<string, string>): boolean {
  const ts = Number(headers["x-interbox-timestamp"]);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const got = headers["x-interbox-signature"] ?? "";
  return expected.length === got.length && timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}
```

## Egress allowlist (operator)

Because `url` is operator-authored and reaches out from the engine, delivery is
gated by the **`WEBHOOK_EGRESS_ALLOWLIST`** environment variable — a
comma-separated list of allowed hosts (exact, or `*.suffix` for subdomains):

```
WEBHOOK_EGRESS_ALLOWLIST=hooks.example.com,*.partner.example.com
```

- **Empty or unset ⇒ all webhook delivery is denied** (fail-closed). Set it
  whenever you declare a `.webhook()`.
- A `url` whose host is not in the list is refused.
- Cloud-metadata / link-local addresses (`169.254.0.0/16`, IPv6 link-local) are
  **always** blocked, even if allowlisted.
- Private / loopback hosts (on-prem targets) are allowed **if** the host is in
  the allowlist — an allowlist entry is explicit trust. Set
  **`WEBHOOK_BLOCK_PRIVATE=true`** (recommended on cloud deployments) to also
  refuse loopback / RFC1918 / IPv6-ULA targets — including a host that *resolves*
  to one.

Signing (HMAC) proves a request came from Interbox and wasn't tampered with, but
it can't stop an attacker from POSTing to a URL they discover — so also restrict
who can reach your endpoint (source-IP allowlist / network isolation) as
defense-in-depth.
