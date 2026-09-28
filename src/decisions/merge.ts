import type { Decision } from "../core/types.js";
import { classifyDecisionSource, nearDuplicate } from "./extract.js";

export interface MissingDecision {
  decision: Decision;
  /** "file-gone": the source file no longer exists. "not-found": the file exists but no longer states it. */
  reason: "file-gone" | "not-found";
}

export interface MergeResult {
  /** Existing decisions (in their order, statuses untouched) followed by the new ones. */
  decisions: Decision[];
  added: Decision[];
  /** Existing decisions extraction could no longer find. They are kept; the caller reports them. */
  missing: MissingDecision[];
}

/** "CLAUDE.md:14" -> "CLAUDE.md". */
export function sourceFile(source: string): string {
  return source.replace(/:\d+$/, "");
}

/**
 * Merge a fresh extraction into the decisions already in decree.json. Existing decisions win: their status, text
 * and scope stay as the team left them (only `source` follows the text when it moved). New ids are appended.
 * Existing decisions whose source disappeared are reported in `missing`, never dropped. Hand-written decisions
 * whose source is not a decision file (a meeting, a URL) are left alone.
 */
export function mergeDecisions(existing: Decision[], extracted: Decision[], fileExists: (rel: string) => boolean): MergeResult {
  const fresh = new Map(extracted.map((d) => [d.id, d]));
  const matched = new Set<string>();
  const missing: MissingDecision[] = [];
  const decisions = existing.map((e) => {
    const same = fresh.get(e.id) ?? extracted.find((x) => !existing.some((o) => o.id === x.id) && nearDuplicate(x.constraint, e.constraint));
    if (same) {
      matched.add(same.id);
      // Found again, possibly on another line or in another file: point at where it is written now.
      return same.source !== e.source ? { ...e, source: same.source } : e;
    }
    const file = sourceFile(e.source);
    if (classifyDecisionSource(file)) missing.push({ decision: e, reason: fileExists(file) ? "not-found" : "file-gone" });
    return e;
  });
  const ids = new Set(existing.map((d) => d.id));
  const added: Decision[] = [];
  for (const d of extracted) {
    if (matched.has(d.id) || ids.has(d.id)) continue;
    ids.add(d.id);
    added.push(d);
  }
  // A new decision may point at one the team already removed from decree.json.
  const all = [...decisions, ...added];
  const known = new Set(all.map((d) => d.id));
  const cleaned = added.map((d) => {
    if (!d.supersededBy || known.has(d.supersededBy)) return d;
    const { supersededBy: _drop, ...rest } = d;
    return rest;
  });
  return { decisions: [...decisions, ...cleaned], added: cleaned, missing };
}
