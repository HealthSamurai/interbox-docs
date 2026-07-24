# `/fhir`

```ts
import type {
  Patient,
  Observation,
  /* ... */
} from "@health-samurai/interbox/fhir";
import {
  isRecord,
  /* ... */
} from "@health-samurai/interbox/fhir/4.0.1/profile-helpers";
```

| import | contents |
|---|---|
| `@health-samurai/interbox/fhir` | re-exports both of the below — the convenience default |
| `@health-samurai/interbox/fhir/4.0.1` | generated FHIR R4 core resource/datatype interfaces (`Patient`, `Observation`, `HumanName`, …) |
| `@health-samurai/interbox/fhir/4.0.1/profiles` | generated profile classes built on the core types |
| `@health-samurai/interbox/fhir/4.0.1/profile-helpers` | hand-written runtime helpers profile classes call: slice match/get/set/default-fill, complex-extension read, choice-type (`value[x]`) wrap/unwrap, structural validation, deep-match/deep-merge/path utilities |

This is a **generated, spec-sized surface** — hundreds of R4 resource and
datatype interfaces — so it isn't enumerated field-by-field here. Your
editor's autocomplete over the interfaces covers field names and shapes;
for cardinality, code bindings, and reference-target semantics, the
[FHIR R4 specification](https://hl7.org/fhir/R4/) is the authoritative
source. A `1..1` field is required; a bound coded field expects one of its
value set's codes.

Note these are the **R4 core** types only — profile/US-Core constraints
(must-support, slicing, ValueSet URLs) live in the relevant implementation
guide, not here.
