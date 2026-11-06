# SFTP

SFTP is the most common way healthcare partners exchange files: labs drop HL7v2 result batches,
payers and clearinghouses deliver eligibility files and rosters, and EHR vendors push nightly
extracts. It runs over SSH, needs one open port, and every organisation already has a server or
can get one.

## When Interbox reads a file

An SFTP server shows a file while the sending system is still writing it. Interbox reads a file
once its size and modification time match across two polls and it is at least `minFileAge` old.
A delivery's marker file follows the same rule.

```mermaid
graph LR
    L1(Poll 1: a.hl7, 4 MB):::neutral2 -->|grew: wait| L2(Poll 2: a.hl7, 9 MB):::neutral2
    L2 -->|same: read| RD(Read):::green2
```

Set `minFileAge` when a sending system can pause mid-file for longer than `pollInterval`. A
sending system that writes each file under a temporary name and renames it when done avoids the
question.

A few servers need more care:

- **After a restart** every file waits one poll, since Interbox has no earlier listing to compare.
- **An empty file** waits until it is at least five minutes old, since some servers create a file
  empty and fill it later.
- **Windows-based servers** lock a file while it uploads and refuse to open it. Interbox leaves
  the file for the next poll and reads the rest. A file still refused after `waitFor.warn` (see
  [What happens to a delivery](README.md#what-happens-to-a-delivery)) gets its delivery one
  warning, since the account may lack the right to read it. Interbox tries the file at every
  poll until it abandons the delivery after `waitFor.abandon`.
- **A subfolder the account cannot open**: Interbox reports it once and reads the rest of the
  feed. It does the same for a symlink whose target leaves the feed or does not exist, and for an
  entry that is neither a file, a folder nor a symlink.
- **Modification times must be in UTC.** A server that reports local time ahead of UTC delays
  every file, and Interbox logs a warning once a poll.

## Setup

Interbox signs in with a password or a private key and needs read access to the directory. Pin the
server's host key so Interbox talks to the right server.

After a rejected login, Interbox waits before it tries that server and user again: 1 minute,
doubling up to 1 hour, reset by a successful login. Servers that lock an account after repeated
failures stay unlocked while you fix the password.

`hostKey` is the key's algorithm followed by its SHA-256 fingerprint. Ask the server's
administrator for it, or read it over a network you trust:

```sh
ssh-keyscan -t ed25519 sftp.example.com 2>/dev/null | ssh-keygen -lf -
# 256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA sftp.example.com (ED25519)
```

Interbox offers the server only the pinned algorithm and refuses any other key. It accepts:

- `ssh-ed25519`
- `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`
- `ssh-rsa`

`hostKey: "accept-unverified"` turns the check off and logs a warning at every start; keep it for
test servers.

## Configuration

```ts
import { env } from "@health-samurai/interbox";
import { aidbox, fhirItems } from "@health-samurai/interbox/aidbox";
import { pipeline, postgresStore } from "@health-samurai/interbox/chain";
import { fileDropSource, hl7v2Messages, records, sftp } from "@health-samurai/interbox/files";
import { messageToResources } from "./mappers/lab-results";

const toAidbox = aidbox({
  url: env("AIDBOX_URL"),
  auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
});

pipeline("labs")
  .source(
    fileDropSource({
      transport: sftp({
        host: "sftp.example.com",
        username: "interbox",
        privateKey: env("SFTP_PRIVATE_KEY"),
        hostKey: "ssh-ed25519 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        dir: "/outbound/labs",
      }),
    }),
  )
  .step(hl7v2Messages())
  .store(postgresStore({ codec: "text" }))
  .step(records(messageToResources))
  .step(fhirItems())
  .sender(toAidbox);
```

`hl7v2Messages()` gives each message as a string. `messageToResources` is your mapping, from one
HL7v2 message to the FHIR resources to write.

| Field | Required | Default | Sets |
|---|---|---|---|
| `host` | yes | | the server |
| `port` | | `22` | |
| `username` | yes | | |
| `password` or `privateKey` | one of them | | as `env("…")`, since a literal string is a type error; a key in OpenSSH format (`-----BEGIN OPENSSH PRIVATE KEY-----`), not PKCS8 PEM: convert with `ssh-keygen -p -f <keyfile>` |
| `passphrase` | | | for an encrypted `privateKey`, as `env("…")` |
| `hostKey` | yes | | the pinned host key |
| `dir` | yes | | the feed directory; Interbox fails each poll if it does not exist |
| `timeout` | | `30s` | the longest Interbox waits for any one answer |
| `minFileAge` | | `0s` | how old a file must be before Interbox reads it |
| `legacyAlgorithms` | | `false` | also offer SHA-1 key exchanges, for an old server that offers nothing newer |

## Network

Interbox connects out to `host` on `port` and opens one SSH session per poll. See
[Network Access](../../ops/network.md) for egress rules.

Deliveries, file formats and pipeline settings shared by every storage are on
[Reading Files from Storage](README.md).
