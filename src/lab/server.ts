import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { HarnessSpec } from "../core/types.js";
import { RequestGuard, createToken, isWildcardHost } from "../preview/security.js";
import { SSEStream } from "../preview/sse.js";
import { DECREE_VERSION } from "../version.js";
import { detectLocalModels, modelKey, type DetectOptions, type DetectedServer, type LocalModel } from "./endpoints.js";
import { renderLabPage } from "./page.js";
import { runLab, type LabRunOptions } from "./run.js";
import { listRuns, loadRun, saveRun, saveSuite } from "./store.js";
import { DOMAINS, generateSuite, tailorFor } from "./suite.js";
import type { DomainId } from "./types.js";

/**
 * The lab dashboard: a local page to pick models, inspect the generated suite and run it, with live
 * progress and a model-card table of results. Same security model as `preview` (loopback bind, Host and
 * Origin checks, a per-session token on every API call; see src/preview/security.ts).
 */

export interface LabServerDeps {
  loadSpec: () => Promise<{ spec: HarnessSpec; source: "decree.json" | "scan"; warnings?: string[] }>;
  detect?: (opts: DetectOptions) => Promise<DetectedServer[]>;
  /** Test seam passed through to runLab. */
  clientFor?: LabRunOptions["clientFor"];
}

export interface LabServerOptions {
  root: string;
  host?: string;
  port?: number;
  strictPort?: boolean;
  token?: string;
  detect?: DetectOptions;
  apiKey?: string;
  maxContext?: number;
  heartbeatMs?: number;
  deps: LabServerDeps;
  /** Servers already detected by the CLI (skips the first probe). */
  initial?: DetectedServer[];
}

export interface LabServer {
  url: string;
  port: number;
  token: string;
  portFallback: boolean;
  close(): Promise<void>;
}

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "Expected Content-Type: application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body is not a JSON object");
  }
}

const DOMAIN_IDS = new Set<string>(DOMAINS.map((d) => d.id));

export async function startLabServer(opts: LabServerOptions): Promise<LabServer> {
  const root = path.resolve(opts.root);
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? createToken();
  const guard = new RequestGuard(token, host, opts.port ?? 0);
  const detect = opts.deps.detect ?? detectLocalModels;
  let servers: DetectedServer[] = opts.initial ?? [];
  let detectedAt = opts.initial ? new Date().toISOString() : undefined;
  let running: { ac: AbortController; models: string[] } | undefined;

  const allModels = (): LocalModel[] => servers.flatMap((s) => s.models);
  const findModel = (key: string) => allModels().find((m) => modelKey(m) === key);

  async function refresh(): Promise<void> {
    servers = await detect(opts.detect ?? {});
    detectedAt = new Date().toISOString();
  }

  async function apiState(res: ServerResponse): Promise<void> {
    if (!detectedAt) await refresh();
    let harness: Record<string, unknown>;
    try {
      const { spec, source, warnings } = await opts.deps.loadSpec();
      harness = {
        ok: true,
        name: spec.name,
        displayName: spec.displayName,
        source,
        tools: spec.tools.length,
        decisions: (spec.decisions ?? []).filter((d) => d.status === "live").length,
        warnings: warnings ?? [],
      };
    } catch (err) {
      harness = { ok: false, error: (err as Error).message };
    }
    sendJson(res, 200, {
      version: DECREE_VERSION,
      project: { name: path.basename(root), root },
      harness,
      detectedAt,
      servers: servers.map((s) => ({ ...s, models: s.models.map((m) => ({ ...m, key: modelKey(m) })) })),
      domains: DOMAINS,
      running: running ? { models: running.models } : null,
      runs: await listRuns(root),
    });
  }

  async function apiDetect(res: ServerResponse): Promise<void> {
    await refresh();
    return apiState(res);
  }

  async function apiSuite(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const model = findModel(String(body.model ?? ""));
    if (!model) throw new HttpError(404, "Unknown model. Refresh the model list.", "unknown_model");
    const { spec } = await opts.deps.loadSpec();
    const tailoring = tailorFor(model, spec, { maxContext: opts.maxContext });
    const suite = generateSuite(spec, { project: path.basename(root), tailoring });
    // Long-context prompts are megabytes of logs: the page gets a summary instead.
    const slim = {
      ...suite,
      domains: suite.domains.map((d) => ({
        ...d,
        items: d.items.map((i) => ({ ...i, system: undefined, prompt: i.summary ? i.summary : i.prompt.length > 1200 ? `${i.prompt.slice(0, 1200)}…` : i.prompt })),
      })),
    };
    sendJson(res, 200, slim);
  }

  async function apiRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (running) throw new HttpError(409, "A run is already in progress.", "busy");
    const keys = Array.isArray(body.models) ? body.models.map(String) : [];
    const models = keys.map(findModel).filter((m): m is LocalModel => !!m);
    if (!models.length) throw new HttpError(400, "Pick at least one model.", "no_models");
    const samples = Math.min(10, Math.max(1, Math.floor(Number(body.samples) || 1)));
    const domains = Array.isArray(body.domains) ? (body.domains.map(String).filter((d) => DOMAIN_IDS.has(d)) as DomainId[]) : undefined;
    const { spec } = await opts.deps.loadSpec();
    const ac = new AbortController();
    running = { ac, models: models.map(modelKey) };
    const stream = new SSEStream(res, { heartbeatMs: opts.heartbeatMs });
    // Closing the tab doesn't stop the run: it is saved, and the page finds it in the history.
    stream.send("start", { models: running.models, samples });
    try {
      const run = await runLab({
        projectRoot: root,
        project: path.basename(root),
        spec,
        models,
        samples,
        domains: domains?.length ? domains : undefined,
        tailor: { maxContext: opts.maxContext },
        apiKey: opts.apiKey,
        signal: ac.signal,
        clientFor: opts.deps.clientFor,
        onSuite: (m, suite) => saveSuite(root, m, suite).then(() => undefined),
        onEvent: (e) => stream.send(e.type, e),
      });
      await saveRun(root, run);
      stream.send("done", { id: run.id, stopped: ac.signal.aborted });
    } catch (err) {
      stream.send("fatal", { message: (err as Error).message });
    } finally {
      running = undefined;
      stream.end();
    }
  }

  async function apiStop(res: ServerResponse): Promise<void> {
    running?.ac.abort();
    sendJson(res, 200, { ok: true, stopped: !!running });
  }

  async function apiRunGet(url: URL, res: ServerResponse): Promise<void> {
    const run = await loadRun(root, url.searchParams.get("id") ?? "");
    if (!run) throw new HttpError(404, "No such run.", "not_found");
    sendJson(res, 200, run);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const isApi = url.pathname.startsWith("/api/");
    const denied = guard.check(req, { api: isApi });
    if (denied) {
      if (isApi) sendJson(res, denied.status, { ok: false, code: "forbidden", error: denied.reason });
      else {
        res.writeHead(denied.status, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
        res.end(denied.reason);
      }
      return;
    }
    const method = req.method ?? "GET";
    if (!isApi) {
      if ((method === "GET" || method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
        const nonce = randomBytes(16).toString("base64");
        const html = renderLabPage({ token, nonce, projectName: path.basename(root) });
        res.writeHead(200, {
          ...BASE_HEADERS,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            "style-src-attr 'unsafe-inline'",
            "connect-src 'self'",
            "img-src 'self' data:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join("; "),
        });
        res.end(method === "HEAD" ? undefined : html);
        return;
      }
      res.writeHead(url.pathname === "/favicon.ico" ? 204 : 404, BASE_HEADERS);
      res.end();
      return;
    }
    switch (`${method} ${url.pathname}`) {
      case "GET /api/state":
        return apiState(res);
      case "POST /api/detect":
        return apiDetect(res);
      case "POST /api/suite":
        return apiSuite(req, res);
      case "POST /api/run":
        return apiRun(req, res);
      case "POST /api/stop":
        return apiStop(res);
      case "GET /api/run":
        return apiRunGet(url, res);
      default:
        throw new HttpError(404, `No route ${method} ${url.pathname}`);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) sendJson(res, err.status, { ok: false, code: err.code, error: err.message });
      else sendJson(res, 500, { ok: false, code: "internal", error: (err as Error)?.message ?? String(err) });
    });
  });
  server.keepAliveTimeout = 5000;

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
    } else throw err;
  }
  const port = (server.address() as AddressInfo).port;
  guard.setPort(port);
  const displayHost = isWildcardHost(host) ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${port}/`,
    port,
    token,
    portFallback,
    close: async () => {
      running?.ac.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
