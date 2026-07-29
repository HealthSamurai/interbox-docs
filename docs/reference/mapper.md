# Mapper authoring

```ts
import { defineMapper, MapperRegistry } from "@health-samurai/interbox";
```

`defineMapper` is exported from the root and re-exported (with all its
types) from `@health-samurai/interbox/core`'s mapper types. Unlike
sources/senders/parsers, mappers are the one stage kind a workspace **defines
itself** — see [Stages](../concepts/stages.md) for why.

## `defineMapper`

```ts
function defineMapper<K extends ParserType, Cfg = unknown, Out = unknown>(
  spec: MapperSpec<K, Cfg, Out>,
): MapperDescriptor<K, Cfg>;

interface MapperSpec<K extends ParserType, Cfg, Out> {
  readonly type: string;
  // pass a parser descriptor, e.g. hl7v2Parser — types `input` below
  readonly parser: { readonly type: K };
  map(
    config: Cfg,
    input: ParserOutputMap[K],
    ctx: MapperContext,
  ): Out | undefined | Promise<Out | undefined>;
}
```

Calling `defineMapper(...)` **registers** the definition into
`MapperRegistry` immediately (for the engine to read back) and returns a
callable **descriptor** — calling *that* produces a `ConfiguredMapper` for a
pipeline's `.mapper()`:

```ts
const v2ToFhir = defineMapper({
  type: "v2-to-fhir",
  parser: hl7v2Parser,
  map(config, input, ctx) {
    // input: parsed HL7v2 segments
    // return a FHIR resource, an array, or undefined to skip
  },
});

pipeline("hl7-to-aidbox")
  .source(/* ... */)
  .mapper(v2ToFhir(/* config, if Cfg isn't unknown */));
```

`map` may return `undefined` (skip — no resource produced), a single
resource, an array of resources, or a `Promise` of either. Throw a
`domainError` (see [Errors](../concepts/errors.md)) for anything the engine
should classify rather than treat as an internal bug.

## `MapperRegistry`

```ts
const MapperRegistry: {
  mappers: Map<string, MapperDefinition>;
  register(def: MapperDefinition): void;  // throws on a duplicate `type`
  get(type: string): MapperDefinition | undefined;
  getAll(): MapperDefinition[];
  clear(): void;                          // test-only
};
```

The engine reads this registry back from the workspace bundle at load time
to know which mappers exist and which parser each one consumes.

## Supporting types

```ts
interface ConfiguredMapper<MK extends ParserType = ParserType> {
  readonly type: string;
  readonly parser: MK;
  readonly config: unknown;
}

interface MapperDescriptor<MK extends ParserType, Cfg> {
  readonly type: string;
  readonly parser: MK;
  // config is optional only when Cfg has no required fields
  (...config: {} extends Cfg ? [config?: Cfg] : [config: Cfg]): ConfiguredMapper<MK>;
}

interface MapperDefinition<
  K extends ParserType = ParserType,
  Cfg = unknown,
  Out = unknown,
> {
  readonly type: string;
  // parser type the engine uses to parse inbound messages before map()
  readonly parser: K;
  map(
    config: Cfg,
    input: ParserOutputMap[K],
    ctx: MapperContext,
  ): Out | undefined | Promise<Out | undefined>;
}

// Runtime services the engine hands a mapper. Terminology lookups resolve against
// the engine-owned ConceptMap store; the workspace never touches the DB directly.
interface MapperContext {
  translate(conceptMapId: string, code: string): Promise<MappedCode | undefined>;
  readonly source: MapperSource;
}

// The inbound message being mapped.
interface MapperSource {
  readonly format: string;     // parser/format it arrived as, e.g. "hl7v2"
  readonly id: string;         // inbound row id, stringified (it is a bigserial)
  readonly pipeline: string;
  readonly receivedAt: string; // ingest time, ISO-8601
}

// A resolved terminology mapping (ConceptMap target).
interface MappedCode {
  targetCode: string;
  targetDisplay?: string;
}

// Parser type -> the parsed value the engine hands map(). Extend via declaration
// merge if a future built-in parser adds another key.
interface ParserOutputMap {
  hl7v2: HL7v2Segment[];
}

type ParserType = keyof ParserOutputMap;
```

`ParserOutputMap` is the type-level link between a source's parser and what a
mapper attached to it receives as `input` — it's why `.mapper()` can
type-check `input` against the exact parser the mapper declared, and why
[Pipelines](../concepts/pipelines.md)'s `SP` tracking works.

`ctx.source` identifies the message currently being mapped. The engine records the
same facts on every queue row this message produces, and exposes them here so you
can build output that refers to the message — most often a FHIR `Provenance`, via
[`provenanceFor`](#provenancefor--a-fhir-provenance-for-what-a-mapper-produced).

Prefer `ctx.source.receivedAt` over `new Date()` for anything you embed in a
resource. It is the inbound row's ingest time, so it does not move between runs:
re-mapping a message (a Retry) then reproduces byte-identical resources, and the
sender's content hash lets them skip instead of rewriting the destination.

## `provenanceFor` — a FHIR Provenance for what a mapper produced

```ts
function provenanceFor(
  ctx: Pick<MapperContext, "source">,
  resources: readonly Resource[],
  overrides?: Partial<Provenance>,
): Provenance | undefined;
```

Interbox records which inbound message produced every resource, but keeps it in the
queue row's own `source` column — nothing interbox-shaped is written into your
resources or sent to your FHIR server. If you want the destination to *hold*
provenance, emit it as a resource from your mapper:

```ts
map(cfg, msg, ctx) {
  const out = [patient, encounter, observation];
  return [...out, provenanceFor(ctx, out)];
}
```

```json
{
  "resourceType": "Provenance",
  "id": "ib-hl7v2-42",
  "recorded": "2026-07-29T10:00:00.000Z",
  "agent": [{ "who": { "display": "Interbox" } }],
  "target": [
    { "reference": "Patient/p1" },
    { "reference": "Encounter/e1" },
    { "reference": "Observation/o1" }
  ]
}
```

No engine machinery stands behind this — it is a plain function, and what it
returns is enqueued like any other mapped resource. Because `target` holds
ordinary FHIR references, the sender's closure walk already treats the targets as
this resource's dependencies and ships them in the same bundle.

- **The id is derived from the message** (`ib-<format>-<id>`), so re-mapping
  overwrites the message's own record instead of accumulating duplicates.
- **`recorded` comes from `ctx.source.receivedAt`**, not the clock, so a Retry
  reproduces the resource byte-for-byte rather than churning the destination.
- **Resources without an `id` are skipped**, and if that leaves no targets the
  function returns `undefined` — FHIR requires at least one, and an untargeted
  Provenance is rejected as bad data, failing the whole message.
- **`overrides` is shallow-merged last**, so a real `agent` or `activity` costs one
  field while `target` and `id` stay derived.

If you supply your own `agent`, keep `who` as a `display` unless the resource it
references actually exists at the destination: a `who: { reference: … }` is
collected as a dependency of the Provenance, and an unresolvable one blocks the
bundle from ever being sent.
