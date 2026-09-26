import { realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import type { HarnessSpec, JSONSchema, ToolSpec } from "../../core/types.js";

/** Context every tool executor receives. */
export interface ToolContext {
  projectRoot: string;
  /** Used for guardrails (blockedCommands, allowedPaths, redactEnv). */
  spec: Pick<HarnessSpec, "guardrails">;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Environment to read base URLs / auth / redaction values from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Memory tool backing directory. Defaults to `<projectRoot>/.decree/memory`. */
  memoryDir?: string;
}

export interface ToolOutput {
  output: string;
  isError: boolean;
}

export type ToolInput = Record<string, unknown>;

export const ok = (output: string): ToolOutput => ({ output, isError: false });
export const fail = (output: string): ToolOutput => ({ output, isError: true });

export function envOf(ctx: ToolContext): NodeJS.ProcessEnv {
  return ctx.env ?? process.env;
}

/** Keep the first `max` chars, appending a truncation note. */
export function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** Keep the last `max` chars, prefixing a truncation note. */
export function truncateTail(text: string, max: number, dropped = 0): string {
  const extra = Math.max(0, text.length - max);
  const total = extra + dropped;
  if (total === 0) return text;
  return `…[truncated ${total} chars]\n${text.slice(text.length - Math.min(max, text.length))}`;
}

/**
 * Replace the value of every env var listed in `guardrails.redactEnv` with
 * `[REDACTED:<NAME>]`. Longer values are replaced first so a secret that
 * contains another secret is fully scrubbed.
 */
export function redact(text: string, names: string[], env: NodeJS.ProcessEnv = process.env): string {
  const pairs = names
    .map((name) => [name, env[name]] as const)
    .filter((p): p is readonly [string, string] => typeof p[1] === "string" && p[1].length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of pairs) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  return out;
}

/** True when `child` is `parent` or inside it (both absolute, normalized). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** realpath of `p`, or of its nearest existing ancestor joined with the missing tail. */
function realpathOfNearest(p: string): string | undefined {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    let exists = false;
    try {
      lstatSync(cur);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      const real = safeRealpath(cur);
      // A dangling symlink: lstat succeeds but realpath fails. Refuse.
      if (real === undefined) return undefined;
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

export class PathError extends Error {}

/**
 * Resolve a model-supplied path under `base`, refusing anything that escapes it
 * lexically or via symlinks, or that falls outside every `allowed` root.
 * Returns the absolute resolved path.
 */
export function confinePath(base: string, input: string, allowed?: string[]): string {
  if (typeof input !== "string") throw new PathError("path must be a string");
  if (input.includes("\0")) throw new PathError("path contains a NUL byte");
  const absBase = path.resolve(base);
  const target = path.resolve(absBase, input);
  if (!isInside(absBase, target)) throw new PathError(`path escapes the allowed root: ${input}`);
  if (allowed && allowed.length && !allowed.some((a) => isInside(path.resolve(a), target))) {
    throw new PathError(`path is outside guardrails.allowedPaths: ${input}`);
  }
  const realBase = safeRealpath(absBase) ?? absBase;
  const realTarget = realpathOfNearest(target);
  if (realTarget === undefined) throw new PathError(`path cannot be resolved safely: ${input}`);
  if (!isInside(realBase, realTarget)) throw new PathError(`path escapes the allowed root via a symlink: ${input}`);
  if (allowed && allowed.length) {
    const realAllowed = allowed.map((a) => safeRealpath(path.resolve(a)) ?? path.resolve(a));
    if (!realAllowed.some((a) => isInside(a, realTarget))) {
      throw new PathError(`path is outside guardrails.allowedPaths: ${input}`);
    }
  }
  return target;
}

/** Absolute allowed roots from guardrails.allowedPaths (relative to project root). */
export function allowedRoots(ctx: ToolContext): string[] {
  const list = ctx.spec.guardrails.allowedPaths ?? [];
  return list.map((p) => path.resolve(ctx.projectRoot, p));
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Stringify an input value for shell/query/header use. */
export function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

const jsonTypeOf = (v: unknown): string[] => {
  if (v === null) return ["null"];
  if (Array.isArray(v)) return ["array"];
  if (typeof v === "number") return Number.isInteger(v) ? ["integer", "number"] : ["number"];
  return [typeof v];
};

/**
 * Minimal input validation against a tool's JSON schema: input must be an object,
 * required keys present, primitive `type`s and `enum`s respected for top-level
 * properties. Returns an error message, or undefined when valid.
 */
export function validateInput(schema: JSONSchema | undefined, input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return `Invalid tool input: expected a JSON object, got ${JSON.stringify(input)}`;
  }
  if (!schema || typeof schema !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined) problems.push(`missing required parameter "${key}"`);
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const v = obj[key];
    if (v === undefined || !prop || typeof prop !== "object") continue;
    const t = prop.type;
    if (t !== undefined) {
      const allowed = Array.isArray(t) ? t : [t];
      const actual = jsonTypeOf(v);
      if (!actual.some((a) => allowed.includes(a))) {
        problems.push(`parameter "${key}" must be ${allowed.join(" | ")}, got ${actual[0]}`);
        continue;
      }
    }
    if (Array.isArray(prop.enum) && !prop.enum.some((e) => e === v)) {
      problems.push(`parameter "${key}" must be one of ${JSON.stringify(prop.enum)}`);
    }
  }
  if (!problems.length) return undefined;
  return `Invalid tool input: ${problems.join("; ")}. Received: ${JSON.stringify(input)}`;
}

/** Tools whose kind has side effects (for dry run). */
export function hasSideEffects(tool: ToolSpec, input: ToolInput): boolean {
  switch (tool.kind) {
    case "write_file":
    case "shell":
      return true;
    case "http":
      return !["GET", "HEAD", "OPTIONS"].includes(tool.http?.method ?? "GET");
    case "memory":
      return input.command !== "view";
    default:
      return false;
  }
}

/** Combine several abort signals (AbortSignal.any is Node >= 20.3). */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
