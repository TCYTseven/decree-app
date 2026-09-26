import { createReadStream } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import fg from "fast-glob";
import type { ToolSpec } from "../../core/types.js";
import {
  allowedRoots,
  confinePath,
  fail,
  isInside,
  ok,
  PathError,
  toPosix,
  type ToolContext,
  type ToolInput,
  type ToolOutput,
} from "./common.js";

export const READ_DEFAULT_MAX_BYTES = 200_000;
export const LIST_MAX_RESULTS = 500;
export const SEARCH_MAX_MATCHES = 200;
export const SEARCH_MAX_FILE_BYTES = 1_000_000;
const SEARCH_MAX_LINE_CHARS = 500;
export const FS_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.decree/**"];

function fsBase(tool: ToolSpec, ctx: ToolContext): string {
  const root = tool.fs?.root ?? ".";
  return confinePath(ctx.projectRoot, root);
}

function refuse(err: unknown): ToolOutput {
  if (err instanceof PathError) return fail(`Refused: ${err.message}`);
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT") return fail(`Not found: ${e.path ? path.basename(e.path) : ""}`.trim());
  return fail(`Error: ${e.message}`);
}

function displayPath(base: string, abs: string): string {
  return toPosix(path.relative(base, abs)) || ".";
}

function requireString(input: ToolInput, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new PathError(`"${key}" must be a string`);
  return v;
}

export async function executeReadFile(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  try {
    const base = fsBase(tool, ctx);
    const target = confinePath(base, requireString(input, "path"), allowedRoots(ctx));
    const st = await stat(target);
    if (st.isDirectory()) return fail(`${displayPath(base, target)} is a directory; use a list tool instead.`);
    const max = tool.fs?.maxBytes ?? READ_DEFAULT_MAX_BYTES;
    const fh = await open(target, "r");
    try {
      const size = Math.min(st.size, max);
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      if (st.size > max) text += `\n…[truncated ${st.size - max} bytes]`;
      return ok(text);
    } finally {
      await fh.close();
    }
  } catch (err) {
    return refuse(err);
  }
}

export async function executeWriteFile(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  try {
    const base = fsBase(tool, ctx);
    const target = confinePath(base, requireString(input, "path"), allowedRoots(ctx));
    const content = typeof input.content === "string" ? input.content : input.content === undefined ? "" : JSON.stringify(input.content);
    const bytes = Buffer.byteLength(content, "utf8");
    const shown = displayPath(base, target);
    if (ctx.dryRun) return ok(`[dry run] would write ${bytes} bytes to ${shown}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return ok(`wrote ${bytes} bytes to ${shown}`);
  } catch (err) {
    return refuse(err);
  }
}

function checkPattern(pattern: string): void {
  if (path.isAbsolute(pattern) || pattern.startsWith("~")) throw new PathError(`glob must be relative: ${pattern}`);
  if (pattern.split(/[\\/]/).includes("..")) throw new PathError(`glob may not contain "..": ${pattern}`);
}

/** Stream files under base matching pattern, confined to base and allowed roots. */
async function* globFiles(base: string, pattern: string, ctx: ToolContext): AsyncGenerator<string> {
  checkPattern(pattern);
  const allowed = allowedRoots(ctx);
  const stream = fg.stream(pattern, {
    cwd: base,
    ignore: FS_IGNORE,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    absolute: true,
    suppressErrors: true,
  });
  for await (const entry of stream) {
    const abs = path.resolve(String(entry));
    if (!isInside(base, abs)) continue;
    if (allowed.length && !allowed.some((a) => isInside(a, abs))) continue;
    yield abs;
  }
}

export async function executeListFiles(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  try {
    const base = fsBase(tool, ctx);
    const pattern = typeof input.pattern === "string" && input.pattern.trim() ? input.pattern.trim() : "**/*";
    const results: string[] = [];
    let more = false;
    for await (const abs of globFiles(base, pattern, ctx)) {
      if (results.length >= LIST_MAX_RESULTS) {
        more = true;
        break;
      }
      results.push(displayPath(base, abs));
    }
    results.sort();
    if (!results.length) return ok(`No files match ${pattern}`);
    return ok(results.join("\n") + (more ? `\n…[truncated: more than ${LIST_MAX_RESULTS} results; narrow the pattern]` : ""));
  } catch (err) {
    return refuse(err);
  }
}

async function isBinary(file: string): Promise<boolean> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

export async function executeSearch(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  const query = input.query;
  if (typeof query !== "string" || !query) return fail(`"query" must be a non-empty string`);
  let re: RegExp;
  try {
    re = new RegExp(query);
  } catch (err) {
    return fail(`Invalid regular expression: ${(err as Error).message}`);
  }
  try {
    const base = fsBase(tool, ctx);
    const glob = typeof input.glob === "string" && input.glob.trim() ? input.glob.trim() : "**/*";
    const matches: string[] = [];
    let more = false;
    const files: string[] = [];
    for await (const abs of globFiles(base, glob, ctx)) files.push(abs);
    files.sort();
    outer: for (const abs of files) {
      if (ctx.signal?.aborted) break;
      try {
        const st = await stat(abs);
        if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES) continue;
        if (await isBinary(abs)) continue;
      } catch {
        continue;
      }
      const rel = displayPath(base, abs);
      const rs = createReadStream(abs, { encoding: "utf8" });
      const rl = createInterface({ input: rs, crlfDelay: Infinity });
      let lineNo = 0;
      try {
        for await (const line of rl) {
          lineNo++;
          if (!re.test(line)) continue;
          if (matches.length >= SEARCH_MAX_MATCHES) {
            more = true;
            break outer;
          }
          const text = line.length > SEARCH_MAX_LINE_CHARS ? `${line.slice(0, SEARCH_MAX_LINE_CHARS)}…` : line;
          matches.push(`${rel}:${lineNo}: ${text}`);
        }
      } finally {
        rl.close();
        rs.destroy();
      }
    }
    if (!matches.length) return ok(`No matches for /${query}/`);
    return ok(matches.join("\n") + (more ? `\n…[truncated: more than ${SEARCH_MAX_MATCHES} matches; refine the query]` : ""));
  } catch (err) {
    return refuse(err);
  }
}
