# Env references & resolved config

## `env()`

A workspace author wraps a value with `env("NAME")` instead of reading
`process.env` directly at module-eval time. This keeps the pipeline
declaration — and anything that introspects `PipelineRegistry` before the
engine resolves it — free of resolved secrets:

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

The engine resolves every `EnvRef` against its own process environment when
it builds the runner config — a workspace author never resolves one by hand.

## Authoring types: `Str` / `Num`

Config fields that may be supplied either literally or via `env()` are typed
with these two unions instead of `string`/`number`:

```ts
type Str = string | EnvRef;
type Num = number | EnvRef;
```

You'll see these on every built-in config — e.g. `MllpSourceConfig.port: Num`,
`AidboxSenderConfig.url: Str` (see [/builtins](../reference/builtins.md)).

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
authoring config type (`Resolved<MllpSourceConfig>`, for instance) instead of
hand-maintaining a second, parallel "resolved" interface that could drift
from the authoring one.
