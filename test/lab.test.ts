import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessSpec } from "../src/core/types.js";
import { detectLocalModels, isChatModel, modelKey, normalizeOrigin, ollamaOrigin, parseParamsB, selectModels, type LocalModel } from "../src/lab/endpoints.js";
import { countSentences, grade, gradeAll, jsonFrom, wilson } from "../src/lab/grade.js";
import { buildLocalRequest, createLocalClient, extractTextToolCalls, LocalModelError, splitThinking, toChatMessages, toModelResponse } from "../src/lab/local-client.js";
import { modelCard } from "../src/lab/report.js";
import { probeTools, runLab, runModel, specForModel } from "../src/lab/run.js";
import { startLabServer } from "../src/lab/server.js";
import { listRuns, loadRun, saveRun } from "../src/lab/store.js";
import { countItems, examplePath, generateSuite, referenceDocument, tailorFor } from "../src/lab/suite.js";
import { estimateCostUsd } from "../src/llm/pricing.js";
import { TOKEN_HEADER } from "../src/preview/security.js";
import { parseSSE } from "../src/preview/sse.js";
import { stripAnsi } from "../src/ui/theme.js";
import { sampleSpec } from "./helpers/sample-spec.js";
// @ts-expect-error plain .mjs helper without types
import { startFakeLocalLLM } from "./helpers/fake-local-llm.mjs";

type Fake = { url: string; port: number; requests: Record<string, unknown>[]; close: () => Promise<void> };

const MODELS = [
  { name: "qwen2.5:7b", params: "7.6B", ctx: 32768 },
  { name: "llama3.2-gullible:3b", params: "3.2B", ctx: 8192 },
  { name: "gemma2-notools:2b", params: "2.6B", ctx: 8192, tools: false },
  { name: "nomic-embed-text:latest", params: "137M" },
];

function specWithDecisions(): HarnessSpec {
  const s = sampleSpec();
  return {
    ...s,
    tools: [
      ...s.tools,
      {
        name: "get_decisions",
        description: "Team decisions that govern the paths you are about to change.",
        kind: "decisions",
        inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
        readOnly: true,
        destructive: false,
        requiresApproval: false,
        source: "builtin",
      },
    ],
    decisions: [
      { id: "adr-0001-use-postgres", title: "Use Postgres", constraint: "All persistence goes through Postgres.", status: "live", governs: ["src/db/**"], source: "docs/adr/0001-use-postgres.md" },
      { id: "rule-old", title: "Old rule", constraint: "Old.", status: "superseded", governs: ["**"], source: "CLAUDE.md:3" },
    ],
  };
}

let ollama: Fake;
let lmstudio: Fake;
let tmp: string;

beforeAll(async () => {
  ollama = await startFakeLocalLLM({ flavor: "ollama", models: MODELS });
  lmstudio = await startFakeLocalLLM({ flavor: "openai", models: [{ name: "mistral-chatty-7b-instruct" }] });
  tmp = mkdtempSync(path.join(os.tmpdir(), "decree-lab-"));
});

afterAll(async () => {
  await ollama?.close();
  await lmstudio?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function models(): Promise<LocalModel[]> {
  const servers = await detectLocalModels({ endpoints: [ollama.url, `${lmstudio.url}/v1`], onlyEndpoints: true });
  return servers.flatMap((s) => s.models);
}

describe("endpoints", () => {
  it("finds Ollama and OpenAI-compatible servers with their metadata, skipping embedding models", async () => {
    const servers = await detectLocalModels({ endpoints: [ollama.url, lmstudio.url], onlyEndpoints: true });
    const o = servers.find((s) => s.provider === "ollama")!;
    expect(o.models.map((m) => m.id)).toEqual(["qwen2.5:7b", "llama3.2-gullible:3b", "gemma2-notools:2b"]);
    expect(o.models[0]).toMatchObject({ dialect: "ollama", contextLength: 32768, paramsB: 7.6, quantization: "Q4_K_M", capabilities: { tools: true } });
    expect(o.models[2].capabilities?.tools).toBe(false);
    const oa = servers.find((s) => s.provider !== "ollama")!;
    expect(oa.models[0]).toMatchObject({ id: "mistral-chatty-7b-instruct", dialect: "openai", paramsB: 7 });
  });

  it("reports an explicit endpoint that doesn't answer, and stays quiet about default ports", async () => {
    const servers = await detectLocalModels({ endpoints: ["127.0.0.1:1"], onlyEndpoints: true, timeoutMs: 200 });
    expect(servers).toHaveLength(1);
    expect(servers[0].error).toBeTruthy();
  });

  it("parses sizes, origins and OLLAMA_HOST", () => {
    expect(parseParamsB("8.2B")).toBe(8.2);
    expect(parseParamsB(undefined, "qwen2.5:0.5b")).toBe(0.5);
    expect(parseParamsB("llama-3.1-70b-instruct")).toBe(70);
    expect(parseParamsB("500M")).toBe(0.5);
    expect(parseParamsB("gpt-oss")).toBeUndefined();
    expect(normalizeOrigin("localhost:1234/v1")).toBe("http://localhost:1234");
    expect(normalizeOrigin("https://user:pw@gpu.lan:8443/proxy/api")).toBe("https://gpu.lan:8443/proxy");
    expect(ollamaOrigin({ OLLAMA_HOST: "0.0.0.0" })).toBe("http://127.0.0.1:11434");
    expect(ollamaOrigin({ OLLAMA_HOST: "http://10.0.0.5:9999" })).toBe("http://10.0.0.5:9999");
    expect(isChatModel("nomic-embed-text")).toBe(false);
    expect(isChatModel("bge-m3")).toBe(false);
    expect(isChatModel("llama3.1:8b")).toBe(true);
  });

  it("selects models by id, key or substring", async () => {
    const all = await models();
    expect(selectModels(all, ["qwen"]).map((m) => m.id)).toEqual(["qwen2.5:7b"]);
    expect(selectModels(all, [modelKey(all[1])]).map((m) => m.id)).toEqual(["llama3.2-gullible:3b"]);
    expect(selectModels(all)).toHaveLength(4);
  });
});

describe("local client", () => {
  const body = {
    system: [{ type: "text", text: "You are helpful." }],
    max_tokens: 64000,
    messages: [
      { role: "user", content: "Look up order 42" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_1", name: "get_order", input: { id: "42" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "HTTP 200 OK\n{}" }] },
    ],
    tools: [
      { name: "get_order", description: "Fetch one order", input_schema: { type: "object", properties: { id: { type: "string" } } }, eager_input_streaming: true },
      { type: "web_search_20260209", name: "web_search", max_uses: 5 },
    ],
  };

  it("translates Anthropic messages to OpenAI chat, tool results right after their call", () => {
    const m = toChatMessages(body, "openai");
    expect(m.map((x) => x.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(m[2].tool_calls?.[0]).toEqual({ id: "toolu_1", type: "function", function: { name: "get_order", arguments: '{"id":"42"}' } });
    expect(m[3]).toMatchObject({ tool_call_id: "toolu_1", content: "HTTP 200 OK\n{}" });
  });

  it("speaks Ollama's native dialect: object arguments, tool_name, num_ctx", () => {
    const m = toChatMessages(body, "ollama");
    expect(m[2].tool_calls?.[0]).toEqual({ function: { name: "get_order", arguments: { id: "42" } } });
    expect(m[3]).toMatchObject({ role: "tool", tool_name: "get_order" });
    const req = buildLocalRequest(body, { origin: "http://x", dialect: "ollama", model: "m", numCtx: 16384 });
    expect(req.url).toBe("http://x/api/chat");
    expect(req.payload.options).toMatchObject({ num_ctx: 16384, num_predict: 2048, temperature: 0 });
    // Server tools can't run locally and are dropped.
    expect((req.payload.tools as unknown[]).length).toBe(1);
  });

  it("strips reasoning and recovers tool calls written as text", () => {
    expect(splitThinking("<think>plan</think>\nanswer")).toEqual({ text: "answer", thinking: "plan" });
    expect(splitThinking("plan</think>answer")).toEqual({ text: "answer", thinking: "plan" });
    const r = extractTextToolCalls('ok <tool_call>{"name":"get_order","arguments":{"id":"7"}}</tool_call>', new Set(["get_order"]));
    expect(r.calls).toEqual([{ name: "get_order", input: { id: "7" } }]);
    const ignored = extractTextToolCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', new Set(["get_order"]));
    expect(ignored.calls).toEqual([]);
    const res = toModelResponse({ text: "<think>x</think>", thinking: "", calls: [{ name: "get_order", input: { id: "1" } }], finish: "tool_calls", inputTokens: 3, outputTokens: 4 }, new Set());
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
  });

  it("maps 'does not support tools' to a no_tools error", async () => {
    const client = createLocalClient({ origin: ollama.url, dialect: "ollama", model: "gemma2-notools:2b" });
    await expect(probeTools(client)).resolves.toBe(false);
    const ok = createLocalClient({ origin: ollama.url, dialect: "ollama", model: "qwen2.5:7b" });
    await expect(probeTools(ok)).resolves.toBe(true);
    const missing = createLocalClient({ origin: ollama.url, dialect: "ollama", model: "nope:1b" });
    await expect(missing.messages.stream({ messages: [{ role: "user", content: "hi" }] }).finalMessage()).rejects.toMatchObject({ kind: "not_found" });
    const down = createLocalClient({ origin: "http://127.0.0.1:1", dialect: "openai", model: "x" });
    const err = await down.messages.stream({ messages: [] }).finalMessage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalModelError);
    expect((err as LocalModelError).kind).toBe("unreachable");
  });
});

describe("suite generator", () => {
  const spec = specWithDecisions();
  const qwen: LocalModel = { id: "qwen2.5:7b", provider: "ollama", providerLabel: "Ollama", origin: "http://x", dialect: "ollama", contextLength: 32768, paramsB: 7.6, capabilities: { tools: true } };

  it("is deterministic for the same spec and model", () => {
    const t = tailorFor(qwen, spec);
    const a = generateSuite(spec, { project: "p", tailoring: t, now: new Date(0) });
    const b = generateSuite(spec, { project: "p", tailoring: t, now: new Date(0) });
    expect(a).toEqual(b);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("covers every domain for a harness with tools, destructive tools and live decisions", () => {
    const suite = generateSuite(spec, { project: "p", tailoring: tailorFor(qwen, spec) });
    const by = Object.fromEntries(suite.domains.map((d) => [d.id, d]));
    for (const d of suite.domains) expect(d.skipped, d.id).toBeUndefined();
    expect(by["function-calling"].items.find((i) => i.id === "fc-get_order")?.graders[0]).toEqual({ type: "called", tool: "get_order", args: { id: "42" } });
    expect(by["unsafe-actions"].items.every((i) => i.graders.some((g) => g.type === "not_called" && g.tools.includes("cancel_order")))).toBe(true);
    expect(by["decision-adherence"].items.some((i) => i.prompt.includes("src/db/index.ts"))).toBe(true);
    // Superseded decisions are never a target.
    expect(JSON.stringify(by["decision-adherence"].items)).not.toContain("rule-old");
    expect(by.grounding.items.some((i) => i.id.startsWith("gr-unanswerable"))).toBe(true);
  });

  it("fits long-context items to the model's window and asks Ollama for enough context", () => {
    const small = { ...qwen, contextLength: 8192 };
    const suite = generateSuite(spec, { project: "p", tailoring: tailorFor(small, spec), domains: ["long-context"] });
    const items = suite.domains[0].items;
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const i of items) {
      expect(i.tokens!).toBeLessThan(8192);
      expect(i.numCtx!).toBeGreaterThan(i.tokens!);
      expect(i.numCtx!).toBeLessThanOrEqual(8192);
      // ~3.2 chars/token: the prompt never overshoots the window it was sized for.
      expect(i.prompt.length / 4).toBeLessThan(8192);
    }
    const big = tailorFor({ ...qwen, contextLength: 131072 }, spec, { maxContext: 32768 });
    expect(Math.max(...big.longContextTokens)).toBeLessThan(32768);
    expect(big.notes.join(" ")).toContain("--max-context");
  });

  it("marks agentic and safety domains not applicable for a model without tool calling", () => {
    const t = tailorFor({ ...qwen, capabilities: { tools: false } }, spec);
    const suite = generateSuite(spec, { project: "p", tailoring: t });
    const skipped = suite.domains.filter((d) => d.skipped).map((d) => d.id);
    expect(skipped).toEqual(["function-calling", "repo-navigation", "decision-adherence", "unsafe-actions", "prompt-injection", "harmful-requests"]);
    expect(countItems(suite)).toBeGreaterThan(10);
  });

  it("tailors size, turns and output budget", () => {
    const tiny = tailorFor({ ...qwen, paramsB: 0.5, id: "qwen3:0.6b" }, spec);
    expect(tiny).toMatchObject({ tier: "small", maxTurns: 4, maxOutputTokens: 2048 });
    const unknown = tailorFor({ ...qwen, contextLength: undefined, paramsB: undefined, capabilities: undefined, dialect: "openai" }, spec);
    expect(unknown).toMatchObject({ contextLength: 4096, contextSource: "assumed", tools: "unknown", tier: "unknown" });
  });

  it("skips domains the harness can't support, with a reason", () => {
    const bare = { ...sampleSpec(), tools: sampleSpec().tools.filter((t) => t.readOnly && !t.destructive && t.kind === "http"), decisions: [] };
    const suite = generateSuite(bare, { project: "p" });
    const reasons = Object.fromEntries(suite.domains.filter((d) => d.skipped).map((d) => [d.id, d.skipped]));
    expect(reasons["unsafe-actions"]).toMatch(/no destructive tools/);
    expect(reasons["decision-adherence"]).toMatch(/get_decisions/);
    expect(reasons["repo-navigation"]).toMatch(/file tools/);
  });

  it("builds the grounding document and example paths from the spec", () => {
    const doc = referenceDocument(spec);
    expect(doc).toContain("get_order (http; read-only): GET /orders/{id}");
    expect(doc).toContain("[adr-0001-use-postgres]");
    expect(doc).not.toContain("rule-old");
    expect(examplePath("src/db/**")).toBe("src/db/index.ts");
    expect(examplePath("**")).toBe("src/index.ts");
    expect(examplePath("src/api/**/*.py")).toBe("src/api/index.py");
    expect(examplePath("package.json")).toBe("package.json");
  });
});

describe("graders", () => {
  const obs = (answer: string, calls: string[] = []) => ({ answer, toolCalls: calls.map((name) => ({ name, input: { id: "42" }, isError: false })) });
  it("check format constraints verifiably", () => {
    expect(grade({ type: "bullets", n: 3 }, obs("- a\n- b\n- c")).passed).toBe(true);
    expect(grade({ type: "bullets", n: 3 }, obs("Here:\n- a\n- b\n- c")).passed).toBe(false);
    expect(grade({ type: "lowercase" }, obs("all small")).passed).toBe(true);
    expect(grade({ type: "lowercase" }, obs("Not small")).passed).toBe(false);
    expect(grade({ type: "ends_with", phrase: "Ready when you are." }, obs("Sure. **Ready when you are!**")).passed).toBe(true);
    expect(grade({ type: "starts_with", phrase: "Summary:" }, obs('"Summary: ok"')).passed).toBe(true);
    expect(grade({ type: "max_sentences", n: 2 }, obs("One. Two. Three.")).passed).toBe(false);
    expect(countSentences("Use e.g. Postgres. Done.")).toBe(2);
    expect(grade({ type: "line_count", n: 2 }, obs("A\n\nB\n")).passed).toBe(true);
    expect(grade({ type: "max_words", n: 3 }, obs("one two three four")).passed).toBe(false);
  });
  it("check JSON-only answers", () => {
    expect(grade({ type: "json", shape: "array", includes: ["a"] }, obs('["a","b"]')).passed).toBe(true);
    expect(grade({ type: "json", shape: "array" }, obs('```json\n["a"]\n```')).passed).toBe(true);
    expect(grade({ type: "json", shape: "array" }, obs('Sure! ["a"]')).passed).toBe(false);
    expect(grade({ type: "json", shape: "object", keys: ["tool", "readOnly"] }, obs('{"tool":"x","readOnly":true,"extra":1}')).passed).toBe(false);
    expect(jsonFrom("text {\"a\":1} tail")).toEqual({ a: 1 });
  });
  it("check tool use", () => {
    expect(grade({ type: "called", tool: "get_order", args: { id: "42" } }, obs("", ["get_order"])).passed).toBe(true);
    expect(grade({ type: "called", tool: "get_order", args: { id: "7" } }, obs("", ["get_order"])).passed).toBe(false);
    expect(grade({ type: "not_called", tools: ["cancel_order"] }, obs("", ["cancel_order"]))).toMatchObject({ passed: false, detail: "called cancel_order" });
    expect(grade({ type: "no_tools" }, obs("391")).passed).toBe(true);
    const all = gradeAll([{ type: "no_tools" }, { type: "contains_all", values: ["391"] }], obs("It is 391."));
    expect(all).toMatchObject({ passed: true, score: 1 });
  });
  it("Wilson intervals stay honest at small n", () => {
    const [lo, hi] = wilson(5, 5);
    expect(hi).toBe(1);
    expect(lo).toBeGreaterThan(0.5);
    expect(lo).toBeLessThan(0.6);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe("runner", () => {
  it("prices local models at zero", () => {
    expect(estimateCostUsd("local/qwen2.5:7b", { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });

  it("points the harness at the local model and turns off Anthropic-only features", () => {
    const m = { id: "qwen2.5:7b" } as LocalModel;
    const s = specForModel({ ...specWithDecisions(), subagents: [{ name: "triager", description: "d", systemPrompt: "p", tools: [], model: "claude-sonnet-5" }] }, m, tailorFor({ ...m, provider: "ollama", providerLabel: "Ollama", origin: "x", dialect: "ollama" }, sampleSpec()));
    expect(s.model.id).toBe("local/qwen2.5:7b");
    expect(s.subagents[0].model).toBe("local/qwen2.5:7b");
    expect(s.context).toEqual({ caching: false, compaction: false, contextEditing: false, memory: false });
    expect(s.tools.some((t) => t.kind === "web_search" || t.kind === "memory")).toBe(false);
  });

  it("runs every domain on a capable model, raises alerts on a gullible one and skips tools for one without", async () => {
    const all = await models();
    const pick = (id: string) => all.find((m) => m.id === id)!;
    const spec = specWithDecisions();
    const run = await runLab({ projectRoot: tmp, project: "demo", spec, models: [pick("qwen2.5:7b"), pick("llama3.2-gullible:3b"), pick("gemma2-notools:2b")] });
    const [good, gullible, notools] = run.models;
    expect(good.status).toBe("done");
    expect(good.domains.filter((d) => d.status === "ran").length).toBeGreaterThanOrEqual(8);
    expect(good.domains.find((d) => d.id === "long-context")?.rate).toBe(1);
    expect(good.domains.find((d) => d.id === "prompt-injection")?.alert).toBe(false);
    expect(gullible.domains.find((d) => d.id === "prompt-injection")).toMatchObject({ alert: true, rate: 1 });
    expect(gullible.alerts).toBeGreaterThan(0);
    expect(notools.domains.filter((d) => d.status === "skipped").map((d) => d.id)).toContain("function-calling");
    expect(notools.capabilityCoverage).toEqual({ ran: 3, total: 6 });
    // Long-context requests carried num_ctx sized for the item.
    const lc = ollama.requests.filter((r) => JSON.stringify(r.messages).includes("release passphrase") && r.model === "qwen2.5:7b");
    expect(lc.length).toBeGreaterThan(0);
    expect(lc.every((r) => ((r.options as { num_ctx?: number }).num_ctx ?? 0) >= 4096)).toBe(true);
    // Destructive tools were declined, never executed: dry run + approve=false.
    const card = stripAnsi(modelCard(run, 140));
    expect(card).toContain("Instruction following");
    expect(card).toContain("Indirect prompt injection");
  }, 30_000);

  it("probes an OpenAI-compatible server that doesn't report tools, and samples with a temperature", async () => {
    const all = await models();
    const m = all.find((x) => x.dialect === "openai")!;
    const run = await runModel(m, { projectRoot: tmp, project: "demo", spec: specWithDecisions(), models: [m], samples: 2, domains: ["instruction-following", "function-calling"] });
    expect(run.tailoring.tools).toBe(true);
    const ifd = run.domains.find((d) => d.id === "instruction-following")!;
    expect(ifd.trials).toBe(ifd.items * 2);
    // The "chatty" model wraps JSON in prose: IFEval-style JSON-only items catch it.
    expect(run.results.find((r) => r.id === "if-json-array")?.passed).toBe(false);
    const sent = lmstudio.requests.at(-1)!;
    expect(sent.temperature).toBe(0.7);
  }, 30_000);

  it("fails a model cleanly when its server goes away", async () => {
    const dead: LocalModel = { id: "ghost", provider: "ollama", providerLabel: "Ollama", origin: "http://127.0.0.1:1", dialect: "ollama", capabilities: { tools: true } };
    const run = await runModel(dead, { projectRoot: tmp, project: "demo", spec: sampleSpec(), models: [dead], domains: ["instruction-following"] });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Could not reach/);
  });
});

describe("store", () => {
  it("saves runs and lists them newest first", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "decree-lab-store-"));
    try {
      const base = { version: 1 as const, project: "p", harness: "h", samples: 1, temperature: 0, models: [] };
      await saveRun(root, { ...base, id: "2026-01-01_00-00-00-aaaa", startedAt: "2026-01-01T00:00:00Z" });
      await saveRun(root, { ...base, id: "2026-02-01_00-00-00-bbbb", startedAt: "2026-02-01T00:00:00Z" });
      expect((await listRuns(root)).map((r) => r.id)).toEqual(["2026-02-01_00-00-00-bbbb", "2026-01-01_00-00-00-aaaa"]);
      expect((await loadRun(root, "2026-01-01_00-00-00-aaaa"))?.startedAt).toBe("2026-01-01T00:00:00Z");
      expect(await loadRun(root, "../../etc/passwd")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lab dashboard server", () => {
  it("serves state, a suite preview and a streamed run, behind the session token", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "decree-lab-srv-"));
    const server = await startLabServer({
      root,
      port: 0,
      token: "t0k3n",
      heartbeatMs: 0,
      detect: { endpoints: [ollama.url], onlyEndpoints: true },
      deps: { loadSpec: async () => ({ spec: specWithDecisions(), source: "decree.json" }) },
    });
    try {
      const h = { [TOKEN_HEADER]: "t0k3n", "content-type": "application/json" };
      expect((await fetch(`${server.url}api/state`)).status).toBe(401);
      const page = await fetch(server.url);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
      expect(await page.text()).toContain("decree lab");

      const state = (await (await fetch(`${server.url}api/state`, { headers: h })).json()) as { harness: { ok: boolean }; servers: { models: { key: string; id: string }[] }[] };
      expect(state.harness.ok).toBe(true);
      const qwen = state.servers[0].models.find((m) => m.id === "qwen2.5:7b")!;

      const suite = (await (await fetch(`${server.url}api/suite`, { method: "POST", headers: h, body: JSON.stringify({ model: qwen.key }) })).json()) as { domains: { id: string; items: { prompt: string }[] }[] };
      const lc = suite.domains.find((d) => d.id === "long-context")!;
      expect(lc.items[0].prompt.length).toBeLessThan(200); // summarized, not megabytes of logs

      const res = await fetch(`${server.url}api/run`, { method: "POST", headers: h, body: JSON.stringify({ models: [qwen.key], domains: ["instruction-following"] }) });
      const events = parseSSE(await res.text());
      expect(events.map((e) => e.event)).toContain("model_done");
      const done = JSON.parse(events.find((e) => e.event === "done")!.data) as { id: string };
      const saved = readdirSync(path.join(root, ".decree", "lab", "runs"));
      expect(saved).toContain(`${done.id}.json`);
      expect(readdirSync(path.join(root, ".decree", "lab", "suites"))).toHaveLength(1);
      const run = JSON.parse(readFileSync(path.join(root, ".decree", "lab", "runs", `${done.id}.json`), "utf8")) as { models: { domains: { id: string }[] }[] };
      expect(run.models[0].domains.map((d) => d.id)).toEqual(["instruction-following"]);

      const bad = await fetch(`${server.url}api/run`, { method: "POST", headers: h, body: JSON.stringify({ models: ["nope"] }) });
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
