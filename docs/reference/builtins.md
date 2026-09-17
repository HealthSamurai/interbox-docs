# `/builtins`

```ts
import {
  mllpSource,
  aidboxSender,
  hl7v2Parser,
  ccdaParser,
  fhirSystem,
  aidboxSystem,
  epicSystem,
  paragonSystem,
} from "@health-samurai/interbox/builtins";
```

Typed handles for the engine's built-ins, grouped by kind. A pipeline references
the stage descriptors by value; each config is co-located with its descriptor. The
engine owns the implementations and resolves them by `type` at runtime — see
[Stages](../concepts/stages.md).

The **system** descriptors at the bottom are not stages. A pipeline never
references them; a stage imports the handle `defineSystem` returned and calls it —
see [Systems](../concepts/systems.md).

## `mllpSource` — MLLP TCP listener source

```ts
interface MllpSourceConfig {
  host?: Str;
  port: Num;
}

const mllpSource: SourceDescriptor<"mllp", MllpSourceConfig>;
```

```ts
mllpSource({
  id: "mllp-default",
  port: env("MLLP_PORT"),
  parser: hl7v2Parser({ skipZSegments: false }),
});
```

## `ccdaParser` — C-CDA document parser

```ts
interface CcdaParserConfig {}   // no options yet
```

Parses an HL7 C-CDA XML document into a typed clinical document and lands it in
`ccda_in`. Unlike HL7v2, one payload is one document — nothing is split.

```ts
ccdaParser()
```

Mapping to FHIR is yours to write. `@health-samurai/interbox/ccda` exports
`toFhirBundle`, which turns the parsed document into a FHIR R4 `Bundle`:

```ts
import { toFhirBundle } from "@health-samurai/interbox/ccda";

defineMapper({
  parser: ccdaParser,
  map: (doc) => (toFhirBundle(doc).entry ?? []).map((e) => e.resource),
});
```

The bundle links its entries with `urn:uuid:` references. If your destination
expects `Type/id` references, rewrite them in the mapper — `entry.fullUrl` carries
the `urn:uuid:` that the other entries point at, and every resource has an `id`.

**Derive your own resource ids.** The bundle's ids are fresh UUIDs per conversion, so
converting the same document twice produces two unrelated sets of resources — a retry
or a resent correction then duplicates every patient at the destination. Key each
resource on something stable (its first `identifier`, else its position), hash that
together with the document's own id, and build the reference map over the ids you
derived:

```ts
const docId = doc.id?.extension ?? doc.id?.root ?? "unknown-document";
const key = resource.identifier?.[0]?.value ?? `#${index}`;
const id = hash(`${docId}|${resource.resourceType}|${key}`);
```

Same document in, same ids out, so a re-send overwrites its own resources.

A document is rejected before parsing when its root element is not
`ClinicalDocument`. Namespace-*prefixed* documents (`<cda:ClinicalDocument>`) are
not supported and are rejected with the error kind `prefixed_ccda`; the usual
default-namespace form (`xmlns="urn:hl7-org:v3"`) is what to send.

## `aidboxSender` — Aidbox FHIR sender

```ts
type AidboxAuth =
  | { kind: "basic"; user: Str; password: Str }
  | { kind: "bearer"; token: Str };

interface AidboxSenderConfig {
  url: Str;
  auth: AidboxAuth;
  batchSize?: number;  // max rows claimed per loop
  // consecutive transient failures to retry before the batch is recorded errored
  maxRetries?: number;
  // ceiling of the retry backoff for resources deferred on a missing reference
  // target: retries start at 5s and double per attempt up to this (default 5 min)
  retryDelayMs?: number;
}

const aidboxSender: SenderDescriptor<"aidbox", AidboxSenderConfig>;
```

```ts
aidboxSender({
  url: env("AIDBOX_URL"),
  auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
});
```

## `hl7v2Parser` — HL7v2 parser

```ts
interface Hl7v2ParserConfig {
  skipZSegments?: boolean;
}

const hl7v2Parser: ParserDescriptor<"hl7v2", Hl7v2ParserConfig>;
```

```ts
hl7v2Parser();                          // config optional, defaults to {}
hl7v2Parser({ skipZSegments: true });
```

Bound to a source's `parser` field — see [Pipelines](../concepts/pipelines.md)
for how a source's parser type propagates to which mappers can attach to it.

## System descriptors — `fhirSystem`, `aidboxSystem`, `epicSystem`, `paragonSystem`

Passed to `defineSystem`, not to a pipeline. All four speak base FHIR R4 through
one client and differ in what has been tested and which credentials they accept —
see [Systems](../concepts/systems.md) for the per-method support tables and the
constraints on calling one from a mapper.

```ts
type FhirJwtAlg = "RS384" | "RS256" | "ES384" | "ES256";

type FhirCredential =
  | { kind: "basic"; user: Str; password: Str }
  | { kind: "bearer"; token: Str }
  | { kind: "client-secret"; clientId: Str; clientSecret: Str }
  | { kind: "jwt-assertion"; clientId: Str; privateKey: Str; alg?: FhirJwtAlg; kid?: Str };

interface FhirEndpointConfig {
  fhirBaseUrl: Str;   // required — there is no default
  tokenUrl: Str;      // required — there is no default
  scope?: Str;
  timeoutMs?: Num;    // per attempt. Default 10s; see the ceiling in Systems
}
```

| descriptor | accepted `auth.kind` |
|---|---|
| `fhirSystem` | all four |
| `aidboxSystem` | all four |
| `epicSystem` | `jwt-assertion` |
| `paragonSystem` | `jwt-assertion`, `client-secret` |

A credential a connector does not accept is a compile error, not a runtime 401.

```ts
export const ehr = defineSystem(fhirSystem, {
  id: "ehr-prod",
  fhirBaseUrl: env("EHR_FHIR_BASE"),
  tokenUrl: env("EHR_TOKEN_URL"),
  auth: { kind: "client-secret", clientId: env("EHR_ID"), clientSecret: env("EHR_SECRET") },
  timeoutMs: 3_000,
});
```

The service interface each one yields — `read`, `readBinary`, `search`,
`findPatientByIdentifier`, `get`, `operation`, `matchPatient` — is read-only by
contract, because the dashboard's Retry re-runs a mapper. Writes belong in a
sender.

Support tables are importable alongside the descriptors: `FHIR_SUPPORT`,
`AIDBOX_SUPPORT`, `EPIC_SUPPORT`, `PARAGON_SUPPORT`. They record what has been
called and change no behaviour.
