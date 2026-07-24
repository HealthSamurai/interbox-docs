# Getting Started

## Start from the workspace template

Don't start an empty project. [`interbox-workspace`](https://github.com/HealthSamurai/interbox-workspace)
is the reference pipeline template — fork it, adjust for your own data, and
deploy:

```sh
git clone https://github.com/HealthSamurai/interbox-workspace.git
cd interbox-workspace
docker compose up
```

No `.env` to copy first — every setting `docker-compose.yaml` reads has a
built-in default (`AIDBOX_CLIENT_SECRET`, `INTERBOX_VERSION`, …), and the image is
**licensed** but there's no manual key to paste in either: the dashboard's
first-run portal OAuth flow signs both the Interbox and Aidbox licenses for
you — the pipeline just stays paused (with an activation screen) until you
click through it once.

Open `http://localhost:3001` for the dashboard, then send HL7v2 over MLLP to
`localhost:2575` and watch messages flow through to the FHIR server.

No MLLP client handy? The dashboard's **Sources** screen has a "Simulate
message" panel on each non-facility source — paste raw HL7v2 (or drag in
`.hl7`/text files) and hit **Send**. It's not a dry run: the pasted message
goes through the exact same parse → mapper → sender path as a real MLLP
write, so it's a fine way to poke the pipeline before wiring up a real
sender.

Copy `.env.example` to `.env` only if you want to override a default —
pinning `INTERBOX_VERSION`, setting a real `AIDBOX_CLIENT_SECRET`, or pointing at a
private registry.

```sh
# postinstall runs `interbox sync` automatically, mirroring this package's
# skills/interbox/* into .claude/skills/interbox-*
bun install
bun run typecheck
bun test
```

## How a workspace is laid out

```
src/
  index.ts             # imports ./mappers and ./pipelines (registration side effects),
                        # re-exports { MapperRegistry, PipelineRegistry } for the engine
  mappers/
    index.ts           # imports every mapper module
    v2-to-fhir/…        # your defineMapper() implementations
  pipelines/
    index.ts           # imports every pipeline module
    hl7-to-aidbox/index.ts
```

```ts
// src/index.ts
import "./mappers";
import "./pipelines";
export { MapperRegistry, PipelineRegistry } from "@health-samurai/interbox";
```

```ts
// src/pipelines/hl7-to-aidbox/index.ts
import { env, pipeline } from "@health-samurai/interbox";
import {
  aidboxSender,
  hl7v2Parser,
  mllpSource,
} from "@health-samurai/interbox/builtins";
import { v2ToFhirMapper } from "../../mappers/v2-to-fhir/index.ts";

pipeline("hl7-to-aidbox")
  .source(
    mllpSource({
      id: "mllp-default",
      host: env("MLLP_HOST"),
      port: env("MLLP_PORT"),
      parser: hl7v2Parser({ skipZSegments: false }),
    }),
  )
  .mapper(v2ToFhirMapper())
  .sender(
    aidboxSender({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  );
```

Every stage is referenced **by value** (built-in descriptors + your own
mapper), so types — including the source↔mapper parser match, see
[Pipelines](concepts/pipelines.md) — are checked at compile time. Deployment
values (`MLLP_HOST`, `AIDBOX_URL`, secrets) come from `env()`, resolved by
the engine when it builds the runner config — see
[Env & Config](concepts/env-and-config.md).

**The engine bundles `src/index.ts` itself** — a workspace has no `build`
step of its own. It takes one `INTERBOX_WORKSPACE_GIT_URL`: a remote URL
(clones + `bun install`s, for deploy) or a local `file://`/bare path (bundles
the live working tree in place, no clone/install, for a fast edit →
hot-reload loop). A pipeline change reloads into its **own runtime**, not by
restarting `interbox` itself: in local dev the engine polls the workspace
(`INTERBOX_WORKSPACE_POLL_MS`, 2s in the template's `docker-compose.yaml`)
and swaps workers in place; elsewhere, trigger the same reload from the
dashboard ("Pull now").
