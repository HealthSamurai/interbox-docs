# Systems: calling an external API from a step

A **system** is an API a step calls while doing its own work — a FHIR server it
reads a patient from, say. It is not a step: nothing flows through it, and it
appears nowhere in a pipeline.

This exists because a step can otherwise reach only what its context offers
beyond its input: terminology, and its pipeline's own state and units.
Everything else about a message has to already be in the message. An ADT
carries an MRN; the resource you want may need demographics, coverage, or an
identifier the EHR assigns — and the sender, which runs after the steps, only
delivers.

## Declaring one

A system is declared **anywhere in the workspace**, not on a pipeline, and used by
importing the handle `defineSystem` returns:

```ts
// src/systems/ehr.ts
import { defineSystem, env } from "@health-samurai/interbox";
import { fhirSystem } from "@health-samurai/interbox/builtins";

export const ehr = defineSystem(fhirSystem, {
  id: "ehr-prod",
  fhirBaseUrl: env("EHR_FHIR_BASE"),
  tokenUrl: env("EHR_TOKEN_URL"),
  auth: {
    kind: "client-secret",
    clientId: env("EHR_CLIENT_ID"),
    clientSecret: env("EHR_CLIENT_SECRET"),
  },
  timeoutMs: 3_000,
});
```

Not on a pipeline: the system a step uses is the one it imports, and the steps of
any pipeline may import it. A workspace that declares systems exports
`SystemRegistry` from its `src/index.ts` beside `ChainRegistry`, so the engine
can bind them:

```ts
export { ChainRegistry } from "@health-samurai/interbox/chain";
export { SystemRegistry } from "@health-samurai/interbox";
```

Steps on both sides of the store can call a system. A sender's `run` cannot:
systems are not bound where senders run.

`id` names the declaration. It prefixes every error message the system produces,
so pick something an operator will recognise in an error queue.

## The four connectors

All four speak base FHIR R4 over the same client. They differ in what has been
**tested**, and in which credentials they accept.

| descriptor | what it claims |
|---|---|
| `fhirSystem` | base R4 against an endpoint we have not tested |
| `aidboxSystem` | tested against Aidbox |
| `epicSystem` | tested against Epic's R4 sandbox |
| `paragonSystem` | for Paragon; not yet exercised against a live endpoint |

`fhirSystem` is the one to reach for when your vendor is not on the list. It is
not a lesser client — it is the same client — and everything below holds for it:

- a path that resolves outside the configured FHIR base is refused
- a `next` link from a response body must share the base's origin, because it
  arrives in data and following it unchecked would send your token wherever that
  data points
- a `POST` may only address a `$operation` path; a POST to a bare resource path is
  a create, and systems do not write
- redirects are not followed, so a gateway answering `302 → /login` classifies as
  the transient status it is instead of becoming an opaque HTML `200`
- every call has a deadline, so a hung socket fails the call instead of holding
  up the step until the engine gives up on it

What `fhirSystem` does **not** promise is capability: that a given call is the
right shape for your server, that an operation exists there, or that its error
codes mean what we assume. That is the whole of the difference.

### What has actually been called

Support is recorded per method, and it changes no behaviour — nothing throws,
nothing is blocked. It tells you where you are on tested ground.

| method | `fhirSystem` | `aidboxSystem` | `epicSystem` | `paragonSystem` |
|---|---|---|---|---|
| `read` | unknown | supported | supported | unknown |
| `readBinary` | unknown | supported | supported | unknown |
| `search` | unknown | supported | supported | unknown |
| `findPatientByIdentifier` | unknown | supported | supported | unknown |
| `get` | unknown | supported | supported | unknown |
| `operation` | unknown | supported | supported | unknown |
| `matchPatient` | unknown | **unsupported** | supported | unknown |

`unknown` means nobody has called it. It says something about us rather than about
your server — a method sitting there may work perfectly. `unsupported` means the
opposite: it was called and the vendor does not implement it.

Whether *your* deployment exposes what a `supported` method reaches is a separate
question no table can answer. Access is usually set by your app registration, and
two sites on the same product routinely differ.

The same facts are importable, if you would rather branch on them than read a
table:

```ts
import { EPIC_SUPPORT } from "@health-samurai/interbox/builtins";
EPIC_SUPPORT.matchPatient; // "supported"
```

## Reads only

Every method is a read, and that is a contract rather than an omission.

Steps run again: a **Retry** runs every step after the store again, and a step
before the store runs again whenever the sending side resends its input. A read
is idempotent under that; a write is not. So there is no `request(method, …)`,
and the single `POST` on the surface can only address a `$operation` path — a
POST to a bare resource path would be a create, and the client refuses to
compose one.

Writes belong in a sender.

## Calling one from a step

Use `mapAll`, and return failures **in their slot** rather than throwing:

```ts
import { domainError, mapWithConcurrency } from "@health-samurai/interbox";
import { defineStep, type Batch } from "@health-samurai/interbox/chain";
import type { HL7v2Message } from "@health-samurai/interbox/hl7v2";
import { ehr } from "../systems/ehr";

const MRN_SYSTEM = "https://ehr.example.com/mrn";

export const withPatient = defineStep("with-patient", (msgs: Batch<HL7v2Message>) =>
  msgs.mapAll(async (rows) => {
    const found = await mapWithConcurrency(rows, 8, async (msg) => ({
      msg,
      page: await ehr.findPatientByIdentifier(MRN_SYSTEM, mrnOf(msg)),
    }));
    return found.map((hit) => {
      if (hit instanceof Error) return hit;
      const [patient, ...rest] = hit.page.resources;
      if (!patient) return domainError("system", "patient_not_found", "no patient for this message's MRN");
      if (rest.length > 0) return domainError("system", "patient_ambiguous", `${rest.length + 1} patients match this message's MRN`);
      return { msg: hit.msg, patient };
    });
  }),
);
```

Fan-out is yours: the client neither queues nor schedules, so the number of
concurrent calls is the number you pass to `mapWithConcurrency`, which answers a
failed call with its `Error` in that row's place. An `Error` returned in a row's
place fails only that row's unit, and is classified like a throw: a
`domainError`, or a system's `_rejected` error or one of its variants, ends the
unit at `error` at once with its kind; a system's `_unreachable` error, or any
other `Error`, is tried again (see [Errors](#errors)). A throw out of `mapAll`
fails every unit in the call.

Two things that bite:

**A search that matches nothing is not an error.** It is an empty `resources`, and
if you do not check it you will build a resource with no patient link and no
failure recorded anywhere. That is the quietest bug available here. The same goes
for more than one match — a `SearchPage` is returned rather than a single resource
precisely so the client does not decide patient identity on your behalf.

**Calling a system couples your throughput to theirs.** One call per message
against a rate-limited API caps the pipeline at that rate, and a faster feed grows
a backlog with no error and no event, because a backlog is not a failure. Dedupe
where you can — a hundred messages about one patient should not spend a hundred
requests.

### The ceiling, and it is a real one

After the store, a step's calls run inside the **take's deadline**: 60 seconds
for all the work on a take of up to the store's `batch` units, **100** by
default. So the worst case is arithmetic:

```
time the take needs  ≈  ceil(batch / concurrency) × timeoutMs
```

At the default `timeoutMs` of 10s and a concurrency of 4, a take where every call
times out needs **over four minutes**, far past its deadline. The engine stops
waiting at 60 seconds: every unit of the take counts a failed attempt and is
taken alone from then on, and a unit that keeps failing ends at `error` with
`engine/step_timeout` after five attempts.

So set both knobs deliberately, and the store's `batch` with them.
`timeoutMs: 3_000` with a concurrency of 8 bounds a take of 100 to about 40
seconds. Prefer one batched call over one call per message wherever the API
allows it.

Before the store, a step's calls run inside the transaction that stores the
input, and the sending side waits for its answer until they finish. A slow call
there can make the sender give up and resend; keep such calls short, or make
them after the store.

## Configuration

`fhirBaseUrl` and `tokenUrl` are **required on every connector**. There are no
endpoint defaults, on purpose: a default would mean a workspace that forgot one
still starts, authenticates somewhere, and returns data from the wrong place —
which is worse than refusing to load, because it looks like it worked.

A missing or malformed system config fails the workspace load, not the message.

Credentials are a discriminated union, and each connector accepts only the kinds
its vendor issues:

| `kind` | fields | reaches a token endpoint? |
|---|---|---|
| `basic` | `user`, `password` | no — the header is the credential |
| `bearer` | `token` | no |
| `client-secret` | `clientId`, `clientSecret` | yes, OAuth2 `client_credentials` |
| `jwt-assertion` | `clientId`, `privateKey`, `alg?`, `kid?` | yes, signed JWT assertion |

The two static kinds have nothing to refresh, so a `401` on them is final and is
not retried. Set `kid` only when your public key is registered as a JWK Set; omit
it for a single uploaded certificate.

## Errors

A failed call classifies itself in its error's kind. The group is `system`, the
specific names the connector — `system/epic_unreachable`,
`system/aidbox_rejected` — so a read that failed is never confused with a write
that failed, which is `sender/…`. See [errors](./errors.md).

Whether the kind says `_unreachable` or `_rejected` is decided on the same status
rule the senders use: 5xx, 408, 425, 429 and 3xx are `_unreachable`; everything
else is `_rejected` or one of its variants. A call that never got an answer at
all — DNS, refused connection, TLS — is `_unreachable` too.

After the store, a step that lets the error through fails its unit by that kind:

- **`_unreachable` is transient.** The unit stays at the store and is tried
  again 4 seconds later, then 8, 16 and 32, as after any other throw. A fifth
  failure ends it at `error` with `engine/attempts_exhausted`, and a message
  that begins with the system's kind: `system/epic_unreachable: …`.
- **`_rejected`, and each of its variants, is permanent.** The unit ends at
  `error` at once with that kind, as after a `domainError`, and is not tried
  again on its own.

A step that turns the system's answer into a failure of its own — no patient
found, or more than one — throws a `domainError`, and its unit ends at `error`
at once with that error's kind. Before the store, the input is refused, as any
throw there refuses it.

A system that stays down past the fifth attempt leaves its units at
`engine/attempts_exhausted`. Once it is back, filter the Units page on that
`error_kind` and the step's `error_step`, and retry those units.

Where a server explains itself in an `OperationOutcome`, its `diagnostics` are
carried into the message. Read them: they are usually the answer.

## Epic specifics

`epicSystem` carries rules measured against Epic's own API rather than inferred
from the specification.

**`matchPatient` needs Epic's "3+1".** First and last name, legal sex, date of
birth, **and** at least one further identifier — an address, an email, a phone, or
an identifier. A phone must carry a `use` (`home`, `work`, `mobile`, …); Epic
rejects one without it whatever the number's format, and the type enforces this so
it is a compile error rather than a per-message failure.

Send less than the 3+1 and the call is refused before it leaves, because Epic
answers a thin query for a patient who *exists* with an error while answering the
same query for someone who does not exist with an empty result. The refusal names
the missing field; the alternative was a round trip that says nothing actionable.

It is necessary, not sufficient: Epic can still find no certain match when the
identifier you sent belongs to nobody.

**Epic's MRN is not typed `MRN`.** Select it by identifier `system`, from config —
the OID differs per site, and matching on the type text will break at the next
deployment.

```ts
const mrn = patient.identifier?.find((i) => i.system === MRN_SYSTEM)?.value;
```

**`matchPatient` already returns the full Patient**, identifiers and demographics
together, so there is no second `read` to make. Use `search` when you need
clinical data, keyed on `patient.id` — the FHIR id, not the MRN.

## Testing a step that uses a system

Bind a fake. No network, no credentials:

```ts
import { SystemRegistry } from "@health-samurai/interbox";

SystemRegistry.override("ehr-prod", {
  async findPatientByIdentifier() {
    return { resources: [{ resourceType: "Patient", id: "p1" }], bundle: { … } };
  },
  // …the rest of the interface
});
```

The override is process-global, so set it and clear it around a test rather than
leaving it standing.
