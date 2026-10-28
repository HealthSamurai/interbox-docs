# `/core`

```ts
import type { ... } from "@health-samurai/interbox/core";
```

Pure stage contracts shared by the SDK (descriptors, authoring) and the
engine (factories, runtime) — types + light pure helpers only, no
`drizzle`/`pg`, so a workspace's bundle stays lean.

**A workspace author rarely imports from `/core` directly.** Everything you
use day-to-day — `defineStep`, `StepContext`, `env()`, the builtin config
types — is exported from the package root, `/chain` or `/builtins`, and a
step's parameter types are inferred for you. This subpath exists so the engine
and the SDK share one set of type definitions and can't drift.

What's in it, by category:

| category | types | who cares |
|---|---|---|
| authoring values | `Str`, `Num`, `Resolved` | you, occasionally — see [Env & Config](../concepts/env-and-config.md) |
| terminology | `ConceptMapMatch`, `ConceptMapContext` | you, occasionally — what a step's `ctx.translate` and `ctx.translateFor` take and answer, see [Steps](steps.md#terminology) |
| 1.x mapper contracts | `MapperDefinition`, `MapperContext`, `MapperBatchContext`, `MapperSource`, `ParserOutputMap`, `ParserType` and their siblings | the 1.x `defineMapper`, which the 2.0 engine does not run. `MapperBatchContext` is also the three terminology lookups a step's context carries |
| error taxonomy | `domainError`, `ERROR_GROUPS`, `ErrorGroup` | you — re-exported from the root, see [Errors](../concepts/errors.md) |
| payloads | `PayloadItem`, `PayloadBody`, `bodyFromBytes`, `bodyFromStream`, `concatChunks`, `PayloadBodyConsumed`, `ConfiguredPreprocessor`, `Preprocessor`, `PreprocessorDefinition` | you, on 1.x, when a source you define runs a `preprocess` chain or you declare a preprocessor — all but `concatChunks` and `ConfiguredPreprocessor` are re-exported from the root, the latter from `/builtins`; see [Preprocessing what a source read](index.md#preprocessing-what-a-source-read) and [Defining a preprocessor](index.md#defining-a-preprocessor) |
| 1.x stage runtime contracts | `SourceDefinition`/`SenderDefinition`/`ParserDefinition` + their `*Config`/`*Entry`/`*Factory`/`*Instance` siblings, `Runner` | the 1.x engine, except `SourceDefinition`, which a 1.x workspace implements through `defineSource` — see [Sources](index.md#sources) |
| shared names and keys | `checkPipelineName`, `byNumericId`, `resLeaseKey`, `RES_LEASE_PREFIX`, `ITEM_LEASE_PREFIX`, the lease-key SQL helpers and `SKIPPED_ATTR` | the engine and the [admin library](../ops/admin-scripts.md), so both read a pipeline name, a sender's lease and a unit's skip counts the same way |

Annotating a helper that takes a step's context needs no `/core` import. Take
only what the helper uses, so a step's `StepContext` and a row function's
`RowContext` both fit:

```ts
import type { StepContext } from "@health-samurai/interbox/chain";

async function resolveObservationCode(ctx: Pick<StepContext, "translate">, code: string) {
  return ctx.translate("obs-codes", code);
}
```

For the shapes of a step's context, see [Steps](steps.md). For the engine-side
runtime contracts, read `src/core/*.ts` in the package — they're small,
documented files, and if you're implementing one you're working on the engine,
not a workspace.
