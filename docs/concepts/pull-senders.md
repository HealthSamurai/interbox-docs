# A Queue Consumers Poll

Some systems cannot take an inbound connection, so no sender can push to them.
A pull sender keeps the newest version of each record a pipeline produces, and
such a system polls for them: it receives what is pending, acknowledges what it
processed, and searches what is pending or delivered. It reaches the queue
through an Aidbox App, so Aidbox owns its credentials and access policy, and
Interbox stays internal.

```ts
import { env } from "@health-samurai/interbox";
import { pipeline, postgresStore, pullSender, webhookSource } from "@health-samurai/interbox/chain";

interface Resource {
  readonly resourceType: string;
  readonly id: string;
  readonly meta: { readonly lastUpdated: string; readonly versionId: string };
}

interface Notification {
  readonly entry: ReadonlyArray<{ readonly resource: Resource; readonly request: { readonly method: string } }>;
}

function changesOf(body: string) {
  const { entry } = JSON.parse(body) as Notification;
  return entry
    .filter(({ resource }) => resource.resourceType !== "AidboxSubscriptionStatus")
    .map(({ resource, request }) => ({
      key: `${resource.resourceType}/${resource.id}`,
      at: new Date(resource.meta.lastUpdated),
      version: Number(resource.meta.versionId),
      resource: request.method === "DELETE" ? null : resource,
    }));
}

pipeline("consumer-a-feed")
  .source(webhookSource({ path: "/events/consumer-a", secret: env("EVENTS_SECRET") }))
  .store(postgresStore({ codec: "text" }))
  .step((bodies) => bodies
    .flatMap(changesOf)
    .withMeta((change) => ({ key: change.key, version: change.version }))
    .withOrder((change) => change.at)
    .map((change) => change.resource))
  .sender(pullSender({
    path: "/consumer-a",
    secret: env("CONSUMER_A_APP_SECRET"),
    leaseMs: 60_000,
  }));
```

A `webhookSource` hands each body over as text, and with `full-resource` content
Aidbox sends a notification `Bundle`: an `AidboxSubscriptionStatus` entry, then
the changed resource with the request that changed it. A delete carries the
deleted resource with `request.method` `DELETE` and a newer `lastUpdated`. The
step turns it into a `null` item, which the consumer receives as a delete.

The step sets both the key and the order, and both matter:

- **The key** names the record. The queue keeps one row per key, so an item
  without one is rejected, and its unit goes to `error`.
- **The order** decides which version is newer. Without `withOrder`, a version
  is ordered by when it arrived, and a late retry of an older event replaces a
  newer version. The engine cannot check for it, since the call is in a step.
- **The version** breaks a tie on the order. A `Date` keeps milliseconds, so
  two versions in one millisecond tie; then the one whose `version` in the
  item's meta is greater wins. Give a number that grows with each version of
  the record: Aidbox's `meta.versionId` does. Without it, a tie changes nothing.

| field | default | what it does |
|---|---|---|
| `path` | required | where the App's endpoint calls, on the engine's webhook port, `INTERBOX_WEBHOOK_PORT` (`3002` when unset). It starts with `/`, holds no `?` or `#`, and matches exactly; a trailing `/` is ignored, and a path a request would carry percent-encoded, such as `/a b`, is refused at load |
| `secret` | required | the App's secret, as `env("NAME")` with no default. A literal string, or a default, is refused at load |
| `leaseMs` | required | how long a received item stays at one consumer before it is served again |
| `batch` | 100 | items per sender pick |

Two pull senders on one path, or a pull sender and a webhook source on one path,
refuse the load and name both pipelines. A pull sender takes no retry or timeout
tuning: it has no `run` to retry.

## The Queue API

The consumer calls the queue through the Aidbox App, on Aidbox's address, never
the engine's. Each operation is a path under the App's prefix: with the App in
[Setting up Aidbox](#setting-up-aidbox), `receive` is
`https://aidbox.example.com/consumer-a/queue/receive`. `receive`, `ack` and
`search` are `POST` calls with a JSON body and `Authorization: Bearer <access
token>`; `openapi` is a `GET` and needs no token.

| operation | what it does |
|---|---|
| [`receive`](#receive) | leases pending items and answers them |
| [`ack`](#ack) | marks items processed |
| [`search`](#search) | reads items by key, state, time or content, and changes nothing |
| [`openapi`](#openapi) | answers the OpenAPI document of the queue |

### Items

The queue holds one row per key, with the newest version of that record. An
answer shows a row as an item:

| field | what it is |
|---|---|
| `key` | the record's name, such as `Patient/pt-1`, which the pipeline's step sets. One row per key |
| `seq` | the version's number. Each new version gets a greater `seq` than any before it, across all keys, with gaps between them. Ack by it, and keep a record only when its `seq` is greater than the one you stored |
| `data` | the record, as JSON, as the pipeline produced it; `null` when it was deleted |
| `status` | `search` only: `pending`, `in-flight` or `delivered` |
| `updatedAt` | `search` only: when the row last changed. A new version, a lease and an ack each change it |

An item is in one of three states:

- **`pending`**: no ack has named its current `seq`, and it has no live lease.
  `receive` serves it.
- **`in-flight`**: a `receive` leased it for the pull sender's `leaseMs`, and
  the lease is live. No other `receive` serves it until the lease runs out or
  the item is acked.
- **`delivered`**: an ack named its current `seq`.

A new version of a delivered record makes it `pending` again, with a new `seq`.
A new version of an `in-flight` record replaces the leased one in the row, but
waits for the lease: it is `pending` once the consumer acks the leased `seq` or
the lease runs out. A lease that runs out without an ack makes the item
`pending`, and the next `receive` serves it, to this consumer instance or
another.

A delivered record stays in the queue for the pipeline's `retention` after its
ack, 7 days by default (see [Pipelines](pipelines.md#the-chain)). Then Interbox
drops the record and keeps only its key and version, so `search` no longer
finds it, and an older version that arrives later still changes nothing. A
record not yet acked stays however old it is.

### receive

`POST <prefix>/receive` leases pending items and answers them.

| field | default | what it is |
|---|---|---|
| `limit` | `100` | the most items to answer, 1 to 1000 |

The body may be empty. The answer is `{ items }`, each item with `key`, `seq`
and `data`, lowest `seq` first. Each item is now `in-flight` for the pull
sender's `leaseMs`. An empty list means nothing is pending. Two calls at the
same time never get the same item.

```http
POST /consumer-a/queue/receive
Authorization: Bearer <access token>
Content-Type: application/json

{ "limit": 2 }
```

The answer:

```json
{
  "items": [
    { "key": "Patient/pt-1", "seq": 1041, "data": { "resourceType": "Patient", "id": "pt-1", "active": true } },
    { "key": "Patient/pt-2", "seq": 1046, "data": null }
  ]
}
```

### ack

`POST <prefix>/ack` marks items processed.

| field | default | what it is |
|---|---|---|
| `items` | required | a list of `{ key, seq }`, at most 1000, each `seq` as `receive` or `search` answered it |

For each key, the ack takes the greatest named `seq` that is not above the
row's current `seq`, and marks every version up to it processed:

- When it is the row's current `seq`, the item is `delivered`.
- When it is the leased `seq`, the lease ends. A newer version that waited for
  the lease is `pending` at once.
- A `seq` above the row's current one, or a key the queue does not hold,
  changes nothing.

An item need not be received first: an ack of a `pending` item's current `seq`
delivers it.

The answer is `{ acked }`: how many of the named keys changed their row. A
repeated ack is not counted. An ack of an older version is counted, though the
row stays `pending` or `in-flight` with its newer version.

```http
POST /consumer-a/queue/ack
Authorization: Bearer <access token>
Content-Type: application/json

{ "items": [{ "key": "Patient/pt-1", "seq": 1041 }, { "key": "Patient/pt-2", "seq": 1046 }] }
```

The answer:

```json
{ "acked": 2 }
```

### search

`POST <prefix>/search` reads items without changing them.

| field | default | what it is |
|---|---|---|
| `keys` | every key | only items with one of these keys |
| `status` | any | only items in this state: `pending`, `in-flight` or `delivered` |
| `updatedFrom` | none | only items whose `updatedAt` is at or after this time |
| `updatedTo` | none | only items whose `updatedAt` is before this time |
| `match` | none | only items whose `data` contains this JSON object: each field it names has the same value in `data`, at any depth, and a list in it matches a list in `data` that holds each of its elements |
| `limit` | `100` | the most items in one answer, 1 to 1000 |
| `after` | none | the `next` of the previous answer |

`updatedFrom` and `updatedTo` are a date and time with its offset, such as
`2026-11-01T00:00:00Z` or `2026-11-01T02:00:00+02:00`. A search with `match`, or
with `updatedFrom` or `updatedTo` but no `keys`, needs `status` `pending` or
`in-flight`, so it reads only the items not yet delivered. Either is answered
`400` otherwise.

The answer is `{ items, next? }`, items in key order, each with all five
fields. `next` is there when more items match: send the same body with `after`
set to it for the next page.

```http
POST /consumer-a/queue/search
Authorization: Bearer <access token>
Content-Type: application/json

{ "status": "pending", "match": { "resourceType": "Patient", "active": true }, "limit": 2 }
```

The answer:

```json
{
  "items": [
    { "key": "Patient/pt-3", "seq": 1050, "status": "pending", "data": { "resourceType": "Patient", "id": "pt-3", "active": true }, "updatedAt": "2026-11-16T12:30:05.120Z" },
    { "key": "Patient/pt-4", "seq": 1052, "status": "pending", "data": { "resourceType": "Patient", "id": "pt-4", "active": true }, "updatedAt": "2026-11-16T12:31:44.007Z" }
  ],
  "next": "UGF0aWVudC9wdC00"
}
```

### openapi

`GET <prefix>/openapi` answers the queue's OpenAPI 3.1 document, without a
token; see [The OpenAPI document](#the-openapi-document).

### Answers

| answer | when |
|---|---|
| `200` | the operation ran |
| `400` | the body, a field or the operation is refused; `{ message }` names which, such as `limit must be a whole number from 1 to 1000` |
| `401` | from Aidbox: no token, or one Aidbox does not accept. From the engine: the App's `secret` is not the pull sender's |
| `403` | from Aidbox: the Client's access policy does not allow the operation |
| `404` | no pull sender or webhook source has the path the App calls: check the App's `endpoint.url` |
| `413` | the call is over 1 MiB |
| `500` | Postgres failed or timed out; the body is a fixed text, and the reason goes to the engine's log. Aidbox also answers `500` when it cannot reach the engine |
| `503` | the engine is stopping |

Aidbox answers `401` and `403` before the call reaches the engine, so the queue
does not change. A `400` changes nothing either.

## The consumer contract

- **Delivery is at least once.** Ack after processing.
- **Keep a record only when its `seq` is greater** than the one stored for its
  key, and dedupe side effects by `(key, seq)`. When a lease runs out, a second
  consumer instance can take a newer version while the first still works on the
  older one; this rule keeps the newer.
- **Ack a record you cannot process** to move past it. The engine has no
  delivery limit: an item you never ack comes back each time its lease runs out.
- **Several consumer instances are safe.** While a lease is live, a key is at
  one instance.
- **Retry with backoff on any 5xx.** A reload or restart closes the port
  briefly, and Aidbox answers `500` while it is closed. Leases survive it.

## Setting up Aidbox

**The App** forwards each operation to the pull sender. Its `endpoint.url` is
the engine's webhook port and the pull sender's `path`, and its `secret` is the
value of the pull sender's `secret`. When the endpoint is unreachable, Aidbox
answers the consumer `500` with the endpoint URL in its body, so give the engine's
Service a name you are content for the consumer to see. Keep the four operations
under one prefix, so the OpenAPI document resolves them. `openapi` alone is
public:

```yaml
resourceType: App
id: consumer-a-queue
apiVersion: 1
type: app
endpoint:
  type: http-rpc
  url: http://feed.internal.example:3002/consumer-a
  secret: <the value of CONSUMER_A_APP_SECRET>
operations:
  receive: { method: POST, path: [consumer-a, queue, receive] }
  ack: { method: POST, path: [consumer-a, queue, ack] }
  search: { method: POST, path: [consumer-a, queue, search] }
  openapi:
    method: GET
    path: [consumer-a, queue, openapi]
    policies:
      public-openapi: { engine: allow }
```

The `policies` entry is Aidbox's: `engine: allow` picks Aidbox's built-in
`allow` policy engine, not the Interbox engine, so Aidbox serves `openapi`
without a token. The document holds field shapes
and the path prefix, never queue data. Interbox needs no setting for it: every
pull sender answers `openapi`.

**The consumer's Client** authenticates with a private-key JWT: the consumer
keeps the private key and publishes its public key at a `jwks_uri`. Set it up
as Aidbox documents in
[private key JWT authentication](https://www.health-samurai.io/docs/aidbox/access-control/authorization/smart-on-fhir/smart-client-authentication/smart-asymmetric-docs-private-key-jwt-authentication).
A Client with a shared secret suits a test environment, or a consumer that
cannot sign.

**An access policy** lets that Client call the three queue operations and
nothing else. Link it by `resourceType` and `id`:

```yaml
resourceType: AccessPolicy
id: consumer-a-queue
engine: matcho
link:
  - { resourceType: Client, id: consumer-a }
matcho:
  request-method: post
  uri: { $enum: [/consumer-a/queue/receive, /consumer-a/queue/ack, /consumer-a/queue/search] }
```

**Getting a token** with a private-key JWT: sign an assertion with `RS384`,
whose `iss` and `sub` are the Client id, `aud` is Aidbox's `/auth/token`, and
`exp` is at most five minutes ahead, then post it:

```js
import { importPKCS8, SignJWT } from "jose";

const tokenUrl = "https://aidbox.example.com/auth/token";
const key = await importPKCS8(process.env.CONSUMER_A_PRIVATE_KEY, "RS384");
const assertion = await new SignJWT({})
  .setProtectedHeader({ alg: "RS384", kid: "consumer-a-1", typ: "JWT" })
  .setIssuer("consumer-a")
  .setSubject("consumer-a")
  .setAudience(tokenUrl)
  .setJti(crypto.randomUUID())
  .setExpirationTime("5m")
  .sign(key);

const res = await fetch(tokenUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
    scope: "<a scope the Client allows>",
  }),
});
const { access_token } = await res.json();
```

Then call an operation with `Authorization: Bearer <access_token>`, for example
`POST https://aidbox.example.com/consumer-a/queue/receive` with `{ "limit": 50 }`;
see [The Queue API](#the-queue-api).

**The events in** come from an `AidboxSubscriptionTopic` on the feed's resource
types and an `AidboxTopicDestination` of kind `webhook-at-least-once`, with
`maxMessagesInBatch: 1`, `full-resource` content and an `x-interbox-secret`
header the `webhookSource` checks. A `PUT` of the destination may change only
its `endpoint`, and keeps the events not yet delivered. Any other change means
deleting and recreating it, which loses them. An event the pipeline refuses
holds back every later one, since Aidbox retries it in order, so put the steps
that can fail after the store.

## The OpenAPI document

`GET https://aidbox.example.com/consumer-a/queue/openapi` answers the queue's
OpenAPI 3.1 document, without a token. Load it into Swagger UI, Postman or any
OpenAPI tool. Its server URL is relative, so the operations resolve against the
address the document was fetched from. It offers two ways to authenticate:

- **OAuth2 client credentials** against Aidbox's `/auth/token`, under the base
  URL Aidbox is configured with, `BOX_WEB_BASE_URL`: the tool gets the token
  itself, for a Client with a secret.
- **Bearer**: paste a token you got beforehand, as a Client with a private-key
  JWT does, since no tool signs the assertion in the browser.

A tool served from another origin calls Aidbox across origins. Aidbox answers
those calls, the token request included.

The engine serves no API console of its own. To try the operations in a
browser, run Swagger UI on your machine against the document:

```sh
docker run --rm -p 8080:8080 \
  -e URL=https://aidbox.example.com/consumer-a/queue/openapi \
  swaggerapi/swagger-ui
```

Then open `http://localhost:8080`, choose **Authorize**, and enter the Client's
id and secret. Do not enter a Client's secret into a Swagger UI someone else
hosts.

## Operating

- **The dashboard** shows, under a pipeline's sender items, the address the
  App's endpoint calls, `polled at [::]:3002/consumer-a`, with `down` when no
  engine instance that reports it has the port bound, followed by the error an
  instance reports, such as the port being in use. With no recent report from any
  engine, the line is not shown.
- **The port** is the webhook port, `INTERBOX_WEBHOOK_PORT` (`3002` when unset). Let only Aidbox reach it; see
  [Network access](../ops/network.md#inbound).
- **A rename** makes the pipeline new: its queue starts empty, and items still
  pending in the old one are never delivered. Let the consumer drain the queue
  first. The `path` does not change with the name, so the App keeps calling the
  new queue.
