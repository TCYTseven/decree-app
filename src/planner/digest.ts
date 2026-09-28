/**
 * Compact, token-efficient text rendering of a ProjectProfile for LLM prompts.
 * Hard-capped (default 60k chars); key file excerpts are trimmed first, then the endpoint table,
 * tree and README.
 */
import type { ApiEndpoint, JSONSchema, ProjectProfile } from "../core/types.js";
import { cleanRoutePath, clip, isPlainObject } from "./util.js";
import { isInjectedParam } from "./heuristic.js";
import { maskSecrets } from "../core/mask-secrets.js";

export interface DigestOptions {
  maxChars?: number;
}

export const DEFAULT_DIGEST_CHARS = 60000;

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1000) return `${Math.round(n / 1000)}KB`;
  return `${n}B`;
}

function schemaType(s: JSONSchema | undefined): string {
  if (!s || !isPlainObject(s)) return "any";
  if (Array.isArray(s.enum) && s.enum.length) return clip(s.enum.map(String).join("|"), 40);
  if (typeof s.$ref === "string") return s.$ref.split("/").pop() ?? "object";
  if (s.type === "array") return `${schemaType(s.items as JSONSchema)}[]`;
  if (Array.isArray(s.type)) return s.type.join("|");
  return typeof s.type === "string" ? s.type : "any";
}

function bodySummary(body: JSONSchema | undefined): string {
  if (!body || !isPlainObject(body)) return "";
  const props = isPlainObject(body.properties) ? (body.properties as Record<string, JSONSchema>) : undefined;
  if (!props || !Object.keys(props).length) return schemaType(body);
  const req = new Set(Array.isArray(body.required) ? (body.required as string[]) : []);
  const fields = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? "*" : ""}:${schemaType(v)}`);
  return `{${clip(fields.join(", "), 200)}}`;
}

function endpointRow(e: ApiEndpoint): string {
  // Framework-injected parameters (FastAPI SessionDep/CurrentUser) are not part of the HTTP interface.
  const injected = e.params.filter(isInjectedParam);
  const params = [
    ...e.params.filter((p) => !injected.includes(p)).map((p) => `${p.name}(${p.in}${p.required ? ",req" : ""})`),
    ...(injected.some((p) => /current_?user/i.test(`${p.name} ${p.description ?? ""}`)) ? ["[auth required]"] : []),
  ].join(" ");
  const cells = [
    `${e.method} ${cleanRoutePath(e.path)}`,
    e.operationId ?? "",
    e.summary ? clip(e.summary.replace(/\s+/g, " "), 80) : "",
    params,
    bodySummary(e.requestBody),
    e.tags?.length ? e.tags.join(",") : "",
    e.source,
  ];
  return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
}

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n${body.trim()}\n` : "";
}

interface Budgets {
  endpoints: number; // max rows
  tree: number; // chars
  readme: number; // chars
  deps: number; // count
}

function renderCore(p: ProjectProfile, b: Budgets): string {
  const out: string[] = [];
  out.push(`# Project: ${p.name}`);
  if (p.description) out.push(maskSecrets(p.description.trim())); // may be quoted from the README
  const facts: string[] = [];
  if (p.languages.length) facts.push(`Languages: ${p.languages.slice(0, 6).map((l) => `${l.name} (${l.files} files, ${fmtBytes(l.bytes)})`).join(", ")}`);
  if (p.frameworks.length) facts.push(`Frameworks: ${p.frameworks.join(", ")}`);
  if (p.packageManager) facts.push(`Package manager: ${p.packageManager}`);
  if (p.git?.remote || p.git?.branch) facts.push(`Git: ${[p.git.remote, p.git.branch && `branch ${p.git.branch}`].filter(Boolean).join(", ")}`);
  facts.push(`Size: ${p.stats.files} files, ${p.stats.dirs} dirs${p.stats.truncated ? " (scan truncated)" : ""}`);
  const cfg = Object.entries(p.existingAgentConfig)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (cfg.length) facts.push(`Existing agent config: ${cfg.join(", ")}`);
  if (p.decisionSources?.length) facts.push(`Decision records (served by a get_decisions tool that decree adds after planning): ${p.decisionSources.length} files`);
  if (p.cli) facts.push(`Ships a CLI: \`${p.cli.bin}\` (commands: ${clip(p.cli.commands.join(", "), 300)})`);
  out.push(facts.map((f) => `- ${f}`).join("\n"));
  out.push("");

  out.push(section("Scripts", p.scripts.map((s) => `- ${s.name} [${s.source}]: ${clip(s.command, 200)}`).join("\n")));

  if (p.apis.length) {
    const rows = p.apis.slice(0, b.endpoints).map(endpointRow);
    const more = p.apis.length > b.endpoints ? `\n(${p.apis.length - b.endpoints} more endpoints not shown)` : "";
    const specs = p.openapiSpecs.length ? `OpenAPI specs: ${p.openapiSpecs.join(", ")}\n` : "";
    out.push(
      section(
        `API endpoints (${p.apis.length})`,
        `${specs}| endpoint | operationId | summary | params | body (* = required) | tags | source |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}${more}`,
      ),
    );
  } else {
    out.push(section("API endpoints", "None detected."));
  }

  out.push(
    section(
      "Environment variables",
      p.envVars.map((v) => `- ${v.name}${v.secret ? " (secret)" : ""}${v.example && !v.secret ? ` e.g. ${clip(v.example.replace(/\/\/([^:/@\s]+):[^@\s]*@/, "//$1:***@"), 60)}` : ""} [${v.source}]`).join("\n"),
    ),
  );

  if (p.database) {
    out.push(
      section(
        "Database",
        `Kind: ${p.database.kind}\nSchema files: ${p.database.schemaFiles.join(", ") || "-"}\nModels: ${clip(p.database.models.join(", ") || "-", 1500)}`,
      ),
    );
  }

  const deps = p.dependencies.filter((d) => !d.dev);
  const devCount = p.dependencies.length - deps.length;
  if (p.dependencies.length) {
    out.push(
      section(
        "Dependencies",
        `${deps
          .slice(0, b.deps)
          .map((d) => `${d.name}${d.version ? `@${d.version}` : ""}`)
          .join(", ")}${deps.length > b.deps ? `, … (${deps.length - b.deps} more)` : ""}${devCount ? `\n(+${devCount} dev dependencies)` : ""}`,
      ),
    );
  }

  out.push(section("File tree", "```\n" + clip(p.tree, b.tree) + "\n```"));
  // Mask hardcoded secrets (keyfile excerpts are masked by the scanner; the README is masked here).
  if (p.docs.readme) out.push(section("README (excerpt)", clip(maskSecrets(p.docs.readme), b.readme)));
  if (p.docs.files.length > 1) out.push(section("Other docs", clip(p.docs.files.join(", "), 800)));
  return out.filter(Boolean).join("\n");
}

function renderKeyFiles(p: ProjectProfile, budget: number): string {
  if (!p.keyFiles.length || budget < 200) return p.keyFiles.length ? `## Key files\n(${p.keyFiles.map((k) => k.path).join(", ")}; excerpts omitted for length)\n` : "";
  const header = "## Key files\n";
  let remaining = budget - header.length;
  const perFile = Math.max(400, Math.min(4000, Math.floor(remaining / p.keyFiles.length)));
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const k of p.keyFiles) {
    const head = `### ${k.path} (${k.reason})\n`;
    const room = Math.min(perFile, remaining - head.length - 10);
    if (room < 200) {
      skipped.push(k.path);
      continue;
    }
    const block = `${head}\`\`\`\n${clip(k.excerpt, room)}\n\`\`\`\n`;
    parts.push(block);
    remaining -= block.length;
  }
  if (skipped.length) parts.push(`(Not shown: ${skipped.join(", ")})\n`);
  return header + parts.join("");
}

/** Render the profile as compact markdown for prompts, capped at `maxChars` (default 60k). */
export function renderProfileDigest(profile: ProjectProfile, opts: DigestOptions = {}): string {
  const max = opts.maxChars ?? DEFAULT_DIGEST_CHARS;
  const budgets: Budgets = { endpoints: 400, tree: 8000, readme: 6000, deps: 60 };
  let core = renderCore(profile, budgets);
  // Reserve at least a quarter of the budget for key files when possible; shrink the rest if needed.
  const shrinkSteps: Partial<Budgets>[] = [
    { endpoints: 200 },
    { tree: 4000, readme: 3000 },
    { endpoints: 100, deps: 30 },
    { tree: 2000, readme: 1500, endpoints: 60 },
  ];
  for (const step of shrinkSteps) {
    if (core.length <= max * 0.75) break;
    Object.assign(budgets, step);
    core = renderCore(profile, budgets);
  }
  const keyFiles = renderKeyFiles(profile, max - core.length - 1);
  const out = `${core}\n${keyFiles}`.trim() + "\n";
  return out.length <= max ? out : clip(out, max - 20) + "\n[digest truncated]\n";
}
