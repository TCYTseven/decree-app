import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fsp, watch as fsWatch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { EvalResult, GeneratedFile, HarnessSpec, LLM, RunOptions, RunResult, RuntimeEvent, Target } from "../core/types.js";
import { projectPaths, readDotEnv, writeSchema } from "../core/config.js";
import { stringifySpec, validateSpec } from "../core/spec.js";
import { writeFiles, type WriteReport } from "../core/writer.js";
import { generateTargets } from "../generators/index.js";
import { DECREE_VERSION, DEFAULT_OUT_DIR, SPEC_FILENAME } from "../version.js";
import { renderPage } from "./page.js";
import { RequestGuard, createToken, isLoopbackHost, isWildcardHost } from "./security.js";
import { SSEStream } from "./sse.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreviewDeps {
  /** Resolve the Anthropic API key (flag > env > .env). Returns undefined when there is none. */
  resolveKey: (root: string) => { key?: string; source?: string };
  runAgent: (spec: HarnessSpec, opts: RunOptions) => Promise<RunResult>;
  runEvals: (spec: HarnessSpec, opts: { projectRoot: string; apiKey: string; judge?: LLM; concurrency?: number; filter?: string; dryRunTools?: boolean; onResult?: (r: EvalResult) => void }) => Promise<EvalResult[]>;
  createJudge?: (apiKey: string) => LLM | undefined;
  explainError?: (err: unknown) => { message: string; hint?: string };
}

export interface PreviewOptions {
  root: string;
  host?: string;
  /** Preferred port. 0 = random. If taken, a random free port is used unless `strictPort`. */
  port?: number;
  strictPort?: boolean;
  /** Fixed token (tests); default: random per session. */
  token?: string;
  outDir?: string;
  /** Watch decree.json and push changes to open pages (default true). */
  watch?: boolean;
  watchDebounceMs?: number;
  heartbeatMs?: number;
  deps: PreviewDeps;
}

export interface PreviewServer {
  url: string;
  host: string;
  port: number;
  token: string;
  /** True when the preferred port was taken and a random one was used instead. */
  portFallback: boolean;
  server: http.Server;
  close(): Promise<void>;
}

type SpecState =
  | { ok: true; spec: HarnessSpec; warnings: string[]; hash: string; raw: string }
  | { ok: false; kind: "missing" | "parse" | "invalid"; errors: string[]; hash?: string; raw?: string };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MAX_BODY = 2 * 1024 * 1024;
/** Top-level decree.json fields the dashboard may patch. */
const PATCHABLE = new Set(["displayName", "description", "goal", "systemPrompt", "model", "tools", "subagents", "guardrails", "context", "evals", "targets", "env"]);

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// Spec I/O
// ---------------------------------------------------------------------------

export async function readSpecState(root: string): Promise<SpecState> {
  const file = projectPaths(root).specPath;
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, kind: "missing", errors: [`No ${SPEC_FILENAME} in ${root}. Run \`npx decree-harness init\` first.`] };
    }
    throw err;
  }
  const hash = sha(raw);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, kind: "parse", errors: [`${SPEC_FILENAME} is not valid JSON: ${(err as Error).message}`], hash, raw };
  }
  const res = validateSpec(json);
  if (!res.ok) return { ok: false, kind: "invalid", errors: res.errors, hash, raw };
  return { ok: true, spec: res.spec, warnings: res.warnings, hash, raw };
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, file);
}

/**
 * Apply a patch of top-level fields to decree.json. The file is re-read, patched, validated with
 * validateSpec and written with stringifySpec (canonical formatting). The previous file is backed up
 * to .decree/decree.backup.json. `baseHash` guards against overwriting an edit made on disk meanwhile.
 */
export async function patchSpecFile(
  root: string,
  patch: Record<string, unknown>,
  baseHash?: string,
): Promise<{ ok: true; spec: HarnessSpec; warnings: string[]; hash: string } | { ok: false; status: number; code: string; errors: string[]; hash?: string }> {
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, status: 400, code: "empty_patch", errors: ["Nothing to save."] };
  const bad = keys.filter((k) => !PATCHABLE.has(k));
  if (bad.length) return { ok: false, status: 400, code: "bad_field", errors: bad.map((k) => `Field "${k}" cannot be edited from the preview.`) };
  const paths = projectPaths(root);
  let raw: string;
  try {
    raw = await fsp.readFile(paths.specPath, "utf8");
  } catch {
    return { ok: false, status: 404, code: "missing", errors: [`No ${SPEC_FILENAME} found.`] };
  }
  const hash = sha(raw);
  if (baseHash && baseHash !== hash) {
    return { ok: false, status: 409, code: "conflict", hash, errors: [`${SPEC_FILENAME} changed on disk since you started editing. Reload to get the latest version, then re-apply your edit.`] };
  }
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root is not an object");
    json = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, status: 422, code: "parse", hash, errors: [`${SPEC_FILENAME} is not valid JSON (${(err as Error).message}); fix it by hand first.`] };
  }
  if ("systemPrompt" in patch && (typeof patch.systemPrompt !== "string" || !patch.systemPrompt.trim())) {
    return { ok: false, status: 422, code: "invalid", hash, errors: ["systemPrompt: the system prompt can't be empty."] };
  }
  const next = { ...json, ...patch };
  const res = validateSpec(next);
  if (!res.ok) return { ok: false, status: 422, code: "invalid", hash, errors: res.errors };
  const content = stringifySpec(res.spec);
  if (content !== raw) {
    await fsp.mkdir(paths.cacheDir, { recursive: true });
    await fsp.writeFile(path.join(paths.cacheDir, "decree.backup.json"), raw, "utf8");
    await writeAtomic(paths.specPath, content);
    try {
      await fsp.access(paths.schemaPath);
    } catch {
      await writeSchema(root).catch(() => undefined);
    }
  }
  return { ok: true, spec: res.spec, warnings: res.warnings, hash: sha(content) };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers["content-type"] ?? "");
  // application/json cannot be sent cross-origin without a preflight, which we never grant.
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, "Expected Content-Type: application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body is not a JSON object");
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

interface Conversation {
  history: unknown[];
  busy: boolean;
  runId?: string;
}

interface PendingApproval {
  resolve: (ok: boolean) => void;
  runId: string;
}

export async function startPreviewServer(opts: PreviewOptions): Promise<PreviewServer> {
  const root = path.resolve(opts.root);
  const host = opts.host ?? "127.0.0.1";
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  const token = opts.token ?? createToken();
  const deps = opts.deps;
  const guard = new RequestGuard(token, host, opts.port ?? 0);
  const paths = projectPaths(root, outDir);
  const relOut = path.relative(root, paths.outDir).split(path.sep).join("/") || ".";

  const eventClients = new Set<SSEStream>();
  const conversations = new Map<string, Conversation>();
  const runs = new Map<string, AbortController>();
  const approvals = new Map<string, PendingApproval>();
  let evalRunning = false;
  let lastSpecHash: string | undefined;
  let generatedCache: { hash: string; targets: string; files: GeneratedFile[] } | undefined;

  const explain = (err: unknown) => deps.explainError?.(err) ?? { message: err instanceof Error ? err.message : String(err) };

  const broadcast = (event: string, data: unknown) => {
    for (const c of eventClients) c.send(event, data);
  };

  async function loadValid(): Promise<Extract<SpecState, { ok: true }>> {
    const st = await readSpecState(root);
    if (!st.ok) throw new HttpError(409, st.errors[0] ?? `${SPEC_FILENAME} is not valid`, "spec_invalid", { errors: st.errors });
    return st;
  }

  function generated(st: Extract<SpecState, { ok: true }>, targets: Target[]): GeneratedFile[] {
    const key = targets.join(",");
    if (generatedCache && generatedCache.hash === st.hash && generatedCache.targets === key) return generatedCache.files;
    const files = generateTargets(st.spec, targets, { outDir: relOut, decreeVersion: DECREE_VERSION });
    generatedCache = { hash: st.hash, targets: key, files };
    return files;
  }

  const fileStatus = (report: WriteReport): Map<string, string> => {
    const m = new Map<string, string>();
    for (const p of report.created) m.set(p, "new");
    for (const p of report.updated) m.set(p, "changed");
    for (const p of report.unchanged) m.set(p, "unchanged");
    for (const p of report.skipped) m.set(p, "edited");
    for (const p of report.removed) m.set(p, "removed");
    return m;
  };

  async function envStatus(spec: HarnessSpec): Promise<Record<string, boolean>> {
    const dot = await readDotEnv(root);
    const out: Record<string, boolean> = {};
    for (const e of spec.env) out[e.name] = !!(process.env[e.name]?.trim() || dot[e.name]?.trim());
    return out;
  }

  // ---- routes -------------------------------------------------------------

  async function apiState(res: ServerResponse): Promise<void> {
    const st = await readSpecState(root);
    const key = deps.resolveKey(root);
    const base = {
      version: DECREE_VERSION,
      project: { root, name: path.basename(root), specFile: SPEC_FILENAME, outDir: relOut },
      apiKey: { available: !!key.key, source: key.source ?? null },
      baseUrlOverride: !!process.env.ANTHROPIC_BASE_URL,
    };
    if (!st.ok) {
      sendJson(res, 200, { ...base, ok: false, kind: st.kind, errors: st.errors, hash: st.hash ?? null });
      return;
    }
    sendJson(res, 200, { ...base, ok: true, spec: st.spec, warnings: st.warnings, hash: st.hash, env: await envStatus(st.spec) });
  }

  async function apiPatchSpec(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const patch = body.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "Expected { patch: { ... } }");
    const r = await patchSpecFile(root, patch as Record<string, unknown>, typeof body.baseHash === "string" ? body.baseHash : undefined);
    if (!r.ok) {
      sendJson(res, r.status, { ok: false, code: r.code, errors: r.errors, hash: r.hash ?? null });
      return;
    }
    lastSpecHash = r.hash;
    broadcast("spec", { hash: r.hash, source: "ui" });
    sendJson(res, 200, { ok: true, spec: r.spec, warnings: r.warnings, hash: r.hash });
  }

  async function apiFiles(res: ServerResponse): Promise<void> {
    const st = await loadValid();
    const targets = st.spec.targets;
    const files = generated(st, targets);
    const report = await writeFiles(paths.outDir, files, { dryRun: true, manifestPath: paths.manifestPath });
    const status = fileStatus(report);
    sendJson(res, 200, {
      outDir: relOut,
      targets,
      hash: st.hash,
      files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content), lines: f.content.split("\n").length, status: status.get(f.path) ?? "new" })),
      summary: { new: report.created.length, changed: report.updated.length, unchanged: report.unchanged.length, edited: report.skipped.length },
    });
  }

  async function apiFile(url: URL, res: ServerResponse): Promise<void> {
    const st = await loadValid();
    const p = url.searchParams.get("path") ?? "";
    const f = generated(st, st.spec.targets).find((x) => x.path === p);
    if (!f) throw new HttpError(404, `No generated file ${p}`);
    sendJson(res, 200, { path: f.path, content: f.content, executable: !!f.executable });
  }

  async function apiGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const st = await loadValid();
    const files = generated(st, st.spec.targets);
    const report = await writeFiles(paths.outDir, files, { force: body.force === true, manifestPath: paths.manifestPath });
    sendJson(res, 200, { ok: true, outDir: relOut, report });
  }

  function requireKey(): string {
    const { key } = deps.resolveKey(root);
    if (!key) throw new HttpError(400, "No Anthropic API key. Set ANTHROPIC_API_KEY (or add it to .env) and reload.", "no_api_key");
    return key;
  }

  async function apiChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new HttpError(400, "Empty message");
    const conversationId = typeof body.conversationId === "string" && body.conversationId.length <= 100 ? body.conversationId : randomUUID();
    const dryRun = body.dryRun !== false;
    const st = await loadValid();
    const apiKey = requireKey();
    let conv = conversations.get(conversationId);
    if (!conv) {
      conv = { history: [], busy: false };
      conversations.set(conversationId, conv);
    }
    if (conv.busy) throw new HttpError(409, "This conversation is already running a reply", "busy");
    const runId = randomUUID();
    const ac = new AbortController();
    conv.busy = true;
    conv.runId = runId;
    runs.set(runId, ac);

    const stream = new SSEStream(res, { heartbeatMs: opts.heartbeatMs });
    const myApprovals = new Set<string>();
    const pendingCalls: { id: string; name: string; input: string }[] = [];
    stream.onClose(() => {
      if (!ac.signal.aborted) ac.abort();
      for (const id of myApprovals) approvals.get(id)?.resolve(false);
    });
    stream.send("start", { runId, conversationId, dryRun, model: st.spec.model.id });

    const approve: RunOptions["approve"] = (call) =>
      new Promise<boolean>((resolve) => {
        if (ac.signal.aborted || stream.closed) return resolve(false);
        const approvalId = randomUUID();
        const inputKey = JSON.stringify(call.input ?? null);
        const match = pendingCalls.find((p) => p.name === call.name && p.input === inputKey) ?? pendingCalls.find((p) => p.name === call.name);
        const done = (ok: boolean) => {
          if (!approvals.has(approvalId)) return;
          approvals.delete(approvalId);
          myApprovals.delete(approvalId);
          ac.signal.removeEventListener("abort", onAbort);
          stream.send("approval_resolved", { approvalId, approved: ok });
          resolve(ok);
        };
        const onAbort = () => done(false);
        ac.signal.addEventListener("abort", onAbort);
        approvals.set(approvalId, { resolve: done, runId });
        myApprovals.add(approvalId);
        stream.send("approval_request", {
          approvalId,
          toolUseId: match?.id ?? null,
          name: call.name,
          input: call.input,
          destructive: call.tool.destructive,
          readOnly: call.tool.readOnly,
          description: call.tool.description,
        });
      });

    const onEvent = (e: RuntimeEvent) => {
      if (e.type === "tool_call") pendingCalls.push({ id: e.id, name: e.name, input: JSON.stringify(e.input ?? null) });
      if (e.type === "tool_result" || e.type === "approval_denied") {
        const k = pendingCalls.findIndex((p) => p.id === e.id);
        if (k !== -1) pendingCalls.splice(k, 1);
      }
      if (e.type === "done") return; // summarized in "result"
      stream.send(e.type, e);
    };

    try {
      const result = await deps.runAgent(st.spec, {
        projectRoot: root,
        prompt,
        history: conv.history,
        apiKey,
        dryRun,
        signal: ac.signal,
        approve,
        onEvent,
      });
      if (ac.signal.aborted) {
        stream.send("stopped", { reason: "stopped", usage: result.usage, costUsd: result.costUsd });
      } else {
        conv.history = result.messages;
        stream.send("result", {
          finalText: result.finalText,
          turns: result.turns,
          toolCalls: result.toolCalls.length,
          usage: result.usage,
          costUsd: result.costUsd,
          stopReason: result.stopReason,
        });
      }
    } catch (err) {
      if (ac.signal.aborted) stream.send("stopped", { reason: "stopped" });
      else stream.send("fatal", explain(err));
    } finally {
      conv.busy = false;
      conv.runId = undefined;
      runs.delete(runId);
      for (const id of myApprovals) approvals.get(id)?.resolve(false);
      stream.end();
    }
  }

  async function apiChatStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const ac = typeof body.runId === "string" ? runs.get(body.runId) : undefined;
    if (ac) ac.abort();
    sendJson(res, 200, { ok: true, stopped: !!ac });
  }

  async function apiChatReset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (typeof body.conversationId === "string") {
      const conv = conversations.get(body.conversationId);
      if (conv?.runId) runs.get(conv.runId)?.abort();
      conversations.delete(body.conversationId);
    }
    sendJson(res, 200, { ok: true });
  }

  async function apiApproval(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const id = typeof body.approvalId === "string" ? body.approvalId : "";
    const pending = approvals.get(id);
    if (!pending) throw new HttpError(404, "This approval request is no longer pending", "not_pending");
    pending.resolve(body.approved === true);
    sendJson(res, 200, { ok: true });
  }

  async function apiEvals(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const filter = typeof body.filter === "string" && body.filter ? body.filter : undefined;
    const st = await loadValid();
    const apiKey = requireKey();
    const cases = st.spec.evals.filter((c) => !filter || c.id.includes(filter));
    if (!cases.length) throw new HttpError(400, filter ? `No eval ids match "${filter}"` : `${SPEC_FILENAME} has no evals`, "no_evals");
    if (evalRunning) throw new HttpError(409, "Evals are already running", "busy");
    evalRunning = true;
    const stream = new SSEStream(res, { heartbeatMs: opts.heartbeatMs });
    stream.send("start", { total: cases.length, ids: cases.map((c) => c.id) });
    try {
      let judge: LLM | undefined;
      try {
        judge = deps.createJudge?.(apiKey);
      } catch {
        judge = undefined;
      }
      const results = await deps.runEvals(st.spec, {
        projectRoot: root,
        apiKey,
        judge,
        filter,
        dryRunTools: true,
        concurrency: 2,
        onResult: (r) => stream.send("result", r),
      });
      const passed = results.filter((r) => r.passed).length;
      const costUsd = results.reduce((a, r) => a + (r.run?.costUsd ?? 0), 0);
      const avgScore = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0;
      stream.send("done", { total: results.length, passed, failed: results.length - passed, errored: results.filter((r) => r.error).length, avgScore, costUsd });
    } catch (err) {
      stream.send("fatal", explain(err));
    } finally {
      evalRunning = false;
      stream.end();
    }
  }

  function apiEvents(res: ServerResponse): void {
    const stream = new SSEStream(res, { heartbeatMs: opts.heartbeatMs });
    eventClients.add(stream);
    stream.onClose(() => eventClients.delete(stream));
    stream.send("hello", { hash: lastSpecHash ?? null, watching: opts.watch !== false });
  }

  // ---- dispatcher ---------------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const isApi = url.pathname.startsWith("/api/");
    const denied = guard.check(req, { api: isApi });
    if (denied) {
      if (isApi) sendJson(res, denied.status, { ok: false, code: "forbidden", error: denied.reason });
      else sendText(res, denied.status, denied.reason);
      return;
    }
    const method = req.method ?? "GET";
    if (!isApi) {
      if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
        const nonce = randomBytes(16).toString("base64");
        const html = renderPage({ token, nonce, projectName: path.basename(root) });
        res.writeHead(200, {
          ...BASE_HEADERS,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            // style="" attributes (bar widths etc.); they cannot run script.
            "style-src-attr 'unsafe-inline'",
            "connect-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join("; "),
        });
        res.end(method === "HEAD" ? undefined : html);
        return;
      }
      if (method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204, BASE_HEADERS);
        res.end();
        return;
      }
      sendText(res, 404, "Not found");
      return;
    }

    const route = `${method} ${url.pathname}`;
    switch (route) {
      case "GET /api/state":
        return apiState(res);
      case "PATCH /api/spec":
      case "POST /api/spec":
        return apiPatchSpec(req, res);
      case "GET /api/files":
        return apiFiles(res);
      case "GET /api/file":
        return apiFile(url, res);
      case "POST /api/generate":
        return apiGenerate(req, res);
      case "POST /api/chat":
        return apiChat(req, res);
      case "POST /api/chat/stop":
        return apiChatStop(req, res);
      case "POST /api/chat/reset":
        return apiChatReset(req, res);
      case "POST /api/approval":
        return apiApproval(req, res);
      case "POST /api/evals":
        return apiEvals(req, res);
      case "GET /api/events":
        return apiEvents(res);
      default:
        throw new HttpError(404, `No route ${route}`);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) sendJson(res, err.status, { ok: false, code: err.code ?? "error", error: err.message, ...err.extra });
      else sendJson(res, 500, { ok: false, code: "internal", error: explain(err).message });
    });
  });
  server.keepAliveTimeout = 5000;

  // ---- listen (fall back to a random port) ---------------------------------

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  const preferred = opts.port ?? 0;
  let portFallback = false;
  try {
    await listen(preferred);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && preferred !== 0 && !opts.strictPort) {
      portFallback = true;
      await listen(0);
    } else {
      throw err;
    }
  }
  const port = (server.address() as AddressInfo).port;
  guard.setPort(port);

  // ---- watch decree.json ---------------------------------------------------

  let watcher: FSWatcher | undefined;
  let polling = false;
  let timer: NodeJS.Timeout | undefined;
  const initial = await readSpecState(root).catch(() => undefined);
  lastSpecHash = initial?.hash;
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = undefined;
      const st = await readSpecState(root).catch(() => undefined);
      if (!st) return;
      const h = st.hash ?? null;
      if (h === (lastSpecHash ?? null)) return;
      lastSpecHash = st.hash;
      broadcast("spec", { hash: h, source: "disk", ok: st.ok });
    }, opts.watchDebounceMs ?? 150);
    timer.unref?.();
  };
  if (opts.watch !== false) {
    try {
      watcher = fsWatch(root, { persistent: false }, (_evt, filename) => {
        if (!filename || String(filename) === SPEC_FILENAME) onChange();
      });
      watcher.on("error", () => undefined);
    } catch {
      polling = true;
      watchFile(paths.specPath, { interval: 1000, persistent: false }, onChange);
    }
  }

  const displayHost = isWildcardHost(host) ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${port}/`,
    host,
    port,
    token,
    portFallback,
    server,
    close: async () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      if (polling) unwatchFile(paths.specPath);
      for (const ac of runs.values()) ac.abort();
      for (const a of approvals.values()) a.resolve(false);
      for (const c of eventClients) c.end();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

export { isLoopbackHost };
