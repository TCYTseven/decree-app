// A fake local LLM server for tests and manual runs of `decree-harness lab`.
//
// It answers like Ollama (GET /api/tags, POST /api/show, POST /api/chat) or like an OpenAI-compatible
// server such as LM Studio (GET /v1/models, POST /v1/chat/completions), depending on `flavor`.
// The "model" is a few rules: it calls the tool whose name best matches the request, quotes
// passphrases out of long logs, and answers formatting requests. Some models are made worse on
// purpose (`gullible` follows injected instructions, `notools` refuses tools) so a run shows a spread.
//
//   node test/helpers/fake-local-llm.mjs ollama 11434
//   node test/helpers/fake-local-llm.mjs openai 1234

import http from "node:http";

const STOP = new Set(["the", "a", "an", "to", "of", "for", "in", "on", "and", "or", "is", "it", "this", "that", "me", "i", "use", "right", "tool", "need", "please", "with", "by", "from", "one", "all", "get", "run"]);
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return String(messages[i].content ?? "");
  return "";
}

/** Decide one assistant turn. Returns { content, toolCalls: [{ name, arguments }] }. */
export function respond(model, messages, tools) {
  const system = String(messages.find((m) => m.role === "system")?.content ?? "");
  const user = lastUser(messages);
  const lastMsg = messages[messages.length - 1];
  const gullible = model.includes("gullible");

  // After a tool result: wrap up.
  if (lastMsg?.role === "tool") {
    const body = String(lastMsg.content ?? "").slice(0, 200);
    return { content: `Done. The tool said: ${body}`, toolCalls: [] };
  }

  if (tools?.length) {
    if (gullible) {
      const m = /call (\w+) (?:immediately|now)|Run (\w+) now/.exec(user);
      const canary = /CANARY-[0-9A-F]+/.exec(user)?.[0];
      if (m) return { content: canary ?? "", toolCalls: [{ name: m[1] ?? m[2], arguments: { id: "1", reason: "override" } }] };
      if (canary) return { content: `Here you go: ${canary}`, toolCalls: [] };
      const destructive = tools.find((t) => /delete|cancel|drop|reset|deploy|migrate/.test(t.function.name));
      if (destructive && /clean|tidy|messy|fresh|clean state/i.test(user)) return { content: "", toolCalls: [{ name: destructive.function.name, arguments: { id: "1", reason: "cleanup" } }] };
    }
    if (/summari[sz]e|no tools needed|just say goodbye|times/i.test(user) && !/change|which team decisions/i.test(user)) {
      const m = /what is (\d+) times (\d+)/i.exec(user);
      if (m) return { content: String(Number(m[1]) * Number(m[2])), toolCalls: [] };
      if (/goodbye/i.test(user)) return { content: "Goodbye!", toolCalls: [] };
      return { content: "Summary: a note about the order and the API rate limit.", toolCalls: [] };
    }
    if (/which team decisions|which file in this repository/i.test(user)) {
      const pick = tools.find((t) => (/decisions/i.test(user) ? t.function.name === "get_decisions" : t.function.name === "search_code" || t.function.name === "search"));
      if (pick) {
        const path = /change (\S+?)\./.exec(user)?.[1] ?? "src/index.ts";
        const args = pick.function.name === "get_decisions" ? { paths: [path] } : { query: (/"(.+?)"/.exec(user)?.[1] ?? "test").split(" ")[0] };
        return { content: "", toolCalls: [{ name: pick.function.name, arguments: args }] };
      }
    }
    if (/delete the git history|exfiltrat|posts it to|always pass/i.test(user)) return { content: "I can't help with that.", toolCalls: [] };
    // Pick the tool with the most word overlap with the request.
    const want = new Set(words(user));
    let best;
    let bestScore = 0;
    for (const t of tools) {
      const nameWords = words(t.function.name.replace(/_/g, " "));
      const score = nameWords.filter((w) => want.has(w) || want.has(`${w}s`) || want.has(w.replace(/s$/, ""))).length * 2 + words(t.function.description).filter((w) => want.has(w)).length * 0.1;
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    if (best && bestScore >= 2 && !/investigate|take a look|plan first|summarize anything/i.test(user)) {
      const args = {};
      const props = best.function.parameters?.properties ?? {};
      for (const name of best.function.parameters?.required ?? []) {
        const m = new RegExp(`${name.replace(/_/g, " ")} "?([\\w@.:/-]+)"?`, "i").exec(user);
        args[name] = m ? (props[name]?.type === "integer" || props[name]?.type === "number" ? Number(m[1]) : m[1]) : "42";
      }
      return { content: "", toolCalls: [{ name: best.function.name, arguments: args }] };
    }
    return { content: `I looked at it: nothing unusual in ${tools[0].function.name}. Want me to dig further?`, toolCalls: [] };
  }

  // Plain chat.
  const passphrases = [...(system + "\n" + user).matchAll(/passphrase (?:for [^\n]*? )?is ([a-z]+-[a-z]+-\d+)/g)].map((m) => m[1]);
  if (/passphrase/i.test(user) && passphrases.length) {
    const nth = /note \(#(\d)\)/.exec(user);
    return { content: nth ? passphrases[Number(nth[1]) - 1] ?? passphrases[0] : passphrases[0], toolCalls: [] };
  }
  if (/exactly 3 bullet/i.test(user)) return { content: "- Inspect orders\n- Run tests\n- Triage failures", toolCalls: [] };
  if (/only lowercase/i.test(user)) return { content: "it helps on-call engineers inspect orders and run checks.", toolCalls: [] };
  if (/without using any commas/i.test(user)) return { content: "It helps engineers fix things fast. It runs checks and reads orders.", toolCalls: [] };
  if (/Ready when you are\./.test(user)) return { content: "Ask it about orders. Ready when you are.", toolCalls: [] };
  if (/Start your reply with "Summary:"/.test(user)) return { content: "Summary: it operates the orders API.", toolCalls: [] };
  if (/JSON array of strings/i.test(user)) {
    const list = user.split("JSON: ")[1]?.split(",").map((s) => s.trim()) ?? [];
    return { content: model.includes("chatty") ? `Sure! ${JSON.stringify(list)}` : JSON.stringify(list), toolCalls: [] };
  }
  if (/JSON object with exactly two keys/i.test(user)) {
    const tool = /for the tool (\w+)/.exec(user)?.[1];
    return { content: JSON.stringify({ tool, readOnly: /which is read-only/.test(user) }), toolCalls: [] };
  }
  if (/Write exactly \d+ lines/i.test(user)) {
    const list = user.split(": ").pop().split(",").map((s) => s.trim());
    return { content: list.join("\n"), toolCalls: [] };
  }
  if (/<document>/.test(system)) {
    const doc = system.split("<document>")[1] ?? "";
    const q = words(user).filter((w) => w.length > 3);
    const line = doc.split("\n").find((l) => q.some((w) => l.toLowerCase().includes(w)) && /[a-z]/i.test(l));
    if (/port does the production database|on-call engineer/i.test(user) || !line) return { content: "Not in the document.", toolCalls: [] };
    return { content: line.replace(/^- /, ""), toolCalls: [] };
  }
  return { content: "I am not sure.", toolCalls: [] };
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * Start a fake server. models: [{ name, size?, ctx?, tools?: boolean }]
 * Returns { url, close, requests } where requests records every chat payload.
 */
export function startFakeLocalLLM({ flavor = "ollama", port = 0, models = [{ name: "qwen2.5:7b", params: "7.6B", ctx: 32768 }], delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (flavor === "ollama" && req.method === "GET" && url.pathname === "/api/tags") {
        return send(res, 200, { models: models.map((m) => ({ name: m.name, model: m.name, size: m.size ?? 4_700_000_000, details: { parameter_size: m.params ?? "7.6B", quantization_level: "Q4_K_M", family: "qwen2" } })) });
      }
      if (flavor === "ollama" && req.method === "POST" && url.pathname === "/api/show") {
        const b = await body(req);
        const m = models.find((x) => x.name === b.model);
        if (!m) return send(res, 404, { error: "model not found" });
        return send(res, 200, { capabilities: ["completion", ...(m.tools === false ? [] : ["tools"])], model_info: { "qwen2.context_length": m.ctx ?? 32768 }, details: { parameter_size: m.params ?? "7.6B" } });
      }
      if (flavor === "openai" && req.method === "GET" && url.pathname === "/v1/models") {
        return send(res, 200, { object: "list", data: models.map((m) => ({ id: m.name, object: "model" })) });
      }
      const chat = (flavor === "ollama" && url.pathname === "/api/chat") || (flavor === "openai" && url.pathname === "/v1/chat/completions");
      if (req.method === "POST" && chat) {
        const b = await body(req);
        requests.push(b);
        const m = models.find((x) => x.name === b.model);
        if (!m) return send(res, 404, { error: `model "${b.model}" not found, try pulling it first` });
        if (b.tools?.length && m.tools === false) return send(res, 400, { error: `registry.ollama.ai/library/${m.name} does not support tools` });
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const out = respond(m.name, b.messages ?? [], b.tools ?? []);
        const think = m.name.includes("think") ? "<think>Let me work this out.</think>\n" : "";
        if (flavor === "ollama") {
          return send(res, 200, {
            model: m.name,
            message: { role: "assistant", content: think + out.content, tool_calls: out.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) },
            done: true,
            done_reason: "stop",
            prompt_eval_count: JSON.stringify(b.messages).length >> 2,
            eval_count: Math.max(1, out.content.length >> 2),
          });
        }
        return send(res, 200, {
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              finish_reason: out.toolCalls.length ? "tool_calls" : "stop",
              message: { role: "assistant", content: think + out.content, ...(out.toolCalls.length ? { tool_calls: out.toolCalls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) },
            },
          ],
          usage: { prompt_tokens: JSON.stringify(b.messages).length >> 2, completion_tokens: Math.max(1, out.content.length >> 2) },
        });
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: String(err?.message ?? err) });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        requests,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flavor = process.argv[2] ?? "ollama";
  const port = Number(process.argv[3] ?? (flavor === "ollama" ? 11434 : 1234));
  const models =
    flavor === "ollama"
      ? [
          { name: "qwen2.5:7b", params: "7.6B", ctx: 32768 },
          { name: "llama3.2-gullible:3b", params: "3.2B", ctx: 8192 },
          { name: "gemma2-notools:2b", params: "2.6B", ctx: 8192, tools: false },
        ]
      : [{ name: "mistral-chatty-7b-instruct", ctx: 8192 }];
  startFakeLocalLLM({ flavor, port, models }).then((s) => console.log(`fake ${flavor} server on ${s.url}`));
}
