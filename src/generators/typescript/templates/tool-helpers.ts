/**
 * Static tool implementations of the generated project. They follow the
 * "Tool semantics" section of docs/ARCHITECTURE.md exactly.
 *
 * These are template literals holding TypeScript: backslashes, backticks and
 * `${` inside the generated code are escaped (\\ \` \${).
 */

export function httpTs(): string {
  return `/** HTTP tools: call an endpoint of the project's API. */
import { redact } from "../config.js";
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
/** Same-origin redirects followed per request; cross-origin redirects are never followed. */
const MAX_REDIRECTS = 5;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function callHttp(input: Record<string, unknown>, binding: HttpBinding): Promise<ToolResult> {
  const base = process.env[binding.baseUrlEnv] ?? binding.defaultBaseUrl;
  if (!base) return { output: \`Set \${binding.baseUrlEnv} to the API base URL.\`, isError: true };

  // Own properties only: a param named "constructor" must not read Object.prototype.
  const get = (name: string): unknown => (Object.hasOwn(input, name) ? input[name] : undefined);
  const consumed = new Set<string>();
  let missing: string | undefined;
  let dotSegment: string | undefined;
  const urlPath = binding.path.replace(/\\{([^}]+)\\}/g, (_, name: string) => {
    consumed.add(name);
    const value = get(name);
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
    const value = get(key);
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, toText(item));
  }

  const headers: Record<string, string> = { accept: "application/json, */*" };
  for (const key of binding.headerParams ?? []) {
    consumed.add(key);
    const value = get(key);
    if (value !== undefined && value !== null) headers[key] = toText(value);
  }
  const secret = binding.auth?.env ? process.env[binding.auth.env] : undefined;
  if (secret && binding.auth?.type === "bearer") headers.authorization = \`Bearer \${secret}\`;
  if (secret && binding.auth?.type === "header" && binding.auth.header) headers[binding.auth.header] = secret;

  let body: string | undefined;
  if (BODY_METHODS.has(binding.method)) {
    let payload: unknown;
    if (binding.bodyParam) {
      payload = get(binding.bodyParam);
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
    const { res, note } = await fetchSameOrigin(url, { method: binding.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // Redact before truncating: a cut through a secret would leave a piece redact() cannot match.
    const text = redact(await res.text());
    return { output: \`HTTP \${res.status} \${res.statusText}\\n\${note ? note + "\\n" : ""}\${truncate(text)}\`, isError: res.status >= 400 };
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? \`timed out after \${TIMEOUT_MS}ms\` : errorText(err);
    return { output: \`\${binding.method} \${url.origin}\${url.pathname} failed: \${reason}\`, isError: true };
  }
}

/**
 * fetch with redirect: "manual", following at most MAX_REDIRECTS redirects that stay on
 * the same origin. A redirect to another origin is returned as-is with a note, so the
 * auth header never leaves the API's origin. 303 (and 301/302 after POST) continue as GET.
 */
async function fetchSameOrigin(
  start: URL,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<{ res: Response; note?: string }> {
  let url = start;
  let { method, body } = init;
  const headers = { ...init.headers };
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { method, headers, body, signal: init.signal, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return { res };
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return { res, note: \`[redirect not followed: invalid Location \${JSON.stringify(location)}]\` };
    }
    if (next.origin !== url.origin) return { res, note: \`[redirect to \${next.href} not followed: different origin]\` };
    if (hop >= MAX_REDIRECTS) return { res, note: \`[redirect not followed: more than \${MAX_REDIRECTS} redirects]\` };
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      if (method !== "HEAD") method = "GET";
      body = undefined;
      delete headers["content-type"];
    }
    url = next;
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
import { GUARDRAILS, PROJECT_ROOT, redact } from "../config.js";
import type { ToolResult } from "../types.js";

export interface ShellBinding {
  /** Command template; {{param}} is replaced with the shell-quoted input value. */
  command: string;
  /** Working directory relative to the project root. */
  cwd?: string;
  timeoutMs?: number;
  /** Params whose values may start with "-" (their schema sets "x-allow-flags": true). */
  allowFlags?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** The tail of the output is kept: that is where failures and summaries are. */
const MAX_OUTPUT_CHARS = 30_000;
const PLACEHOLDER = /\\{\\{\\s*([A-Za-z0-9_-]+)\\s*\\}\\}/;
const PLACEHOLDER_AT = new RegExp("^" + PLACEHOLDER.source);

/** POSIX single-quote escaping: it's -> 'it'\\''s'. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\\\''") + "'";
}

/**
 * A quoted value is one literal shell word only where the placeholder is plain,
 * top-level shell text. Returns why a placeholder is not (inside quotes, backticks,
 * a parameter expansion or a comment; right after $, \\\\ or $( ), or null when the
 * template is safe.
 */
export function unsafePlaceholder(template: string): string | null {
  const stack: string[] = [];
  const startsPlaceholder = (j: number) => PLACEHOLDER_AT.test(template.slice(j));
  for (let i = 0; i < template.length; ) {
    const match = PLACEHOLDER_AT.exec(template.slice(i));
    if (match) {
      if (stack.length > 0) return \`{{\${match[1]}}} is inside \${stack[stack.length - 1]}\`;
      if (template[i - 1] === "$" || template[i - 1] === "\\\\" || /\\$\\(\\s*$/.test(template.slice(0, i))) {
        return \`{{\${match[1]}}} follows "$", "\\\\" or "$("\`;
      }
      i += match[0].length;
      continue;
    }
    const c = template[i];
    const top = stack[stack.length - 1];
    if (top === "single quotes" || top === "a comment") {
      if (c === (top === "a comment" ? "\\n" : "'")) stack.pop();
      i++;
      continue;
    }
    if (c === "\\\\") {
      i += startsPlaceholder(i + 1) ? 1 : 2;
      continue;
    }
    const expansion = c === "$" && template[i + 1] === "{" && !startsPlaceholder(i + 1);
    if (top === "double quotes") {
      if (c === '"') stack.pop();
      else if (c === "\`") stack.push("backticks");
      else if (expansion) stack.push("a parameter expansion");
    } else if (c === "'") stack.push("single quotes");
    else if (c === '"') stack.push("double quotes");
    else if (c === "\`") {
      if (top === "backticks") stack.pop();
      else stack.push("backticks");
    } else if (expansion) stack.push("a parameter expansion");
    else if (c === "}" && top === "a parameter expansion") stack.pop();
    else if (c === "#" && (i === 0 || /[\\s;&|()<>]/.test(template[i - 1]))) stack.push("a comment");
    i += expansion ? 2 : 1;
  }
  return null;
}

/**
 * Fill {{param}} placeholders. Missing optional params render as nothing, and
 * the space that separated them is dropped so no empty argument is passed.
 * Throws when the template is unsafe, or when a value starts with "-" (it would be
 * read as an option) and the param is not listed in \`allowFlags\`.
 */
export function renderCommand(template: string, input: Record<string, unknown>, allowFlags: string[] = []): string {
  const unsafe = unsafePlaceholder(template);
  if (unsafe) throw new Error(\`unsafe command template: \${unsafe}; placeholders must be bare shell words.\`);
  // split() with a capture group alternates literal text and placeholder names.
  const parts = template.split(new RegExp(PLACEHOLDER.source, "g"));
  let command = "";
  let skipped = false;
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      command += skipped && command.endsWith(" ") ? part.replace(/^ +/, "") : part;
      return;
    }
    // Own properties only: a param named "constructor" must not read Object.prototype.
    const value = Object.hasOwn(input, part) ? input[part] : undefined;
    skipped = value === undefined || value === null;
    if (skipped) return;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.startsWith("-") && !allowFlags.includes(part)) {
      throw new Error(\`parameter values may not start with '-' (\${part}).\`);
    }
    command += shellQuote(text);
  });
  return command.trim();
}

export function runShell(input: Record<string, unknown>, binding: ShellBinding): Promise<ToolResult> {
  let command: string;
  try {
    command = renderCommand(binding.command, input, binding.allowFlags);
  } catch (err) {
    return Promise.resolve({ output: \`Refused: \${(err as Error).message}\`, isError: true });
  }
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
    // Redact before cutting: a cut through a secret would leave a piece redact() cannot match.
    const keepTail = () => {
      output = redact(output);
      if (output.length > MAX_OUTPUT_CHARS) {
        dropped += output.length - MAX_OUTPUT_CHARS;
        output = output.slice(-MAX_OUTPUT_CHARS);
      }
    };
    const collect = (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS * 2) keepTail();
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
      keepTail();
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
import { GUARDRAILS, PROJECT_ROOT, redact } from "../config.js";
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
/** read_file reads this many bytes past maxBytes so redaction sees a secret that straddles the cut. */
const REDACT_MARGIN = 4096;
/** A directory holding this file is decree's generated output: list_files and search skip it. */
const GENERATED_MARKER = ".decree-generated";
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".decree", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".svelte-kit", ".turbo", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache"]);

export async function readFile(input: Record<string, unknown>, binding: FsBinding): Promise<ToolResult> {
  return guarded(async () => {
    const target = await resolvePath(binding, input.path);
    const maxBytes = binding.maxBytes ?? DEFAULT_MAX_BYTES;
    const handle = await fs.open(target, "r");
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) throw new ToolError("That path is a directory; use the list tool instead.");
      const size = stat.size;
      // Read a margin past the limit and redact BEFORE cutting, so no fragment of a secret survives the cut.
      const buf = Buffer.alloc(Math.min(size, maxBytes + REDACT_MARGIN));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const out = Buffer.from(redact(buf.subarray(0, bytesRead).toString("utf8")), "utf8");
      // When the file was not read to the end, the last REDACT_MARGIN bytes may start a secret that
      // continues past what was read; always cut them.
      const keep = bytesRead >= size ? maxBytes : Math.max(0, Math.min(maxBytes, out.length - REDACT_MARGIN));
      if (out.length <= keep) return out.toString("utf8");
      return \`\${out.subarray(0, keep).toString("utf8")}\\n…[truncated \${out.length - keep + size - bytesRead} bytes]\`;
    } finally {
      await handle.close();
    }
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

/** Files under \`dir\` as sorted POSIX paths relative to it, skipping ignored, generated and disallowed directories. */
async function* walk(dir: string, prefix = ""): AsyncGenerator<string> {
  const entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const allowed = GUARDRAILS.allowedPaths.map((p) => path.resolve(PROJECT_ROOT, p));
  for (const entry of entries) {
    const rel = prefix ? \`\${prefix}/\${entry.name}\` : entry.name;
    const abs = path.join(dir, rel);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      // decree's own generated output (marked with .decree-generated) is not part of the project.
      if (await isGeneratedDir(abs)) continue;
      // Descend only where an allowed path is inside, or contains, this directory.
      if (allowed.some((a) => isInside(a, abs) || isInside(abs, a))) yield* walk(dir, rel);
    } else if (entry.isFile() && allowed.some((a) => isInside(a, abs))) {
      yield rel;
    }
  }
}

const generatedDirs = new Map<string, boolean>();

/** Whether \`dir\` holds the .decree-generated marker (cached per directory). */
async function isGeneratedDir(dir: string): Promise<boolean> {
  let hit = generatedDirs.get(dir);
  if (hit === undefined) {
    hit = await fs.access(path.join(dir, GENERATED_MARKER)).then(
      () => true,
      () => false,
    );
    generatedDirs.set(dir, hit);
  }
  return hit;
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
      const target = await resolve(cmd.path);
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
      const target = await resolve(cmd.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text(cmd.file_text, "file_text"), "utf8");
      return \`File created successfully at: \${cmd.path}\`;
    }
    case "str_replace": {
      const target = await resolve(cmd.path);
      const content = await readExisting(target, cmd.path);
      const oldStr = text(cmd.old_str, "old_str");
      const count = content.split(oldStr).length - 1;
      if (count === 0) throw new Error(\`No replacement was performed, old_str did not appear verbatim in \${cmd.path}.\`);
      if (count > 1) throw new Error(\`No replacement was performed: old_str appears \${count} times in \${cmd.path}; make it unique.\`);
      await fs.writeFile(target, content.replace(oldStr, () => text(cmd.new_str, "new_str")), "utf8");
      return "The memory file has been edited.";
    }
    case "insert": {
      const target = await resolve(cmd.path);
      const lines = (await readExisting(target, cmd.path)).split("\\n");
      if (!Number.isInteger(cmd.insert_line) || cmd.insert_line < 0 || cmd.insert_line > lines.length) {
        throw new Error(\`Invalid insert_line \${cmd.insert_line}: must be between 0 and \${lines.length}.\`);
      }
      lines.splice(cmd.insert_line, 0, text(cmd.insert_text, "insert_text"));
      await fs.writeFile(target, lines.join("\\n"), "utf8");
      return \`The file \${cmd.path} has been edited.\`;
    }
    case "delete": {
      const target = await resolve(cmd.path);
      if (target === MEMORY_DIR) throw new Error("Refusing to delete the memory root.");
      await readStat(target, cmd.path);
      await fs.rm(target, { recursive: true, force: true });
      return \`Successfully deleted \${cmd.path}\`;
    }
    case "rename": {
      const from = await resolve(cmd.old_path);
      const to = await resolve(cmd.new_path);
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

/**
 * Map a /memories/... path onto MEMORY_DIR, refusing anything that escapes it,
 * lexically or through a symlink (same confinement as the file tools).
 */
async function resolve(virtualPath: unknown): Promise<string> {
  const p = text(virtualPath, "path");
  if (p !== VIRTUAL_ROOT && !p.startsWith(VIRTUAL_ROOT + "/")) {
    throw new Error(\`Memory paths must start with \${VIRTUAL_ROOT} (got \${p}).\`);
  }
  const target = path.resolve(MEMORY_DIR, "." + p.slice(VIRTUAL_ROOT.length));
  if (!isInside(MEMORY_DIR, target)) throw new Error(\`Refused: \${p} escapes \${VIRTUAL_ROOT}.\`);
  const realRoot = await realpathOfNearest(MEMORY_DIR);
  if (!isInside(realRoot, await realpathOfNearest(target))) {
    throw new Error(\`Refused: \${p} resolves outside \${VIRTUAL_ROOT} through a symlink.\`);
  }
  return target;
}

/** realpath of the path, or of its nearest existing ancestor joined with the rest. */
async function realpathOfNearest(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // It exists but cannot be resolved (a dangling or looping symlink): refuse.
    if (await fs.lstat(p).then(() => true, () => false)) {
      throw new Error("Refused: the path goes through a symlink that cannot be resolved.");
    }
    const parent = path.dirname(p);
    return parent === p ? p : path.join(await realpathOfNearest(parent), path.basename(p));
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
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
