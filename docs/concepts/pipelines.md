# Pipelines

`pipeline(name)` both **creates and registers** a pipeline declaration in one
call — the returned builder *is* the declaration. Chained `.source()`/
`.mapper()`/`.sender()` calls mutate the same registered object, so it doesn't
matter whether the engine reads `PipelineRegistry` before or after a module
finishes evaluating; by the time any workspace module has fully run, every
pipeline it declared is in the registry.

```ts
import { pipeline, env } from "@health-samurai/interbox";
import {
  mllpSource,
  aidboxSender,
  hl7v2Parser,
} from "@health-samurai/interbox/builtins";
// a workspace-defined mapper (defineMapper)
import { v2ToFhir } from "./mappers/v2-to-fhir";

pipeline("hl7-to-aidbox")
  .source(
    mllpSource({
      id: "mllp-default",
      port: env("MLLP_PORT"),
      parser: hl7v2Parser(),
    }),
  )
  .mapper(v2ToFhir())
  .sender(
    aidboxSender({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  );
```

## The type-level guarantee: mappers can't outrun their sources

`PipelineBuilder` tracks, at the type level, the union of parser types
produced by the sources added so far (`SP`). `.mapper()` requires its
mapper's parser to be a member of `SP` — added *after* a matching `.source()`
call. Add a mapper before any source (or before a source with a matching
parser), and TypeScript reports it at the `.mapper()` call site instead of
letting it fail silently at runtime:

```
Property 'interbox: no source in this pipeline produces parser "hl7v2" —
add a matching .source() before .mapper()' is missing …
```

This is enforced structurally (an intersection type that resolves to a
readable sentinel object on mismatch, `unknown` — a no-op — on match), not by
a runtime check, so there's no cost outside the type checker.

## What gets stored

Each stage call appends a plain declaration object to the pipeline — not the
descriptor/builder value itself:

```ts
interface SourceDecl {
  type: string;
  id: string;
  config: Record<string, unknown>;
  parser: { type: string; config: unknown };
}

interface MapperDecl {
  type: string;
  config: unknown;
}

interface SenderDecl {
  type: string;
  config: unknown;
}

interface PipelineDecl {
  readonly name: string;
  readonly sources: SourceDecl[];
  readonly mappers: MapperDecl[];
  readonly senders: SenderDecl[];
}
```

This is the shape the engine actually reads back — it's why you can also
build a pipeline from raw object literals (as in
[Getting Started](../getting-started.md)) instead of the typed descriptors;
the descriptors just add compile-time shape-checking and the source/mapper
parser-matching guarantee above.

## `PipelineRegistry`

```ts
const PipelineRegistry: {
  SDK_VERSION: string;                      // re-exported for the engine's compat check
  pipelines: Map<string, PipelineDecl>;
  register(p: PipelineDecl): void;          // throws on a duplicate name
  get(name: string): PipelineDecl | undefined;
  getAll(): PipelineDecl[];
  clear(): void;                            // test-only: reset all registered pipelines
};
```

A workspace's `src/index.ts` re-exports this object verbatim
(`export { PipelineRegistry } from "@health-samurai/interbox"`) so the engine
has a single read path regardless of whether the workspace is loaded as a
local path or a bundled git clone. Two pipelines can't share a name —
`register()` throws `duplicate pipeline name: <name>`.

See [Reference → root](../reference/index.md) for the full exported-type list
(`ConfiguredSource`, `SourceDescriptor`, `ConfiguredMapper`, etc.).
