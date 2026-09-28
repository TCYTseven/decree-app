import type { GeneratedFile, GenerateOptions, HarnessSpec, SubagentSpec, ToolSpec } from "../../core/types.js";
import { withFrontmatter } from "../common/frontmatter.js";
import { codeBlock, demoteHeadings, inlineCode, oneLine, renderTable } from "../common/markdown.js";
import { displayShellCommand, envDefault, httpTools, needsApproval, shellPlaceholders, toolEnvRefs } from "../common/spec-utils.js";
import {
  allowRulesFor,
  bashRules,
  claudeModelAlias,
  claudeToolsFor,
  claudeToolsForNames,
  decisionsViaMcp,
  DECISIONS_BASH_RULE,
  DECISIONS_SCRIPT,
  derivePermissions,
  FALLBACK_TOOLS,
  mcpServerName,
  mcpToolName,
  type MappingOptions,
} from "./mapping.js";
import { decisionsJson, decisionsScriptMjs } from "../common/decisions.js";

export * from "./mapping.js";

/** CLAUDE.md is loaded every session: inline at most this much of the system prompt. */
const CLAUDE_MD_PROMPT_BUDGET = 4000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function kebab(s: string, fallback: string): string {
  const k = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return k || fallback;
}

/**
 * Skills and commands expand `$ARGUMENTS`/`$N` and execute `` !`cmd` `` / ```` ```! ```` blocks
 * when invoked. Neutralize those in text that came from the spec so a
 * description can never inject a shell command or swallow arguments.
 */
export function neutralizeSkillText(s: string): string {
  return s
    .replace(/\$(ARGUMENTS|\d)/g, "\\$$$1")
    .replace(/!`/g, "! `")
    .replace(/^(\s*(?:`{3,}|~{3,}))\s*!/gm, "$1");
}

function isAsk(spec: HarnessSpec, t: ToolSpec): boolean {
  return needsApproval(t, spec.guardrails.approvalMode) || t.destructive;
}

/** Relative location of the generated harness (for the MCP server path); falls back to `agent`. */
function harnessDir(opts: GenerateOptions): string {
  const raw = (opts.outDir ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.split("/").includes("..") || raw === ".") return "agent";
  return raw;
}

function shQuoteDouble(s: string): string {
  return s.replace(/["\\$`]/g, "\\$&");
}

function shQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface ApiGroup {
  skill: string;
  baseUrlEnv: string;
  label: string;
  tools: ToolSpec[];
}

function apiGroups(spec: HarnessSpec): ApiGroup[] {
  const groups: ApiGroup[] = [];
  for (const t of httpTools(spec)) {
    const env = t.http!.baseUrlEnv;
    let g = groups.find((x) => x.baseUrlEnv === env);
    if (!g) {
      let base = env.toLowerCase().replace(/_?(base_?url|api_?url|url|host|endpoint)$/i, "");
      base = kebab(base, "api");
      const label = base.endsWith("api") ? base : `${base}-api`;
      let skill = kebab(`call-${label}`, "call-api");
      let i = 2;
      while (groups.some((x) => x.skill === skill)) skill = `call-${label}-${i++}`;
      g = { skill, baseUrlEnv: env, label, tools: [] };
      groups.push(g);
    }
    g.tools.push(t);
  }
  return groups;
}

function apiTitle(label: string): string {
  return label
    .split("-")
    .map((w) => (w === "api" ? "API" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function shellTools(spec: HarnessSpec): ToolSpec[] {
  return spec.tools.filter((t) => t.kind === "shell" && t.shell);
}

function shellInvocation(t: ToolSpec): string {
  const cmd = displayShellCommand(t.shell!.command);
  const cwd = t.shell!.cwd;
  return cwd && cwd !== "." ? `cd ${cwd} && ${cmd}` : cmd;
}

/** Names of skills relevant to a set of harness tool names. */
function skillsFor(spec: HarnessSpec, toolNames: string[] | null): string[] {
  const has = (t: ToolSpec) => toolNames === null || toolNames.includes(t.name);
  const out: string[] = [];
  if (shellTools(spec).some(has)) out.push("run-checks");
  for (const g of apiGroups(spec)) if (g.tools.some(has)) out.push(g.skill);
  if (spec.tools.some((t) => t.kind === "decisions" && has(t))) out.push("decisions");
  return out;
}

function decisionsToolOf(spec: HarnessSpec): ToolSpec | undefined {
  return spec.tools.find((t) => t.kind === "decisions");
}

/** How Claude Code gets decisions: the primary call, and the script fallback when that call is the MCP tool. */
function decisionsHowTo(spec: HarnessSpec, t: ToolSpec, mo: MappingOptions): { primary: string; fallback?: string } {
  const script = `run \`node ${DECISIONS_SCRIPT} <paths...>\``;
  return mo.decisionsViaMcp ? { primary: `call ${inlineCode(mcpToolName(spec, t))}`, fallback: script } : { primary: script };
}

/** "How the harness tool names map to Claude Code" note appended to agent prompts. */
function toolMappingNote(spec: HarnessSpec, toolNames: string[], mo: MappingOptions): string {
  const lines: string[] = [];
  for (const t of spec.tools) {
    if (!toolNames.includes(t.name)) continue;
    const ask = isAsk(spec, t) ? " (ask the user first)" : "";
    switch (t.kind) {
      case "shell":
        lines.push(`- \`${t.name}\`: run ${inlineCode(shellInvocation(t))} with Bash${ask}.`);
        break;
      case "http":
        lines.push(`- \`${t.name}\`: call ${inlineCode(mcpToolName(spec, t))}${ask}.`);
        break;
      case "memory":
        lines.push(`- \`${t.name}\`: use your agent memory directory (\`memory: project\`) for durable notes.`);
        break;
      case "decisions": {
        const how = decisionsHowTo(spec, t, mo);
        lines.push(`- \`${t.name}\`: ${how.primary}${how.fallback ? ` (or ${how.fallback} with Bash when the MCP server is not running)` : " with Bash"}. Skill \`decisions\` has the details.`);
        break;
      }
      default: {
        const mapped = claudeToolsFor(spec, t, mo);
        if (mapped.length) lines.push(`- \`${t.name}\`: use ${mapped.join(" / ")}${ask}.`);
      }
    }
  }
  if (!lines.length) return "";
  return ["", "## Tools in Claude Code", "", "The instructions above use harness tool names. In Claude Code they map to:", "", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

function truncatePrompt(prompt: string, budget: number): { text: string; truncated: boolean } {
  if (prompt.length <= budget) return { text: prompt, truncated: false };
  const cut = prompt.slice(0, budget);
  const para = cut.lastIndexOf("\n\n");
  const text = para > budget / 2 ? cut.slice(0, para) : cut;
  // Never leave an unclosed code fence behind.
  const fences = (text.match(/^\s{0,3}(```|~~~)/gm) ?? []).length;
  return { text: fences % 2 === 1 ? `${text}\n\`\`\`` : text, truncated: true };
}

function renderClaudeMd(spec: HarnessSpec, mainAgent: string, withMcp: boolean, mo: MappingOptions): string {
  const out: string[] = [];
  out.push(`# ${oneLine(spec.displayName)}`, "", oneLine(spec.description), "", `Goal: ${oneLine(spec.goal)}`, "");

  const { text, truncated } = truncatePrompt(spec.systemPrompt.trim(), CLAUDE_MD_PROMPT_BUDGET);
  out.push("## Working rules", "", demoteHeadings(text, 2), "");
  if (truncated) out.push(`_Abridged. Full prompt: \`.claude/agents/${mainAgent}.md\`._`, "");

  const shells = shellTools(spec);
  if (shells.length) {
    out.push("## Commands", "");
    for (const t of shells) out.push(`- ${inlineCode(shellInvocation(t))}: ${oneLine(t.description)}`);
    out.push("");
  }

  const groups = apiGroups(spec);
  if (groups.length) {
    out.push("## API", "");
    for (const g of groups) {
      const def = envDefault(spec, g.baseUrlEnv);
      const auth = g.tools.map((t) => t.http!.auth).find((a) => a && a.type !== "none" && a.env);
      out.push(
        `- Base URL: \`$${g.baseUrlEnv}\`${def ? ` (default ${inlineCode(def)})` : ""}${auth ? `; auth token: \`$${auth.env}\`` : ""}. ` +
          (withMcp ? `Prefer the \`mcp__${mcpServerName(spec)}__*\` tools; ` : "") +
          `endpoint reference: skill \`${g.skill}\`.`,
      );
    }
    out.push("");
  }

  const dt = decisionsToolOf(spec);
  if (dt) {
    const how = decisionsHowTo(spec, dt, mo);
    // Only how to look decisions up: listing them here would load every rule into every session.
    out.push(
      "## Team decisions",
      "",
      `- Before you edit or create code, ${how.primary} with the files or directories you will change. It returns only the live decisions that govern those paths.${how.fallback ? ` If the MCP server is not running, ${how.fallback} instead.` : ""}`,
      "- Follow them and cite the decision id when one constrains your change. If a request conflicts with a live decision, stop and tell the user which decision it conflicts with.",
      "",
    );
  }

  const g = spec.guardrails;
  out.push("## Safety", "");
  const destructive = spec.tools.filter((t) => isAsk(spec, t));
  if (destructive.length) {
    out.push(`- Ask for explicit confirmation before: ${destructive.map((t) => `\`${t.name}\``).join(", ")}. State exactly what will change.`);
  }
  if (g.blockedCommands.length) out.push(`- Never run: ${g.blockedCommands.map((c) => inlineCode(c)).join(", ")}.`);
  if (g.allowedPaths.length && !(g.allowedPaths.length === 1 && g.allowedPaths[0] === ".")) {
    out.push(`- Only read or write under: ${g.allowedPaths.map((c) => inlineCode(c)).join(", ")}.`);
  }
  const secrets = [...new Set([...g.redactEnv, ...spec.env.filter((e) => e.secret).map((e) => e.name)])];
  if (secrets.length) out.push(`- Never print or commit secrets (${secrets.map((c) => `\`${c}\``).join(", ")}); do not read \`.env\` files.`);
  out.push("- Prefer read-only actions; verify with the checks above before claiming a change works.", "");

  out.push(
    "## Agent setup",
    "",
    `- Main agent: \`${mainAgent}\` (\`.claude/agents/${mainAgent}.md\`).` +
      (spec.subagents.length ? ` Subagents: ${spec.subagents.map((s) => `\`${subagentName(s)}\``).join(", ")}.` : ""),
    "- Skills live in `.claude/skills/`, slash commands in `.claude/commands/`.",
    "- Generated by decree-harness from `decree.json`; regenerate instead of hand-editing.",
    "",
  );
  return out.join("\n").replace(/\n+$/, "\n");
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

function agentFile(
  spec: HarnessSpec,
  a: { name: string; description: string; systemPrompt: string; tools: string[]; model: string | undefined; effort: string },
  mo: MappingOptions,
): string {
  let tools = claudeToolsForNames(spec, a.tools, mo);
  if (tools.length === 0) tools = FALLBACK_TOOLS;
  const usesMemory = spec.tools.some((t) => t.kind === "memory" && a.tools.includes(t.name));
  const skills = skillsFor(spec, a.tools);
  const fm: Record<string, unknown> = {
    name: a.name,
    description: oneLine(a.description),
    tools: tools.join(", "),
    model: claudeModelAlias(a.model),
    effort: a.effort,
    maxTurns: spec.guardrails.maxTurns,
    skills: skills.length ? skills : undefined,
    memory: usesMemory ? "project" : undefined,
  };
  return withFrontmatter(fm, a.systemPrompt.trim() + "\n" + toolMappingNote(spec, a.tools, mo));
}

function subagentName(s: SubagentSpec): string {
  return kebab(s.name, "subagent");
}

function mainAgentName(spec: HarnessSpec): string {
  const base = kebab(spec.name, "agent");
  return spec.subagents.some((s) => subagentName(s) === base) ? `${base}-main` : base;
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

function renderRunChecksSkill(spec: HarnessSpec): string {
  const shells = shellTools(spec);
  const allowed = shells.filter((t) => !isAsk(spec, t)).flatMap(bashRules);
  const names = shells.map((t) => t.name).join(", ");
  const out: string[] = [
    "# Run checks",
    "",
    "Exact commands for this project. Run them from the repository root with Bash. Replace `<param>` placeholders with shell-quoted values, or drop them when optional.",
    "",
  ];
  for (const t of shells) {
    const sh = t.shell!;
    out.push(`## ${t.name}`, "", neutralizeSkillText(t.description.trim()), "", codeBlock(shellInvocation(t), "sh"), "");
    const params = shellPlaceholders(sh.command);
    const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    const required = t.inputSchema.required ?? [];
    for (const p of params) {
      out.push(`- \`<${p}>\`${required.includes(p) ? " (required)" : " (optional)"}${props[p]?.description ? `: ${neutralizeSkillText(oneLine(props[p]!.description!))}` : ""}`);
    }
    out.push(`- Timeout: ${Math.round((sh.timeoutMs ?? 120000) / 1000)}s${isAsk(spec, t) ? ". Changes state: ask the user before running." : "."}`, "");
  }
  if (spec.guardrails.blockedCommands.length) {
    out.push("## Never", "", ...spec.guardrails.blockedCommands.map((c) => `- ${inlineCode(neutralizeSkillText(c))}`), "");
  }
  out.push("## Reporting", "", "Report the exit code and the relevant failing lines (not the whole log). If a check fails, find the root cause before proposing a fix.");
  return withFrontmatter(
    {
      name: "run-checks",
      description: oneLine(`Run this project's checks and scripts (${names}). Use when you need to run tests, lint, build, or verify a change, and you need the exact command.`),
      "allowed-tools": allowed.length ? allowed : undefined,
    },
    out.join("\n"),
  );
}

function curlExample(spec: HarnessSpec, t: ToolSpec): string {
  const h = t.http!;
  const def = envDefault(spec, h.baseUrlEnv);
  const base = def && !/[}]/.test(def) ? `\${${h.baseUrlEnv}:-${shQuoteDouble(def)}}` : `\${${h.baseUrlEnv}}`;
  const pathParams: string[] = [];
  const path = h.path.replace(/\{([^}]+)\}/g, (_, n: string) => {
    pathParams.push(n);
    return `<${n}>`;
  });
  const query = (h.queryParams ?? []).map((q) => `${encodeURIComponent(q)}=<${q}>`).join("&");
  const url = `${base}${shQuoteDouble(path)}${query ? `?${shQuoteDouble(query)}` : ""}`;
  const parts: string[] = ["curl -sS"];
  if (h.method !== "GET") parts.push(`-X ${h.method}`);
  parts.push(`"${url}"`);
  if (h.auth?.type === "bearer" && h.auth.env) parts.push(`-H "Authorization: Bearer $${h.auth.env}"`);
  if (h.auth?.type === "header" && h.auth.env) parts.push(`-H "${shQuoteDouble(h.auth.header ?? "X-API-Key")}: $${h.auth.env}"`);
  for (const hp of h.headerParams ?? []) parts.push(`-H "${shQuoteDouble(hp)}: <${shQuoteDouble(hp)}>"`);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(h.method)) {
    const consumed = new Set([...pathParams, ...(h.queryParams ?? []), ...(h.headerParams ?? [])]);
    let body: unknown;
    if (h.bodyParam) body = `<${h.bodyParam}>`;
    else {
      const keys = Object.keys((t.inputSchema.properties ?? {}) as object).filter((k) => !consumed.has(k));
      if (keys.length) body = Object.fromEntries(keys.map((k) => [k, `<${k}>`]));
    }
    if (body !== undefined) {
      parts.push(`-H "Content-Type: application/json"`);
      parts.push(`-d ${shQuoteSingle(JSON.stringify(body))}`);
    }
  }
  return parts.join(" \\\n  ");
}

function renderApiSkill(spec: HarnessSpec, g: ApiGroup, withMcp: boolean): string {
  const def = envDefault(spec, g.baseUrlEnv);
  const auth = g.tools.map((t) => t.http!.auth).find((a) => a && a.type !== "none" && a.env);
  const out: string[] = [
    `# Call the ${apiTitle(g.label)}`,
    "",
    `- Base URL: \`$${g.baseUrlEnv}\`${def ? ` (default ${inlineCode(def)})` : ""}`,
  ];
  if (auth) out.push(`- Auth: ${auth.type === "bearer" ? "`Authorization: Bearer`" : `header ${inlineCode(auth.header ?? "X-API-Key")}`} from \`$${auth.env}\`. Never echo the token.`);
  if (withMcp) {
    out.push(`- Prefer the MCP tools (\`mcp__${mcpServerName(spec)}__<tool>\`); fall back to curl only when the MCP server is not running.`);
  }
  out.push("- Endpoints marked **confirm first** change data: get explicit user confirmation of the exact target before calling.", "");
  out.push(
    renderTable(
      ["Tool", "Endpoint", "Safety"],
      g.tools.map((t) => [inlineCode(t.name), inlineCode(`${t.http!.method} ${t.http!.path}`), isAsk(spec, t) ? "confirm first" : t.readOnly ? "read-only" : "writes"]),
    ),
    "",
  );
  for (const t of g.tools) {
    out.push(`## ${t.name}${isAsk(spec, t) ? " (confirm first)" : ""}`, "", neutralizeSkillText(t.description.trim()), "");
    const props = (t.inputSchema.properties ?? {}) as Record<string, { type?: unknown; description?: string; enum?: unknown[] }>;
    const req = t.inputSchema.required ?? [];
    const keys = Object.keys(props);
    if (keys.length) {
      out.push(
        renderTable(
          ["Param", "Type", "Required", "Description"],
          keys.map((k) => [
            inlineCode(k),
            props[k]!.enum ? props[k]!.enum!.map((v) => JSON.stringify(v)).join(" / ") : String(props[k]!.type ?? ""),
            req.includes(k) ? "yes" : "no",
            neutralizeSkillText(props[k]!.description ?? ""),
          ]),
        ),
        "",
      );
    }
    out.push(codeBlock(neutralizeSkillText(curlExample(spec, t)), "sh"), "");
  }
  const allowed = withMcp ? g.tools.filter((t) => !isAsk(spec, t)).map((t) => mcpToolName(spec, t)) : [];
  return withFrontmatter(
    {
      name: g.skill,
      description: oneLine(
        `Reference for the ${apiTitle(g.label)} at $${g.baseUrlEnv}: ${g.tools.map((t) => `${t.http!.method} ${t.http!.path}`).join(", ")}. Use when you need to call these endpoints, check parameters, or build a curl request.`,
      ).slice(0, 1024),
      "allowed-tools": allowed.length ? allowed : undefined,
    },
    out.join("\n"),
  );
}

function renderDecisionsSkill(spec: HarnessSpec, t: ToolSpec, mo: MappingOptions): string {
  const n = spec.decisions?.filter((d) => d.status === "live").length ?? 0;
  const out: string[] = [
    "# Team decisions",
    "",
    `This repository records ${n} live decision${n === 1 ? "" : "s"} (ADRs, post-mortem lessons, repo rules). Each one governs some paths. Look up the ones that govern the files you are about to change instead of guessing.`,
    "",
    "## Look them up",
    "",
  ];
  if (mo.decisionsViaMcp) {
    out.push(`Call ${inlineCode(mcpToolName(spec, t))} with \`{"paths": [...]}\`. When the MCP server is not running, run the script from the repository root:`, "");
  } else {
    out.push("Run the script from the repository root with the files or directories you will change:", "");
  }
  out.push(
    codeBlock(`node ${DECISIONS_SCRIPT} src/db/users.ts migrations/`, "sh"),
    "",
    "Add `--proposed` to also see proposed decisions that nobody has confirmed yet.",
    "",
    "## Use them",
    "",
    "- Follow the live decisions it prints, and cite the decision id when one constrains your change.",
    "- If the request conflicts with a live decision, stop and tell the user which decision it conflicts with. Do not work around it.",
    "- Proposed decisions are drafts: mention a conflict with one, but it does not block the change.",
  );
  return withFrontmatter(
    {
      name: "decisions",
      description: oneLine("Look up the team decisions (ADRs, post-mortem lessons, repo rules) that govern the files you are about to edit. Use before changing code."),
      "allowed-tools": mo.decisionsViaMcp ? [mcpToolName(spec, t), DECISIONS_BASH_RULE] : [DECISIONS_BASH_RULE],
    },
    out.join("\n"),
  );
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function readOnlyAllowed(spec: HarnessSpec, names: string[] | null, mo: MappingOptions): string[] {
  const out: string[] = [];
  for (const t of spec.tools) {
    if (names && !names.includes(t.name)) continue;
    if (isAsk(spec, t) || !t.readOnly) continue;
    const rules = allowRulesFor(spec, t, mo);
    for (const r of rules) if (!out.includes(r)) out.push(r);
  }
  return out;
}

function renderCommands(spec: HarnessSpec, main: string, mo: MappingOptions): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const cmd = (name: string, fm: Record<string, unknown>, body: string) =>
    files.push({ path: `.claude/commands/${name}.md`, content: withFrontmatter(fm, body) });

  cmd(
    "ask",
    {
      description: oneLine(`Hand a task to ${spec.displayName}`).slice(0, 200),
      "argument-hint": "<task>",
    },
    [
      `Use the \`${main}\` subagent to handle this task:`,
      "",
      "$ARGUMENTS",
      "",
      "Return its answer, including which tools it relied on. Do not take destructive actions without my explicit confirmation.",
    ].join("\n"),
  );

  const shells = shellTools(spec).filter((t) => !isAsk(spec, t));
  if (shells.length) {
    cmd(
      "check",
      {
        description: "Run the project's checks and summarize failures",
        "argument-hint": "[filter or check name]",
        "allowed-tools": shells.flatMap(bashRules),
      },
      [
        "Run the project's checks. If arguments are given, use them to pick or filter checks: $ARGUMENTS",
        "",
        ...shells.map((t) => `- ${inlineCode(shellInvocation(t))}: ${neutralizeSkillText(oneLine(t.description))}`),
        "",
        "Report pass/fail per check with the exit code and the key failing lines. Do not modify files.",
      ].join("\n"),
    );
  }

  if (spec.subagents.length) {
    const names = [...new Set(spec.subagents.flatMap((s) => s.tools))];
    const allowed = readOnlyAllowed(spec, names, mo);
    cmd(
      "triage",
      {
        description: oneLine(`Investigate a problem and delegate to the right specialist (${spec.subagents.map(subagentName).join(", ")})`).slice(0, 200),
        "argument-hint": "<problem description, failing test, or id>",
        "allowed-tools": allowed.length ? allowed : undefined,
      },
      [
        "Triage this: $ARGUMENTS",
        "",
        "1. Gather facts with read-only tools first.",
        "2. Delegate to the specialist that fits:",
        ...spec.subagents.map((s) => `   - \`${subagentName(s)}\`: ${neutralizeSkillText(oneLine(s.description))}`),
        "3. Report the root cause, the evidence (cite tool output), and a proposed next step.",
        "",
        "Do not make changes or call destructive tools without my explicit confirmation.",
      ].join("\n"),
    );
  }

  if (spec.evals.length) {
    const lines: string[] = [
      `Dry-run smoke test of the ${neutralizeSkillText(oneLine(spec.displayName))} behaviour against its eval cases. ${spec.evals.length} case(s); optional filter by id: $ARGUMENTS`,
      "",
      "For each case: say how you would respond and which tools you would call, then check it against the expectations. Do NOT execute tools that change state; read-only calls are fine. Finish with a pass/fail table.",
      "",
    ];
    for (const e of spec.evals) {
      lines.push(`## ${neutralizeSkillText(oneLine(e.id))}`, "", `Input: ${neutralizeSkillText(oneLine(e.input))}`, "");
      const x = e.expect;
      if (x.toolsCalled?.length) lines.push(`- Must call: ${x.toolsCalled.map((n) => `\`${n}\``).join(", ")}`);
      if (x.toolsNotCalled?.length) lines.push(`- Must not call: ${x.toolsNotCalled.map((n) => `\`${n}\``).join(", ")}`);
      if (x.contains?.length) lines.push(`- Answer contains: ${x.contains.map((s) => neutralizeSkillText(JSON.stringify(s))).join(", ")}`);
      if (x.notContains?.length) lines.push(`- Answer omits: ${x.notContains.map((s) => neutralizeSkillText(JSON.stringify(s))).join(", ")}`);
      if (x.rubric) lines.push(`- Rubric: ${neutralizeSkillText(oneLine(x.rubric))}`);
      lines.push("");
    }
    const allowed = readOnlyAllowed(spec, null, mo);
    cmd(
      "smoke-test",
      {
        description: "Dry-run the harness eval cases and report pass/fail",
        "argument-hint": "[eval id]",
        "allowed-tools": allowed.length ? allowed : undefined,
      },
      lines.join("\n"),
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// settings.json / .mcp.json / README.md
// ---------------------------------------------------------------------------

function renderSettings(spec: HarnessSpec, withMcp: boolean, mo: MappingOptions): string {
  const perms = derivePermissions(spec, mo);
  const settings: Record<string, unknown> = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: perms,
  };
  if (withMcp) settings.enabledMcpjsonServers = [mcpServerName(spec)];
  return JSON.stringify(settings, null, 2) + "\n";
}

function renderMcpJson(spec: HarnessSpec, opts: GenerateOptions): string {
  const env: Record<string, string> = {};
  for (const name of toolEnvRefs(spec.tools)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const def = envDefault(spec, name);
    const isSecret = spec.tools.some((t) => t.http?.auth?.env === name) || spec.env.some((e) => e.name === name && e.secret);
    env[name] = def !== undefined && !isSecret && !/[}$]/.test(def) ? `\${${name}:-${def}}` : `\${${name}}`;
  }
  const server: Record<string, unknown> = {
    // `--prefix` resolves tsx from the MCP server's own node_modules; a bare `npx tsx` from the repo root would
    // try to download tsx at every cold start (and hang offline or under a minimal env).
    command: "npx",
    args: ["--prefix", `${harnessDir(opts)}/mcp-server`, "tsx", `${harnessDir(opts)}/mcp-server/src/server.ts`],
  };
  if (Object.keys(env).length) server.env = env;
  return JSON.stringify({ mcpServers: { [mcpServerName(spec)]: server } }, null, 2) + "\n";
}

function renderReadme(spec: HarnessSpec, opts: GenerateOptions, main: string, files: GeneratedFile[], withMcp: boolean, mo: MappingOptions): string {
  const dir = harnessDir(opts);
  const out: string[] = [
    `# ${oneLine(spec.displayName)} for Claude Code`,
    "",
    `Claude Code project configuration generated by decree-harness from \`decree.json\`. It gives Claude Code the ${oneLine(spec.displayName)} agent: its working rules, tools, subagents, skills, slash commands, and permissions.`,
    "",
    "## Install",
    "",
    "From your repository root, copy the config (not this README) into place:",
    "",
    codeBlock(`cp -R ${dir}/claude-code/CLAUDE.md ${dir}/claude-code/.claude ${withMcp ? `${dir}/claude-code/.mcp.json ` : ""}.`, "sh"),
    "",
    "Merge by hand if you already have a `CLAUDE.md`, `.claude/settings.json`, or `.mcp.json`. A future `decree-harness generate --target claude-code --in-place` will write these files to the repo root directly.",
    "",
  ];
  if (withMcp) {
    const envs = toolEnvRefs(spec.tools);
    const served = [httpTools(spec).length ? "The API tools" : "", mo.decisionsViaMcp ? "`get_decisions`" : ""].filter(Boolean).join(" and ");
    out.push(
      "### MCP server",
      "",
      `${served} ${served.includes(" and ") ? "are" : "is"} served by the generated MCP server (\`${dir}/mcp-server\`). \`.mcp.json\` starts it with \`npx --prefix ${dir}/mcp-server tsx ${dir}/mcp-server/src/server.ts\` from the repository root, which assumes the default output dir \`${dir}/\`; edit the path if you generated elsewhere. Install its dependencies once (\`cd ${dir}/mcp-server && npm install\`)${envs.length ? ` and export ${envs.map((e) => `\`${e}\``).join(", ")}` : ""} before starting \`claude\`. Approve the server when Claude Code asks (or keep \`enabledMcpjsonServers\` in settings).`,
      "",
    );
  }
  const dt = decisionsToolOf(spec);
  if (dt) {
    out.push(
      "### Team decisions",
      "",
      `\`CLAUDE.md\` tells Claude to look up the decisions that govern the files it is about to change, instead of listing every decision. ${
        mo.decisionsViaMcp
          ? `It calls ${inlineCode(mcpToolName(spec, dt))}; the \`decisions\` skill's script is the fallback when the MCP server is not running.`
          : `It runs the \`decisions\` skill's script (\`node ${DECISIONS_SCRIPT} <paths...>\`), which needs only Node.js.`
      } The data is \`.claude/skills/decisions/decisions.json\`, written from \`decree.json\`: change decisions with \`npx decree-harness decisions\` and regenerate.`,
      "",
    );
  }
  out.push("## Files", "");
  const describe = (p: string): string => {
    if (p === "CLAUDE.md") return "Project memory, loaded every session: overview, working rules, commands, safety.";
    if (p === ".claude/settings.json") return "Permissions: allow read-only tools and checks, ask before destructive actions, deny blocked commands and `.env` reads.";
    if (p === ".mcp.json") return `Registers the generated MCP server that exposes ${httpTools(spec).length ? "the API tools" : "get_decisions"}.`;
    if (p === "README.md") return "This file.";
    if (p === `.claude/agents/${main}.md`) return "Main agent (the full system prompt). Invoke it as a subagent or run `claude --agent " + main + "`.";
    if (p.startsWith(".claude/agents/")) return "Subagent.";
    if (p === ".claude/skills/decisions/get-decisions.mjs") return "Prints the live decisions that govern the paths you pass (used by the `decisions` skill).";
    if (p === ".claude/skills/decisions/decisions.json") return "The team decisions from `decree.json`, read by the script.";
    if (p.startsWith(".claude/skills/")) return "Skill: loaded on demand when its description matches the task.";
    if (p.startsWith(".claude/commands/")) return `Slash command \`/${p.slice(".claude/commands/".length, -3)}\`.`;
    return "";
  };
  out.push(renderTable(["File", "Purpose"], files.map((f) => [inlineCode(f.path), describe(f.path)])), "");
  out.push(
    "## Use",
    "",
    `- Ask Claude Code to "use the ${main} agent" for anything in scope, or run \`claude --agent ${main}\` to make it the main session agent.`,
  );
  for (const s of spec.subagents) out.push(`- \`${subagentName(s)}\`: ${oneLine(s.description)}`);
  const cmds = files.filter((f) => f.path.startsWith(".claude/commands/")).map((f) => `\`/${f.path.slice(".claude/commands/".length, -3)}\``);
  if (cmds.length) out.push(`- Slash commands: ${cmds.join(", ")}.`);
  out.push(
    "- Skills load automatically when relevant; invoke one directly with `/<skill-name>`.",
    "",
    "## Tool mapping",
    "",
    renderTable(
      ["Harness tool", "Claude Code", "Permission"],
      spec.tools.map((t) => {
        const mapped =
          t.kind === "memory"
            ? "agent `memory: project`"
            : (t.kind === "decisions" ? allowRulesFor(spec, t, mo) : claudeToolsFor(spec, t, mo)).map((c) => inlineCode(c)).join(", ");
        const perm = t.kind === "memory" ? "" : isAsk(spec, t) ? "ask" : "allow";
        return [inlineCode(t.name), mapped, perm];
      }),
    ),
    "",
    "Regenerate with `npx decree-harness generate` after editing `decree.json`.",
    "",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------

export function generateClaudeCode(spec: HarnessSpec, opts: GenerateOptions): GeneratedFile[] {
  const mo: MappingOptions = { decisionsViaMcp: decisionsViaMcp(spec, opts) };
  const withMcp = httpTools(spec).length > 0 || !!mo.decisionsViaMcp;
  const main = mainAgentName(spec);
  const files: GeneratedFile[] = [];

  files.push({ path: "CLAUDE.md", content: renderClaudeMd(spec, main, withMcp, mo) });

  files.push({
    path: `.claude/agents/${main}.md`,
    content: agentFile(spec, {
      name: main,
      description: `${oneLine(spec.description)} Use for: ${oneLine(spec.goal)}`,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools.map((t) => t.name),
      model: spec.model.id,
      effort: spec.model.effort,
    }, mo),
  });
  const seen = new Set([main]);
  for (const s of spec.subagents) {
    const name = subagentName(s);
    if (seen.has(name)) continue;
    seen.add(name);
    files.push({
      path: `.claude/agents/${name}.md`,
      content: agentFile(spec, {
        name,
        description: s.description,
        systemPrompt: s.systemPrompt,
        tools: s.tools,
        model: s.model ?? spec.model.subagentId,
        effort: s.effort ?? "medium",
      }, mo),
    });
  }

  if (shellTools(spec).length) files.push({ path: ".claude/skills/run-checks/SKILL.md", content: renderRunChecksSkill(spec) });
  for (const g of apiGroups(spec)) files.push({ path: `.claude/skills/${g.skill}/SKILL.md`, content: renderApiSkill(spec, g, withMcp) });
  const dt = decisionsToolOf(spec);
  if (dt) {
    files.push(
      { path: ".claude/skills/decisions/SKILL.md", content: renderDecisionsSkill(spec, dt, mo) },
      { path: DECISIONS_SCRIPT, content: decisionsScriptMjs(), executable: true },
      { path: ".claude/skills/decisions/decisions.json", content: decisionsJson(spec) },
    );
  }

  files.push(...renderCommands(spec, main, mo));
  files.push({ path: ".claude/settings.json", content: renderSettings(spec, withMcp, mo) });
  if (withMcp) files.push({ path: ".mcp.json", content: renderMcpJson(spec, opts) });

  const readmePlaceholder: GeneratedFile = { path: "README.md", content: "" };
  files.push(readmePlaceholder);
  readmePlaceholder.content = renderReadme(spec, opts, main, files, withMcp, mo).replace(/\n+$/, "\n");
  return files;
}
