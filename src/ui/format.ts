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

/**
 * Collapse warnings that differ only by array index, e.g. six
 * `evals[3].expect.toolsNotCalled: unknown tool "x"` lines become one line with a count.
 */
export function groupWarnings(warnings: string[]): string[] {
  const groups = new Map<string, { first: string; count: number }>();
  for (const w of warnings) {
    const key = w.replace(/\[\d+\]/g, "[]");
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { first: w, count: 1 });
  }
  return [...groups.entries()].map(([key, g]) => (g.count === 1 ? g.first : `${key.replace(/\[\]/g, "[…]").replace(/\.$/, "")} (${g.count} places)`));
}

/** Edit distance, for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** The closest candidate within a small edit distance, if any. */
export function closest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const cand of candidates) {
    const dist = editDistance(word.toLowerCase(), cand.toLowerCase());
    if (dist < bestD) {
      bestD = dist;
      best = cand;
    }
  }
  return best && bestD <= Math.max(1, Math.floor(best.length / 3)) ? best : undefined;
}
