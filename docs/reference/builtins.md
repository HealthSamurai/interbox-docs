# `/builtins`

**On 2.0, only the system descriptors here apply.** The source, preprocessor,
parser and sender descriptors on this page belong to the 1.x pipeline DSL, and
the 2.0 engine does not run them. A 2.0 pipeline takes `mllpSource` and
`webhookSource` from `@health-samurai/interbox/chain` — see
[Sources](steps.md#sources-mllpsource-and-webhooksource) — parses HL7v2 with
the `hl7v2Parser()` step from `@health-samurai/interbox/hl7v2`, and delivers to
Aidbox with `aidbox()` from `@health-samurai/interbox/aidbox` — see
[Steps](steps.md). It has no SFTP source and no preprocessors.

```ts
import {
  mllpSource,
  sftpSource,
  webhookSource,
  unpack,
  hl7v2Batch,
  lines,
  normalizePreprocessChain,
  aidboxSender,
  hl7v2Parser,
  ccdaParser,
  fhirSystem,
  aidboxSystem,
  epicSystem,
  paragonSystem,
} from "@health-samurai/interbox/builtins";
```

Typed handles for the engine's built-ins, grouped by kind. **On 1.x**, a
pipeline references the stage descriptors by value; each config is co-located
with its descriptor, and the engine owns the implementations and resolves them
by `type` at runtime.

The **system** descriptors at the bottom are not stages. A pipeline never
references them; a step imports the handle `defineSystem` returned and calls it —
see [Systems](../concepts/systems.md).

## 1.x: `mllpSource` — MLLP TCP listener source

```ts
interface MllpSourceConfig {
  host?: Str;
  port: Num;
}

const mllpSource: SourceDescriptor<"mllp", MllpSourceConfig>;
```

```ts
mllpSource({
  id: "mllp-default",
  port: env("MLLP_PORT"),
  parser: hl7v2Parser({ skipZSegments: false }),
});
```

## 1.x: `sftpSource` — SFTP polling source (read-only)

```ts
interface SftpSourceConfig {
  host: Str;
  port?: Num;
  username: Str;
  password?: Str;
  privateKey?: Str;
  passphrase?: Str;
  hostKey: Str;
  dir: Str;
  pattern?: Str;
  pollIntervalMs?: Num;
  timeoutMs?: Num;
  maxFileBytes?: Num;
  maxExpandedBytes?: Num;
  maxItems?: Num;
  encoding?: Str;
  preprocess?: ConfiguredPreprocessor[];
}

const sftpSource: SourceDescriptor<"sftp", SftpSourceConfig>;
```

Polls a directory on a remote SFTP server and ingests each new file as one
message. **The source is read-only: the engine never writes, moves, or
deletes anything on the remote server.** Which files it has already ingested
is tracked in the engine's own database, so nothing on the remote side needs
to change for a file to count as processed, and the memory survives engine
restarts.

```ts
sftpSource({
  id: "sftp-drop",
  host: env("SFTP_HOST"),
  username: env("SFTP_USERNAME"),
  password: env("SFTP_PASSWORD"),
  hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  dir: "/upload",
  pattern: "*.hl7",
  parser: hl7v2Parser(),
});
```

### Config

| field | type | default | notes |
|---|---|---|---|
| `id` | `string` | required | must be unique across every pipeline in the workspace |
| `host` | `Str` | required | e.g. `sftp.example.com` |
| `port` | `Num` | `22` | |
| `username` | `Str` | required | |
| `password` | `Str` | — | exactly one of `password` / `privateKey` |
| `privateKey` | `Str` | — | the key **content**, not a path — see below |
| `passphrase` | `Str` | — | only valid together with `privateKey` |
| `hostKey` | `Str` | required | `SHA256:<base64>` pin, or `accept-unverified` — see below |
| `dir` | `Str` | required | remote directory; not recursive — subdirectories and symlinks are ignored |
| `pattern` | `Str` | all files | glob over the file name; `*` and `?` only |
| `pollIntervalMs` | `Num` | `30000` | at least `1000` |
| `timeoutMs` | `Num` | `30000` | bounds the connect and every remote operation |
| `maxFileBytes` | `Num` | `16777216` (16 MiB) | files listed larger are skipped unread, with a log line — whatever the `preprocess` chain |
| `maxExpandedBytes` | `Num` | = `maxFileBytes` | caps the total bytes of the messages one file may produce — see below |
| `maxItems` | `Num` | `10000` | caps the number of messages one file may produce — see below |
| `encoding` | `Str` | `"utf-8"` | decodes file bytes into the message string; any `TextDecoder` encoding |
| `preprocess` | — | none | chain of preprocessors run between download and decode — see below |
| `parser` | — | required | the bound parser, exactly as on `mllpSource` |

Every `Str`/`Num` field accepts an `env()` ref. The engine coerces and
validates the whole config when it loads the workspace, so a bad value fails
the load — with the source id and the reason — instead of a poll cycle later.

### Authentication

Exactly one of `password` or `privateKey` — supplying both or neither is a
config error, and `passphrase` is only accepted alongside `privateKey`.

`privateKey` is the key **content**, not a path to a key file — put the whole
key, newlines included, in the environment variable your `env()` ref names:

```ts
sftpSource({
  id: "sftp-drop",
  host: env("SFTP_HOST"),
  username: env("SFTP_USERNAME"),
  privateKey: env("SFTP_PRIVATE_KEY"),
  hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  dir: "/upload",
  parser: hl7v2Parser(),
});
```

The key must be in OpenSSH format — what `ssh-keygen` produces by default,
starting with `-----BEGIN OPENSSH PRIVATE KEY-----`. PKCS8 PEM
(`-----BEGIN PRIVATE KEY-----`) is rejected; convert with
`ssh-keygen -p -f <keyfile>` first.

### Host key verification

`hostKey` is required and has no default: either a `SHA256:<base64>` pin of
the server's public key, or the literal `"accept-unverified"`.

To bootstrap a pin, connect once with a placeholder (the all-`A` pin from the
examples will do): the source fails to start and the error names the
fingerprint the server actually presented. Verify that fingerprint with
whoever runs the server, then put it in the config.

`"accept-unverified"` disables server authentication entirely — the engine
will send credentials to whatever answers at `host:port`, including an
impostor. It is spelled as a literal so that the decision is greppable;
production configs should carry a pin. While it is set, the source logs a
warning naming itself and the server once, after its first successful
connection each time the source starts — not on every poll.

### Preprocessors

`preprocess` is a chain of transforms the source runs on each downloaded
file, between download and decode. The file enters as bytes, each
preprocessor maps bytes to bytes in declaration order, and every item the
chain ends with becomes one message for the bound parser. Without a chain,
one file is one message.

The common case — a drop directory of zipped HL7v2 batch files:

```ts
sftpSource({
  id: "sftp-drop",
  host: env("SFTP_HOST"),
  username: env("SFTP_USERNAME"),
  password: env("SFTP_PASSWORD"),
  hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  dir: "/upload",
  pattern: "*.zip",
  preprocess: [unpack({ entryPattern: "*.hl7" }), hl7v2Batch()],
  parser: hl7v2Parser(),
});
```

`unpack` turns each zip into its `.hl7` entries, `hl7v2Batch` turns each
entry into one message per `MSH` — one nightly file lands as individual
rows in the queue.

Three preprocessors ship today:

**`unpack({ format?, entryPattern?, maxEntryBytes? })`** expands archives. `format` defaults
to `"auto"`, which detects zip and gzip by content and passes everything
else through untouched; force `"zip"` or `"gzip"` when the drop must contain
only that format — a file that then is not one fails the chain (see the
failure rules below). `entryPattern` is a glob (`*` and `?`) over each zip
entry's file name **without its folder path** — archives routinely prefix a
folder, and a full-path pattern would silently match nothing. It applies to
zip only: combining it with `format: "gzip"` is a config error, and on a
gzip file under `"auto"` it does nothing — a gzip holds a single stream,
which comes out named after the file minus its `.gz` suffix. Directory
entries are ignored. Encrypted and corrupt archives fail the chain whole:
the file is never partially ingested, and it is dropped under the failure
rules below. A truncated archive counts as corrupt — each zip entry is
checked against the uncompressed size its header declares, and a gzip
against the length in its trailer — so a drop that was cut short in
transit is refused rather than ingested as a short message. Neither check
reads the stored checksum, so corruption that preserves the length still
gets through, and a zip entry written by a producer that streams its
entries without declaring their sizes up front carries nothing to check
against and is not checked. `maxEntryBytes` (default 16 MiB) bounds each zip
entry, and a gzip file as a whole, while it inflates: an entry that inflates
past it fails the chain before any of it is emitted, so the memory one entry
takes stays within about that bound.

**`hl7v2Batch()`** splits an HL7v2 batch file into one message per `MSH`
segment. The `FHS`/`BHS`/`BTS`/`FTS` batch envelope lines are dropped, and a
blank line never ends a message: a message runs from its `MSH` line to the
next `MSH` or envelope line or to the end of the file, so segments after a
blank line — as in a file whose writer terminates every segment with
`\r\r\n` — stay in their message. `\r`, `\n` and `\r\n` line endings all
work, and the field separator can be any character — MSH-1 defines it and
the parser honors it. It splits raw bytes, so any ASCII-compatible `encoding` works
(UTF-8, Latin-1, …); a UTF-16 file fails the chain. A file with content but
not a single `MSH` line fails it too — recording that as "done, zero
messages" would be silent data loss.

**`lines({ delimiter?, skipFirst?, maxRecordBytes?, trimTrailingCR? })`** splits
the file into one message per delimited record — NDJSON, one JSON object per
line, is the case it was written for:

```ts
sftpSource({
  ...,
  pattern: "*.ndjson",
  preprocess: [lines()],
});
```

`delimiter` defaults to `"\n"` and is matched across the boundaries of whatever
chunks arrive, so no record is lost to a split read. `trimTrailingCR` (default
`true`) drops a single trailing `\r`, so a CRLF file yields clean records.
`skipFirst` (default `0`) drops that many leading records — set it to `1` for a
file that opens with a header row. Empty records are skipped rather than emitted
as empty messages, a last record with no trailing delimiter is still emitted, and
a trailing delimiter at end of file does not produce an empty one.
`maxRecordBytes` (default 1 MiB) is the memory bound: a record longer than it
fails the chain, naming the record's position in the file.

It is **not a CSV reader.** A quoted CSV field containing a newline is split
through the middle — wrongly, silently, with no error and nothing in the logs.
Use `lines` only where a record can never contain the delimiter.

`lines` **streams**: it reads the file as it arrives and holds one record at a
time, never the whole file. Nothing is lifted for it automatically, though: a
file listed past `maxFileBytes` is still skipped unread, and the records still
count against `maxExpandedBytes` and `maxItems`. To ingest large files through
`[lines()]`, raise all three to fit the largest file you expect:

```ts
sftpSource({
  ...,
  pattern: "*.ndjson",
  preprocess: [lines()],
  maxFileBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxItems: 2_000_000,
});
```

Memory stays bounded by `maxRecordBytes` and the source's own flush batches
however high those three go, because the file is streamed rather than held. In
`[unpack(), lines()]` the archive is held whole to be expanded, so there
`maxFileBytes` is also the memory it may take.

The failure rules:

- **A failure in the chain skips the rest of the remote file**, and what
  happens next depends on whether the same bytes would fail the same way
  next time:
  - a **deterministic** failure — a typo'd `entryPattern`, an encrypted or
    corrupt archive, a record over `maxRecordBytes`, bytes that do not
    decode in the configured `encoding`, a cap exceeded — is logged as an
    **error** naming the file and the reason, and the file is then marked
    done carrying that reason. It is never read again, so the feed keeps
    moving instead of re-downloading a file that cannot work. No error row
    appears in the queue, because no row was ever written for it;
  - a **transient** failure — a dropped connection, a server-side error,
    anything the engine does not recognise — is logged as a warn, the file
    is left unmarked, and the next poll retries it.
- **A pattern that selects nothing is a failure, not an empty result.** A
  zip with entries where `entryPattern` matches none is deterministic: the
  file is marked done with that reason. Correcting the pattern does not
  bring it back on its own — re-drop the file so it arrives with a new
  mtime or name.
- **Genuinely empty is done.** A zero-byte file, a zip with no file entries,
  or a batch that is only envelope lines produces zero messages and is
  recorded as done, with one info log — a quiet night converges instead of
  retrying forever.
- **What a file produces is capped.** `maxExpandedBytes` bounds the total
  bytes of the messages the chain emits for one file and defaults to
  `maxFileBytes`. It bounds what is emitted, not what is inflated: `unpack`
  inflates each archive entry whole before it emits it, bounded only by its
  own `maxEntryBytes` (default 16 MiB, whatever `maxFileBytes` is), and an
  entry a later stage drops is never counted. It is a separate knob from
  `maxFileBytes`: a high-compression drop can raise what it may emit without
  also allowing bigger downloads. `maxItems` (default 10 000) bounds how many
  messages one file may produce. Both are counted on what the chain finally
  emits, as it emits it — every chain, streaming or not — so a stage in the
  middle is not counted twice. Over either cap the chain is stopped where it
  crossed, and the file is marked done with that reason.
- **A file refused over a cap may already be partly ingested.** The batches
  written before the chain crossed the cap stay written, as described next.
  How many messages that was is in the error log, in its `written` field, and
  at the end of the reason the file is recorded with:
  `…; 1000 messages written`. A file refused before anything was written
  records the reason alone.
  Raising the cap does not bring the rest of the file back on its own:
  re-drop the file so it arrives with a new mtime or name, and it is ingested
  from its first message, so the part already written arrives a second time.
- **A big file fails in the middle after some of it has landed.** A file
  that produced more than 500 messages has already written them when a later
  record fails the chain. If that failure is deterministic the file is marked
  done, so the prefix is written once and the rest of the file never
  arrives — a partial ingest you have to notice in the error log. If it is
  transient, the next poll re-ingests the prefix as it retries. Keep the
  mapper's ids stable and the duplicates overwrite instead of accumulating.

`encoding` applies after the chain, to each item it emits — the chain itself
works on bytes.

The same three preprocessors are open to a source you define yourself: pass a
chain to its context's `preprocess`, and validate it at load with
`normalizePreprocessChain` — see
[Preprocessing what a source read](index.md#preprocessing-what-a-source-read).
A preprocessor of your own, declared with
[`definePreprocessor`](index.md#defining-a-preprocessor), goes in an
`sftpSource` chain beside these, or in your own source's, and
`normalizePreprocessChain` accepts it.
Each descriptor also has its config validator on its own —
`normalizeUnpackConfig`, `normalizeHl7v2BatchConfig`, `normalizeLinesConfig` —
which returns the config with its defaults filled in, or throws naming the
refused field.

### What gets ingested, and when

- A file is picked up once its size and mtime are stable across two
  consecutive listings, so a file still being uploaded waits a cycle. After
  an engine restart every file waits one cycle for the same reason.
- A file's identity is its path + mtime + size. A file that changes after
  ingestion is a new identity and is ingested **again**.
- With no `preprocess` chain, one file becomes exactly one message, handed
  as-is to the bound parser; with one, each item the chain emits becomes one
  message — see "Preprocessors" above.
- Delivery is **at-least-once**: after a crash the same file can arrive
  twice — with a `preprocess` chain, that means every message it expanded
  to. Handling duplicates is the pipeline's job — make the mapper derive
  stable ids so a re-send overwrites rather than duplicates.
- A file that is oversize for `maxFileBytes`, or that could not be read this
  time, is skipped with a log line and retried on the next cycle. A file
  whose bytes do not decode in the configured `encoding` is marked done with
  that reason instead, like any other deterministic failure. Neither ever
  wedges the rest of the directory.

### When the server misbehaves

A connection failure, an authentication failure, a host-key mismatch, or any
operation exceeding `timeoutMs` restarts the source worker with exponential
backoff, and the engine keeps retrying. The dashboard shows the source as
down with its restart count and last error — a wrong password and an
unreachable host look the same there, so read the error text. A stalled
server surfaces as a timeout, never as a silent hang.

## 1.x: `webhookSource` — HTTP webhook source

```ts
interface WebhookSourceConfig {
  port: Num;     // accepts POST on any path of this port
  secret?: Str;  // when set, a request without a matching x-interbox-secret header is 401
}

const webhookSource: SourceDescriptor<"webhook", WebhookSourceConfig>;
```

```ts
webhookSource({
  id: "inbound-webhook",
  port: env("WEBHOOK_PORT"),
  secret: env("WEBHOOK_SECRET"),
  parser: hl7v2Parser(),
});
```

An HTTP endpoint. Each `POST` body becomes one inbound row exactly as it arrived, and the request
is answered `200` once the row is committed. A body the parser rejects is stored as an error row
and still answered `200`. A failed write answers `500`, so a sender that retries delivers again.
Any other method is `405`, and a body over 16 MB is `413`.

An Aidbox topic destination can point here: its notification Bundle arrives as one row, and the
workspace's parser or mapper picks the resources out of it.
With `secret` set, give the destination a `header` parameter carrying it:

```json
{ "name": "header", "valueString": "x-interbox-secret: <secret>" }
```

Aidbox does not allow a topic destination to be modified, so adding the header means deleting the
destination and creating it again.

Not to be confused with [webhooks](../concepts/webhooks.md), which Interbox sends out.

## 1.x: `ccdaParser` — C-CDA document parser

```ts
interface CcdaParserConfig {}   // no options yet
```

Parses an HL7 C-CDA XML document into a typed clinical document and lands it in
`ccda_in`. Unlike HL7v2, one payload is one document — nothing is split.

```ts
ccdaParser()
```

Mapping to FHIR is yours to write. `@health-samurai/interbox/ccda` exports
`parseCda`, which parses the document, and `toFhirBundle`, which turns the
parsed document into a FHIR R4 `Bundle`. A 2.0 pipeline has no parser stage, so
one step after the store does both:

```ts
import { defineStep, type Batch } from "@health-samurai/interbox/chain";
import { parseCda, toFhirBundle } from "@health-samurai/interbox/ccda";

const ccdaToFhir = defineStep("ccda-to-fhir", (docs: Batch<string>) =>
  docs.flatMap((xml) =>
    (toFhirBundle(parseCda(xml, "ClinicalDocument")).entry ?? []).flatMap((e) => (e.resource ? [e.resource] : [])),
  ),
);
```

A step that calls `parseCda` itself does not make the root-element checks
described below; those belong to the 1.x `ccdaParser`.

The bundle links its entries with `urn:uuid:` references. If your destination
expects `Type/id` references, rewrite them in the step — `entry.fullUrl` carries
the `urn:uuid:` that the other entries point at, and every resource has an `id`.

**Derive your own resource ids.** The bundle's ids are fresh UUIDs per conversion, so
converting the same document twice produces two unrelated sets of resources — a retry
or a resent correction then duplicates every patient at the destination. Key each
resource on something stable (its first `identifier`, else its position), hash that
together with the document's own id, and build the reference map over the ids you
derived:

```ts
const docId = doc.id?.extension ?? doc.id?.root ?? "unknown-document";
const key = resource.identifier?.[0]?.value ?? `#${index}`;
const id = hash(`${docId}|${resource.resourceType}|${key}`);
```

Same document in, same ids out, so a re-send overwrites its own resources.

A document is rejected before parsing when its root element is not
`ClinicalDocument`. Namespace-*prefixed* documents (`<cda:ClinicalDocument>`) are
not supported and are rejected with the error kind `prefixed_ccda`; the usual
default-namespace form (`xmlns="urn:hl7-org:v3"`) is what to send.

## 1.x: `aidboxSender` — Aidbox FHIR sender

```ts
type AidboxAuth =
  | { kind: "basic"; user: Str; password: Str }
  | { kind: "bearer"; token: Str };

interface AidboxSenderConfig {
  url: Str;
  auth: AidboxAuth;
  batchSize?: number;  // max rows claimed per loop
  // consecutive transient failures to retry before the batch is recorded errored
  maxRetries?: number;
  // ceiling of the retry backoff for resources deferred on a missing reference
  // target: retries start at 5s and double per attempt up to this (default 5 min)
  retryDelayMs?: number;
}

const aidboxSender: SenderDescriptor<"aidbox", AidboxSenderConfig>;
```

```ts
aidboxSender({
  url: env("AIDBOX_URL"),
  auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
});
```

## 1.x: `hl7v2Parser` — HL7v2 parser

```ts
interface Hl7v2ParserConfig {
  skipZSegments?: boolean;
}

const hl7v2Parser: ParserDescriptor<"hl7v2", Hl7v2ParserConfig>;
```

```ts
hl7v2Parser();                          // config optional, defaults to {}
hl7v2Parser({ skipZSegments: true });
```

Bound to a 1.x source's `parser` field. A 2.0 pipeline parses HL7v2 with the
`hl7v2Parser()` step from `@health-samurai/interbox/hl7v2` instead — see
[Steps](steps.md#hl7v2-hl7v2parser-and-frommsh7).

## System descriptors — `fhirSystem`, `aidboxSystem`, `epicSystem`, `paragonSystem`

Passed to `defineSystem`, not to a pipeline. All four speak base FHIR R4 through
one client and differ in what has been tested and which credentials they accept —
see [Systems](../concepts/systems.md) for the per-method support tables and the
constraints on calling one from a step.

```ts
type FhirJwtAlg = "RS384" | "RS256" | "ES384" | "ES256";

type FhirCredential =
  | { kind: "basic"; user: Str; password: Str }
  | { kind: "bearer"; token: Str }
  | { kind: "client-secret"; clientId: Str; clientSecret: Str }
  | { kind: "jwt-assertion"; clientId: Str; privateKey: Str; alg?: FhirJwtAlg; kid?: Str };

interface FhirEndpointConfig {
  fhirBaseUrl: Str;   // required — there is no default
  tokenUrl: Str;      // required — there is no default
  scope?: Str;
  timeoutMs?: Num;    // per attempt. Default 10s; see the ceiling in Systems
}
```

| descriptor | accepted `auth.kind` |
|---|---|
| `fhirSystem` | all four |
| `aidboxSystem` | all four |
| `epicSystem` | `jwt-assertion` |
| `paragonSystem` | `jwt-assertion`, `client-secret` |

A credential a connector does not accept is a compile error, not a runtime 401.

```ts
export const ehr = defineSystem(fhirSystem, {
  id: "ehr-prod",
  fhirBaseUrl: env("EHR_FHIR_BASE"),
  tokenUrl: env("EHR_TOKEN_URL"),
  auth: { kind: "client-secret", clientId: env("EHR_ID"), clientSecret: env("EHR_SECRET") },
  timeoutMs: 3_000,
});
```

The service interface each one yields — `read`, `readBinary`, `search`,
`findPatientByIdentifier`, `get`, `operation`, `matchPatient` — is read-only by
contract, because a Retry runs every step after the store again. Writes belong
in a sender.

Support tables are importable alongside the descriptors: `FHIR_SUPPORT`,
`AIDBOX_SUPPORT`, `EPIC_SUPPORT`, `PARAGON_SUPPORT`. They record what has been
called and change no behaviour.
