import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureCacheDir,
  loadProfile,
  loadSpec,
  projectPaths,
  resolveProjectRoot,
  saveProfile,
  saveSpec,
  SpecNotFoundError,
  SpecParseError,
  SpecValidationError,
} from "../src/core/config.js";
import { sampleProfile, sampleSpec } from "./helpers/sample-spec.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-config-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("config", () => {
  it("resolves paths", () => {
    expect(resolveProjectRoot("/a/b", "c")).toBe(path.resolve("/a/b/c"));
    expect(resolveProjectRoot("/a/b")).toBe(path.resolve("/a/b"));
    const p = projectPaths("/proj", "out");
    expect(p.specPath).toBe(path.join("/proj", "decree.json"));
    expect(p.manifestPath).toBe(path.join("/proj", ".decree", "manifest.json"));
    expect(p.outDir).toBe(path.join("/proj", "out"));
  });

  it("saves and loads a spec round-trip, writing schema + gitignore", async () => {
    await saveSpec(root, sampleSpec());
    const raw = JSON.parse(await fs.readFile(path.join(root, "decree.json"), "utf8"));
    expect(Object.keys(raw)[0]).toBe("$schema");
    const { spec } = await loadSpec(root);
    expect(spec.name).toBe("acme-ops-agent");
    expect(spec.tools.map((t) => t.name)).toContain("cancel_order");
    await fs.access(path.join(root, ".decree", "schema.json"));
    expect(await fs.readFile(path.join(root, ".decree", ".gitignore"), "utf8")).toContain("runs/");
  });

  it("keeps a backup when overwriting", async () => {
    await saveSpec(root, sampleSpec());
    await saveSpec(root, sampleSpec({ displayName: "Renamed" }));
    const backup = JSON.parse(await fs.readFile(path.join(root, ".decree", "decree.backup.json"), "utf8"));
    expect(backup.displayName).toBe("Acme Ops Agent");
  });

  it("throws SpecNotFoundError when missing", async () => {
    await expect(loadSpec(root)).rejects.toBeInstanceOf(SpecNotFoundError);
  });

  it("throws SpecParseError naming the file for bad JSON", async () => {
    await fs.writeFile(path.join(root, "decree.json"), "{ nope");
    const err = await loadSpec(root).catch((e) => e);
    expect(err).toBeInstanceOf(SpecParseError);
    expect(err.message).toContain(path.join(root, "decree.json"));
  });

  it("throws SpecValidationError with details for an invalid spec", async () => {
    await fs.writeFile(path.join(root, "decree.json"), JSON.stringify({ version: 1, tools: "nope" }));
    const err = await loadSpec(root).catch((e) => e);
    expect(err).toBeInstanceOf(SpecValidationError);
    expect(err.message).toContain("decree.json");
    expect(err.errors.length).toBeGreaterThan(0);
  });

  it("saves and loads the profile", async () => {
    expect(await loadProfile(root)).toBeUndefined();
    await saveProfile(root, sampleProfile());
    expect((await loadProfile(root))?.name).toBe("acme");
  });

  it("does not overwrite a custom .decree/.gitignore", async () => {
    await fs.mkdir(path.join(root, ".decree"));
    await fs.writeFile(path.join(root, ".decree", ".gitignore"), "custom\n");
    await ensureCacheDir(root);
    expect(await fs.readFile(path.join(root, ".decree", ".gitignore"), "utf8")).toBe("custom\n");
  });
});
