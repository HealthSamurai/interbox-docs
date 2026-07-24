# `/builtins`

```ts
import {
  mllpSource,
  aidboxSender,
  hl7v2Parser,
} from "@health-samurai/interbox/builtins";
```

Typed handles for the engine's built-in stages, grouped by kind. A pipeline
references these by value; each stage's config is co-located with its
descriptor. The engine owns the implementations and resolves them by `type`
at runtime — see [Stages](../concepts/stages.md).

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
