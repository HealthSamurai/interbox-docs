#!/usr/bin/env bun
// Patch docs-tools for a Windows path bug (applied on postinstall).
//
// docs-tools' getMarkdownFiles (src/lib/files.ts) pushes Bun.Glob.scan output verbatim.
// On Windows that's backslash-separated ("concepts\\cli.md"), so the summary-sync check
// (and the exclude split) compare it against SUMMARY.md's forward-slash paths and never
// match nested files — every nested page false-fails lint and blocks the pre-push hook.
//
// `bun patch` can't generate a patch for this git dependency (it segfaults on Windows,
// bun 1.3.12), so we normalize the path in a postinstall step. Idempotent; a no-op on
// POSIX (no backslashes) and if docs-tools is already patched or its layout changed.
//
// Upstream fix: normalize in HealthSamurai/docs-tools getMarkdownFiles; then drop this.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const target = "node_modules/docs-tools/src/lib/files.ts";

if (!existsSync(target)) process.exit(0); // deps not installed yet
const src = readFileSync(target, "utf8");
if (src.includes("rawPath")) process.exit(0); // already patched

const from = "  for await (const path of glob.scan({ cwd: docsDir, absolute: false })) {";
const to = String.raw`  for await (const rawPath of glob.scan({ cwd: docsDir, absolute: false })) {
    // Normalize Windows backslash paths so they match SUMMARY.md hrefs ("/"). No-op on POSIX.
    const path = rawPath.replace(/\\/g, "/");`;

if (!src.includes(from)) {
  console.warn("[patch-docs-tools] target not found — docs-tools may have changed; skipping");
  process.exit(0);
}

writeFileSync(target, src.replace(from, to));
console.log("[patch-docs-tools] applied Windows path normalization to docs-tools");
