# The Workspace

Interbox does not carry your pipelines. They live in a separate
[workspace](../getting-started.md) repository, which the
[workspace service](deploy.md#the-workspace-service) checks out, builds and
publishes to PostgreSQL. Every replica runs the current build and switches to
each new one while it runs. This page covers how you point a deployment at a
workspace, how updates reach the replicas, and what the dashboard is allowed to
change.

Two settings decide almost everything here:

| | |
|---|---|
| `INTERBOX_WORKSPACE_MODE` | **how** the workspace service holds the workspace: a copy it owns, or a directory it builds in place |
| `INTERBOX_WORKSPACE_ACCESS` | **what the dashboard may do** to it — browse, propose changes, or change what is running |

They are independent. The first is about the workspace service, the second
about the people looking at it.

## Pointing a deployment at a workspace

```sh
INTERBOX_WORKSPACE_GIT_URL=git@github.com:acme/interbox-workspace.git
INTERBOX_WORKSPACE_GIT_REF=main          # branch to run (default: main)
INTERBOX_WORKSPACE_GIT_KEY=              # the credential for a private workspace
INTERBOX_WORKSPACE_POLL_MS=30000         # how often to look for changes; 0 disables
```

Give the workspace service and the replicas the same settings. Only the
workspace service contacts the repository, so the credential below is used
there alone.

## The credential

A private workspace needs one credential, and `INTERBOX_WORKSPACE_GIT_KEY` is
it — for both transports. An `https://` remote wants a token, which Interbox
sends as an `Authorization` header scoped to that remote's own host. A `git@…` or
`ssh://…` remote wants an SSH private key, as PEM or base64-encoded PEM. A public
repository over `https://`, or a local path, needs nothing at all.

A public repository over **SSH** still needs a key, which surprises people. The
forges do not offer anonymous SSH — GitHub answers an unauthenticated
`git@github.com:…` with `Permission denied (publickey)` whether the repository is
public or not, and the others behave the same way. So point a public workspace at
its `https://` URL and supply nothing, or supply a key and use the SSH one; what
does not work is an SSH URL with no credential.

| | |
|---|---|
| `INTERBOX_WORKSPACE_GIT_KEY` | the credential itself |
| `INTERBOX_WORKSPACE_GIT_KEY_PATH` | the same credential, from a file |

One setting offered twice. Inline suits a secret manager, which hands you a
value and no filesystem — and base64 is accepted alongside PEM because several
of them mangle a multi-line value on the way through. A path suits anything that
already arrives as a file: a mounted secret volume, a projected file. Set both
and the inline one wins.

There is deliberately no setting that says *which kind* of credential you
supplied. The URL already decides the transport, and a private key announces
itself — so Interbox reads the value, recognises a private key by its
`-----BEGIN … PRIVATE KEY` armour, and treats anything that is not a PEM block at
all as a token. It then checks that against the remote, and says so plainly when
the two disagree: a key against an `https://` URL is refused with the
`git@host:org/repo` form to use instead, and a token against an SSH URL is
refused as a token where a key is needed. Both of those used to fail much further
along, as a mangled clone URL or an `invalid format` complaint from `ssh`.

A PEM block that is *not* a private key — a certificate, or a public key — is
refused by name rather than handed to `ssh`, which is the other way people arrive
at that same `invalid format`. If you reach for the file with the `.pub` suffix,
you will be told so.

A key must not be passphrase-protected — nothing here has a terminal to type one
into, so a key that asks for one is refused with a message saying so rather than
hanging the clone. A token is sent exactly as you configured it, so one with
whitespace *inside* it — what a wrapped copy/paste leaves behind — is refused
too, rather than delivered whole and answered with a bare `401` that says nothing
about why.

> **Upgrading?** Three things changed with it. Releases before the token moved
> into a header put it in the clone URL, and refused any token containing `@`,
> `/`, `?` or `#` because a URL does not survive them — the advice was to
> percent-encode it yourself. Such tokens are now accepted as they stand, and
> nothing decodes them, so if you took that advice, put the original value back.
> And a token configured against a **public** repository now goes out on the
> first request. A URL credential was only ever offered after the forge asked for
> one, and a public repository never asks — so any value at all worked there.
> An expired or wrong one now turns a clone that used to succeed anonymously into
> a `401`. Unset the credential if the repository is public. And the Basic
> credential itself has a new shape: the token used to go in the username slot
> with an empty password, and now goes in the password slot as
> `x-access-token:<token>`, which is what CI clones and the forges' own
> instructions use. GitHub accepts either, so nothing is asked of you there, and
> Azure DevOps — which requires the token to be the password — now works. It is a
> change on the wire all the same, so a forge that only ever took the old shape
> is the one to check.

A token is only ever sent over `https://`. A plain `http://` remote with a token
configured is refused at boot rather than cloned: sending it would put the
credential on the wire in cleartext on every poll, and not sending it would leave
a credential configured that nothing ever uses. If that repository really is
public, unset the credential and the clone goes ahead.

Nothing is written into `~/.ssh`. A key is materialised at mode `0600` under the
workspace service's own [cache directory](#cache-and-disk), never into the workspace
checkout, which the dashboard can browse, and `ssh` is pointed at it per git
command. A token is never written down: it is handed to each `git` process as a
request header, so it is not in the checkout, not in any config file, and not on
any command line. It does ride in that process's environment, which anything
running as the same user can read for as long as the child lives — and a fetch
can run for minutes. Every `git` the workspace service spawns carries it, the purely local
ones included. The clone URL this replaced was worse on both counts: it put the
credential in the argv of every `ls-remote` the poll ran, which `/proc` makes
readable by *any* user rather than only the same one — and it stayed behind in
the clone's own config once the process was gone. Once the credential is
resolved, both variables are deleted from the process environment, so workspace
code and the actions the dashboard runs cannot read it back out of
`process.env`. That is not the same as hiding it: a key file is still there for
anything running as the same user, which is what the mode and the location are
for, and so is the environment of a `git` that is still running.

A cache kept from a release that cloned with the token in the URL still has that
URL in its copy of the repository. The first update after the
upgrade rewrites the remote, so the credential leaves the disk on its own — there
is nothing to clean up by hand, and no need to discard the cache.

Set neither and an SSH remote falls back to whatever the machine already has: on
a developer's machine git finds `~/.ssh` and any running agent, which is usually
what you want locally. One thing does not fall back. Every `git` the workspace
service runs
has `GIT_TERMINAL_PROMPT=0` set, overriding an ambient `1`, because nothing here
has a terminal to answer a prompt with — so a private `https://` workspace with
no credential configured fails with `terminal prompts disabled` rather than
asking for a password and hanging. For an SSH remote the workspace service
warns once at boot, because in a deployment a clone with no key configured is one that is going
to fail for a reason nothing else explains.

Changing a credential needs a restart of the workspace service. It is read
once, when the workspace service starts.

The credential reaches the workspace repository and nothing else. After cloning,
the workspace service installs the workspace's own dependencies, and that step does not get
it — so a dependency your `package.json` names as `git+ssh://…` or over private
`https` will not resolve, and the clone will look fine while the install fails.
Publish such a dependency to a registry the workspace service can reach, or vendor it into
the workspace. The credential stays scoped to the one repository it was issued
for, which is also what makes a read-only deploy key a complete answer.

### Host keys are checked

The workspace repository is the code every replica imports and executes, so
whatever the SSH connection actually reaches chooses that code. Whenever Interbox
supplies the key it verifies the host key on every connection, and there is no
setting to relax that — no need to go looking for one. An SSH remote whose host
key cannot be found anywhere fails the clone rather than trusting it. With no key
configured Interbox is not in the connection at all: git uses the ambient
`~/.ssh`, and that machine's own ssh configuration decides how strictly it
checks.

GitHub, GitLab, Bitbucket and Azure DevOps (`ssh.dev.azure.com` and
`vs-ssh.visualstudio.com`) are already known to the image, so they need nothing
beyond a key — though Azure DevOps is the one that may refuse an ed25519 deploy
key, and if it does, generate an RSA one instead
(`ssh-keygen -t rsa -b 4096 -N ""`). Anything else — a self-hosted forge, a
mirror inside your own network — you read once and pass in:

```sh
ssh-keyscan git.example.com
```

```sh
INTERBOX_WORKSPACE_SSH_KNOWN_HOSTS="git.example.com ssh-ed25519 AAAAC3Nza…"
```

`ssh-keyscan` trusts whatever answers it, so compare the fingerprint it prints
against one your forge publishes before pasting it anywhere.
`INTERBOX_WORKSPACE_SSH_KNOWN_HOSTS_PATH` takes a `known_hosts` file instead, if
that is how yours arrives. These two are the only SSH-specific settings left —
host keys are what an https token has no equivalent of.

What you supply is *added* to what the image already knows rather than replacing
it — a host is accepted when the key it offers matches any entry — so adding a
private forge never costs you github.com. It is also the way out when a public
forge rotates its host key faster than an Interbox release does: set the new
line and restart the workspace service. Like the credential, host keys are read
once, when the workspace service starts, so a rotation does not reach a process that is already
running — and that holds for a `_PATH` file just the same, since its contents
are read at that same moment rather than watched.

### A read-only key is enough

The workspace service clones, fetches and resets; it never pushes on its own. A deploy key with
read-only access therefore runs a deployment end to end, and that is what to
give it.

Write access is a second, separate decision. The dashboard can commit and push a
branch, but only at `INTERBOX_WORKSPACE_ACCESS=push` or `apply` (see [what the
dashboard may do](#what-the-dashboard-may-do)) — and only then does the key need
to be writable. Both have to be true before anything leaves this deployment, and
neither is the default.

Prefer a deploy key to a personal access token where the forge offers one. A
deploy key belongs to the repository: it reaches that repository and nothing
else, and it does not expire. A token belongs to a person — it carries whatever
that person can reach, stops working when their access does, and expires on a
clock (GitHub caps a fine-grained token at 366 days, and an organisation can
require less).

## clone or worktree

```sh
INTERBOX_WORKSPACE_MODE=clone      # or: worktree
```

**`clone`**: the workspace service clones the URL into its cache, installs the
workspace's dependencies and builds it. That copy belongs to the workspace
service: it fetches, checks out and resets it freely, which is what makes
branch switching and dashboard edits safe. This is what a deployment runs.

**`worktree`**: the workspace service bundles a directory exactly as it
stands, including uncommitted edits, and never checks anything out or resets
anything. The directory belongs to someone else: your own checkout while
developing, or the volume mounted at `/workspace` in the image. It must be a
git checkout, because git decides which files a build holds. A change to any
file the workspace service publishes is picked up.

If you don't set it, the URL scheme picks the default — `git@`, `https://` and
`ssh://` mean `clone`; a `file://` URL or a plain path means `worktree`. That is
only a default. `file:///path/to/repo` is a git remote like any other, so

```sh
INTERBOX_WORKSPACE_GIT_URL=file:///home/me/interbox-workspace
INTERBOX_WORKSPACE_MODE=clone
```

runs a local repository exactly as a deployment runs a remote one, the way to
exercise branch switching and dashboard commits without a shared environment.
The deployment then runs your **commits**, not your working tree; uncommitted
edits are invisible to it until you commit them.

The two modes differ in one more way worth knowing: only a `clone` can be
**held** (see below), because only a clone is ever reset.

## How an update reaches the replicas

A pipeline change is a workspace change, not an engine upgrade: no image bump,
no restart. The workspace service publishes a new build when:

- **the branch moves, in `clone` mode.** It compares the branch's commit at the
  remote every `INTERBOX_WORKSPACE_POLL_MS` (default 30 s), and checks at once
  on **Sync now** in the dashboard's Repository tab and when the branch is
  switched. A clone with changes publishes only on **Publish**; see
  [Held updates](#held-updates).
- **a file changes, in `worktree` mode.** It checks every file it publishes at
  the same interval, and after each dashboard save.

The workspace service builds the revision and runs the replicas' load and
planning checks on it before it publishes. A commit that fails a check of the
whole workspace, such as a missing `ChainRegistry` export, an SDK outside the
engine's version range or two pipelines on one webhook path, is never
published: the replicas keep the build they run, and the Repository tab shows
the error. A pipeline that fails its own checks is
[parked](#parked-pipelines) instead, and the rest of the build is published.
The checks that read PostgreSQL, such as a store codec changed while units
wait, run only on the replicas.

When a publish fails, the workspace service tries the same revision again after
30 seconds, and after each further failure waits twice as long, up to 10
minutes, so a git or package registry outage clears without a new commit. A new
commit, a branch switch, **Sync now**, **Publish** and **Discard and update**
each try again at once. It logs the first error in full and a repeat of the same
error as one short warning. A replica that has no build yet names the failed
revision and its error on the Instances page.

Each replica loads a new build when PostgreSQL announces it, on its own poll at
the same interval, and on `SIGHUP`. It loads the build **first**: it unpacks it,
runs its workspace migrations and prepares the pipelines' storage, and only then
swaps its workers. A build that fails to load leaves the replica on the build it
had, and the Instances page shows the failure. On Linux, the replica starts the
new build's listeners on the same ports beside the old ones, then closes the
old ones, so new connections are never refused; an open MLLP connection is
closed once its in-flight message is answered, and the sending system
reconnects. On other systems the listeners close first and refuse connections
until the new ones are up.

### Parked pipelines

A pipeline is parked when its own source, store, sender or webhook settings fail the
checks, for example when its source's config reads an `env()` variable the
engine's environment does not set. The workspace service publishes the build
with the pipeline parked, and every replica runs the other pipelines and no
stage of the parked one:

- The Pipelines page shows it as `Parked, not running` with the error, and the
  workspace service and each replica log the error once per build.
- Its MLLP port is not served. A request to its webhook source's or pull
  sender's path gets `503` with `Retry-After: 60`, so the sending system
  retries instead of dropping the input; when the path itself is what fails
  the checks, the request gets `404`. Its storage and the units it already
  stored stay, and inputs another pipeline sends into it with `intoPipeline()`
  wait in its queue.
- A pipeline that ran in the previous build stops when the replicas load the
  build that parks it.
- A pipeline that sends into a parked pipeline whose webhook URL cannot be
  resolved is parked too, because it reports that pipeline's events.

To run it again, fix its configuration in a new revision, or set the missing
variable on the replicas and the workspace service and restart them. On start,
the workspace service checks the current build again and publishes the same
revision with the pipeline running.

### Changes the previous revision must survive

Each replica switches on its own, so for a moment some replicas store inputs
with the new build while others still use the old one. The active replica may
process units the old build stored with the new build's steps, or the reverse.
A workspace revision therefore keeps the previous revision working, the same
rule Interbox's own releases follow. Make each of these changes in two
revisions: the first keeps the old form working beside the new one, and the
second removes the old form once every replica runs the first.

- dropping or renaming a table or column that a workspace migration created:
  stop using it in one revision, remove it in the next
- changing how steps before the store key inputs or split them into units
- changing the shape of the state that sources or steps before the store write
- removing a pipeline: stop sending to it, then remove it once its units have
  finished

A store's codec does not change in place: Interbox refuses a build that changes
a pipeline's codec while units stored with the old codec wait. Give the
pipeline a new name instead.

### Held updates

If the workspace service's clone contains work that a refresh would destroy,
uncommitted edits or commits that were never pushed, it **stops following the
branch** rather than resetting over them, and says so in the dashboard:

> **Workspace updates are paused.** The workspace service is holding `main` at
> the current commit because updating would destroy local changes.

The replicas keep running the build they have until someone resolves it: push
the work to keep it, publish the checkout as it stands with **Publish**, or
discard the work. Publishing and discarding need
`INTERBOX_WORKSPACE_ACCESS=apply`, since one changes what runs and the other
destroys the work for good. Untracked files never cause a hold; they survive a
reset anyway. They do count as changes, so a checkout that has them is
published only on **Publish**.

The workspace service stores a discard as a command in PostgreSQL, applies it
once and acknowledges it. A missed notification is recovered on the next poll,
or when the workspace service's connection to PostgreSQL comes back.

`POST /api/repository/discard` returns the committed command's `generation`
before the workspace service has applied it. `GET /api/repository` reports each
workspace cache in `replicas`, with `id`, `requestedGeneration`,
`acknowledgedGeneration`, `hold`, `seenAt` and `stale`. A report with no check
for 90 seconds is stale. A new cache does not replay earlier discards.

This only applies to `clone` mode. A worktree is never refreshed or reset, so
there is nothing to hold.

## What the dashboard may do

```sh
INTERBOX_WORKSPACE_ACCESS=read     # or: push, apply
```

The Repository tab can browse the workspace, and — depending on this setting —
edit it. Each level includes the ones before it:

| | `read` (default) | `push` | `apply` |
|---|---|---|---|
| browse files, history, diffs | ✅ | ✅ | ✅ |
| edit and push to a **new** branch | | ✅ | ✅ |
| push to the deployed or default branch | | | |
| switch the branch the deployment runs | | | ✅ |
| save straight into a worktree | | | ✅ |
| publish a changed checkout | | | ✅ |
| discard a held update | | | ✅ |

The line that matters is between `push` and `apply`: **can an unreviewed change
reach what this deployment is running?** A pushed branch cannot — it waits for a
human to merge it. Switching the ref, publishing a changed checkout, or saving
into a worktree publishes the change to every replica without a review.

**The dashboard has a login, but no per-user permission.** Everyone who signs in
gets whatever this allows, so treat it as a property of the environment rather
than of a person:

- **production**: `read`, or `push` if you want people proposing pipeline
  changes from the browser. Never `apply`.
- **a test environment**: `push` is usually right. Use `apply` when you deliberately want
  to point it at a branch from the browser to verify something.
- **a local machine**: `apply`. This is the only level at which a worktree
  workspace can be edited at all.

Anything unrecognised is treated as `read`: a typo in a deployment's config
should cost a feature, never grant one.

### Editing from the dashboard

What "edit" means follows from the mode, because the two workspaces keep changes
in different places:

- **clone**: the copy is reset on every refresh, so an edit only survives as a
  commit. The dashboard writes your changed files, commits them as
  `interbox-dashboard` — one shared identity, since the default deployment has one
  shared account — and pushes to a branch you name. Never the deployed branch, never the
  remote's default. Open a pull request from there as usual.
- **worktree**: the file on disk *is* what the workspace service builds, so
  the dashboard saves it there and the workspace service publishes it.
  Committing is yours to do, in your own git.

Edits live in your **browser** until then, not on the server and not in the
repository. They survive a reload and are visible only to you.

### When two people edit the same file

The editor records which version of the file it loaded. If that file changes
before you commit (a colleague pushes, the workspace service refreshes), Interbox performs
the same three-way merge git would:

- **edits in different parts of the file** are merged, and the confirmation says
  which files were merged and why.
- **edits on the same lines** cannot be merged. The push is refused with the
  file named, and you choose: keep yours (the pull request shows exactly what
  that replaced) or cancel and rework on top of theirs.

Nothing is overwritten silently, and nothing is lost by refusing — your work
stays in the browser either way.

## Workspace actions

A workspace can ship server-side functions that its own UI pages run on demand.
Put them in `server/actions.ts`: every exported function is an action, except a
`default` export and a name starting with `_`.

```ts
export async function dailyReport(input: { day: string }, ctx) {
  ctx.log(`building the report for ${input.day}`);
  return { day: input.day, rows: await countUnits(ctx.dbUrl, input.day) };
}
```

An action gets the request's JSON body as `input`, and a context with `dbUrl`,
`log(message)` and `signal`. Build connections with `postgresConfig(ctx.dbUrl)`
from `@health-samurai/interbox/postgres`, so the action also logs in on
[Databricks Lakebase](lakebase.md). `signal` aborts at
the deadline, 15 minutes unless `WORKSPACE_ACTION_TIMEOUT_MS` sets it; an action
that ignores it keeps running.

Actions run in the workspace service, so set the variables they read there.
It builds `server/actions.ts` and its imports from its checkout when an action
is first listed or started after each sync, so an action runs the checkout as
it stands, which can be ahead of the build the replicas run. When the build
fails, starting an action answers `400` with the error and the list keeps its
last successful load; a workspace without the file answers `501`. On a stop
the workspace service refuses new runs with `503`, aborts the running ones and
waits up to `INTERBOX_STOP_GRACE_MS` for them. A request an action sent can still complete
after the abort, so its writes need a destination that tolerates a retry.

| route | does |
|---|---|
| `GET /api/workspace/actions` | the names of the actions |
| `POST /api/workspace/actions/<name>` | starts a run and answers `202` with `{ runId, action, startedAt }`, at once, never with its outcome; `409` while that action already runs |
| `GET /api/workspace/actions/runs` | the last 50 runs, newest first, without their results |
| `GET /api/workspace/actions/runs/<runId>` | one run, with its result; `404` after its completed history entry has been pruned |

A run is `{ runId, action, startedAt, finishedAt?, ok?, error?, result?,
resultBytes?, resultError? }`. Its history entry is terminal when `finishedAt` is set:
poll the run by id until then. `ok: false` carries the failure message in `error`.
After connection loss, a failed history entry does not prove that its action stopped or
that external writes finished.

**What an action returns is its run's `result`**, as JSON, so a `Date` arrives
as its ISO string, and `resultBytes` is the size of that JSON. It is capped at
256 KiB of JSON unless `WORKSPACE_ACTION_RESULT_MAX_BYTES` sets another whole
number of bytes; `0` keeps no result at all. A larger result, or one JSON cannot
hold (a cycle, a `BigInt`, a function), is dropped: the run stays `ok: true`,
and `resultError` says why. Serialising stops as soon as the result is known to
be over the cap, so a huge return value is not copied in full first. A value of
the variable that is not a whole number of bytes keeps no result either, and
`resultError` names it. Returning nothing leaves all three unset.

PostgreSQL stores UUID run IDs, results and the latest 50 completed runs plus all
unfinished runs; list requests return the latest 50 entries across restarts.
Reading history marks a run failed if its database session disappeared,
without replaying it. Store larger or longer-lived reports in a workspace table
and return a reference.

With sign-in on, only a signed-in operator can list, start or read runs, and
every signed-in operator can read every run by its id: a result is not tied to
the session that started it, so do not return data some operators must not
see. With sign-in turned off (`INTERBOX_AUTH_ENABLED=false`, see
[Securing Dashboard Access](secure-access.md#turning-it-off)), anyone who can
reach the API can do all of that. A [service credential](secure-access.md)
cannot reach these routes either way.

## Switching the branch an environment runs

At `apply`, the Repository tab's branch picker selects the branch the
deployment runs. The selection is stored in PostgreSQL, so it survives restarts
of the workspace service and the replicas; use the picker to return to the
declared ref. The dashboard shows the override.

The workspace service fetches the selected branch, checks it out, installs and
builds it, and publishes it; then every replica loads that build. A held
checkout holds the switch too. The dashboard waits for the workspace service to
report the sync rather than assuming it.

## Cache and disk

Each process keeps its cache in `interbox-engine` under the system temp
directory: `/tmp/interbox-engine` in the image, on the container's own
filesystem.

- **The workspace service's cache** holds its checkout, the checkout's
  dependencies and the SSH key it writes. Mount a volume that outlives the pod
  at `/tmp/interbox-engine`, as the Helm chart does, or a restart loses edits
  nobody has pushed.
  Branch selection lives in PostgreSQL, so a workspace service with an empty
  cache clones the selected branch, or the declared ref if none is selected.
- **A replica's cache** holds the build it runs and its readiness report.
  A replica removes a build once it runs a newer one, so give the cache room
  for two builds, each at most 100 MB.

**Each pod needs its own cache.** A replica's API reads its engine's readiness
from it, and two pods on one cache would overwrite each other's readiness and
checkout.
