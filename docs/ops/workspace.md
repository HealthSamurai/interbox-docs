# The Workspace

Interbox does not carry your pipelines — it loads them from a separate
[workspace](../getting-started.md) repository at boot and keeps them up to date
while it runs. This page covers how you point an engine at one, how updates
reach it, and what the dashboard is allowed to change.

Two settings decide almost everything here:

| | |
|---|---|
| `INTERBOX_WORKSPACE_MODE` | **how** the workspace is run — a copy the engine owns, or a directory it reads in place |
| `INTERBOX_WORKSPACE_ACCESS` | **what the dashboard may do** to it — browse, propose changes, or change what is running |

They are independent. The first is about the engine, the second about the
people looking at it.

## Pointing the engine at a workspace

```sh
INTERBOX_WORKSPACE_GIT_URL=git@github.com:acme/interbox-workspace.git
INTERBOX_WORKSPACE_GIT_REF=main          # branch to run (default: main)
INTERBOX_WORKSPACE_GIT_KEY=              # the credential for a private workspace
INTERBOX_WORKSPACE_POLL_MS=30000         # how often to look for changes; 0 disables
```

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
engine's own [cache directory](#cache-and-disk), never into the workspace
checkout, which the dashboard can browse, and `ssh` is pointed at it per git
command. A token is never written down: it is handed to each `git` process as a
request header, so it is not in the checkout, not in any config file, and not on
any command line. It does ride in that process's environment, which anything
running as the same user can read for as long as the child lives — and a fetch
can run for minutes. Every `git` the engine spawns carries it, the purely local
ones included. The clone URL this replaced was worse on both counts: it put the
credential in the argv of every `ls-remote` the poll ran, which `/proc` makes
readable by *any* user rather than only the same one — and it stayed behind in
the clone's own config once the process was gone. Once the credential is
resolved, both variables are deleted from the process environment, so workspace
code and the actions the dashboard runs cannot read it back out of
`process.env`. That is not the same as hiding it: a key file is still there for
anything running as the same user, which is what the mode and the location are
for, and so is the environment of a `git` that is still running.

An engine upgraded from a release that cloned with the token in the URL still has
that URL in its existing copy of the repository. The first update after the
upgrade rewrites the remote, so the credential leaves the disk on its own — there
is nothing to clean up by hand, and no need to discard the cache.

Set neither and an SSH remote falls back to whatever the machine already has: on
a developer's machine git finds `~/.ssh` and any running agent, which is usually
what you want locally. One thing does not fall back. Every `git` the engine runs
has `GIT_TERMINAL_PROMPT=0` set, overriding an ambient `1`, because nothing here
has a terminal to answer a prompt with — so a private `https://` workspace with
no credential configured fails with `terminal prompts disabled` rather than
asking for a password and hanging. For an SSH remote the engine warns once at
boot, because in a deployment a clone with no key configured is one that is going
to fail for a reason nothing else explains.

Changing a credential needs a restart. It is read once, when the engine starts.

The credential reaches the workspace repository and nothing else. After cloning,
the engine installs the workspace's own dependencies, and that step does not get
it — so a dependency your `package.json` names as `git+ssh://…` or over private
`https` will not resolve, and the clone will look fine while the install fails.
Publish such a dependency to a registry the engine can reach, or vendor it into
the workspace. The credential stays scoped to the one repository it was issued
for, which is also what makes a read-only deploy key a complete answer.

### Host keys are checked

The workspace repository is the code this engine imports and executes, so
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
line and restart the engine. Like the credential, host keys are read once, when
the engine starts, so a rotation does not reach a process that is already
running — and that holds for a `_PATH` file just the same, since its contents
are read at that same moment rather than watched.

### A read-only key is enough

The engine clones, fetches and resets; it never pushes. A deploy key with
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

**`clone`** — the engine clones the URL into its cache, installs the workspace's
dependencies and builds it. That copy belongs to the engine: it fetches, checks
out and resets it freely, which is what makes branch switching and dashboard
edits safe. This is what a deployment runs.

**`worktree`** — the engine bundles a directory exactly as it stands, including
uncommitted edits, and never checks anything out or resets anything. The
directory belongs to someone else: your own checkout while developing, or the
volume mounted at `/workspace` in the image. Changes are picked up by watching
the newest modification time under `src/`.

If you don't set it, the URL scheme picks the default — `git@`, `https://` and
`ssh://` mean `clone`; a `file://` URL or a plain path means `worktree`. That is
only a default. `file:///path/to/repo` is a git remote like any other, so

```sh
INTERBOX_WORKSPACE_GIT_URL=file:///home/me/interbox-workspace
INTERBOX_WORKSPACE_MODE=clone
```

runs a local repository exactly as a deployment runs a remote one — the way to
exercise branch switching and dashboard commits without a stand. Note that the
engine then runs your **commits**, not your working tree; uncommitted edits are
invisible to it until you commit them.

The two modes differ in one more way worth knowing: only a `clone` can be
**held** (see below), because only a clone is ever reset.

## How an update reaches a running engine

A pipeline change is a workspace change, not an engine upgrade — no image bump,
no restart. Three things trigger a reload:

- **the poll** — `INTERBOX_WORKSPACE_POLL_MS` (default 30s). In `clone` mode it
  compares the ref's sha at the remote; in `worktree` mode, the newest mtime
  under `src/`.
- **"Sync now"** in the dashboard's Repository tab, which asks the engine
  directly rather than waiting for the poll.
- **`SIGHUP`**, for anyone driving the process from outside.

A reload loads the new workspace **first** and only swaps the running workers
once it builds. A broken commit therefore leaves the previous pipeline running
rather than taking the engine down, and the failure is reported in the
dashboard: *"the workspace on `<ref>` failed to load, so the engine is still
running the code it had"*, with the underlying error. During the swap, listeners
refuse new connections for up to the stop grace period
(`INTERBOX_STOP_GRACE_MS`, see [Updating the Engine](updating.md)) while
in-flight work finishes.

### Held updates

If the engine's copy contains work that a refresh would destroy — uncommitted
edits, or commits that were never pushed — it **stops updating** rather than
resetting over them, and says so in the dashboard:

> Workspace updates are paused — the engine is holding `main` at the current
> commit because updating would destroy local changes.

The environment keeps running the code it has until someone resolves it: push
the work to keep it, or discard it (`INTERBOX_WORKSPACE_ACCESS=apply`, since
discarding destroys it for good — as does replacing the pod). Untracked files
never cause a hold; they survive a reset anyway.

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
| switch the branch the engine runs | | | ✅ |
| save straight into a worktree | | | ✅ |
| discard a held update | | | ✅ |

The line that matters is between `push` and `apply`: **can an unreviewed change
reach what this deployment is running?** A pushed branch cannot — it waits for a
human to merge it. Switching the ref, or writing into a worktree the engine runs
in place, does it immediately.

**The dashboard has a login, but no per-user permission.** Everyone who signs in
gets whatever this allows, so treat it as a property of the environment rather
than of a person:

- **production** — `read`, or `push` if you want people proposing pipeline
  changes from the browser. Never `apply`.
- **a stand** — `push` is usually right. Use `apply` when you deliberately want
  to point it at a branch from the browser to verify something.
- **a local machine** — `apply`. This is the only level at which a worktree
  workspace can be edited at all.

Anything unrecognised is treated as `read`: a typo in a deployment's config
should cost a feature, never grant one.

### Editing from the dashboard

What "edit" means follows from the mode, because the two workspaces keep changes
in different places:

- **clone** — the copy is reset on every refresh, so an edit only survives as a
  commit. The dashboard writes your changed files, commits them as
  `interbox-dashboard` — one shared identity, since the default deployment has one
  shared account — and pushes to a branch you name. Never the deployed branch, never the
  remote's default. Open a pull request from there as usual.
- **worktree** — the file on disk *is* what runs, so the dashboard saves it
  there and the engine picks it up on the next poll. Committing is yours to do,
  in your own git.

Edits live in your **browser** until then — not on the engine, not in the
repository. They survive a reload and are visible only to you.

### When two people edit the same file

The editor records which version of the file it loaded. If that file changes
before you commit — a colleague pushes, the engine refreshes — Interbox performs
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
`log(message)` and `signal`. `signal` aborts at the deadline, 15 minutes unless
`WORKSPACE_ACTION_TIMEOUT_MS` sets it; an action that ignores it keeps running.

| route | does |
|---|---|
| `GET /api/workspace/actions` | the names of the actions |
| `POST /api/workspace/actions/<name>` | starts a run and answers `202` with `{ runId, action, startedAt }`, at once, never with its outcome; `409` while that action already runs |
| `GET /api/workspace/actions/runs` | the last 50 runs, newest first, without their results |
| `GET /api/workspace/actions/runs/<runId>` | one run, with its result; `404` once it has left the last 50 |

A run is `{ runId, action, startedAt, finishedAt?, ok?, error?, result?,
resultBytes?, resultError? }`. It is finished when `finishedAt` is set: poll the
run by id until then. `ok: false` carries the thrown message in `error`.

**What an action returns is its run's `result`**, as JSON, so a `Date` arrives
as its ISO string, and `resultBytes` is the size of that JSON. It is capped at
256 KiB of JSON unless `WORKSPACE_ACTION_RESULT_MAX_BYTES` sets another whole
number of bytes; `0` keeps no result at all. A larger result, or one JSON cannot
hold (a cycle, a `BigInt`, a function), is dropped: the run stays `ok: true`,
and `resultError` says why. Serialising stops as soon as the result is known to
be over the cap, so a huge return value is not copied in full first. A value of
the variable that is not a whole number of bytes keeps no result either, and
`resultError` names it. Returning nothing leaves all three unset.

Runs and their results live in the memory of the process that ran them, as
JSON text, so they hold at most 50 times the cap: a restart forgets them, and so
does the 51st run after them. A report that must outlive that, or that is larger
than the cap, belongs in a table of the workspace's own, with the action
returning where to find it.

With sign-in on, only a signed-in operator can list, start or read runs, and
every signed-in operator can read every run by its id: a result is not tied to
the session that started it, so do not return data some operators must not
see. With sign-in turned off (`INTERBOX_AUTH_ENABLED=false`, see
[Securing Dashboard Access](secure-access.md#turning-it-off)), anyone who can
reach the API can do all of that. A [service credential](secure-access.md)
cannot reach these routes either way.

## Switching the branch an environment runs

At `apply`, the Repository tab's branch picker points the engine at another
branch: verify a pull request on a stand, then switch back. The override is
stored beside the clone, so **a restart returns the environment to the ref it
declares** — nobody can leave a stand silently pinned to a test branch, and the
dashboard says when it is running an override.

Switching takes as long as a full reload (fetch, checkout, install, build), and
the dashboard waits for the engine to confirm rather than assuming.

## Cache and disk

```sh
INTERBOX_WORKSPACE_CACHE=/var/lib/interbox    # default: the system temp dir
```

In `clone` mode this holds the clone, its `node_modules`, the built bundle and
the ref override. The default lives in the temp directory, which on Kubernetes
means the pod's own filesystem: a replaced pod re-clones from scratch and
returns to the declared ref. Point it at a volume if you would rather keep the
clone (and any branch override) across restarts.
