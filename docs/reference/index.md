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

plus the re-exported types `ConfiguredMapper`, `MappedCode`, `MapperContext`,
`MapperDefinition`, `MapperDescriptor`, `ParserOutputMap`, `ParserType`.
