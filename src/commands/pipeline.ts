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
import { c, sym, termWidth, truncate } from "../ui/theme.js";
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
  rows.push(["Files", `${profile.stats.files}${profile.stats.truncated ? c.yellow(" (truncated)") : ""} ${c.dim(`scanned in ${profile.stats.scanMs}ms`)}`]);
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

export function safetyBadge(t: HarnessSpec["tools"][number]): string {
  if (t.requiresApproval || t.destructive) return c.yellow(`${sym.approval} approval`);
  if (t.readOnly) return c.green(`${sym.readOnly} read-only`);
  return c.blue(`${sym.bullet} writes`);
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

export function toolsTable(spec: HarnessSpec, opts: { source?: boolean } = {}): string {
  const cols = [
    { header: "Tool", min: 10 },
    { header: "Kind", min: 4 },
    { header: "Safety", min: 8 },
    { header: opts.source ? "Source" : "Binds to", min: 8, max: 48 },
  ];
  const rows = spec.tools.map((t) => [c.bold(t.name), c.dim(t.kind), safetyBadge(t), c.dim(opts.source ? (t.source ?? "") : toolTarget(t))]);
  return renderTable(cols, rows, { width: termWidth() - 4 }); // leave room for the clack gutter
}

/** Summary printed after planning. */
export function specSummary(spec: HarnessSpec): string {
  const lines: string[] = [];
  lines.push(`${c.bold(spec.displayName)} ${c.dim(`(${spec.name})`)}`);
  if (spec.description) lines.push(c.dim(spec.description));
  lines.push("");
  lines.push(toolsTable(spec));
  if (spec.subagents.length) {
    lines.push("");
    lines.push(c.bold("Subagents"));
    for (const s of spec.subagents) {
      lines.push(`  ${c.cyan(s.name)} ${c.dim(`${sym.dot} ${plural(s.tools.length, "tool")} ${sym.dot} ${s.model ?? spec.model.subagentId}`)}`);
      lines.push(`    ${c.dim(truncate(s.description, termWidth() - 8))}`);
    }
  }
  lines.push("");
  const approvals = spec.tools.filter((t) => t.requiresApproval || t.destructive).length;
  const facts = [
    `${c.dim("Model")} ${c.cyan(spec.model.id)} ${c.dim(`(effort ${spec.model.effort}${spec.model.thinking === "adaptive" ? ", adaptive thinking" : ""})`)}`,
    `${c.dim("Evals")} ${spec.evals.length}`,
    `${c.dim("Approval")} ${spec.guardrails.approvalMode}${approvals ? c.dim(` (${approvals} gated)`) : ""}`,
  ];
  lines.push(facts.join(c.dim("   ")));
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
  log.message(renderFileTree(entries, relOut));
  if (report.skipped.length) {
    log.warn(
      `${plural(report.skipped.length, "file")} you edited ${report.skipped.length === 1 ? "was" : "were"} left untouched. Re-run with ${c.bold("--force")} to overwrite.`,
    );
  }
}

export function targetDirs(targets: Target[], outDir: string): string[] {
  return targets.map((t) => path.posix.join(outDir.split(path.sep).join("/"), TARGET_DIRS[t]));
}
