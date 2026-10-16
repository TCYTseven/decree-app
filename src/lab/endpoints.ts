/**
 * Find the local LLM servers running on this machine and the chat models they serve.
 *
 * Probed by default (loopback only, short timeouts, nothing leaves the machine):
 *   Ollama      :11434  native /api/tags + /api/show (context length, capabilities, size)
 *   LM Studio   :1234   /api/v0/models (context length, quantization), else /v1/models
 *   llama.cpp   :8080   /v1/models + /props (n_ctx)       (LocalAI answers here too)
 *   vLLM        :8000   /v1/models (max_model_len)
 *   Jan         :1337   /v1/models
 *   text-generation-webui :5000, KoboldCpp :5001   /v1/models
 *
 * Extra servers come from `--endpoint <url>` and `$DECREE_LOCAL_ENDPOINTS` (comma-separated), and
 * `$OLLAMA_HOST` moves the Ollama probe. An explicit endpoint may be any host: the user chose it.
 */

export type Provider = "ollama" | "lmstudio" | "llamacpp" | "vllm" | "jan" | "textgen" | "koboldcpp" | "openai-compatible";

/** Wire format the adapter speaks to this server. */
export type Dialect = "ollama" | "openai";

export interface LocalModel {
  /** Model id as the server knows it, e.g. "qwen3:8b". */
  id: string;
  provider: Provider;
  providerLabel: string;
  /** Server origin, e.g. http://127.0.0.1:11434 */
  origin: string;
  dialect: Dialect;
  /** Context window in tokens, when the server reports it. */
  contextLength?: number;
  /** "8.2B", "0.5B" ... */
  parameterSize?: string;
  /** Parameter count in billions, parsed from parameterSize or the id. */
  paramsB?: number;
  quantization?: string;
  family?: string;
  sizeBytes?: number;
  /** What the server says the model can do. undefined = not reported (probe it). */
  capabilities?: { tools?: boolean; thinking?: boolean; vision?: boolean };
}

export interface DetectedServer {
  provider: Provider;
  label: string;
  origin: string;
  models: LocalModel[];
  error?: string;
}

export interface DetectOptions {
  /** Extra endpoints (URLs). Ports default to http. */
  endpoints?: string[];
  /** Skip the default port probes (only `endpoints`). */
  onlyEndpoints?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam. */
  fetch?: typeof fetch;
  /** Bearer token for OpenAI-compatible servers that want one ($DECREE_LOCAL_API_KEY). */
  apiKey?: string;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  jan: "Jan",
  textgen: "text-generation-webui",
  koboldcpp: "KoboldCpp",
  "openai-compatible": "OpenAI-compatible server",
};

const DEFAULT_PROBES: { provider: Provider; port: number }[] = [
  { provider: "ollama", port: 11434 },
  { provider: "lmstudio", port: 1234 },
  { provider: "llamacpp", port: 8080 },
  { provider: "vllm", port: 8000 },
  { provider: "jan", port: 1337 },
  { provider: "textgen", port: 5000 },
  { provider: "koboldcpp", port: 5001 },
];

/** Models that cannot chat (embeddings, rerankers, speech, image generation). */
const NON_CHAT = /(^|[-_:/.])(embed|embedding|embeddings|rerank|reranker|bge|e5|minilm|nomic-embed|mxbai|whisper|tts|clip|sdxl|stable-diffusion|flux)([-_:/.]|$)/i;

export function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id);
}

/** "8.2B" -> 8.2, "500M" -> 0.5, ids like "qwen2.5:0.5b" / "llama-3.1-70b-instruct" -> 0.5 / 70. */
export function parseParamsB(...hints: (string | undefined)[]): number | undefined {
  for (const h of hints) {
    if (!h) continue;
    const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*([bm])(?![a-z])/i.exec(h) ?? /^(\d+(?:\.\d+)?)\s*([bm])$/i.exec(h.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    return m[2].toLowerCase() === "m" ? n / 1000 : n;
  }
  return undefined;
}

/** Normalize a user-supplied endpoint to an origin: "localhost:1234/v1" -> "http://localhost:1234". */
export function normalizeOrigin(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error("empty endpoint");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported protocol in ${raw}`);
  u.username = "";
  u.password = "";
  // Keep a path prefix (reverse proxies) but drop a trailing /v1 or /api: we add those ourselves.
  const p = u.pathname.replace(/\/+$/, "").replace(/\/(v1|api)$/i, "");
  return `${u.protocol}//${u.host}${p}`;
}

/** Where Ollama listens, honoring $OLLAMA_HOST ("0.0.0.0" means "this machine"). */
export function ollamaOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OLLAMA_HOST?.trim();
  if (!raw) return "http://127.0.0.1:11434";
  try {
    const withPort = /:\d+$/.test(raw.replace(/^[a-z]+:\/\//i, "")) ? raw : `${raw}:11434`;
    const o = normalizeOrigin(withPort);
    return o.replace("://0.0.0.0", "://127.0.0.1");
  } catch {
    return "http://127.0.0.1:11434";
  }
}

async function getJson(f: typeof fetch, url: string, timeoutMs: number, init: RequestInit = {}): Promise<unknown> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function finish(m: LocalModel): LocalModel {
  m.paramsB = m.paramsB ?? parseParamsB(m.parameterSize, m.id);
  return m;
}

// ---------------------------------------------------------------------------
// Per-provider probes
// ---------------------------------------------------------------------------

async function probeOllama(f: typeof fetch, origin: string, timeoutMs: number): Promise<LocalModel[]> {
  const tags = (await getJson(f, `${origin}/api/tags`, timeoutMs)) as { models?: unknown[] };
  if (!tags || !Array.isArray(tags.models)) throw new Error("not an Ollama server");
  const out: LocalModel[] = [];
  for (const raw of tags.models) {
    const t = raw as { name?: unknown; model?: unknown; size?: unknown; details?: Record<string, unknown> };
    const id = str(t.name) ?? str(t.model);
    if (!id || !isChatModel(id)) continue;
    const m: LocalModel = {
      id,
      provider: "ollama",
      providerLabel: PROVIDER_LABELS.ollama,
      origin,
      dialect: "ollama",
      sizeBytes: num(t.size),
      parameterSize: str(t.details?.parameter_size),
      quantization: str(t.details?.quantization_level),
      family: str(t.details?.family),
    };
    // /api/show: context length and capabilities. Best effort; a failure keeps what /api/tags gave.
    try {
      const show = (await getJson(f, `${origin}/api/show`, Math.max(timeoutMs, 1500), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: id }),
      })) as { capabilities?: unknown; model_info?: Record<string, unknown>; details?: Record<string, unknown> };
      const info = show.model_info ?? {};
      for (const [k, v] of Object.entries(info)) {
        if (k.endsWith(".context_length") && num(v)) m.contextLength = num(v);
      }
      if (Array.isArray(show.capabilities)) {
        const caps = new Set(show.capabilities.map(String));
        if (!caps.has("completion")) continue; // embedding-only model
        m.capabilities = { tools: caps.has("tools"), thinking: caps.has("thinking"), vision: caps.has("vision") };
      }
      m.parameterSize = m.parameterSize ?? str(show.details?.parameter_size);
    } catch {
      /* keep the basic entry */
    }
    out.push(finish(m));
  }
  return out;
}

function openAiModelIds(body: unknown): { id: string; raw: Record<string, unknown> }[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("not an OpenAI-compatible /v1/models response");
  return data
    .map((d) => d as Record<string, unknown>)
    .map((raw) => ({ id: str(raw.id) ?? "", raw }))
    .filter((x) => x.id && isChatModel(x.id));
}

async function probeOpenAI(
  f: typeof fetch,
  provider: Provider,
  origin: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<{ provider: Provider; models: LocalModel[] }> {
  // LM Studio's richer API first: it reports context length, quantization and model type.
  if (provider === "lmstudio") {
    try {
      const body = (await getJson(f, `${origin}/api/v0/models`, timeoutMs, { headers })) as { data?: unknown[] };
      if (Array.isArray(body.data)) {
        const models = body.data
          .map((d) => d as Record<string, unknown>)
          .filter((d) => (d.type === undefined || d.type === "llm" || d.type === "vlm") && str(d.id) && isChatModel(String(d.id)))
          .map((d) =>
            finish({
              id: String(d.id),
              provider,
              providerLabel: PROVIDER_LABELS[provider],
              origin,
              dialect: "openai",
              contextLength: num(d.loaded_context_length) ?? num(d.max_context_length),
              quantization: str(d.quantization),
              family: str(d.arch),
              capabilities: Array.isArray(d.capabilities) ? { tools: d.capabilities.includes("tool_use"), vision: d.type === "vlm" } : undefined,
            }),
          );
        return { provider, models };
      }
    } catch {
      /* fall through to /v1/models */
    }
  }
  const ids = openAiModelIds(await getJson(f, `${origin}/v1/models`, timeoutMs, { headers }));
  let ctx: number | undefined;
  let detected = provider;
  // llama.cpp's server exposes /props with the loaded context size.
  if (provider === "llamacpp" || provider === "openai-compatible") {
    try {
      const props = (await getJson(f, `${origin}/props`, timeoutMs, { headers })) as { default_generation_settings?: Record<string, unknown>; n_ctx?: unknown };
      ctx = num(props.default_generation_settings?.n_ctx) ?? num(props.n_ctx);
      if (ctx) detected = "llamacpp";
    } catch {
      if (provider === "llamacpp") detected = "openai-compatible"; // LocalAI and friends also live on :8080
    }
  }
  const models = ids.map(({ id, raw }) =>
    finish({
      id,
      provider: detected,
      providerLabel: PROVIDER_LABELS[detected],
      origin,
      dialect: "openai",
      contextLength: num(raw.max_model_len) ?? num(raw.context_length) ?? num(raw.max_context_length) ?? ctx,
    }),
  );
  return { provider: detected, models };
}

async function probeOrigin(
  f: typeof fetch,
  provider: Provider,
  origin: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<DetectedServer> {
  if (provider === "ollama") {
    const models = await probeOllama(f, origin, timeoutMs);
    return { provider, label: PROVIDER_LABELS.ollama, origin, models };
  }
  const r = await probeOpenAI(f, provider, origin, timeoutMs, headers);
  return { provider: r.provider, label: PROVIDER_LABELS[r.provider], origin, models: r.models };
}

/** An explicit endpoint: try Ollama's native API first (richer metadata), then OpenAI-compatible. */
async function probeExplicit(f: typeof fetch, origin: string, timeoutMs: number, headers: Record<string, string>): Promise<DetectedServer> {
  try {
    return await probeOrigin(f, "ollama", origin, timeoutMs, headers);
  } catch {
    const lmstudio = /:1234$/.test(origin);
    return probeOrigin(f, lmstudio ? "lmstudio" : "openai-compatible", origin, timeoutMs, headers);
  }
}

/** Probe every known local server plus the explicit endpoints. Servers that don't answer are left out. */
export async function detectLocalModels(opts: DetectOptions = {}): Promise<DetectedServer[]> {
  const f = opts.fetch ?? fetch;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 900;
  const headers: Record<string, string> = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};

  const explicit = [
    ...(opts.endpoints ?? []),
    ...(env.DECREE_LOCAL_ENDPOINTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ].map(normalizeOrigin);

  const jobs: { origin: string; run: () => Promise<DetectedServer> }[] = [];
  const seen = new Set<string>();
  for (const origin of explicit) {
    if (seen.has(origin)) continue;
    seen.add(origin);
    jobs.push({ origin, run: () => probeExplicit(f, origin, Math.max(timeoutMs, 2000), headers) });
  }
  if (!opts.onlyEndpoints) {
    for (const p of DEFAULT_PROBES) {
      const origin = p.provider === "ollama" ? ollamaOrigin(env) : `http://127.0.0.1:${p.port}`;
      if (seen.has(origin)) continue;
      seen.add(origin);
      jobs.push({ origin, run: () => probeOrigin(f, p.provider, origin, timeoutMs, headers) });
    }
  }

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const servers: DetectedServer[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") servers.push(s.value);
    else if (explicit.includes(jobs[i].origin)) {
      // An endpoint the user named and that didn't answer is worth reporting; default probes are silent.
      servers.push({ provider: "openai-compatible", label: PROVIDER_LABELS["openai-compatible"], origin: jobs[i].origin, models: [], error: (s.reason as Error)?.message ?? String(s.reason) });
    }
  });
  return servers;
}

/** "ollama/qwen3:8b" style key, unique across servers. */
export function modelKey(m: Pick<LocalModel, "provider" | "id" | "origin">): string {
  return `${m.provider}@${m.origin.replace(/^https?:\/\//, "")}/${m.id}`;
}

/** A filesystem-safe slug for a model, for suite and run file names. */
export function modelSlug(m: Pick<LocalModel, "provider" | "id">): string {
  return `${m.provider}-${m.id}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

/** Pick models by id, key or a substring (`--models qwen,llama3.1:8b`). */
export function selectModels(all: LocalModel[], wanted?: string[]): LocalModel[] {
  if (!wanted?.length) return all;
  const out: LocalModel[] = [];
  for (const w of wanted.map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const exact = all.filter((m) => m.id.toLowerCase() === w || modelKey(m).toLowerCase() === w);
    const hits = exact.length ? exact : all.filter((m) => m.id.toLowerCase().includes(w));
    for (const h of hits) if (!out.includes(h)) out.push(h);
  }
  return out;
}
