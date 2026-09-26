import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  // Keep in sync with package.json "engines" (@clack/prompts 1.x and commander 14 need Node >= 20.12).
  target: "node20",
  platform: "node",
  clean: true,
  // Sourcemaps are ~1.3 MB; leave them out of the published package to keep `npx` fast.
  // Set DECREE_SOURCEMAP=1 for local debugging builds.
  sourcemap: process.env.DECREE_SOURCEMAP === "1",
  // Type declarations for the programmatic API (`import { scanProject } from "decree-harness"`).
  dts: { entry: { index: "src/index.ts" } },
  // cli.ts loads the program with a dynamic import after its Node version check;
  // splitting keeps that import (and the chunk shared with index.js) as separate files.
  splitting: true,
  shims: false,
});
