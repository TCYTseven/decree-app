import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFiles, WriterError } from "../src/core/writer.js";

let tmp: string;
let out: string;
let manifestPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "decree-writer-"));
  out = path.join(tmp, "agent");
  manifestPath = path.join(tmp, ".decree", "manifest.json");
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const read = (p: string) => fs.readFile(path.join(out, p), "utf8");

describe("writeFiles", () => {
  it("creates files and records a manifest", async () => {
    const r = await writeFiles(out, [{ path: "a.txt", content: "A" }, { path: "dir/b.txt", content: "B" }], { manifestPath });
    expect(r.created).toEqual(["a.txt", "dir/b.txt"]);
    expect(await read("dir/b.txt")).toBe("B");
    const m = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(Object.keys(m.outputs.agent.files)).toEqual(["a.txt", "dir/b.txt"]);
  });

  it("reports unchanged and updated files", async () => {
    await writeFiles(out, [{ path: "a.txt", content: "A" }, { path: "b.txt", content: "B" }], { manifestPath });
    const r = await writeFiles(out, [{ path: "a.txt", content: "A" }, { path: "b.txt", content: "B2" }], { manifestPath });
    expect(r.unchanged).toEqual(["a.txt"]);
    expect(r.updated).toEqual(["b.txt"]);
    expect(await read("b.txt")).toBe("B2");
  });

  it("skips files the user edited, unless force", async () => {
    await writeFiles(out, [{ path: "a.txt", content: "A" }], { manifestPath });
    await fs.writeFile(path.join(out, "a.txt"), "user edit");
    let r = await writeFiles(out, [{ path: "a.txt", content: "A2" }], { manifestPath });
    expect(r.skipped).toEqual(["a.txt"]);
    expect(await read("a.txt")).toBe("user edit");
    // still skipped on the next run (manifest keeps decree's hash)
    r = await writeFiles(out, [{ path: "a.txt", content: "A3" }], { manifestPath });
    expect(r.skipped).toEqual(["a.txt"]);
    r = await writeFiles(out, [{ path: "a.txt", content: "A3" }], { manifestPath, force: true });
    expect(r.updated).toEqual(["a.txt"]);
    expect(await read("a.txt")).toBe("A3");
  });

  it("treats pre-existing files decree never wrote as user files", async () => {
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, "README.md"), "mine");
    const r = await writeFiles(out, [{ path: "README.md", content: "generated" }], { manifestPath });
    expect(r.skipped).toEqual(["README.md"]);
    expect(await read("README.md")).toBe("mine");
  });

  it("clean removes stale generated files but keeps edited ones", async () => {
    await writeFiles(out, [{ path: "keep.txt", content: "K" }, { path: "old/stale.txt", content: "S" }, { path: "edited.txt", content: "E" }], { manifestPath });
    await fs.writeFile(path.join(out, "edited.txt"), "changed by user");
    // without clean: nothing removed
    let r = await writeFiles(out, [{ path: "keep.txt", content: "K" }], { manifestPath });
    expect(r.removed).toEqual([]);
    r = await writeFiles(out, [{ path: "keep.txt", content: "K" }], { manifestPath, clean: true });
    expect(r.removed).toEqual(["old/stale.txt"]);
    expect(r.skipped).toEqual(["edited.txt"]);
    await expect(fs.access(path.join(out, "old"))).rejects.toThrow(); // empty dir pruned
    expect(await read("edited.txt")).toBe("changed by user");
  });

  it("dry run writes nothing", async () => {
    const r = await writeFiles(out, [{ path: "a.txt", content: "A" }], { manifestPath, dryRun: true });
    expect(r.created).toEqual(["a.txt"]);
    await expect(fs.access(out)).rejects.toThrow();
    await expect(fs.access(manifestPath)).rejects.toThrow();
  });

  it("sets the executable bit", async () => {
    await writeFiles(out, [{ path: "bin/run.sh", content: "#!/bin/sh\n", executable: true }], { manifestPath });
    const st = await fs.stat(path.join(out, "bin/run.sh"));
    expect(st.mode & 0o111).toBe(0o111);
  });

  it("refuses path traversal and absolute paths", async () => {
    await expect(writeFiles(out, [{ path: "../evil.txt", content: "x" }])).rejects.toBeInstanceOf(WriterError);
    await expect(writeFiles(out, [{ path: "a/../../evil.txt", content: "x" }])).rejects.toBeInstanceOf(WriterError);
    await expect(writeFiles(out, [{ path: "/etc/evil", content: "x" }])).rejects.toBeInstanceOf(WriterError);
    await expect(fs.access(path.join(tmp, "evil.txt"))).rejects.toThrow();
  });

  it("refuses to write through a symlinked directory that escapes outDir", async () => {
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(out, { recursive: true });
    await fs.symlink(outside, path.join(out, "link"));
    await expect(writeFiles(out, [{ path: "link/x.txt", content: "x" }])).rejects.toBeInstanceOf(WriterError);
    await expect(fs.access(path.join(outside, "x.txt"))).rejects.toThrow();
  });
});
