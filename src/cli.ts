#!/usr/bin/env node
// Entry point for the `decree-harness` / `decree` bins.
//
// Keep this file dependency-free: it must run on any Node version so it can print a clear
// message on unsupported runtimes. Our dependencies (@clack/prompts, commander 14) need
// Node >= 20.12 and fail at module-link time with a cryptic SyntaxError on older versions,
// so the program is loaded with a dynamic import only after the version check passes.
import module from "node:module";

const MIN_NODE: readonly [number, number, number] = [20, 12, 0];

function nodeSupported(version: string): boolean {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) !== MIN_NODE[i]) return (parts[i] ?? 0) > MIN_NODE[i]!;
  }
  return true;
}

if (!nodeSupported(process.versions.node)) {
  process.stderr.write(
    `decree-harness requires Node.js >= ${MIN_NODE.join(".")} (you have v${process.versions.node}).\n` +
      "Upgrade Node (https://nodejs.org) and try again.\n",
  );
  process.exit(1);
}

// Node >= 22.1: cache compiled bytecode for our bundle and dependencies between runs
// (noticeably faster repeat `npx decree-harness` invocations). No-op where unavailable.
try {
  (module as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch {
  // best effort
}

const { main } = await import("./commands/program.js");
void main();
