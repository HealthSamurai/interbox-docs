# `/core`

```ts
import type { ... } from "@health-samurai/interbox/core";
```

Pure stage contracts shared by the SDK (descriptors, authoring) and the
engine (factories, runtime) — types + light pure helpers only, no
`drizzle`/`pg`, so a workspace's bundle stays lean.

**A workspace author rarely imports from `/core` directly.** Everything you
use day-to-day — `defineMapper`, `MapperContext`, `env()`, the builtin config
types — is exported from the package root or `/builtins`, and `map()`'s
parameter types are inferred for you. This subpath exists so the engine and
the SDK share one set of type definitions and can't drift.

What's in it, by category:

| category | types | who cares |
|---|---|---|
| authoring values | `Str`, `Num`, `Resolved` | you, occasionally — see [Env & Config](../concepts/env-and-config.md) |
| mapper contracts | `MapperDefinition`, `MapperContext`, `MapperSource`, `MappedCode`, `ParserOutputMap`, `ParserType` | you, via [`defineMapper`](mapper.md) — usually inferred, import only to annotate helpers |
| error taxonomy | `domainError`, `ERROR_GROUPS`, `ErrorGroup` | you — re-exported from the root, see [Errors](../concepts/errors.md) |
| payloads | `PayloadItem`, `PayloadBody`, `bodyFromBytes`, `bodyFromStream`, `concatChunks`, `PayloadBodyConsumed`, `ConfiguredPreprocessor`, `Preprocessor`, `PreprocessorDefinition` | you, when a source you define runs a `preprocess` chain or you declare a preprocessor — all but `concatChunks` and `ConfiguredPreprocessor` are re-exported from the root, the latter from `/builtins`; see [Preprocessing what a source read](index.md#preprocessing-what-a-source-read) and [Defining a preprocessor](index.md#defining-a-preprocessor) |
| stage runtime contracts | `SourceDefinition`/`SenderDefinition`/`ParserDefinition` + their `*Config`/`*Entry`/`*Factory`/`*Instance` siblings, `Runner` | the engine, except `SourceDefinition`, which a workspace implements through `defineSource` — see [Sources](index.md#sources) |

One import that does come up: annotating a mapper helper function that takes
the context —

```ts
import type { MapperContext } from "@health-samurai/interbox/core";

async function resolveObservationCode(ctx: MapperContext, code: string) {
  return ctx.translate("obs-codes", code);
}
```

For the exact shapes of the mapper contracts, see
[Mapper authoring](mapper.md). For the engine-side runtime contracts, read
`src/core/*.ts` in the package — they're small, documented files, and if
you're implementing one you're working on the engine, not a workspace.
