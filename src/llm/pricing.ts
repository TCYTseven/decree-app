import type { LLMUsage } from "../core/types.js";

/** USD per 1M tokens. Cache reads bill at 0.1x input, cache writes at 1.25x input. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Price table keyed by model-id prefix. Order matters: more specific prefixes
 * come first so `claude-opus-5-5` does not match `claude-opus-5`.
 */
export const PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ["claude-opus-5-5", { input: 4, output: 20 }],
  ["claude-opus-5", { input: 5, output: 25 }],
  ["claude-fable-5-1", { input: 10, output: 50 }],
  ["claude-fable-5", { input: 10, output: 50 }],
  ["claude-opus-4-8", { input: 5, output: 25 }],
  ["claude-opus-4-7", { input: 5, output: 25 }],
  ["claude-opus-4-6", { input: 5, output: 25 }],
  ["claude-sonnet-5", { input: 2, output: 10 }],
  ["claude-sonnet-4-6", { input: 3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
];

const DEFAULT_PRICE: ModelPrice = { input: 5, output: 25 }; // opus-5

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Price for a model id (prefix match; unknown models fall back to claude-opus-5 prices). */
export function priceFor(model: string): ModelPrice {
  const id = (model ?? "").trim().toLowerCase();
  for (const [prefix, price] of PRICES) {
    if (id === prefix || id.startsWith(prefix)) {
      // Guard against "claude-opus-5" matching "claude-opus-50" style ids: next char must be a separator or end.
      const next = id.charAt(prefix.length);
      if (next === "" || next === "-" || next === "[" || next === "@" || next === ":") return price;
    }
  }
  return DEFAULT_PRICE;
}

/** Estimated USD cost for a usage record on a given model id. */
export function estimateCostUsd(model: string, usage: LLMUsage): number {
  const p = priceFor(model);
  const n = (x: number | undefined) => (Number.isFinite(x) ? (x as number) : 0);
  const cost =
    (n(usage.inputTokens) * p.input +
      n(usage.outputTokens) * p.output +
      n(usage.cacheReadTokens) * p.input * CACHE_READ_MULTIPLIER +
      n(usage.cacheWriteTokens) * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  return cost;
}

/** Human-friendly USD: "$0.0042", "$0.12", "$3.50", "$1,234.00". */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a === 0) return "$0.00";
  if (a < 0.01) return `${sign}$${a.toFixed(4)}`;
  return `${sign}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
