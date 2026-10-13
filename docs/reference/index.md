# Root — `@health-samurai/interbox`

## Subpaths

| import | what it is |
|---|---|
| `@health-samurai/interbox` | the authoring surface: `pipeline`, `env`, `defineMapper`, error taxonomy (below) |
| `@health-samurai/interbox/core` | shared stage contracts — rarely imported directly, see [/core](core.md) |
| `@health-samurai/interbox/builtins` | typed descriptors for the engine's built-in stages — [/builtins](builtins.md) |
| `@health-samurai/interbox/hl7v2` | generated HL7v2 domain model + parser — [/hl7v2](hl7v2.md) |
| `@health-samurai/interbox/fhir` | FHIR R4 core types + profile helpers — [/fhir](fhir.md) |
| `@health-samurai/interbox/fhir/4.0.1` | same, pinned to the 4.0.1 subpath explicitly |
| `@health-samurai/interbox/fhir/4.0.1/profiles` | generated profile classes |
| `@health-samurai/interbox/fhir/4.0.1/profile-helpers` | runtime helpers profile classes call |

## Root exports

### Pipeline authoring — see [Pipelines](../concepts/pipelines.md)

```ts
// creates AND registers the pipeline; chain .source()/.mapper()/.sender()
function pipeline(name: string): PipelineBuilder;

const PipelineRegistry: {
  SDK_VERSION: string;
  pipelines: Map<string, PipelineDecl>;
  register(p: PipelineDecl): void;          // throws on a duplicate name
  get(name: string): PipelineDecl | undefined;
  getAll(): PipelineDecl[];
  clear(): void;                            // test-only
};
```

The declaration types (`PipelineDecl`, `SourceDecl`, `MapperDecl`,
`SenderDecl`) and the descriptor types (`SourceDescriptor`,
`ConfiguredSource`, `SenderDescriptor`, `ConfiguredSender`,
`ParserDescriptor`, `ConfiguredParser`) are also exported. You rarely write
these by hand — calling `mllpSource(...)` / `aidboxSender(...)` /
`hl7v2Parser(...)` produces correctly-typed values (see
[/builtins](builtins.md)); the decl shapes are shown in
[Pipelines → What gets stored](../concepts/pipelines.md#what-gets-stored).

### `SDK_VERSION`

```ts
const SDK_VERSION: string; // sourced from this package's own package.json
```

Carried into the workspace bundle via `PipelineRegistry.SDK_VERSION` so the
engine can check compatibility at load time.

### Env — see [Env & Config](../concepts/env-and-config.md)

```ts
function env(name: string, fallback?: string): EnvRef;
function isEnvRef(value: unknown): value is EnvRef;

interface EnvRef {
  readonly $env: string;
  readonly $default?: string;
}

type Str = string | EnvRef;
type Num = number | EnvRef;
```

### Errors — see [Errors](../concepts/errors.md)

```ts
function domainError(group: ErrorGroup, kind: string, message: string): Error;

const ERROR_GROUPS: readonly [
  "parse",
  "structure",
  "field",
  "type",
  "code",
  "unsupported",
  "internal",
];

type ErrorGroup = (typeof ERROR_GROUPS)[number];
```

### Mapper authoring — see [Mapper authoring](mapper.md)

```ts
function defineMapper<K extends ParserType, Cfg = unknown, Out = unknown>(
  spec: MapperSpec<K, Cfg, Out>,
): MapperDescriptor<K, Cfg>;

const MapperRegistry: {
  mappers: Map<string, MapperDefinition>;
  register(def: MapperDefinition): void;
  get(type: string): MapperDefinition | undefined;
  getAll(): MapperDefinition[];
  clear(): void;
};
```

plus [`provenanceFor`](mapper.md#provenancefor--a-fhir-provenance-for-what-a-mapper-produced)
and the re-exported types `ConfiguredMapper`, `MappedCode`, `MapperContext`,
`MapperDefinition`, `MapperDescriptor`, `MapperSource`, `ParserOutputMap`,
`ParserType`.

### Sources

A source you define with `defineSource` receives a `SourceContext`: `writeBatch`
to hand messages to the pipeline, `state` to remember what it has already taken,
and [`preprocess`](#preprocessing-what-a-source-read) to split or unpack bytes it
read. The source reads its input itself — a directory, an HTTP endpoint, a
queue — with whatever client suits it. A source logs with `console`, like every
stage — see [Logging](#logging):

```ts
interface SourceContext<T> {
  writeBatch(batch: T[]): Promise<unknown>;
  state: SourceStateStore;
  preprocess(
    chain: readonly (ConfiguredPreprocessor | Preprocessor)[],
    items: AsyncIterable<PayloadItem> | readonly PayloadItem[],
    limits?: { maxInputBytes?: number; maxExpandedBytes?: number; maxItems?: number },
  ): AsyncIterable<PayloadItem>;
}
```

#### Preprocessing what a source read

`preprocess` runs a chain over items your source built. An entry is either a
descriptor — the engine's built-in `unpack`, `hl7v2Batch` and `lines` from
[`/builtins`](builtins.md#preprocessors), the same stages `sftpSource` runs, or
one you declared with [`definePreprocessor`](#defining-a-preprocessor) — or a
plain function, and the two mix freely; entries run in the order you list
them:

```ts
type Preprocessor = (items: AsyncIterable<PayloadItem>) => AsyncIterable<PayloadItem>;

interface PayloadItem {
  name: string;
  body: PayloadBody;
}

interface PayloadBody {
  bytes(): Promise<Uint8Array>;             // reads the body once and keeps it
  stream(): ReadableStream<Uint8Array>;     // readable once, unless bytes() ran first
  readonly size?: number;
}

function bodyFromBytes(bytes: Uint8Array): PayloadBody;
function bodyFromStream(
  source: ReadableStream<Uint8Array>,
  size?: number,
  budget?: { charge(newlyAllocatedBytes: number): void },  // charged per chunk bytes() reads; a throw rejects bytes()
): PayloadBody;

class PayloadBodyConsumed extends Error {}  // name: "InterboxPayloadBodyConsumed"
```

- **The chain is checked on every call.** Each descriptor's config is
  validated the way the workspace load validates an `sftpSource` chain, and a
  type the engine does not know is refused by name. A refused chain throws
  from the `preprocess` call itself, before any item is read. A function entry
  is taken as it is.
- **Nothing is read until you iterate**, and items flow one at a time: the
  first record of a `lines` chain reaches you before the file has been read to
  the end. The chain runs once for each item you pass in, so everything it
  emits is counted against the item it came from.
- **What each item produces is capped.** `maxExpandedBytes` (default 16 MiB)
  bounds the bytes the chain finally emits for one item you passed in, and
  `maxItems` (default 10 000) the number of items. Both are counted outside the
  stages, on the chain's output only: an item as it is emitted, bytes as you
  read each body, through `bytes()` or `stream()`. Nothing is lifted for a
  streaming chain — `[lines()]` over a big file needs both raised. Over either
  cap the iteration throws `PayloadBudgetExceeded`, and the chain is not pulled
  again: a later step of the same iteration throws the same error.
- **Each item you pass in is bounded on its own when a stage holds it whole.**
  `unpack` and `hl7v2Batch` read an item into memory before they split it;
  `maxInputBytes` (default 16 MiB) is the most any one item you passed in may
  hold, counted as it is read, and past it the iteration throws
  `PayloadRejected` naming that item. The items are not summed: two 10 MiB
  files in one call both pass under the default. With an empty chain the items
  come back to you, and it is your `bytes()` call on one that throws. A chain
  that starts with `lines` never holds an item whole, so this bound never
  applies to it.
- **Stopping early releases what `preprocess` took.** Leave the loop with
  `break`, call the iterator's `return()`, or let an error end it, and every
  item body it took and did not read to the end is cancelled — a stream you
  opened is released rather than held open. An array is taken whole at the first step, so every item in it is covered. An
  async iterable is taken one item at a time: `preprocess` calls its
  `return()`, and items it had not yielded yet are never seen, so release
  those in the iterable's own `finally`. When the chain runs to its end,
  nothing is cancelled.
- **Read what you need inside the loop.** A cancelled body reads as zero
  bytes, with no error. With an empty chain the items you receive carry the
  bodies you passed in, so one kept past an early stop and read afterwards
  resolves to zero bytes; so does a body of your own whose `stream()` returns
  the same stream each time. A `bodyFromStream` body is not readable again
  once `preprocess` has taken it, early stop or not: its stream is gone, and
  reading it throws `PayloadBodyConsumed`.
- **A body is read once.** Calling `stream()` twice, or `stream()` while
  `bytes()` is reading, throws `PayloadBodyConsumed`. That is a bug in the code
  reading the body, not bad input, so `payloadErrorName` returns `undefined`
  for it.

Classify a failure with `payloadErrorName(err)`, never `instanceof`: your
workspace is bundled with its own copy of the SDK, so an error the engine's
stages raise is not an instance of the class your code imports.

#### Defining a preprocessor

```ts
import { definePreprocessor } from "@health-samurai/interbox";

interface PreprocessorDefinition<K extends string = string, Cfg = Record<string, unknown>> {
  readonly type: K;
  prepareConfig?(config: Record<string, unknown>): Record<string, unknown>;
  create(config: Cfg): Preprocessor;
}

function definePreprocessor<K extends string, Cfg extends Record<string, unknown> = Record<string, unknown>>(
  definition: PreprocessorDefinition<K, Cfg>,
): (config?: Cfg) => ConfiguredPreprocessor<K>;

const PreprocessorRegistry: {
  get(type: string): PreprocessorDefinition | undefined;
  getAll(): PreprocessorDefinition[];
  // plus register() and clear(), as on the other registries
};
```

A plain function is enough where your own source's code builds the chain.
A chain that comes from a source's config — an `sftpSource` `preprocess` list,
or a list in your own source's config, like `labDrop`'s below — carries names
instead, because a function cannot travel in a config: `definePreprocessor`
registers the definition under its `type` and returns a factory whose call is
the `{ type, config }` descriptor that goes in the list, with the config you
passed, unchanged. Export `PreprocessorRegistry` from your workspace's
`src/index.ts`, as you do `MapperRegistry`, so the engine can resolve the type:

```ts
import { bodyFromBytes, definePreprocessor } from "@health-samurai/interbox";

export const stripNulls = definePreprocessor({
  type: "strip-nulls",
  prepareConfig: (config) => ({ replacement: " ", ...config }),
  create: (config) =>
    async function* (items) {
      const replacement = new TextEncoder().encode(String(config.replacement));
      for await (const item of items) {
        const bytes = await item.body.bytes();
        const out: number[] = [];
        for (const byte of bytes) {
          if (byte === 0) out.push(...replacement);
          else out.push(byte);
        }
        yield { name: item.name, body: bodyFromBytes(Uint8Array.from(out)) };
      }
    },
});

// in a pipeline: sftpSource({ ..., preprocess: [unpack(), stripNulls()] })
```

The engine runs `prepareConfig` when it loads the workspace, after `env()`
values are resolved — a throw refuses the load, naming the source. An
`sftpSource` runs it only then, and turns the prepared config into the
function the chain runs with `create` once, when the source starts. A
`preprocess` call handed the descriptor runs `prepareConfig` again, on every
call, so a descriptor your own source passes to `ctx.preprocess` needs a
`prepareConfig` that accepts its own output. Throw from `prepareConfig` naming
the refused field, never its value.

A stage yields each item as soon as it has it, and needs no limits of its own:
the engine counts what the chain emits, and stops pulling it past `maxItems`
or `maxExpandedBytes`. What a stage holds in memory while it works on one item
is its own to bound — `unpack`'s `maxEntryBytes` and `lines`'s
`maxRecordBytes` are that, for the built-ins. Raise a refusal as one of the
payload errors (`PayloadRejected`, …) when the input cannot ingest as it
stands, so a source records it rather than retrying it.

#### Validating a chain at load

```ts
import { normalizePreprocessChain } from "@health-samurai/interbox/builtins";

function normalizePreprocessChain(raw: unknown): ConfiguredPreprocessor[];
```

Returns the chain with each stage's config prepared — a built-in's defaults
filled in, a type you declared with `definePreprocessor` passed through its own
`prepareConfig` — or throws an `Error` naming the refused field, never its
value, or naming a stage type that is neither built in nor declared. A type you
declared under a built-in's name is prepared as yours, as the engine runs it.
Call it from your source's `prepareConfig` so a bad chain refuses the workspace
load instead of failing the first poll.

#### Example

A source that polls a local drop directory, reads each new file itself, and
runs it through the chain its config declares:

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { bodyFromStream, defineSource, payloadErrorName } from "@health-samurai/interbox";
import { normalizePreprocessChain } from "@health-samurai/interbox/builtins";
import type { ConfiguredPreprocessor } from "@health-samurai/interbox/builtins";

interface LabDropConfig {
  dir: string;
  preprocess: ConfiguredPreprocessor[];   // e.g. [unpack({ entryPattern: "*.hl7" }), stripNulls(), hl7v2Batch()]
}

export const labDrop = defineSource<"lab-drop", LabDropConfig, string>({
  type: "lab-drop",
  kind: "pull",

  prepareConfig(config) {
    return { ...config, preprocess: normalizePreprocessChain(config.preprocess) };
  },

  async start(cfg, ctx) {
    return async () => {
      for (const name of await readdir(cfg.dir)) {
        const path = join(cfg.dir, name);
        const info = await stat(path);
        if (!info.isFile()) continue;
        const version = `${info.mtimeMs}:${info.size}`;
        if ((await ctx.state.get(name)) === version) continue;
        const root = { name, body: bodyFromStream(Bun.file(path).stream(), info.size) };
        const messages: string[] = [];
        try {
          for await (const item of ctx.preprocess(cfg.preprocess, [root])) {
            messages.push(new TextDecoder().decode(await item.body.bytes()));
          }
        } catch (err) {
          if (payloadErrorName(err) === undefined) throw err;
          console.error("file refused", { name, reason: payloadErrorName(err) });
          await ctx.state.set(name, version);
          continue;
        }
        await ctx.writeBatch(messages);
        await ctx.state.set(name, version);
      }
    };
  },
});
```

A file the chain refuses is recorded and never read again; anything else
propagates and the next poll retries it.

The example has no stability gate: a file still being written upstream is
read as it stands, and read again once its size or modification time changes.
The built-in [`sftpSource`](builtins.md) waits for two listings to agree before
it reads a file.

## Logging

Every stage logs with `console` — a source, a mapper, a sender alike. There is
no logger to import and none on a stage's context. Each stage runs in its own
worker thread, and the engine captures that thread's `console.log`, `info`,
`warn`, `error`, `debug` and `trace` as JSON log lines, in the same stream as
the engine's own:

| call | level |
|---|---|
| `console.log`, `console.info` | `info` (30) |
| `console.warn` | `warn` (40) |
| `console.error` | `error` (50) |
| `console.debug`, `console.trace` | `debug` (20) |

At the default level, `info`, debug lines are not written; the engine's
`LOG_LEVEL` environment variable lowers it. `console.trace` writes no stack.

Every line carries the identity of the stage that wrote it:

| stage | fields |
|---|---|
| source | `stage: "source"`, `source` (its id), `type` (its source type) |
| mapper | `stage: "mapper"`, `mapper` (its type) |
| sender | `stage: "sender"`, `sender` (its type) |

A field of yours with one of those names is dropped and the stage's own value
stands, so a line cannot claim to come from another stage.

The arguments become the line like this:

- The message is formatted the way `console.log` formats it, so
  `console.log("read %d files from %s", count, dir)` works.
- A **trailing plain object** becomes the line's fields and is left out of the
  message. Put it last: an object anywhere else is formatted into the message,
  and so is a trailing array, `null`, or a class instance such as a `Date`.
- An **`Error`** becomes the `err` field — its type, message and stack — and is
  left out of the message. An `Error` that a `%s` in the format string consumes
  is formatted into the message instead. Only the first remaining `Error` is
  taken; a second one is formatted into the message. `console.error(err)` on its
  own uses the error's message as the line's message.
- A field of yours named `level`, `time`, `msg`, `pid`, `tid`, `hostname` or `v`
  is moved under a `console` object, so it cannot change the line's own level,
  time or message.

```ts
console.warn("delivery deferred", { key: "a.hl7", attempt: 2 });
console.error("cycle failed", new Error("connection reset"));
```

```json
{"level":40,"time":1790573959774,"pid":71776,"tid":1,"stage":"source","source":"lab-drop-1","type":"lab-drop","key":"a.hl7","attempt":2,"msg":"delivery deferred"}
{"level":50,"time":1790573959774,"pid":71776,"tid":1,"stage":"source","source":"lab-drop-1","type":"lab-drop","err":{"type":"Error","message":"connection reset","stack":"Error: connection reset\n    at …"},"msg":"cycle failed"}
```

Code the engine runs while it loads the workspace, outside any stage — a
source's `prepareConfig` and `describeConfig` — is not captured: its `console`
output is written as plain text, without a stage's identity.
