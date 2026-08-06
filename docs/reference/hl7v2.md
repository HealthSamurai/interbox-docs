# `/hl7v2`

```ts
import {
  parseHl7v2,
  findSegment,
  getComponent,
} from "@health-samurai/interbox/hl7v2";
import type {
  HL7v2Message,
  HL7v2Segment,
  FieldValue,
} from "@health-samurai/interbox/hl7v2";
```

This subpath is **generated** (from the HL7v2 message types listed in
`scripts/regen-hl7v2.ts`) plus one hand-written parser module — it's a large
surface by symbol count, so this page is a map of what's here rather than a
field-by-field dump. Your editor's autocomplete over the generated types is the
day-to-day reference.

## What's exported

- **`types`** — the core shape: `FieldValue` (a field's value — a string, a
  repeating `FieldValue[]`, or a component record `{ [n]: FieldValue }`),
  `HL7v2Segment { segment: string; fields: Record<number, FieldValue> }`,
  `HL7v2Message = HL7v2Segment[]`, and `getComponent(field, ...path)` for
  walking into a field's components.
- **`fields`** — generated per-segment field accessors (e.g. `fromPID`,
  `fromMSH`) and datatype interfaces, so a mapper reads a segment's fields by
  name instead of numeric index.
- **`tables`** — generated HL7v2 coded-value tables (HL7 table 0001, 0004,
  …), importable as typed constants.
- **`messages`** — generated per-message-type builders/shapes (`BAR_P01`,
  `ORM_O01`, `ORU_R01`, `VXU_V04`, `SIU_S12` as of this writing).

## Adding a message type

The generated surface covers the segments, datatypes and tables reachable from
the message types it was generated for — nothing else. A segment outside that
set has no accessor at all, so supporting a new message means regenerating
rather than hand-writing one: add it to `MESSAGE_TYPES` in
`scripts/regen-hl7v2.ts` and run

```sh
bun scripts/regen-hl7v2.ts
```

which rewrites all four generated files in place. The script pins the codegen
version and explains the two post-processing steps it applies; the pin is
deliberately independent of this package's own `@atomic-ehr/hl7v2` dependency,
so regenerating types never changes how messages are parsed at runtime.
- **`parse`** — `parseHl7v2(message: string): HL7v2Message` (throws on
  malformed input) and the re-exported `findSegment` helper. This is the
  parser `hl7v2Parser` binds to (see [/builtins](builtins.md)); it's the
  package's single HL7v2 parsing surface — everything else goes through it
  rather than the underlying `@atomic-ehr/hl7v2` dependency directly.

## The spec itself

The types cover names and shapes; for optionality, repetition, table
bindings, and message structure, consult the HL7v2 standard for the version
your channel speaks. The package ships the spec data (v2.4/v2.5/v2.8.2) in
`hl7v2-reference/` as JSON — it also powers the bundled AI-assistant skills,
so an assistant working in your workspace answers spec questions from the
same source.
