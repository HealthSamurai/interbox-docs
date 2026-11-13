# `/files`

`fileDropSource` reads files that a sending system drops into SFTP, a local or mounted folder, Amazon S3, Google Cloud Storage or Azure Blob Storage, and the steps in `@health-samurai/interbox/files` turn them into records. The concepts are in [Reading Files from Storage](../concepts/reading-files/README.md).

## `fileDropSource`

Reads files that a sending system drops into an SFTP directory, a local or mounted folder or a cloud storage bucket, and
hands each file to the pipeline's first step. [Reading Files from Storage](../concepts/reading-files/README.md)
explains feeds, deliveries and readiness; this section lists the settings. The older 1.x
`sftpSource` (see [/builtins](builtins.md)) reads one SFTP directory without deliveries.

```ts
import { env } from "@health-samurai/interbox";
import { fileDropSource, s3 } from "@health-samurai/interbox/files";

fileDropSource({
  transport: s3({ bucket: env("BUCKET"), prefix: "clinical" }),
});
```

The source, its transports and the steps below come from `@health-samurai/interbox/files`.

| Field | Sets | Default |
|---|---|---|
| `transport` | the storage: `sftp(…)`, `local(…)`, `s3(…)`, `gcs(…)` or `azure(…)` | required |
| `marker` | the name of the file that closes a folder or `group` delivery, found directly in the delivery's folder, or for `group` at the shallowest path `group` maps to the delivery; a file of that name deeper is ignored like `_SUCCESS`; a file at the top level that is a delivery of its own never needs one | `"_READY"` |
| `expect` | name patterns that must each match a file before a delivery is ready, in place of a marker file; Interbox refuses it together with `marker` | none |
| `group` | a function from a file's path to its delivery's name, or `null` | top-level folders and files |
| `ordered` | read one delivery at a time in order, and reject one that arrives late | `false` |
| `latestOnly` | read only the newest delivery of each series: `true`, or a function naming the series | `false` |
| `order` | a function from a delivery name to the key Interbox sorts by | the name |
| `pollInterval` | how often Interbox lists the feed, at least `1s` | `30s` |
| `waitFor` | `{ warn, abandon }`, see [What happens to a delivery](../concepts/reading-files/README.md#what-happens-to-a-delivery) | `1h`, `48h` |
| `cadence` | how often new data should arrive; Interbox warns when no delivery finishes for that long | none |
| `startAfter` | the name of the last delivery another reader already read; Interbox never reads that delivery or any that sorts before it, see [`startAfter`](#startafter) | none |
| `read` | `"file"`: each file is one input; `"delivery"`: each delivery is one input, see [`read: "delivery"`](#read-delivery) | `"file"` |
| `pollTerm` | how long one poll may run, from `6m` to `24h`; with `read: "delivery"` it is the time a delivery has to be copied, see [`read: "delivery"`](#read-delivery) | `15m` |
| `maxFileBytes` | with `read: "file"`, the largest data file read, in bytes as stored; a larger one is skipped, reason `over maxFileBytes`. A file must also be read within one poll: at 15,000 to 25,000 records a second, `pollTerm` bounds how large a file can be. Not allowed with `read: "delivery"` | 64 MiB |

`transport` takes one of [`sftp(…)`](../concepts/reading-files/sftp.md),
[`local(…)`](../concepts/reading-files/local-folder.md),
[`s3(…)`](../concepts/reading-files/amazon-s3.md),
[`gcs(…)`](../concepts/reading-files/google-cloud-storage.md) or
[`azure(…)`](../concepts/reading-files/azure-blob-storage.md); their fields are on those pages.

With `read: "file"`, Interbox reads files of up to 64 MiB as stored and skips a larger one (reason
`over maxFileBytes, listed at <version>`; every skipped file's reason ends with the version it
was listed at, or with `unlisted` when the latest listing no longer had it).

With `.store(…)` right after the source, Interbox stores each file whole, up to 16 MiB, and skips
a larger one (reason `over maxBytes`). It stores the file as text with `codec: "text"`, skipping
a file that is not UTF-8 (reason `not UTF-8`), or as bytes with `codec: "bytes"`. It refuses
`codec: "json"` there. Both limits are fixed, and `fileDropSource` has no setting for them; the
`wholeFile()` step has its own `maxBytes`. A file in another encoding goes through a step that
reads it, such as `csvRows()` with `encoding`, or is stored as bytes.

### `group`

`group` gets each file's path in the feed and returns the name of the delivery the file belongs
to, or `null` to leave the file alone. A flat folder of exports told apart by a prefix, such as
`12345_Patient.ndjson` and `12345_Observation.ndjson`, with the marker file written as
`12345/_READY`:

```ts
group: (path) => /^(\d+)[_/]/.exec(path)?.[1] ?? null
```

The marker file must map to its delivery too: here `[_/]` lets `12345/_READY` join `12345`.
A marker file that lists its files can name them as `12345_Patient.ndjson`: in a `group`
delivery, a name that is not beside the marker file is looked for from the top of the feed.

A file at the top level of the feed joins whichever delivery `group` names for it, and that
delivery is ready by the same rules as a folder. A file that `group` maps to its own path is a
delivery of its own and needs no marker file.

Keep `group` stable: when it changes, the deliveries already in the feed get new names, and
Interbox reads them again. A file for which `group` throws, or returns an empty name or a name
with `/`, is reported and not read.

### `order`

`order` gets a delivery name and returns the key Interbox sorts deliveries by. For
`Census10142026.csv`, dated month, day, year:

```ts
order: (name) => name.replace(/^\D*(\d{2})(\d{2})(\d{4}).*$/, "$3$1$2")
```

A delivery for which `order` throws or returns an empty key is not read: Interbox rejects it with
the reason `order failed: <the error's message>` or `order failed: empty key`.

### `latestOnly`

With `latestOnly: true`, Interbox groups deliveries into series and reads only the newest of each.
A delivery's series is its name with every digit removed, so `ED_202610140600.csv` and
`ED_202610141800.csv` are one series, `ED_.csv`, and every name that is all digits, such as
`20261014`, is in one series too. Pass a function to name the series
yourself:

```ts
latestOnly: (name) => name.split("_")[0]
```

A delivery for which that function throws or returns an empty name is rejected with the reason
`series failed: <the error's message>` or `series failed: empty series`. While one delivery of a
series is being read, no other delivery of it is read or rejected `superseded by <name>` until
that one ends. A delivery of the series that is ready meanwhile is reported once, reason
`held behind <name>, which is still reading`, and is read or rejected once that one ends.

`latestOnly` and `ordered` cannot be set together.

### `startAfter`

`startAfter` names a delivery. Interbox never reads that delivery or any delivery that sorts
before it, in the same order `ordered` uses: by name, or by the key `order` returns.

```ts
startAfter: "20261014T060000Z"
```

- The first time Interbox lists such a delivery, it marks it rejected for good and opens none of
  its files. Removing or changing `startAfter` later does not make it readable.
- The deliveries listed in the feed when a `startAfter` value first applies are closed without a
  report. One that appears later is reported once, reason `named before startAfter <startAfter>`.
- A delivery that was waiting and is no longer listed is not closed by `startAfter`. It is
  abandoned after `waitFor.abandon`, as without `startAfter`.
- With `group`, the value is a name `group` returns.
- A delivery Interbox has already started reading, or has finished with, is left as it is.
- A closed delivery has not been read: with `ordered` it does not hold back later deliveries, and
  with `latestOnly` it does not make a newer snapshot older.
- Interbox refuses to start when `startAfter` is empty, contains `/`, or is a name the feed's
  `order` function throws on or returns an empty key for.

[Moving a feed from another reader](../concepts/reading-files/README.md#moving-a-feed-from-another-reader)
says how to choose the value.

### `read: "delivery"`

With `read: "delivery"`, Interbox copies every data file of a delivery, as stored, into Postgres
and commits the delivery as one unit. The unit lists the files. A step after the store opens them
and reads them as it needs: a header file and a lines file that together make one record, one
provider's rows spread over several files, or a snapshot to compare with the one before it.

```ts
pipeline("providers")
  .source(fileDropSource({
    transport: s3({ bucket: env("BUCKET"), prefix: "providers" }),
    read: "delivery",
    latestOnly: true,
    pollTerm: "45m",
  }))
  .store(postgresStore({ codec: "json" }))
  .step(buildProviders)
  .sender(intoPipeline("practitioners"));
```

Here `buildProviders` reads the delivery's files (see [Reading stored files](#reading-stored-files))
and gives one row per provider, and `intoPipeline("practitioners")` stores each row as a unit of
a second pipeline, whose source is `fromPipeline("providers")`.

- **Everything before reading is the same.** Folders, `group`, the marker file, `expect`,
  `order`, `ordered`, `latestOnly` and `startAfter` decide which deliveries are read and when,
  as with `read: "file"`.
- **No step before the store.** Interbox copies the files as they arrive, `.gz` and `.zip` files
  included, so the store comes right after the source and uses `codec: "json"`. Interbox refuses
  to start a pipeline with a step before the store, a store with another codec, or
  `deliveryEnd()`, whoever wrote the step. The check when the workspace loads sees step names
  only and leaves these rules to the start.
- **No size limit.** `read: "delivery"` limits neither the bytes of a delivery nor those of a
  file. The files take space in Postgres until the retention deletes them, see
  [Retention](#retention).
- **Stored whole or skipped whole.** Interbox streams the files into Postgres, then commits the
  unit in one short transaction. When it cannot read one file, it skips the whole delivery with a
  reason, such as `file members.csv: version_changed`, and keeps no file of it. A delivery is
  stored at most once: when a read stops part-way, the next poll reads it again from its first
  file.
- **Time to copy.** A delivery has to be copied within one poll, whose length is `pollTerm`
  (default `15m`, from `6m` to `24h`). Set it above the time your largest delivery takes to
  copy. A delivery whose copy runs out of time three polls in a row is skipped, reason
  `not read within <seconds>s`. `pollTerm` is also how long the feed waits after an engine stops
  during a poll before another engine takes it over.
- **Changing `read` on a running feed.** A delivery that Interbox began reading file by file and
  had not finished when you set `read: "delivery"` is skipped, reason
  `read partly file by file`; the records it already stored stay. A delivery stored whole and
  then read under `read: "file"` is not read again.
- **No reports.** The source gives no input for a report file or a skipped delivery. A skipped
  delivery shows in the feed's state and in the log, with its reason.
- **Time to process.** A step after the store runs within the unit's 60 second deadline, which
  you cannot change yet. Keep a step that builds many rows quick.
- **Rows stream out.** Interbox writes the rows a step gives as it gives them, so a delivery of
  any number of records takes the same memory. `mapAll` after the store gets them in parts of up
  to 1000 rows, so work that needs the whole delivery at once belongs in the step that reads the
  files: hold the small table in a map and stream the large file against it, as in
  [Reading stored files](#reading-stored-files), keep the keys already given in a set to drop
  duplicates, and compare with the last delivery per row, through stored state or fingerprints.

The value of the delivery's unit is a `StoredDelivery`: `{ kind: "delivery", delivery, files }`,
where each file has `id`, `name`, `version`, `size` (as stored), `sha256` and, when the marker
file gives one, `count`. The files are in name order.

#### Retention

Interbox deletes a delivery's stored bytes after the pipeline's `retention` (`pipeline(name, { retention })`,
default `"7d"`, `"forever"` keeps them) has passed since its unit became `sent` or `skipped`. The unit and its file list stay, and
opening a deleted file fails with an error that names the deletion. A unit in `error` or
`deferred` keeps its files, so Retry works. A copy cut short leaves no stored file behind; after
a crash, Interbox deletes the incomplete files about 25 hours after the copy began (the longest
`pollTerm` plus an hour).

### Reading stored files

A step after the store opens a file of the delivery with `ctx.files.open(file)`, which gives a
`ReadableStream<Uint8Array>` that Interbox reads from Postgres slice by slice. The built-in steps `unpack()`, `csvRows()`, `ndjson()`, `lines()` and `hl7v2Messages()` also take
a file as their first argument and then read that file, with the rules and line numbers of the
step:

| Call | Reads | Gives |
|---|---|---|
| `unpack(file)` | a `.gz` or `.zip` file; other files pass through | the files inside, one after another |
| `csvRows(file, options?)` | a CSV file, gunzipped first when its name ends in `.gz` | `{ kind: "record", line, record }` for each row, keyed by column, and `{ kind: "skip", line, reason }` for a row it cannot read |
| `ndjson(file, options?)` | an NDJSON file | the same, one object per line |
| `lines(file, options?)` | any text file | the same, one string per line |
| `hl7v2Messages(file, options?)` | an HL7v2 batch | the same, one message per record |

Each takes the file as `{ name, body }`, where `body` is the stream, and reads it whatever its
name: the name filter of the step does not apply. `options` are those of the step; for
`csvRows()` it can be a function of the file. A call with a file gives the records, not a step, so
`.step(csvRows(file))` is a type error. A file that cannot be read as a whole, such as a corrupt
archive, throws an error that names it, with the cause. Read a body to its end before you open
the next.

This step reads a small table into a map, then streams the larger file against it and checks
that every attachment a claim names is in the delivery:

```ts
import { defineStep } from "@health-samurai/interbox/chain";
import type { Batch, StepContext } from "@health-samurai/interbox/chain";
import { csvRows, type StoredDelivery } from "@health-samurai/interbox/files";

const buildClaims = defineStep("buildClaims", (rows: Batch<StoredDelivery>, ctx: StepContext) =>
  rows.flatMap(async function* (delivery) {
    const open = (name: string) => {
      const file = delivery.files.find((f) => f.name === name)!;
      return { name: file.name, body: ctx.files.open(file) };
    };

    const providers = new Map<string, string>();
    for await (const row of csvRows(open("providers.csv"))) {
      if (row.kind === "record") providers.set(row.record.id!, row.record.name!);
    }

    const present = new Set(delivery.files.map((f) => f.name));
    for await (const row of csvRows(open("claims.csv.gz"))) {
      if (row.kind !== "record") continue;
      const { id, provider, attachment } = row.record;
      if (!providers.has(provider!)) throw new Error(`claims.csv line ${row.line}: unknown provider ${provider}`);
      if (!present.has(attachment!)) throw new Error(`claims.csv line ${row.line}: ${attachment} is not in the delivery`);
      yield { id, provider: providers.get(provider!) };
    }
  }));
```

### Steps that split a file

The first steps of a file feed's pipeline turn each file into records. A step skips a record it
cannot read and goes on. It skips the whole file when the file is not its kind, or when the file
as a whole cannot be read, as the last column lists.

| Step | Reads | Gives | Skips a record | Skips the file |
|---|---|---|---|---|
| `unpack()` | `.gz` and `.zip`; other files pass through | each archive entry, or the file itself | none | a `.gz` or `.zip` file that is not one (`not gzip`, `not zip`); a zip cut short, after the entries before the cut (`corrupt archive`). A `.gz` entry of a zip that is not gzip or is corrupt is skipped alone, and the zip's other entries are read |
| `ndjson()` | `.ndjson`, `.jsonl` | one JSON object per line | over 64 MiB (`over maxRecordBytes N`), `not UTF-8`, `not JSON`, `not an object`, or an object whose only key is `interbox.deliveryEnd` (`deliveryEnd shape`) | any other name (`name not read by ndjson()`); `corrupt archive` |
| `lines()` | any file | one string per line | over 1 MiB (`over maxRecordBytes N`), or `not UTF-8` | `corrupt archive` |
| `csvRows()` | `.csv`, `.txt` | one object per row, keyed by column | a wrong field count (`field count N, expected M`), over 1 MiB (`over maxRecordBytes N`), or a row whose only column is `interbox.deliveryEnd` (`deliveryEnd shape`) | any other name (`name not read by csvRows()`), an empty or repeated column name (`bad header: …`), a byte its encoding cannot decode (`undecodable byte`), a stray `"` with `quote: true`, the default (`bare quote`), options that break a rule (`csvRows options: …`); `corrupt archive` |
| `hl7v2Messages()` | an HL7v2 batch, MLLP framing stripped | one message per record | over 1 MiB (`over maxRecordBytes N`), a byte its encoding cannot decode (`undecodable byte`), or lines that are neither a message nor a batch header or trailer (`not an HL7v2 message`) | no `MSH` segment anywhere (`no MSH segment`); `corrupt archive` |
| `wholeFile()` | any file | the file's bytes as one record | none | over 16 MiB (`over maxBytes N`); `corrupt archive` |

The text in parentheses is the skip's reason, as the pipeline's units show it; `N` is a size in
bytes or a field count.

In a file or zip entry that was not gzip-compressed, `ndjson()`, `lines()` and
`csvRows()` also skip a last line or row with no line break, reason `unterminated`: the file
may have been cut short. `csvRows()` skips a last row that ends inside an open quote,
`unterminated`, in a gzip file too. A gzip file carries its own check: when a gzip file fails it,
or a zip entry cannot be decompressed, the step reading the file skips it, reason
`corrupt archive: ` and what is wrong with it, and keeps the records it read before. NUL bytes
padding a gzip file after its compressed data are ignored; any other bytes there are
`corrupt archive`. The `deliveryEnd shape` skips keep a line or row of the file from passing for
the record that ends a delivery.

`ndjson()` gives each record as an `NdjsonRecord`, a `Record<string, unknown>`, and `csvRows()`
as a `CsvRecord`. A mapping that expects a FHIR type casts the record:

```ts
import type { Bundle, Resource } from "@health-samurai/interbox/fhir/4.0.1";
import type { NdjsonRecord } from "@health-samurai/interbox/files";

function bundleToResources(row: NdjsonRecord): Resource[] {
  const bundle = row as unknown as Bundle;
  return (bundle.entry ?? []).flatMap((entry) => (entry.resource === undefined ? [] : [entry.resource]));
}
```

Each record carries the attrs `kind` (`"file"`), `delivery` (the delivery's name), `file` (its name),
`version` (the file's version as stored) and `line`. A record from a zip archive also carries
`entry`, the entry's path in the archive. A skip a step makes while reading carries the same
attrs and `stage: "read"`. `line` is the line number for `ndjson()` and `lines()`,
the row's first line for `csvRows()` (the header is line 1), and the message's position in the
batch for `hl7v2Messages()`. A step that takes a size limit accepts `maxRecordBytes` (or `maxBytes`
for `wholeFile()`) to change it. `hl7v2Messages()` also takes `encoding`, UTF-8 by default; with
`"latin1"` it reads Windows-1252.

### `csvRows()`

`csvRows()` splits delimited text into rows. It reads UTF-8 with a header row by default, and
takes:

- `delimiter`: `","` by default; `";"` for a European Excel export, `"|"` for a pipe-delimited
  extract, `"\t"` for a tab-separated one;
- `header: false` for a file without a header row, with `columns` naming the columns, else they
  are named `c1`, `c2` and so on, one per field of the first row;
- `trim: true` to strip the spaces that pad fixed-looking columns, including blanks before an
  opening quote and after a closing one, which without `trim` are a `bare quote`;
- `quote: false` for a file that never quotes fields, so a stray `"` in the data is an ordinary
  character;
- `encoding`: for a file not in UTF-8, such as `"windows-1252"`. A file that starts with a byte
  order mark is read in the encoding the mark names.

When one feed mixes formats, pass a function that picks the options per file:

```ts
csvRows((file) => (file.name.endsWith(".txt") ? { delimiter: "|", trim: true, quote: false } : {}))
```

The function gets the file's `name`, `delivery`, `version` and `size`. For a zip entry, `name` and
`size` are the entry's own and `version` is the archive's. `size` is left out where the archive
does not declare it: for a gzip file, and for a zip entry written with a data descriptor.

### `deliveryEnd()`

A step that records how each delivery of a file feed was read. Put it right after `.store(…)`.
Once Interbox has read or skipped the last file of a delivery, `deliveryEnd()` gives it one
verdict: `complete`, `partial`, `empty` or `abandoned`
(see [What happens to a delivery](../concepts/reading-files/README.md#what-happens-to-a-delivery)).
The verdict shows up as one more unit of the pipeline, with the attrs `kind: "delivery-end"` and
`delivery`, skipped with the verdict as its reason, so it appears wherever the pipeline's units
do. The first verdict that applies is given:

| Verdict | When |
|---|---|
| `abandoned` | Interbox abandoned the delivery while it read it |
| `partial` | Interbox skipped a file of the delivery, a reading step skipped a record or a file, or the records read from a file differ from its `count` in the marker file |
| `empty` | no file of the delivery held a record |
| `complete` | none of the above |

A reading step is `unpack()`, `ndjson()`, `lines()`, `csvRows()`, `hl7v2Messages()` or
`wholeFile()`. What it skips is lost to the reading: an unreadable record, a file it cannot open.
A step of your own that skips or filters out records it does not want, before the store or
after it, does not make the delivery `partial`, and neither does one that skips or filters out a
whole file between `unpack()` and the reading step: such a file counts no record and is not
compared with its `count`. Two pipelines that read one prefix and each skip the other's records
or files both judge a whole delivery `complete`. A delivery whose records were all read and then
skipped by your own steps is `complete`, not `empty`; one whose every file your own steps dropped
before reading is `empty`.

Interbox counts what a reading step reads on the file input itself. A step of your own between
`unpack()` and the reading step that changes the input must spread it, `{ ...file, name: … }`,
to keep that count.

A file's records are what the reading step read from it, skipped ones included, since a marker's
`count` includes every record written; a step of your own that skips, drops or splits records
after it does not change them. A `partial` verdict caused by a count goes on to name each such
file, up to 100, with both counts: `partial: clinical_00002.ndjson.gz: count 12417, records 12400`.
`deliveryEnd()` passes every other row on unchanged.

A file whose records no reading step counted and that stored at least one unit, such as one
whose body a step of your own reads, or an input rebuilt without a spread, is judged as if every
skip were lost to the reading, with its stored and skipped units as its records. One that stored
no unit is treated as a file your own steps dropped before reading.

An archive `unpack()` opens and finds empty is a file read with no record: a `count` the marker
gives it is compared, so an empty zip named with `count: 5` makes the delivery `partial`.

`deliveryEnd()` does not scan the store. When Interbox commits a file, it records in the same
transaction how many records the file stored and skipped, how many of the skips the reading
made, and how many records the reading step read, or that the whole file was skipped.
`deliveryEnd()` judges the delivery from those counts alone, so its cost grows with the
delivery's files, not with the pipeline's units, and the store needs no index for it.

A pipeline with `deliveryEnd()` must also:

- start with `unpack()`;
- store records with `codec: "json"`;
- have `deliveryEnd()` as the first step after `.store(…)`.

Interbox refuses to start a pipeline that breaks one of these. It recognises `unpack()` by a tag
on its function, and `deliveryEnd()` by its name, so do not give a step of your own the name
`deliveryEnd`. A step of your own before the store must also pass the delivery's end record
through unchanged, which Interbox cannot check: wrap it in `records(fn)`, which does.

Without `deliveryEnd()`, Interbox reads deliveries the same way and gives no verdict.

Put mapping steps after `deliveryEnd()`. `records(fn)` after `deliveryEnd()` gives only what
`fn` gives, so `fhirItems()` can follow it. `ndjson()` and `csvRows()` keep the delivery's end
record in their output type, and `records(fn)` keeps it in its own when its input has it, so a
pipeline that maps `ndjson()` or `csvRows()` records to FHIR after the store needs
`deliveryEnd()` before the mapping:

```ts
.step(unpack())
.step(csvRows())
.store(postgresStore({ codec: "json" }))
.step(deliveryEnd())
.step(records(rowToResources))
.step(fhirItems())
```

`lines()`, `hl7v2Messages()` and `wholeFile()` give no end record, so a pipeline built on them maps
after the store with or without `deliveryEnd()`.
