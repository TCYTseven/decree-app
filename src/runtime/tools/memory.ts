import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { confinePath, fail, ok, PathError, toPosix, type ToolContext, type ToolInput, type ToolOutput } from "./common.js";

const VIRTUAL_ROOT = "/memories";
const MAX_VIEW_CHARS = 200_000;

export function memoryDirFor(ctx: ToolContext): string {
  return ctx.memoryDir ?? path.join(ctx.projectRoot, ".decree", "memory");
}

/** Map a model-visible `/memories/...` path to an absolute path inside the memory dir. */
export function resolveMemoryPath(dir: string, p: unknown): string {
  if (typeof p !== "string" || !p) throw new PathError("path must be a non-empty string");
  let rel: string;
  if (p === VIRTUAL_ROOT || p === `${VIRTUAL_ROOT}/`) rel = ".";
  else if (p.startsWith(`${VIRTUAL_ROOT}/`)) rel = p.slice(VIRTUAL_ROOT.length + 1);
  else if (path.isAbsolute(p)) throw new PathError(`memory paths must be under ${VIRTUAL_ROOT}: ${p}`);
  else rel = p;
  return confinePath(dir, rel);
}

function virtualPath(dir: string, abs: string): string {
  const rel = toPosix(path.relative(dir, abs));
  return rel ? `${VIRTUAL_ROOT}/${rel}` : VIRTUAL_ROOT;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

async function listDir(dir: string, abs: string, depth: number, out: string[]): Promise<void> {
  const entries = (await readdir(abs, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const child = path.join(abs, e.name);
    const st = await stat(child).catch(() => undefined);
    if (!st) continue;
    out.push(`${human(st.size)}\t${virtualPath(dir, child)}${e.isDirectory() ? "/" : ""}`);
    if (e.isDirectory() && depth < 2) await listDir(dir, child, depth + 1, out);
  }
}

function str(input: ToolInput, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new PathError(`"${key}" must be a string`);
  return v;
}

export async function executeMemory(input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  const dir = path.resolve(memoryDirFor(ctx));
  const command = input.command;
  try {
    await mkdir(dir, { recursive: true });
    switch (command) {
      case "view": {
        const target = resolveMemoryPath(dir, input.path ?? VIRTUAL_ROOT);
        const shown = virtualPath(dir, target);
        if (!existsSync(target)) return fail(`The path ${shown} does not exist.`);
        const st = await stat(target);
        if (st.isDirectory()) {
          const lines: string[] = [];
          await listDir(dir, target, 1, lines);
          return ok(
            `Here're the files and directories up to 2 levels deep in ${shown}, excluding hidden items and node_modules:\n` +
              `${human(st.size)}\t${shown}/\n${lines.join("\n")}`.trimEnd(),
          );
        }
        const content = await readFile(target, "utf8");
        const all = content.split("\n");
        let start = 1;
        let end = all.length;
        const range = input.view_range;
        if (Array.isArray(range) && range.length === 2) {
          const [a, b] = range.map(Number);
          if (!Number.isInteger(a) || a < 1 || a > all.length) return fail(`Invalid view_range start ${range[0]}: file has ${all.length} lines.`);
          start = a;
          end = b === -1 ? all.length : Math.min(Math.max(b, a), all.length);
        }
        const numbered = all
          .slice(start - 1, end)
          .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
          .join("\n");
        const body = numbered.length > MAX_VIEW_CHARS ? `${numbered.slice(0, MAX_VIEW_CHARS)}\n…[truncated]` : numbered;
        return ok(`Here's the content of ${shown} with line numbers:\n${body}`);
      }
      case "create": {
        const target = resolveMemoryPath(dir, input.path);
        const text = str(input, "file_text");
        const shown = virtualPath(dir, target);
        if (target === dir) return fail("Cannot create a file at the memory root.");
        if (ctx.dryRun) return ok(`[dry run] would create ${shown} (${Buffer.byteLength(text)} bytes)`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text, "utf8");
        return ok(`File created successfully at: ${shown}`);
      }
      case "str_replace": {
        const target = resolveMemoryPath(dir, input.path);
        const oldStr = str(input, "old_str");
        const newStr = typeof input.new_str === "string" ? input.new_str : "";
        const shown = virtualPath(dir, target);
        if (!existsSync(target) || (await stat(target)).isDirectory()) return fail(`The path ${shown} does not exist or is a directory.`);
        const content = await readFile(target, "utf8");
        const count = oldStr ? content.split(oldStr).length - 1 : 0;
        if (count === 0) return fail(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${shown}.`);
        if (count > 1) return fail(`No replacement was performed. Multiple occurrences (${count}) of old_str \`${oldStr}\` in ${shown}. Please ensure it is unique.`);
        if (ctx.dryRun) return ok(`[dry run] would replace text in ${shown}`);
        await writeFile(target, content.replace(oldStr, () => newStr), "utf8");
        return ok(`The memory file ${shown} has been edited.`);
      }
      case "insert": {
        const target = resolveMemoryPath(dir, input.path);
        const text = str(input, "insert_text");
        const lineNo = Number(input.insert_line);
        const shown = virtualPath(dir, target);
        if (!existsSync(target) || (await stat(target)).isDirectory()) return fail(`The path ${shown} does not exist or is a directory.`);
        const lines = (await readFile(target, "utf8")).split("\n");
        if (!Number.isInteger(lineNo) || lineNo < 0 || lineNo > lines.length) {
          return fail(`Invalid \`insert_line\` parameter: ${input.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`);
        }
        if (ctx.dryRun) return ok(`[dry run] would insert ${text.split("\n").length} line(s) at line ${lineNo} of ${shown}`);
        lines.splice(lineNo, 0, ...text.replace(/\n$/, "").split("\n"));
        await writeFile(target, lines.join("\n"), "utf8");
        return ok(`The memory file ${shown} has been edited.`);
      }
      case "delete": {
        const target = resolveMemoryPath(dir, input.path);
        const shown = virtualPath(dir, target);
        if (target === dir) return fail("Cannot delete the memory root directory.");
        if (!existsSync(target)) return fail(`The path ${shown} does not exist.`);
        if (ctx.dryRun) return ok(`[dry run] would delete ${shown}`);
        await rm(target, { recursive: true, force: true });
        return ok(`Successfully deleted ${shown}`);
      }
      case "rename": {
        const from = resolveMemoryPath(dir, input.old_path);
        const to = resolveMemoryPath(dir, input.new_path);
        const shownFrom = virtualPath(dir, from);
        const shownTo = virtualPath(dir, to);
        if (from === dir || to === dir) return fail("Cannot rename the memory root directory.");
        if (!existsSync(from)) return fail(`The path ${shownFrom} does not exist.`);
        if (existsSync(to)) return fail(`The destination ${shownTo} already exists.`);
        if (ctx.dryRun) return ok(`[dry run] would rename ${shownFrom} to ${shownTo}`);
        await mkdir(path.dirname(to), { recursive: true });
        await rename(from, to);
        return ok(`Successfully renamed ${shownFrom} to ${shownTo}`);
      }
      default:
        return fail(`Unknown memory command: ${JSON.stringify(command)}. Use view, create, str_replace, insert, delete or rename.`);
    }
  } catch (err) {
    if (err instanceof PathError) return fail(`Refused: ${err.message}`);
    return fail(`Error: ${(err as Error).message}`);
  }
}
