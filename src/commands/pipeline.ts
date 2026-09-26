import path from "node:path";
import type { HarnessSpec, LLM, ProjectProfile, Target } from "../core/types.js";
import { scanProject } from "../scanner/index.js";
import { planHarness } from "../planner/index.js";
import { generateTargets, TARGET_DIRS } from "../generators/index.js";
import { createLLM, resolveApiKey } from "../llm/client.js";
import { estimateCostUsd } from "../llm/pricing.js";
import { projectPaths, saveProfile } from "../core/config.js";
import { writeFiles, type WriteReport } from "../core/writer.js";
import { DECREE_VERSION } from "../version.js";
import { CliError } from "../ui/errors.js";
import { formatUsage, formatUsd, plural } from "../ui/format.js";
import { log } from "../ui/logger.js";
import { withSpinner } from "../ui/spinner.js";
import { renderTable } from "../ui/table.js";
import { c, contentWidth, sym, truncate, wrapText } from "../ui/theme.js";
import { renderFileTree, summarizeStatuses, type TreeEntry } from "../ui/tree.js";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export const ALL_TARGETS: Target[] = ["typescript", "python", "mcp", "claude-code"];

const TARGET_ALIASES: Record<string, Target> = {
  typescript: "typescript",
  ts: "typescript",
  node: "typescript",
  python: "python",
  py: "python",
  mcp: "mcp",
  "mcp-server": "mcp",
  "claude-code": "claude-code",
  claude: "claude-code",
  cc: "claude-code",
};

export const TARGET_INFO: Record<Target, { label: string; hint: string }> = {
  typescript: { label: "TypeScript agent", hint: "Anthropic SDK, runnable with npm start" },
  python: { label: "Python agent", hint: "anthropic SDK, runnable with python main.py" },
  mcp: { label: "MCP server", hint: "expose the tools to any MCP client" },
  "claude-code": { label: "Claude Code", hint: "CLAUDE.md, subagents, slash commands, settings" },
};

export function parseTargets(input: string): Target[] {
  const parts = input
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes("all")) return [...ALL_TARGETS];
  const out: Target[] = [];
  for (const p of parts) {
    const t = TARGET_ALIASES[p];
    if (!t) {
      throw new CliError(`Unknown target "${p}"`, { hint: `Valid targets: ${ALL_TARGETS.join(", ")} (or "all")` });
    }
    if (!out.includes(t)) out.push(t);
  }
  if (!out.length) throw new CliError("No targets given", { hint: `Valid targets: ${ALL_TARGETS.join(", ")}` });
  return out;
}

export function defaultTargets(profile?: ProjectProfile): Target[] {
  const t: Target[] = [profile?.primaryLanguage === "Python" ? "python" : "typescript", "claude-code"];
  if (profile && profile.apis.length > 0) t.splice(1, 0, "mcp");
  return t;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function topResource(profile: ProjectProfile): string | undefined {
  const counts = new Map<string, number>();
  for (const api of profile.apis) {
    const seg = api.path
      .split("/")
      .filter((s) => s && !s.startsWith("{") && !s.startsWith(":") && !/^(api|v\d+|rest|graphql)$/i.test(s))[0];
    if (seg) counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** A goal suggestion derived from the profile, e.g. "Operate the orders API and triage test failures". */
export function suggestGoal(profile: ProjectProfile): string {
  if (isEmptyProfile(profile)) return "Help me write, explain and safely change code in this project";
  const hasTests = profile.scripts.some((s) => /test|check|spec/i.test(s.name));
  const tail = hasTests ? "triage test failures" : "answer questions about the code";
  if (profile.apis.length) {
    const res = topResource(profile);
    return `Operate the ${res ? `${res} ` : `${profile.name} `}API and ${tail}`;
  }
  if (profile.cli) return `Drive the ${profile.cli.bin} CLI and ${tail}`;
  if (profile.database) return `Explore the ${profile.name} data model and ${tail}`;
  if (hasTests) return `Maintain ${profile.name}: run checks, triage test failures, and explain the code`;
  return `Answer questions about the ${profile.name} codebase and help make safe changes`;
}


/** True when the scan found nothing to build tools from (no files, or no code, APIs or scripts). */
export function isEmptyProfile(profile: ProjectProfile): boolean {
  if (profile.stats.files === 0) return true;
  return !profile.languages.length && !profile.apis.length && !profile.scripts.length && !profile.frameworks.length && !profile.cli && !profile.database;
}

/** Compact multi-line profile summary for a clack note. */
export function profileSummary(profile: ProjectProfile): string {
  const langs = profile.languages
    .slice(0, 3)
    .map((l) => l.name)
    .join(", ");
  const stack = [profile.primaryLanguage ?? langs, profile.packageManager].filter(Boolean).join(c.dim(" · "));
  const cfg = profile.existingAgentConfig;
  const agentCfg = [
    cfg.claudeMd && "CLAUDE.md",
    cfg.agentsMd && "AGENTS.md",
    cfg.mcpJson && ".mcp.json",
    cfg.cursorRules && "cursor rules",
    cfg.claudeDir && ".claude/",
  ].filter(Boolean) as string[];
  const envSecrets = profile.envVars.filter((e) => e.secret).length;
  const scripts = profile.scripts
    .slice(0, 5)
    .map((s) => s.name)
    .join(", ");
  const rows: [string, string][] = [
    ["Stack", stack || c.dim("unknown")],
    ["Frameworks", profile.frameworks.length ? profile.frameworks.join(", ") : c.dim("none detected")],
    [
      "Endpoints",
      profile.apis.length
        ? `${profile.apis.length}${profile.openapiSpecs.length ? c.dim(` (OpenAPI: ${profile.openapiSpecs[0]})`) : c.dim(" (from code)")}`
        : c.dim("none"),
    ],
    ["Scripts", profile.scripts.length ? `${profile.scripts.length} ${c.dim(`(${scripts}${profile.scripts.length > 5 ? ", …" : ""})`)}` : c.dim("none")],
    ["Env vars", profile.envVars.length ? `${profile.envVars.length}${envSecrets ? c.dim(` (${envSecrets} secret)`) : ""}` : c.dim("none")],
  ];
  if (profile.database) rows.push(["Database", `${profile.database.kind}${profile.database.models.length ? c.dim(` (${plural(profile.database.models.length, "model")})`) : ""}`]);
  if (profile.cli) rows.push(["CLI", profile.cli.bin]);
  rows.push(["Agent config", agentCfg.length ? agentCfg.join(", ") : c.dim("none")]);
  if (profile.stats.truncated) rows.push(["Files", `${profile.stats.files} ${c.yellow("(scan stopped early: very large tree)")}`]);
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${c.dim(k.padEnd(w))}  ${v}`).join("\n");
}

export async function scanStep(root: string, opts: { save?: boolean } = {}): Promise<ProjectProfile> {
  const profile = await withSpinner(
    `Scanning ${c.bold(path.basename(root) || root)}…`,
    (spin) => scanProject(root, { onProgress: (m) => spin.message(m) }),
    (p) => `Scanned ${c.bold(p.name)} ${c.dim(`${sym.dot} ${plural(p.stats.files, "file")}`)}`,
    "Scan failed",
  );
  if (opts.save !== false) await saveProfile(root, profile);
  return profile;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** Find an API key (flag > env > .env in the project root > .env in cwd) and say where it came from. */
export async function findApiKey(root: string, explicit?: string): Promise<{ key?: string; source?: string }> {
  if (explicit?.trim()) return { key: explicit.trim(), source: "--api-key" };
  if (process.env.ANTHROPIC_API_KEY?.trim()) return { key: process.env.ANTHROPIC_API_KEY.trim(), source: "env" };
  const fromRoot = resolveApiKey(undefined, root);
  if (fromRoot) return { key: fromRoot, source: ".env" };
  const fromCwd = resolveApiKey(undefined, process.cwd());
  if (fromCwd) return { key: fromCwd, source: ".env (cwd)" };
  return {};
}

export function llmCost(llm: LLM): number {
  try {
    return estimateCostUsd(llm.model, llm.usage());
  } catch {
    return 0;
  }
}

export function usageLine(llm: LLM, label = "Planner"): string {
  const u = llm.usage();
  return `${label} ${c.dim(sym.dot)} ${c.cyan(llm.model)} ${c.dim(sym.dot)} ${formatUsage(u)} ${c.dim(sym.dot)} ${c.bold(formatUsd(llmCost(llm)))}`;
}

export function makeLLM(apiKey: string, model?: string): LLM {
  return createLLM({ apiKey, model });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planStep(
  profile: ProjectProfile,
  opts: { goal: string; targets: Target[]; llm?: LLM; model?: string; critique?: boolean },
): Promise<HarnessSpec> {
  const who = opts.llm ? `Claude ${c.dim(`(${opts.llm.model})`)}` : "offline heuristics";
  return withSpinner(
    opts.llm ? `Designing your harness with ${who}…` : `Planning your harness with ${who}…`,
    (spin) =>
      planHarness(profile, {
        goal: opts.goal,
        targets: opts.targets,
        llm: opts.llm,
        model: opts.model,
        critique: opts.critique,
        onProgress: (m) => spin.message(m),
      }),
    (spec) =>
      `Planned ${c.bold(spec.displayName || spec.name)} ${c.dim(
        `${sym.dot} ${plural(spec.tools.length, "tool")} ${sym.dot} ${plural(spec.subagents.length, "subagent")} ${sym.dot} ${plural(spec.evals.length, "eval")}`,
      )}`,
    "Planning failed",
  );
}

export type Safety = "read-only" | "writes" | "approval" | "destructive";

export function safetyOf(t: HarnessSpec["tools"][number]): Safety {
  if (t.destructive) return "destructive";
  if (t.requiresApproval) return "approval";
  if (t.readOnly) return "read-only";
  return "writes";
}

const SAFETY: Record<Safety, { glyph: () => string; label: string }> = {
  "read-only": { glyph: () => c.green(sym.readOnly), label: "read-only" },
  writes: { glyph: () => c.blue(sym.writes), label: "writes" },
  approval: { glyph: () => c.yellow(sym.approval), label: "asks first" },
  destructive: { glyph: () => c.red(sym.destructive), label: "destructive, asks first" },
};

/** One-cell safety marker; see safetyLegend(). */
export function safetyGlyph(t: HarnessSpec["tools"][number]): string {
  return SAFETY[safetyOf(t)].glyph();
}

/** Glyph plus words, e.g. `▲ asks first`. */
export function safetyBadge(t: HarnessSpec["tools"][number]): string {
  const s = SAFETY[safetyOf(t)];
  return `${s.glyph()} ${s.label}`;
}

/** Legend for the glyphs used by `tools`, e.g. `● read-only  ◆ writes  ▲ asks first`. */
export function safetyLegend(tools: HarnessSpec["tools"]): string {
  const used = new Set(tools.map(safetyOf));
  const order: Safety[] = ["read-only", "writes", "approval", "destructive"];
  return order
    .filter((k) => used.has(k))
    .map((k) => `${SAFETY[k].glyph()} ${c.dim(SAFETY[k].label)}`)
    .join("   ");
}

/** Plain-English approval mode, e.g. `asks before 5 risky tools`. */
export function approvalModeText(mode: HarnessSpec["guardrails"]["approvalMode"], gated?: number): string {
  if (mode === "always") return "asks before every tool call";
  if (mode === "never") return "never asks (approvals off)";
  return gated === undefined ? "asks before risky tools" : gated ? `asks before ${plural(gated, "risky tool")}` : "no tools need approval";
}

export function toolTarget(t: HarnessSpec["tools"][number]): string {
  switch (t.kind) {
    case "http":
      return t.http ? `${t.http.method} ${t.http.path}` : "http";
    case "shell":
      return t.shell ? t.shell.command : "shell";
    case "read_file":
    case "write_file":
    case "list_files":
    case "search":
      return t.fs ? `${t.fs.root}` : ".";
    default:
      return t.source === "builtin" ? "server tool" : (t.source ?? "");
  }
}

/**
 * The tools table: a safety glyph + name, kind, binding and (optionally) source.
 * Columns drop out on narrow terminals instead of truncating everything; a legend follows.
 */
export function toolsTable(spec: HarnessSpec, opts: { source?: boolean; width?: number } = {}): string {
  const width = opts.width ?? contentWidth();
  const cols = [
    { header: "Tool", min: 12 },
    { header: "Kind", min: 4, hideBelow: 66 },
    { header: "Binds to", min: 10, max: 44 },
    ...(opts.source ? [{ header: "Source", min: 8, max: 32, hideBelow: 104 }] : []),
  ];
  const rows = spec.tools.map((t) => [
    `${safetyGlyph(t)} ${c.bold(t.name)}`,
    c.dim(t.kind),
    toolTarget(t),
    ...(opts.source ? [c.dim(t.source ?? "")] : []),
  ]);
  const table = renderTable(cols, rows, { width });
  return `${table}\n${wrapText(` ${safetyLegend(spec.tools)}`, width, " ")}`;
}

/**
 * A list of commands with dim descriptions, aligned in two columns when they fit
 * in `width`, otherwise with each description on its own line under the command.
 */
export function renderSteps(steps: [string, string][], width: number): string {
  const w = Math.max(...steps.filter(([, d]) => d).map(([x]) => x.length), 0) + 2;
  const fits = steps.every(([x, d]) => !d || w + d.length <= width);
  return steps
    .map(([x, d]) => {
      if (!d) return c.cyan(x);
      if (fits) return `${c.cyan(x.padEnd(w))}${c.dim(d)}`;
      return `${c.cyan(x)}\n  ${c.dim(d)}`;
    })
    .join("\n");
}

/** Summary printed after planning. */
export function specSummary(spec: HarnessSpec): string {
  const lines: string[] = [];
  lines.push(`${c.bold(spec.displayName)} ${c.dim(`(${spec.name})`)}`);
  const width = contentWidth();
  if (spec.description) lines.push(c.dim(wrapText(spec.description, width)));
  lines.push("");
  lines.push(toolsTable(spec));
  if (spec.subagents.length) {
    lines.push("");
    lines.push(c.bold("Subagents"));
    for (const s of spec.subagents) {
      lines.push(`  ${c.cyan(s.name)} ${c.dim(`${sym.dot} ${plural(s.tools.length, "tool")} ${sym.dot} ${s.model ?? spec.model.subagentId}`)}`);
      lines.push(`    ${c.dim(truncate(s.description, width - 4))}`);
    }
  }
  lines.push("");
  const approvals = spec.tools.filter((t) => t.requiresApproval || t.destructive).length;
  const facts: [string, string][] = [
    ["Model", `${c.cyan(spec.model.id)} ${c.dim(`effort ${spec.model.effort}${spec.model.thinking === "adaptive" ? ", adaptive thinking" : ""}`)}`],
    ["Safety", approvalModeText(spec.guardrails.approvalMode, approvals)],
    ["Evals", `${spec.evals.length}`],
  ];
  for (const [k, v] of facts) lines.push(wrapText(`${c.dim(k.padEnd(7))}${v}`, width, " ".repeat(7)));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Generate + write
// ---------------------------------------------------------------------------

export interface GenerateStepOptions {
  targets: Target[];
  outDir: string; // relative to root or absolute
  force?: boolean;
  dryRun?: boolean;
  clean?: boolean;
}

export async function generateStep(root: string, spec: HarnessSpec, opts: GenerateStepOptions): Promise<WriteReport> {
  const paths = projectPaths(root, opts.outDir);
  const rel = path.relative(root, paths.outDir) || ".";
  const files = generateTargets(spec, opts.targets, { outDir: rel, decreeVersion: DECREE_VERSION });
  const report = await writeFiles(paths.outDir, files, {
    force: opts.force,
    dryRun: opts.dryRun,
    clean: opts.clean,
    manifestPath: paths.manifestPath,
  });
  printWriteReport(report, rel, opts.dryRun);
  return report;
}

export function reportEntries(report: WriteReport): TreeEntry[] {
  return [
    ...report.created.map((p) => ({ path: p, status: "created" as const })),
    ...report.updated.map((p) => ({ path: p, status: "updated" as const })),
    ...report.unchanged.map((p) => ({ path: p, status: "unchanged" as const })),
    ...report.skipped.map((p) => ({ path: p, status: "skipped" as const })),
    ...report.removed.map((p) => ({ path: p, status: "removed" as const })),
  ];
}

export function printWriteReport(report: WriteReport, relOut: string, dryRun?: boolean): void {
  const entries = reportEntries(report);
  const nothingChanged = !report.created.length && !report.updated.length && !report.removed.length;
  const title = dryRun
    ? `Would write to ${c.bold(relOut)}/ ${c.dim("(dry run)")}`
    : nothingChanged
      ? `${c.bold(relOut)}/ is up to date`
      : `Wrote ${c.bold(relOut)}/`;
  log.step(`${title}  ${summarizeStatuses(entries)}`);
  if (!nothingChanged || dryRun) log.message(renderFileTree(entries, relOut));
  if (report.skipped.length) {
    log.warn(
      `${plural(report.skipped.length, "file")} you edited ${report.skipped.length === 1 ? "was" : "were"} left untouched. Re-run with ${c.bold("--force")} to overwrite.`,
    );
  }
}

export function targetDirs(targets: Target[], outDir: string): string[] {
  return targets.map((t) => path.posix.join(outDir.split(path.sep).join("/"), TARGET_DIRS[t]));
}
