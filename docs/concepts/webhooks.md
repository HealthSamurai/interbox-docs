# Webhooks

A pipeline can notify an external HTTP(S) endpoint when things happen — a message
fails to parse, a mapping errors, a resource is delivered, or a custom event you
raise from mapper code. You declare webhooks on the pipeline; the engine handles
delivery, signing, and retries.

```ts
pipeline("adt")
  .source(mllpSource({ id, port, parser: hl7v2Parser() }))
  .mapper(v2ToFhir())
  .sender(aidboxSender({ url, auth }))
  // group endpoints by concern — .webhook() is repeatable
  .webhook({ url: env("ERR_URL"),  secret: env("WH_SECRET"), on: ["parse_error", "map_error", "send_error", "deferred"] })
  .webhook({ url: env("DATA_URL"), secret: env("WH_SECRET"), on: ["sent"] });
```

`.webhook(cfg)` takes:

| field | type | notes |
|---|---|---|
| `url` | `Str` | endpoint that receives the POST. Use `env("NAME")`. Must be allowlisted (see below). |
| `secret` | `Str?` | HMAC signing key, as `env("NAME")` — the **env var name** is stored, never the value. Omit for unsigned delivery. |
| `on` | `EventType[]` | which events this endpoint receives. |

## How it works — the outbox

Delivery is decoupled from your pipeline. When a stage commits its work, it
writes an event row **in the same database transaction** — so an event exists if
and only if the state change committed (no lost events, no phantom events). A
separate dispatcher worker drains those rows and POSTs them. A slow or down
endpoint never holds up ingestion or delivery.

## Events

| event | stage | when |
|---|---|---|
| `parse_error` | source | an inbound message could not be parsed |
| `map_error` | mapper | `map()` threw or produced no usable resource |
| `mapped` | mapper | a resource was produced (opt-in; **high volume**) |
| `sent` | sender | a source message's resources were delivered |
| `send_error` | sender | permanent delivery failure (destination rejected the data) |
| `deferred` | sender | transient failure, retries exhausted |
| `custom:*` | mapper | a custom event you raise (see below) |

`mapped` fires once per produced resource — subscribe only if you need it.

## Scope — per pipeline

A `.webhook()` fires only for **its own pipeline's** events, including `sent`:
the originating pipeline is stamped on each resource's provenance and read back
at send time, so a shared `aidboxSender` attributes each delivery to the pipeline
that produced it.

> **Note:** an engine currently flattens all declared pipelines into one runtime
> (shared inbound tables + queue). Per-pipeline webhook scoping is reliable with a
> single active pipeline; running several pipelines at once is not yet isolated at
> runtime, so cross-pipeline `sent` attribution can be lost. Prefer one pipeline
> per engine until that lands.

## Custom events from a mapper

Mapper code can raise its own events via `ctx.webhook()` — useful for domain
milestones ("patient reconciled", "duplicate suppressed"):

```ts
map(config, input, ctx) {
  const patient = toPatient(input);
  if (isReconciled(patient)) ctx.webhook("custom:reconciled", { mrn: patient.mrn });
  return patient;
}
```

The event is buffered and written **in the same transaction as the mapped row**,
auto-stamped with the message's source id, format, and pipeline. If your `map()`
throws, the buffered event rolls back with it — no event is delivered for a row
that failed. Subscribe with `.webhook({ on: ["custom:reconciled"] })`.

## Delivery guarantees

- **At least once.** A row is retried until delivered or parked; your endpoint
  may see the same event more than once. Dedupe on the `X-Interbox-Id` header
  (the stable event id).
- **No ordering guarantee.** Independent per-row backoff means events can arrive
  out of order. Order by `X-Interbox-Id` / the payload's `occurredAt` if you care.
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

(The engine exposes the same operation as `redriveWebhooks(db)`.)

### Retention

The outbox is high-volume (`mapped` fires per resource), so the dispatcher runs
an hourly sweep that deletes **delivered** rows older than `WEBHOOK_RETENTION_DAYS`
(unset or blank ⇒ default `30`; an explicit `0` disables the sweep). Parked and
pending rows are never swept — a failed delivery stays until you redrive it or
remove it by hand.

## The request

```
POST <url>
content-type: application/json
x-interbox-id: 918273            # stable event id — dedupe on this
x-interbox-timestamp: 1780480000 # unix seconds (present when signed)
x-interbox-signature: <hex>      # HMAC-SHA256 (present when signed)

{ "id": 918273, "event": "sent", "format": "hl7v2", "sourceId": "42",
  "pipeline": "adt", "occurredAt": "2026-07-13T12:00:00.000Z", ... }
```

### Verifying the signature

When you set `secret`, the engine signs `"<timestamp>.<raw-body>"` with
HMAC-SHA256. Recompute it over the raw request body and reject on mismatch — and
reject a stale `x-interbox-timestamp` (e.g. older than 5 minutes) to defeat
replays:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, rawBody: string, headers: Record<string, string>): boolean {
  const ts = Number(headers["x-interbox-timestamp"]);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false; // stale → replay
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
WEBHOOK_EGRESS_ALLOWLIST=hooks.example.com,*.partner.io
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
