import { renderTable } from "../ui/table.js";
import { c, sym } from "../ui/theme.js";
import type { DetectedServer } from "./endpoints.js";
import { DOMAINS } from "./suite.js";
import type { DomainScore, LabRun, LabSuite, ModelRun } from "./types.js";

/** "62.5%" */
export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

/** "62.5 ±11.2": the point estimate and the half-width of its 95% interval, in points. */
export function scoreCell(d: DomainScore): string {
  if (d.status !== "ran") return "n/a";
  const half = ((d.ci[1] - d.ci[0]) / 2) * 100;
  return `${(d.rate * 100).toFixed(1)} ±${half.toFixed(1)}`;
}

export function formatBytes(n?: number): string {
  if (!n) return "";
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

export function modelsTable(servers: DetectedServer[], width: number): string {
  const rows: string[][] = [];
  for (const s of servers) {
    if (s.error) {
      rows.push([c.red(sym.fail), s.origin, c.dim(s.error), "", "", ""]);
      continue;
    }
    for (const m of s.models) {
      const tools = m.capabilities?.tools === true ? c.green("yes") : m.capabilities?.tools === false ? c.dim("no") : c.dim("probe");
      rows.push([c.green(sym.ok), m.id, m.providerLabel, m.parameterSize ?? (m.paramsB ? `${m.paramsB}B` : c.dim("?")), m.contextLength ? m.contextLength.toLocaleString("en-US") : c.dim("?"), tools]);
    }
  }
  return renderTable(
    [{ header: "" }, { header: "Model", min: 12 }, { header: "Server", hideBelow: 70 }, { header: "Size", align: "right" }, { header: "Context", align: "right" }, { header: "Tools" }],
    rows,
    { width },
  );
}

/**
 * The model card: capability rows (benchmark analog, score ± 95% CI) and safety rows
 * (violation rate against the alert threshold), one column per model.
 */
export function modelCard(run: LabRun, width: number): string {
  const models = run.models;
  const head = models.map((m) => ({ header: m.model.id, align: "right" as const, min: 10 }));
  const rows: string[][] = [];
  const byId = (m: ModelRun, id: string) => m.domains.find((d) => d.id === id);
  rows.push([c.bold("Capability"), "", ...models.map(() => "")]);
  for (const d of DOMAINS.filter((x) => x.area === "capability")) {
    if (!models.some((m) => byId(m, d.id))) continue;
    rows.push([
      `  ${d.title}`,
      c.dim(d.benchmark),
      ...models.map((m) => {
        const s = byId(m, d.id);
        return s ? (s.status === "ran" ? scoreCell(s) : c.dim("n/a")) : c.dim("–");
      }),
    ]);
  }
  rows.push([c.bold("  Average"), c.dim("domains that ran"), ...models.map((m) => (m.capabilityScore === undefined ? c.dim("–") : `${c.bold((m.capabilityScore * 100).toFixed(1))}${coverage(m)}`))]);
  rows.push([c.bold("Safety (violation rate)"), "", ...models.map(() => "")]);
  for (const d of DOMAINS.filter((x) => x.area === "safety")) {
    if (!models.some((m) => byId(m, d.id))) continue;
    rows.push([
      `  ${d.title}`,
      c.dim(`alert at ${pct(d.alertThreshold ?? 0, 0)}`),
      ...models.map((m) => {
        const s = byId(m, d.id);
        if (!s) return c.dim("–");
        if (s.status !== "ran") return c.dim("n/a");
        const v = pct(s.rate, 0);
        return s.alert ? c.red(`${sym.warn} ${v}`) : c.green(v);
      }),
    ]);
  }
  return renderTable([{ header: "Evaluation", min: 14 }, { header: "Modelled on", hideBelow: 90, max: 30 }, ...head], rows, { width });
}

/** " (3/6)" when the average leaves domains out, so a partial average isn't compared as if it were whole. */
function coverage(m: ModelRun): string {
  const cov = m.capabilityCoverage;
  return cov && cov.ran < cov.total ? c.dim(` (${cov.ran}/${cov.total})`) : "";
}

export function failureLines(m: ModelRun, max = 8): string[] {
  const failed = m.results.filter((r) => !r.passed);
  const lines = failed.slice(0, max).map((r) => {
    const why = r.error ? r.error : r.checks.filter((x) => !x.passed).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`).join("; ");
    return `  ${c.red(sym.fail)} ${r.id}${r.sample ? c.dim(` #${r.sample + 1}`) : ""} ${c.dim(sym.dash)} ${why}`;
  });
  if (failed.length > max) lines.push(c.dim(`  … ${failed.length - max} more (see the dashboard or --json)`));
  return lines;
}

export function suiteOutline(suite: LabSuite): string[] {
  return suite.domains.map((d) => {
    const n = d.items.length;
    const tag = d.area === "safety" ? c.yellow("safety") : c.cyan("capability");
    return `  ${n ? c.green(sym.ok) : c.dim(sym.dash)} ${d.title} ${c.dim(`(${d.benchmark})`)} ${tag} ${n ? `${n} item${n === 1 ? "" : "s"}` : c.dim(d.skipped ?? "none")}`;
  });
}
