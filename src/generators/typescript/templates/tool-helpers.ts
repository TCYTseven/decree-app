/**
 * Static tool implementations of the generated project. They follow the
 * "Tool semantics" section of docs/ARCHITECTURE.md exactly.
 *
 * These are template literals holding TypeScript: backslashes, backticks and
 * `${` inside the generated code are escaped (\\ \` \${).
 */

export function httpTs(): string {
  return `/** HTTP tools: call an endpoint of the project's API. */
import type { ToolResult } from "../types.js";

export interface HttpBinding {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  /** Env var holding the base URL; \`defaultBaseUrl\` is used when it is unset. */
  baseUrlEnv: string;
  defaultBaseUrl?: string;
  /** Path template; each {name} is filled from the input field of the same name. */
  path: string;
  queryParams?: string[];
  headerParams?: string[];
  /** Input field sent as the JSON body. When unset, all unconsumed fields are sent. */
  bodyParam?: string;
  auth?: { type: "bearer" | "header" | "none"; env?: string; header?: string };
}

const TIMEOUT_MS = 60_000;
const MAX_BODY_CHARS = 50_000;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function callHttp(input: Record<string, unknown>, binding: HttpBinding): Promise<ToolResult> {
  const base = process.env[binding.baseUrlEnv] ?? binding.defaultBaseUrl;
  if (!base) return { output: \`Set \${binding.baseUrlEnv} to the API base URL.\`, isError: true };

  const consumed = new Set<string>();
  let missing: string | undefined;
  let dotSegment: string | undefined;
  const urlPath = binding.path.replace(/\\{([^}]+)\\}/g, (_, name: string) => {
    consumed.add(name);
    const value = input[name];
    if (value === undefined || value === null) {
      missing ??= name;
      return "";
    }
    // "." and ".." would be resolved as dot segments by the URL parser (/users/.. -> /).
    if (toText(value) === "." || toText(value) === "..") dotSegment ??= name;
    return encodeURIComponent(toText(value));
  });
  if (missing) return { output: \`Missing required path parameter "\${missing}".\`, isError: true };
  if (dotSegment) return { output: \`Path parameter "\${dotSegment}" may not be "." or "..".\`, isError: true };

  let url: URL;
  try {
    url = new URL(base.replace(/\\/+$/, "") + urlPath);
  } catch {
    return { output: \`Invalid URL: \${base}\${urlPath}\`, isError: true };
  }
  for (const key of binding.queryParams ?? []) {
    consumed.add(key);
    const value = input[key];
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, toText(item));
  }

  const headers: Record<string, string> = { accept: "application/json, */*" };
  for (const key of binding.headerParams ?? []) {
    consumed.add(key);
    if (input[key] !== undefined && input[key] !== null) headers[key] = toText(input[key]);
  }
  const secret = binding.auth?.env ? process.env[binding.auth.env] : undefined;
  if (secret && binding.auth?.type === "bearer") headers.authorization = \`Bearer \${secret}\`;
  if (secret && binding.auth?.type === "header" && binding.auth.header) headers[binding.auth.header] = secret;

  let body: string | undefined;
  if (BODY_METHODS.has(binding.method)) {
    let payload: unknown;
    if (binding.bodyParam) {
      payload = input[binding.bodyParam];
    } else {
      const rest = Object.entries(input).filter(([key, value]) => !consumed.has(key) && value !== undefined);
      if (rest.length > 0) payload = Object.fromEntries(rest);
    }
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers["content-type"] = "application/json";
    }
  }

  try {
    const res = await fetch(url, { method: binding.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    return { output: \`HTTP \${res.status} \${res.statusText}\\n\${truncate(text)}\`, isError: res.status >= 400 };
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? \`timed out after \${TIMEOUT_MS}ms\` : errorText(err);
    return { output: \`\${binding.method} \${url.origin}\${url.pathname} failed: \${reason}\`, isError: true };
  }
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function truncate(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return \`\${text.slice(0, MAX_BODY_CHARS)}\\n…[truncated \${text.length - MAX_BODY_CHARS} chars]\`;
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // fetch wraps network failures ("fetch failed"); the cause says what went wrong.
  const cause = err.cause instanceof Error ? \`: \${err.cause.message}\` : "";
  return err.message + cause;
}
`;
}

export function shellTs(): string {
  return `/** Shell tools: run a templated command in the project. */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { GUARDRAILS, PROJECT_ROOT } from "../config.js";
import type { ToolResult } from "../types.js";

export interface ShellBinding {
  /** Command template; {{param}} is replaced with the shell-quoted input value. */
  command: string;
  /** Working directory relative to the project root. */
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** The tail of the output is kept: that is where failures and summaries are. */
const MAX_OUTPUT_CHARS = 30_000;
const PLACEHOLDER = /\\{\\{\\s*([A-Za-z0-9_-]+)\\s*\\}\\}/;

/** POSIX single-quote escaping: it's -> 'it'\\''s'. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\\\''") + "'";
}

/**
 * Fill {{param}} placeholders. Missing optional params render as nothing, and
 * the space that separated them is dropped so no empty argument is passed.
 */
export function renderCommand(template: string, input: Record<string, unknown>): string {
  // split() with a capture group alternates literal text and placeholder names.
  const parts = template.split(new RegExp(PLACEHOLDER.source, "g"));
  let command = "";
  let skipped = false;
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      command += skipped && command.endsWith(" ") ? part.replace(/^ +/, "") : part;
      return;
    }
    const value = input[part];
    skipped = value === undefined || value === null;
    if (!skipped) command += shellQuote(typeof value === "string" ? value : JSON.stringify(value));
  });
  return command.trim();
}

export function runShell(input: Record<string, unknown>, binding: ShellBinding): Promise<ToolResult> {
  const command = renderCommand(binding.command, input);
  const blocked = GUARDRAILS.blockedCommands.find((pattern) => command.includes(pattern));
  if (blocked) {
    return Promise.resolve({ output: \`Refused: the command contains the blocked pattern "\${blocked}".\`, isError: true });
  }
  const cwd = path.resolve(PROJECT_ROOT, binding.cwd ?? ".");
  const timeoutMs = binding.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let output = "";
    let dropped = 0;
    let timedOut = false;
    // detached: the command gets its own process group, so a timeout kills its children too.
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS * 2) {
        dropped += output.length - MAX_OUTPUT_CHARS;
        output = output.slice(-MAX_OUTPUT_CHARS);
      }
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: \`Failed to run command: \${err.message}\`, isError: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (output.length > MAX_OUTPUT_CHARS) {
        dropped += output.length - MAX_OUTPUT_CHARS;
        output = output.slice(-MAX_OUTPUT_CHARS);
      }
      const status = timedOut ? \`\${code ?? "none"} (timed out after \${timeoutMs}ms)\` : String(code ?? \`none (\${signal})\`);
      const body = dropped > 0 ? \`…[truncated \${dropped} chars]\\n\${output}\` : output;
      resolve({ output: \`exit code: \${status}\\n\${body}\`, isError: timedOut || code !== 0 });
    });
  });
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
`;
}

export function fsTs(): string {
  return `/**
 * File tools: read, write, list and search files under a root inside the
 * project. Model-supplied paths are untrusted: every path is resolved against
 * the tool root and refused if it escapes the root or the allowed paths,
 * lexically and after resolving symlinks.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { GUARDRAILS, PROJECT_ROOT } from "../config.js";
import type { ToolResult } from "../types.js";

export interface FsBinding {
  /** Tool root, relative to the project root. */
  root: string;
  /** read_file returns at most this many bytes. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 200_000;
const MAX_LISTED_FILES = 500;
const MAX_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".decree", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".svelte-kit", ".turbo", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache"]);

export async function readFile(input: Record<string, unknown>, binding: FsBinding): Promise<ToolResult> {
  return guarded(async () => {
    const target = await resolvePath(binding, input.path);
    const maxBytes = binding.maxBytes ?? DEFAULT_MAX_BYTES;
    const data = await fs.readFile(target);
    if (data.length <= maxBytes) return data.toString("utf8");
    return \`\${data.subarray(0, maxBytes).toString("utf8")}\\n…[truncated \${data.length - maxBytes} bytes]\`;
  });
}

export async function writeFile(input: Record<string, unknown>, binding: FsBinding): Promise<ToolResult> {
  return guarded(async () => {
    const target = await resolvePath(binding, input.path);
    const content = typeof input.content === "string" ? input.content : JSON.stringify(input.content ?? "");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return \`wrote \${Buffer.byteLength(content)} bytes to \${toPosix(path.relative(PROJECT_ROOT, target))}\`;
  });
}

export async function listFiles(input: Record<string, unknown>, binding: FsBinding): Promise<ToolResult> {
  return guarded(async () => {
    const root = await resolvePath(binding, ".");
    const pattern = globToRegExp(typeof input.pattern === "string" && input.pattern !== "" ? input.pattern : "**/*");
    const files: string[] = [];
    for await (const file of walk(root)) {
      if (!pattern.test(file)) continue;
      if (files.length === MAX_LISTED_FILES) {
        files.push(\`…[more than \${MAX_LISTED_FILES} files; use a narrower pattern]\`);
        break;
      }
      files.push(file);
    }
    return files.length > 0 ? files.join("\\n") : "No files match.";
  });
}

export async function searchFiles(input: Record<string, unknown>, binding: FsBinding): Promise<ToolResult> {
  return guarded(async () => {
    const root = await resolvePath(binding, ".");
    let query: RegExp;
    try {
      query = new RegExp(String(input.query ?? ""));
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    const filter = typeof input.glob === "string" && input.glob !== "" ? globToRegExp(input.glob) : undefined;
    const matches: string[] = [];
    for await (const file of walk(root)) {
      if (filter && !filter.test(file)) continue;
      const abs = path.join(root, file);
      if ((await fs.stat(abs)).size > MAX_SEARCH_FILE_BYTES) continue;
      const data = await fs.readFile(abs);
      if (data.subarray(0, 8000).includes(0)) continue; // binary
      const lines = data.toString("utf8").split("\\n");
      for (let i = 0; i < lines.length; i++) {
        if (!query.test(lines[i])) continue;
        if (matches.length === MAX_MATCHES) {
          matches.push(\`…[more than \${MAX_MATCHES} matches; narrow the query or glob]\`);
          return matches.join("\\n");
        }
        matches.push(\`\${file}:\${i + 1}: \${lines[i].trim().slice(0, 500)}\`);
      }
    }
    return matches.length > 0 ? matches.join("\\n") : "No matches.";
  });
}

/**
 * Glob to RegExp over POSIX relative paths: \`*\` and \`?\` stay within one path
 * segment, \`**\` spans directories, \`{a,b}\` picks alternatives (literal text only).
 */
export function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/^\\.\\//, "");
  let re = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "*" && source[i + 1] === "*") {
      const dirs = source[i + 2] === "/";
      re += dirs ? "(?:.*/)?" : ".*";
      i += dirs ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{" && source.indexOf("}", i) > i) {
      const end = source.indexOf("}", i);
      re += \`(?:\${source.slice(i + 1, end).split(",").map(escapeRegExp).join("|")})\`;
      i = end;
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(\`^\${re}$\`);
}

class ToolError extends Error {}

/** Run a file operation, turning expected failures into an error result for the model. */
async function guarded(op: () => Promise<string>): Promise<ToolResult> {
  try {
    return { output: await op(), isError: false };
  } catch (err) {
    if (err instanceof ToolError) return { output: err.message, isError: true };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { output: "No such file or directory.", isError: true };
    if (code === "EISDIR") return { output: "That path is a directory; use the list tool instead.", isError: true };
    return { output: (err as Error).message, isError: true };
  }
}

async function resolvePath(binding: FsBinding, requested: unknown): Promise<string> {
  if (typeof requested !== "string" || requested === "") throw new ToolError("A non-empty path is required.");
  const root = path.resolve(PROJECT_ROOT, binding.root);
  const target = path.resolve(root, requested);
  const allowed = GUARDRAILS.allowedPaths.map((p) => path.resolve(PROJECT_ROOT, p));
  if (!isInside(root, target) || !allowed.some((dir) => isInside(dir, target))) {
    throw new ToolError(\`Refused: \${requested} is outside the allowed paths.\`);
  }
  // Symlinks could point anywhere: check the real location as well.
  const realTarget = await realpathOfNearest(target);
  const realRoot = await realpathOfNearest(root);
  const realAllowed = await Promise.all(allowed.map(realpathOfNearest));
  if (!isInside(realRoot, realTarget) || !realAllowed.some((dir) => isInside(dir, realTarget))) {
    throw new ToolError(\`Refused: \${requested} resolves outside the allowed paths.\`);
  }
  return target;
}

/** realpath of the path, or of its nearest existing ancestor joined with the rest. */
async function realpathOfNearest(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // It exists but cannot be resolved (a dangling or looping symlink): following it
    // on write could land anywhere, so refuse instead of trusting the lexical path.
    if (await fs.lstat(p).then(() => true, () => false)) {
      throw new ToolError("Refused: the path goes through a symlink that cannot be resolved.");
    }
    const parent = path.dirname(p);
    return parent === p ? p : path.join(await realpathOfNearest(parent), path.basename(p));
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** Files under \`dir\` as sorted POSIX paths relative to it, skipping ignored and disallowed directories. */
async function* walk(dir: string, prefix = ""): AsyncGenerator<string> {
  const entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const allowed = GUARDRAILS.allowedPaths.map((p) => path.resolve(PROJECT_ROOT, p));
  for (const entry of entries) {
    const rel = prefix ? \`\${prefix}/\${entry.name}\` : entry.name;
    const abs = path.join(dir, rel);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      // Descend only where an allowed path is inside, or contains, this directory.
      if (allowed.some((a) => isInside(a, abs) || isInside(abs, a))) yield* walk(dir, rel);
    } else if (entry.isFile() && allowed.some((a) => isInside(a, abs))) {
      yield rel;
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
`;
}

export function memoryTs(): string {
  return `/**
 * Client-side backend for Anthropic's memory tool (memory_20250818). The model
 * addresses files as /memories/...; they live in MEMORY_DIR on disk.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { MEMORY_DIR } from "../config.js";
import type { ToolResult } from "../types.js";

type MemoryCommand = Anthropic.Beta.BetaMemoryTool20250818Command;

const VIRTUAL_ROOT = "/memories";

export async function runMemory(input: Record<string, unknown>): Promise<ToolResult> {
  try {
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    return { output: await execute(input as unknown as MemoryCommand), isError: false };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

async function execute(cmd: MemoryCommand): Promise<string> {
  switch (cmd.command) {
    case "view": {
      const target = resolve(cmd.path);
      const stat = await fs.stat(target).catch(() => undefined);
      if (!stat) throw new Error(\`The path \${cmd.path} does not exist.\`);
      if (stat.isDirectory()) return await listDirectory(target);
      const lines = (await fs.readFile(target, "utf8")).split("\\n");
      const [start, end] = cmd.view_range ?? [1, -1];
      const last = end === -1 ? lines.length : Math.min(end, lines.length);
      const numbered = lines.slice(start - 1, last).map((line, i) => \`\${String(start + i).padStart(6)}\\t\${line}\`);
      return \`Here's the content of \${cmd.path} with line numbers:\\n\${numbered.join("\\n")}\`;
    }
    case "create": {
      const target = resolve(cmd.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text(cmd.file_text, "file_text"), "utf8");
      return \`File created successfully at: \${cmd.path}\`;
    }
    case "str_replace": {
      const target = resolve(cmd.path);
      const content = await readExisting(target, cmd.path);
      const oldStr = text(cmd.old_str, "old_str");
      const count = content.split(oldStr).length - 1;
      if (count === 0) throw new Error(\`No replacement was performed, old_str did not appear verbatim in \${cmd.path}.\`);
      if (count > 1) throw new Error(\`No replacement was performed: old_str appears \${count} times in \${cmd.path}; make it unique.\`);
      await fs.writeFile(target, content.replace(oldStr, () => text(cmd.new_str, "new_str")), "utf8");
      return "The memory file has been edited.";
    }
    case "insert": {
      const target = resolve(cmd.path);
      const lines = (await readExisting(target, cmd.path)).split("\\n");
      if (!Number.isInteger(cmd.insert_line) || cmd.insert_line < 0 || cmd.insert_line > lines.length) {
        throw new Error(\`Invalid insert_line \${cmd.insert_line}: must be between 0 and \${lines.length}.\`);
      }
      lines.splice(cmd.insert_line, 0, text(cmd.insert_text, "insert_text"));
      await fs.writeFile(target, lines.join("\\n"), "utf8");
      return \`The file \${cmd.path} has been edited.\`;
    }
    case "delete": {
      const target = resolve(cmd.path);
      if (target === MEMORY_DIR) throw new Error("Refusing to delete the memory root.");
      await readStat(target, cmd.path);
      await fs.rm(target, { recursive: true, force: true });
      return \`Successfully deleted \${cmd.path}\`;
    }
    case "rename": {
      const from = resolve(cmd.old_path);
      const to = resolve(cmd.new_path);
      await readStat(from, cmd.old_path);
      if (await fs.stat(to).catch(() => undefined)) throw new Error(\`The destination \${cmd.new_path} already exists.\`);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return \`Successfully renamed \${cmd.old_path} to \${cmd.new_path}\`;
    }
    default:
      throw new Error(\`Unknown memory command: \${JSON.stringify((cmd as { command?: unknown }).command)}\`);
  }
}

/** Map a /memories/... path onto MEMORY_DIR, refusing anything that escapes it. */
function resolve(virtualPath: unknown): string {
  const p = text(virtualPath, "path");
  if (p !== VIRTUAL_ROOT && !p.startsWith(VIRTUAL_ROOT + "/")) {
    throw new Error(\`Memory paths must start with \${VIRTUAL_ROOT} (got \${p}).\`);
  }
  const target = path.resolve(MEMORY_DIR, "." + p.slice(VIRTUAL_ROOT.length));
  const rel = path.relative(MEMORY_DIR, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(\`Refused: \${p} escapes \${VIRTUAL_ROOT}.\`);
  }
  return target;
}

async function listDirectory(dir: string): Promise<string> {
  const lines: string[] = [];
  const visit = async (current: string, depth: number) => {
    const entries = (await fs.readdir(current, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const virtual = VIRTUAL_ROOT + "/" + path.relative(MEMORY_DIR, abs).split(path.sep).join("/");
      const size = entry.isDirectory() ? "-" : String((await fs.stat(abs)).size);
      lines.push(\`\${size}\\t\${virtual}\${entry.isDirectory() ? "/" : ""}\`);
      if (entry.isDirectory() && depth < 2) await visit(abs, depth + 1);
    }
  };
  await visit(dir, 1);
  const shown = VIRTUAL_ROOT + (dir === MEMORY_DIR ? "" : "/" + path.relative(MEMORY_DIR, dir).split(path.sep).join("/"));
  return lines.length > 0 ? \`Directory \${shown} (size in bytes, path):\\n\${lines.join("\\n")}\` : \`Directory \${shown} is empty.\`;
}

async function readExisting(target: string, shown: string): Promise<string> {
  await readStat(target, shown);
  return fs.readFile(target, "utf8");
}

async function readStat(target: string, shown: string) {
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat) throw new Error(\`The path \${shown} does not exist.\`);
  return stat;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(\`The \${field} field must be a string.\`);
  return value;
}
`;
}
