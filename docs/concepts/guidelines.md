# Integration guidelines

Practical advice for building a production integration on Interbox — the
things the compiler can't catch.

## Scope from your samples, handle per the spec

Real traffic decides *what* you map — there's no point converting fields
your senders never populate, and no way to test them if you do. Start from
representative samples and map what's actually there.

The spec decides *how* you map it. Samples under-represent variation within
the fields you did choose: a patient with one name in every sample can still
arrive with three name repetitions, a component you've never seen populated,
or a table value your samples didn't cover — same sender, next month. So for
each field you take on, check its datatype components, repetition, and table
binding in the standard rather than assuming the sample's shape is *the*
shape. The generated accessors in [/hl7v2](../reference/hl7v2.md) give you
names and types in the editor.

And make what you *didn't* map explicit. Return `undefined` for message
types the pipeline genuinely shouldn't process; throw
`domainError("unsupported", …)` for ones that should be visible in the error
queue until someone decides. Silently dropping data a sender starts sending
is the only wrong option.

Same on the FHIR side: the generated types in [/fhir](../reference/fhir.md)
enforce field names and shapes at compile time, but cardinality and code
bindings come from the [R4 spec](https://hl7.org/fhir/R4/) — a `1..1` field
is required, a bound coded field expects one of its value set's codes.

## Classify failures

Throw `domainError(group, kind, message)` for anything your mapper can
anticipate — a plain `throw` collapses into a generic bucket in the error
queue, while classified errors get bucketed automatically by triage. See
[Errors](errors.md) for choosing the group.

Two habits that pay off later:

- Put the **offending value and its position** in the message —
  `"PV1.2 'X' is not a valid patient class"`. Error inspection prints the raw
  message by position, so a good message makes the diagnosis one read.
- Return `undefined` from `map()` for messages you *intentionally* don't
  process. A skip is not an error; reserve throwing for actual failures.

## Terminology lives in ConceptMaps, not in mapper code

Resolve local codes through `ctx.translate(conceptMapId, code)` rather than
hardcoding code→LOINC tables in the mapper. Unmapped codes then surface as
`code/unmapped_*` errors and get resolved **at runtime** — through the
dashboard, no code change, no reload.

Two things to know about how this behaves:

- A message errors on its *first* unmapped code. An ORU panel with six local
  codes needs all six resolved before one retry clears it.
- Each sender has its own ConceptMap, deliberately — two facilities can map
  the same local code to different targets. Resolving a code for one channel
  doesn't affect another.

## Design for resend

Delivery is at-least-once: transient sender failures retry, and failed
messages get re-queued during triage. So:

- Key resources on **business identifiers** (MRN, filler order number, visit
  number) — stable across resends — never on anything generated per message.
- After changing identity logic, resend a message and check you updated one
  resource instead of creating a duplicate.

## The edit loop

1. Feed a sample message through the dashboard: **Sources → Simulate
   message** runs the real parse → map → send pipeline, no MLLP client
   needed.
2. Fix the mapper.
3. **A code fix needs a reload before retry** — the engine runs a bundled
   copy of your workspace, so retrying immediately re-hits the old code. In
   local docker-compose dev the reload is automatic (~2s poll); otherwise
   trigger it from the dashboard ("Pull now"). ConceptMap resolves and queue
   operations take effect without a reload.
4. Retry the specific failed messages and verify they clear.

## Keep the workspace shaped like the template

- One module per message type (`mappers/v2-to-fhir/messages/oru-r01.ts`) and
  per segment converter (`segments/pid-patient.ts`). Errors are reported by
  message type and field position, so this layout makes every diagnosis point
  at one file.
- One pipeline per channel/facility. Channel-specific behavior belongs in
  mapper `config` and per-sender ConceptMaps, not in `if (facility === …)`
  branches.
- Deployment values and secrets through `env()` — never `process.env` in a
  pipeline module, never a hardcoded host or credential.

## Test the mapper, not the engine

Unit-test mappers with `bun test`: parse a fixture with `parseHl7v2`, call
the mapper's `map()` directly, assert on the emitted resources. Call
`PipelineRegistry.clear()` / `MapperRegistry.clear()` in `afterEach` —
registration is a module side effect and leaks between tests otherwise.
The engine's queueing, batching, and retries aren't yours to test.

## Mind the PHI

Message payloads, error-queue inspection output, and FHIR query results all
carry PHI. Keep them out of logs, commits, and fixture files — synthesize
test messages instead of copying production ones.
