# Env references & resolved config

## `env()`

A workspace author wraps a value with `env("NAME")` instead of reading
`process.env` directly at module-eval time. This keeps the pipeline
declaration — and anything that reads `ChainRegistry.defs()` — free of
resolved secrets:

```ts
import { env, isEnvRef } from "@health-samurai/interbox";

env("AIDBOX_CLIENT_SECRET");        // => { $env: "AIDBOX_CLIENT_SECRET" }
isEnvRef(env("X"));          // => true
isEnvRef("literal-value");   // => false
```

```ts
interface EnvRef { readonly $env: string; readonly $default?: string }
function env(name: string, fallback?: string): EnvRef;  // fallback = default when unset
function isEnvRef(value: unknown): value is EnvRef;
```

The engine resolves an `EnvRef` against its own process environment — a
workspace author never resolves one by hand. When it reads one depends on
where it sits:

| where | read |
|---|---|
| `aidbox()`: `url` and the `auth` fields | as each send starts, so an unset variable with no default fails that send, and its items are tried again |
| `mllpSource()` and `webhookSource()`: `port`, `host`, `secret` | checked when the workspace loads, so an unset variable with no default refuses the load, and read again when the source starts |
| `.webhook()`: `url` | when the workspace loads; an unset variable with no default refuses the load |
| `.webhook()`: `secret` | as each delivery is sent; an unset variable fails that delivery for good |
| a system declared with `defineSystem` | when the workspace loads; an unset variable with no default refuses the load |

## Authoring types: `Str` / `Num`

Config fields that may be supplied either literally or via `env()` are typed
with these two unions instead of `string`/`number`:

```ts
type Str = string | EnvRef;
type Num = number | EnvRef;
```

You'll see these on the SDK's configs — e.g. `MllpSourceConfig.port: Num`,
`AidboxConfig.url: Str` (see [Steps](../reference/steps.md)).

## `Resolved<T>`

A mapped type that strips every `EnvRef` branch out of an authoring config,
recursively — `Str` collapses to `string`, `Num` to `number`, arrays and
nested objects are walked:

```ts
type Resolved<T> = T extends EnvRef
  ? never
  : T extends readonly (infer U)[]
    ? Resolved<U>[]
    : T extends object
      ? { [K in keyof T]: Resolved<T[K]> }
      : T;
```

This lets the engine derive its own factory config type from the SDK's
authoring config type (`Resolved<FhirSystemConfig>` for the `fhirSystem`
connector, for instance) instead of
hand-maintaining a second, parallel "resolved" interface that could drift
from the authoring one.
