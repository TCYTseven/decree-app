/**
 * Core contracts shared by every decree-harness module.
 *
 * Pipeline:
 *   scanProject(root)          -> ProjectProfile   (deterministic, no network)
 *   planHarness(profile, opts) -> HarnessSpec      (LLM via Anthropic, or offline heuristics)
 *   generateTargets(spec, ...) -> GeneratedFile[]  (pure rendering, no network)
 *   runAgent(spec, ...)        -> runs the harness live against Claude
 *   runEvals(spec, ...)        -> scores the harness against spec.evals
 *
 * The HarnessSpec is persisted as `decree.json` at the project root. It is the
 * editable source of truth (like mintlify's docs.json): users tweak it by hand
 * or via `decree-harness refine`, then re-run `decree-harness generate`.
 */

export type JSONSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  format?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Scanner output
// ---------------------------------------------------------------------------

export interface LanguageStat {
  name: string; // "TypeScript", "Python", ...
  files: number;
  bytes: number;
}

export interface ScriptInfo {
  name: string; // "test", "build", "lint", "migrate"
  command: string; // the raw command line
  source: string; // "package.json", "Makefile", "pyproject.toml", "justfile", ...
}

export interface ApiParam {
  name: string;
  in: "path" | "query" | "header" | "body";
  required: boolean;
  schema?: JSONSchema;
  description?: string;
}

export interface ApiEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string; // "/users/{id}" (OpenAPI-style braces even when detected from code)
  summary?: string;
  operationId?: string;
  params: ApiParam[];
  requestBody?: JSONSchema;
  source: string; // "openapi.yaml" or "src/routes/users.ts:42"
  tags?: string[];
}

export interface EnvVarInfo {
  name: string;
  source: string; // ".env.example", "src/config.ts", ...
  example?: string; // never a real secret value; only from example files
  secret: boolean; // heuristic: KEY/TOKEN/SECRET/PASSWORD in name
}

export interface DependencyInfo {
  name: string;
  version?: string;
  ecosystem: "npm" | "pypi" | "go" | "cargo" | "rubygems" | "maven" | "composer" | "other";
  dev?: boolean;
}

export interface DatabaseInfo {
  kind: string; // "prisma", "drizzle", "sqlalchemy", "django", "typeorm", "sql", "mongoose", ...
  schemaFiles: string[];
  models: string[];
}

export interface KeyFile {
  path: string;
  reason: string; // why this file matters ("entrypoint", "router", "config", ...)
  excerpt: string; // truncated content
}

export interface ProjectProfile {
  root: string; // absolute path
  name: string;
  description?: string;
  languages: LanguageStat[]; // sorted by bytes desc
  primaryLanguage?: string;
  frameworks: string[]; // "express", "nextjs", "fastapi", "django", "flask", "nestjs", "hono", "rails", "gin", "react", ...
  packageManager?: string; // "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "uv" | "cargo" | "go" | ...
  scripts: ScriptInfo[];
  apis: ApiEndpoint[];
  openapiSpecs: string[]; // relative paths
  cli?: { bin: string; commands: string[] }; // if the project itself ships a CLI
  envVars: EnvVarInfo[];
  dependencies: DependencyInfo[];
  database?: DatabaseInfo;
  docs: { readme?: string; files: string[] }; // readme truncated to ~8k chars
  existingAgentConfig: {
    claudeMd: boolean;
    agentsMd: boolean;
    mcpJson: boolean;
    cursorRules: boolean;
    claudeDir: boolean;
  };
  tree: string; // depth-limited ascii tree
  keyFiles: KeyFile[];
  git?: { remote?: string; branch?: string };
  /** Files that hold team decisions (ADRs, agent rules files, post-mortems); set only when some exist. */
  decisionSources?: string[];
  stats: { files: number; dirs: number; truncated: boolean; scanMs: number };
}

// ---------------------------------------------------------------------------
// Harness spec (decree.json)
// ---------------------------------------------------------------------------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ToolKind =
  | "http" // call an HTTP endpoint of the user's API
  | "shell" // run a templated shell command (npm scripts, make targets, CLIs)
  | "read_file" // read a file under an allowed root
  | "write_file" // write/overwrite a file under an allowed root
  | "list_files" // glob files under an allowed root
  | "search" // grep file contents under an allowed root
  | "web_search" // Anthropic server tool
  | "web_fetch" // Anthropic server tool
  | "memory" // persistent notes in a local directory
  | "decisions"; // serve the team decisions (spec.decisions) that govern the given paths

export interface HttpBinding {
  method: ApiEndpoint["method"];
  baseUrlEnv: string; // env var holding the base URL, e.g. "MYAPP_BASE_URL"
  defaultBaseUrl?: string; // e.g. "http://localhost:3000"
  path: string; // "/users/{id}" - {x} filled from input params of the same name
  queryParams?: string[]; // input keys sent as query string
  headerParams?: string[]; // input keys sent as headers
  bodyParam?: string; // input key whose value is sent as JSON body; if omitted and method has a body, all remaining keys are sent
  auth?: { type: "bearer" | "header" | "none"; env?: string; header?: string };
}

export interface ShellBinding {
  command: string; // template, e.g. "npm run test -- {{pattern}}"; params are shell-escaped when substituted
  cwd?: string; // relative to project root
  timeoutMs?: number;
}

export interface FsBinding {
  root: string; // relative to project root, "." for the whole project
  maxBytes?: number;
}

export interface ToolSpec {
  name: string; // snake_case, ^[a-zA-Z0-9_-]{1,64}$
  description: string; // written for the model: what, when to use, what it returns
  kind: ToolKind;
  inputSchema: JSONSchema; // type: "object"; empty for server tools
  http?: HttpBinding;
  shell?: ShellBinding;
  fs?: FsBinding;
  readOnly: boolean;
  destructive: boolean;
  requiresApproval: boolean; // runtime asks the human before executing
  source?: string; // provenance: "openapi:GET /users", "package.json#scripts.test", "builtin"
}

export interface SubagentSpec {
  name: string; // kebab-case
  description: string; // when the main agent should delegate to it
  systemPrompt: string;
  tools: string[]; // names from HarnessSpec.tools
  model?: string; // defaults to spec.model.subagentId
  effort?: Effort;
}

export interface EvalCase {
  id: string;
  input: string; // user message
  expect: {
    toolsCalled?: string[]; // tool names that must be called at least once
    toolsNotCalled?: string[];
    contains?: string[]; // case-insensitive substrings the final answer must contain
    notContains?: string[];
    rubric?: string; // graded by an LLM judge when present
  };
  tags?: string[];
}

export interface Guardrails {
  maxTurns: number; // hard cap on agent loop iterations
  maxOutputTokensPerTurn: number;
  maxCostUsd?: number; // runtime stops once estimated spend passes this
  blockedCommands: string[]; // substrings refused by shell tools ("rm -rf /", "git push --force")
  allowedPaths: string[]; // fs roots; everything else is refused
  redactEnv: string[]; // env var names whose values are scrubbed from tool output
  approvalMode: "always" | "destructive" | "never"; // who needs a human yes
}

export interface ContextStrategy {
  caching: boolean; // prompt caching on system + tools
  compaction: boolean; // server-side compaction beta for long sessions
  contextEditing: boolean; // clear old tool results beta
  memory: boolean; // expose the memory tool
}

export type Target = "typescript" | "python" | "claude-code" | "mcp";

/** live: agents must follow it. proposed: extracted or drafted, waiting for a human to confirm. superseded: kept for history. */
export type DecisionStatus = "live" | "proposed" | "superseded";

/**
 * An architectural decision the team already made (an ADR, a post-mortem lesson, a rule from CLAUDE.md/AGENTS.md).
 * The `get_decisions` tool serves only the live decisions whose `governs` globs match the paths an agent is about
 * to touch, instead of loading every rule into every session.
 */
export interface Decision {
  id: string; // stable slug, e.g. "adr-0003-use-postgres" or "rule-claude-md-never-write-raw-sql"
  title: string;
  constraint: string; // the rule an agent must follow, 1-3 sentences
  status: DecisionStatus;
  governs: string[]; // globs relative to the repo root; "**" = the whole repo
  source: string; // "docs/adr/0003-use-postgres.md" or "CLAUDE.md:14"
  owner?: string;
  supersededBy?: string; // id of the decision that replaced this one
  rationale?: string;
}

export interface HarnessSpec {
  $schema?: string;
  version: 1;
  name: string; // kebab-case slug
  displayName: string;
  description: string;
  goal: string; // what the user wants this agent to do, in their words
  model: {
    id: string; // default "claude-opus-5"
    effort: Effort;
    subagentId: string; // default "claude-sonnet-5"
    thinking: "adaptive" | "off";
  };
  systemPrompt: string; // full markdown system prompt
  tools: ToolSpec[];
  subagents: SubagentSpec[];
  guardrails: Guardrails;
  context: ContextStrategy;
  evals: EvalCase[];
  targets: Target[];
  env: { name: string; description: string; required: boolean; secret: boolean; default?: string }[];
  /** Team decisions served by the `get_decisions` tool. Optional: specs without it behave as before. */
  decisions?: Decision[];
  provenance: {
    generator: "heuristic" | "llm";
    decreeVersion: string;
    createdAt: string; // ISO
    profileName: string;
    notes?: string[]; // design rationale from the planner
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GeneratedFile {
  path: string; // relative to the output dir, POSIX separators
  content: string;
  executable?: boolean;
}

export interface GenerateOptions {
  outDir: string; // informational; generators return relative paths
  decreeVersion: string;
  targets?: Target[]; // every target in this generation, so one target can rely on another (claude-code on mcp)
}

export type Generator = (spec: HarnessSpec, opts: GenerateOptions) => GeneratedFile[];

// ---------------------------------------------------------------------------
// LLM abstraction (lets tests swap in a mock)
// ---------------------------------------------------------------------------

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LLM {
  readonly model: string;
  /** Returns an object validated against `schema` (structured outputs). */
  generateJSON<T>(opts: {
    system: string;
    prompt: string;
    schema: JSONSchema;
    effort?: Effort;
    maxTokens?: number;
    onProgress?: (chars: number) => void;
  }): Promise<T>;
  generateText(opts: {
    system: string;
    prompt: string;
    effort?: Effort;
    maxTokens?: number;
    onProgress?: (chars: number) => void;
  }): Promise<string>;
  usage(): LLMUsage;
}

// ---------------------------------------------------------------------------
// Runtime / eval
// ---------------------------------------------------------------------------

export type RuntimeEvent =
  | { type: "text"; text: string } // streamed assistant text delta
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean; ms: number }
  | { type: "approval_denied"; id: string; name: string }
  | { type: "turn_end"; turn: number; stopReason: string | null; usage: LLMUsage }
  | { type: "error"; message: string }
  | { type: "done"; finalText: string; turns: number; usage: LLMUsage; costUsd: number };

export interface RunOptions {
  projectRoot: string;
  prompt: string;
  history?: unknown[]; // prior Anthropic.MessageParam[] for multi-turn chat
  approve?: (call: { name: string; input: unknown; tool: ToolSpec }) => Promise<boolean>;
  onEvent?: (e: RuntimeEvent) => void;
  apiKey?: string;
  model?: string; // override spec.model.id
  dryRun?: boolean; // tools return a description of what they would do instead of executing
  signal?: AbortSignal;
}

export interface RunResult {
  finalText: string;
  turns: number;
  toolCalls: { name: string; input: unknown; output: string; isError: boolean }[];
  usage: LLMUsage;
  costUsd: number;
  messages: unknown[]; // full Anthropic.MessageParam[] transcript, for chat continuation
  stopReason: string | null;
}

export interface EvalResult {
  id: string;
  passed: boolean;
  score: number; // 0..1
  checks: { name: string; passed: boolean; detail?: string }[];
  run?: Pick<RunResult, "finalText" | "turns" | "toolCalls" | "costUsd">;
  error?: string;
}
