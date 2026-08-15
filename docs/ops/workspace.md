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
INTERBOX_WORKSPACE_GIT_KEY=              # token for a private https clone
INTERBOX_WORKSPACE_POLL_MS=30000         # how often to look for changes; 0 disables
```

`INTERBOX_WORKSPACE_GIT_KEY` is spliced into the clone URL, so use it only with
`https://` remotes. For SSH remotes, mount a key and let git use it as usual.

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
running the code it had"*, with the underlying error.

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

**The dashboard has no login.** Whoever can open it gets whatever this allows,
so treat it as a property of the environment rather than of a person:

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
  `interbox-dashboard` (there is no login, so there is no author to attribute
  them to) and pushes to a branch you name. Never the deployed branch, never the
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
