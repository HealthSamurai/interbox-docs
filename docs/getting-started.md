# Getting Started

## Start from the workspace template

Don't start an empty project. [`interbox-workspace`](https://github.com/HealthSamurai/interbox-workspace)
is the reference pipeline template — fork it, adjust for your own data, and
deploy:

```sh
git clone https://github.com/HealthSamurai/interbox-workspace.git
cd interbox-workspace
cp .env.example .env
docker compose up
```

The stack boots without a `.env` — every setting `docker-compose.yaml` reads has
a built-in default (`AIDBOX_CLIENT_SECRET`, `INTERBOX_VERSION`, …) — but copy it
anyway: that file is where the template's recommended local settings live,
including `INTERBOX_WORKSPACE_ACCESS=apply`, which is what lets you edit
pipelines from the dashboard (see [The Workspace](ops/workspace.md)). Without it
the Repository tab is read-only.

There is no license key to paste either way: the dashboard's first-run portal
OAuth flow signs both the Interbox and Aidbox licenses for you — the pipeline
just stays paused (with an activation screen) until you click through it once.

Open `http://localhost:3001` for the dashboard, then send HL7v2 over MLLP to
`localhost:2575` and watch the units flow through to the FHIR server.

No MLLP client handy? The template ships a traffic generator that sends
synthetic HL7v2 to that port: run `bun run hl7v2:simulator` from the workspace
root and open its UI. See its README in `utils/hl7v2-simulator/`.

`.env` is also where you override the rest — pinning `INTERBOX_VERSION`, setting
a real `AIDBOX_CLIENT_SECRET`, or pointing at a private registry.

Working on the workspace's code locally needs [Bun](https://bun.sh) 1.4 or newer.
Older Bun cannot read the template's `bun.lock`: `bun install` warns that it is
ignoring the lockfile, resolves every dependency again and rewrites `bun.lock`,
and `bun install --frozen-lockfile`, as CI runs it, fails.

```sh
bun install
bun run typecheck
bun test
```

## How a workspace is laid out

```
src/
  index.ts             # imports ./pipelines, re-exports ChainRegistry for the engine
  mappers/
    v2-to-fhir/…        # your mapping steps
  pipelines/
    index.ts           # imports every pipeline module
    hl7-to-aidbox/index.ts
```

The entry imports the pipeline modules, which declare their pipelines as a side
effect, and hands the engine the registry they were declared into:

```ts
// src/index.ts
import "./pipelines";
export { ChainRegistry } from "@health-samurai/interbox/chain";
```

The engine reads your pipelines from this export, not from its own copy of the
SDK, because the bundle carries its own. A workspace that declares external
systems with `defineSystem` also exports `SystemRegistry` from
`@health-samurai/interbox` (see [Systems](concepts/systems.md)).

## The pipeline

```ts
// src/pipelines/hl7-to-aidbox/index.ts
import { env } from "@health-samurai/interbox";
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
import { mllpSource, pipeline, postgresStore } from "@health-samurai/interbox/chain";
import { hl7v2Parser } from "@health-samurai/interbox/hl7v2";
import { v2ToFhir } from "../../mappers/v2-to-fhir/index.ts";

pipeline("hl7-to-aidbox")
  .source(mllpSource({ host: env("MLLP_HOST"), port: env("MLLP_PORT") }))
  .step((raws) => raws.withSearchText((raw) => raw))
  .store(postgresStore({ codec: "text" }), {
    index: { message_type: "btree", event_type: "btree", patient_id: "btree" },
    search: "trgm",
  })
  .step(hl7v2Parser())
  .step(v2ToFhir)
  .step(fhirItems())
  .step(skipUnchanged())
  .sender(
    aidbox({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  );
```

Read it top to bottom:

1. **`mllpSource`** listens for MLLP frames. Each frame is one input.
2. **The step before the store** makes the raw message the unit's searchable
   text, so the dashboard's search finds it from the moment it arrives.
3. **`.store()`** stores each message as text and creates its unit, status
   `received`. Only then does the source answer `AA`. `index` declares the
   attributes the dashboard filters on, and `search: "trgm"` indexes the
   searchable text.
4. **`hl7v2Parser()`** parses the stored text. A message it cannot parse ends
   its unit at `error` with `parse/not_hl7` or `parse/missing_msh`. It records
   `message_type`, `event_type`, `patient_id` and a few more attributes on the
   unit.
5. **`v2ToFhir`** is your mapping step: each message becomes the FHIR resources
   it describes, one item each.
6. **`fhirItems()`** gives each resource the key (`Type/id`), references and
   content hash the Aidbox sender needs, and **`skipUnchanged()`** drops a
   resource identical to the version already queued or delivered.
7. **`aidbox()`** sends the items to Aidbox. When the last item of a unit is
   delivered, the unit becomes `sent`.

The store comes right after the source, before the parser, so the raw message
is what is kept. A Retry after you fix a parsing problem then parses the
original again.

The mapping step lives with your other mapping code:

```ts
// src/mappers/v2-to-fhir/index.ts
import { domainError } from "@health-samurai/interbox";
import { defineStep, type Batch } from "@health-samurai/interbox/chain";
import type { Patient, Resource } from "@health-samurai/interbox/fhir";
import { findSegment, getComponent, type HL7v2Message } from "@health-samurai/interbox/hl7v2";

function patientOf(msg: HL7v2Message): Patient {
  const pid = findSegment(msg, "PID");
  const id = getComponent(pid?.fields[3]);
  if (id === undefined) throw domainError("field", "missing", "PID-3 is empty");
  return { resourceType: "Patient", id, name: [{ family: getComponent(pid?.fields[5], 1) }] };
}

export const v2ToFhir = defineStep("v2-to-fhir", (msgs: Batch<HL7v2Message>) =>
  msgs.flatMap((msg): Resource[] => [patientOf(msg)]),
);
```

A step takes a `Batch` of rows and returns the `Batch` its methods made;
`flatMap` turns each message into its resources. A `domainError` ends the
message's unit at `error` with the kind `field/missing`. Any other throw is
treated as transient, and the unit is tried again. See [Pipelines](concepts/pipelines.md)
for the methods of a `Batch`, and [Steps, store and senders](concepts/stages.md)
for what a step's context offers.

Every part is referenced by value, so the types are checked at compile time:
each step's input is the previous step's output, a store's codec refuses a row
type it cannot hold, and `aidbox()` accepts only the output of `fhirItems()`.
Deployment values (`MLLP_HOST`, `AIDBOX_URL`, secrets) come from `env()`,
resolved by the engine from its own environment rather than when the pipeline
is declared: the source's when the workspace loads and the source starts,
Aidbox's as each send starts — see [Env & Config](concepts/env-and-config.md).

Without a step that sets the unit's event time, versions of one resource are
delivered in the order their messages arrived. To order them by the message's
own time, MSH-7, add a step after the parser with `fromMsh7` from
`@health-samurai/interbox/hl7v2`, naming the sending system's time zone for the
times that carry no offset:

```ts
  .step(hl7v2Parser())
  .step((msgs) => msgs.withOrder((msg) => fromMsh7(msg, "America/New_York")))
  .step(v2ToFhir)
```

## How the engine loads it

**The engine bundles `src/index.ts` itself** — a workspace has no `build`
step of its own. It takes one `INTERBOX_WORKSPACE_GIT_URL`: a remote URL
(clones + `bun install`s, for deploy) or a local `file://`/bare path (bundles
the live working tree in place, no clone/install, for a fast edit →
hot-reload loop). A pipeline change reloads into its **own runtime**, not by
restarting `interbox` itself: in local dev the engine polls the workspace
(`INTERBOX_WORKSPACE_POLL_MS`, 2s in the template's `docker-compose.yaml`)
and swaps workers in place; elsewhere, trigger the same reload from the
dashboard ("Sync now"). A reload that fails leaves the running pipelines as
they were, and the dashboard shows why it failed.

The URL scheme only picks a default. What differs between the two is the
**lifecycle**, set by `INTERBOX_WORKSPACE_MODE`: `clone` means the engine owns a
copy it may fetch, check out and reset, while `worktree` means it bundles the
directory as it stands and never checks anything out or resets anything —
because that directory belongs to you, not to the engine. Since
`file:///path/to/repo` is a git remote like any other,
`INTERBOX_WORKSPACE_MODE=clone` runs a local repository exactly as a deployment
runs a remote one.

What the dashboard may **do** to a workspace is a separate question, set by
`INTERBOX_WORKSPACE_ACCESS`. Both modes can be edited from the browser; where
the edit goes differs — a clone takes commits pushed to a branch, a worktree
takes saves to disk. See [The Workspace](ops/workspace.md) for both settings,
how updates reach a running engine, and what happens when two people edit the
same file.
