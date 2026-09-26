import os from "node:os";
import path from "node:path";
import type { LLMUsage } from "../core/types.js";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${String(rest).padStart(2, "0")}s`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** USD with sensible precision: $0.0042, $0.12, $3.40. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function totalTokens(u: LLMUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export function formatUsage(u: LLMUsage): string {
  const parts = [`${formatTokens(u.inputTokens)} in`, `${formatTokens(u.outputTokens)} out`];
  if (u.cacheReadTokens) parts.push(`${formatTokens(u.cacheReadTokens)} cached`);
  if (u.cacheWriteTokens) parts.push(`${formatTokens(u.cacheWriteTokens)} cache-write`);
  return parts.join(" · ");
}

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const emptyUsage = (): LLMUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Compact one-line JSON preview, e.g. for tool call inputs. */
export function compactJson(v: unknown, max = 80): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "";
  } catch {
    s = String(v);
  }
  if (s === "{}" || s === "") return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A short, readable path: relative to cwd when inside it, else ~-abbreviated absolute. */
export function displayPath(p: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, p);
  if (!rel) return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  const home = os.homedir();
  return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
