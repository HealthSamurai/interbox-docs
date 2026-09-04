# Error taxonomy

Every ingestion failure the engine records carries a machine-readable `kind`
of the form `<group>/<specific>`, persisted to the inbound row's `error_kind`
column — so failures facet by cause family (a prefix match on `group`) as
well as by exact `kind`. This is what powers the dashboard's error-queue
faceting and triage.

## Groups

```ts
const ERROR_GROUPS = [
  "parse",
  "structure",
  "field",
  "type",
  "code",
  "unsupported",
  "source",
  "mapper",
  "system",
  "sender",
  "internal",
] as const;

type ErrorGroup = (typeof ERROR_GROUPS)[number];
```

| group | meaning |
|---|---|
| `parse` | payload-level: not HL7 at all, MSH header missing/broken |
| `structure` | message shape: required segment absent or unusable |
| `field` | segment present, required field empty |
| `type` | field present, value violates its declared HL7 datatype |
| `code` | coded value outside its value set / no concept mapping |
| `unsupported` | valid message the engine has no converter for |
| `source` | a parser threw — our code broke, not the data. `parse/...` is the opposite: a fault the parser understood well enough to name |
| `mapper` | a mapper threw something the engine could not classify |
| `system` | a read a mapper made against an external API failed — the message is fine |
| `sender` | a write to the destination failed — the message is fine |
| `internal` | invariant violations — bugs, not sender data |

`source`, `mapper`, `system` and `sender` name the **stage** rather than a fault in
the data — "the message is bad" and "our code or a server broke" are different
triage. The first two are ours; the last two are external, and they That matters when the same server is on both sides — a workspace
reading Aidbox during mapping and writing Aidbox from the sender produces
`system/aidbox_unreachable` and `sender/aidbox_unreachable`, the same words for
opposite directions, and the group is the only thing that distinguishes them.

## Raising one

A mapper (or any stage implementation) raises a classified failure with
`domainError`:

```ts
import { domainError } from "@health-samurai/interbox";

throw domainError(
  "unsupported",
  "message_type",
  "no converter registered for ORU^R01 with this OBX pattern",
);
// => Error, .name === "InterboxException", .kind === "unsupported/message_type"
```

```ts
function domainError(group: ErrorGroup, kind: string, message: string): Error;
```

The engine duck-types on `.name === "InterboxException"` (not
`instanceof`, since the SDK and engine may be bundled from different module
graphs) and persists `.kind` to `error_kind`. Throwing a plain `Error`
instead still fails the message, but the engine can't classify it beyond a
generic bucket — always prefer `domainError` for anything a mapper can
anticipate.
