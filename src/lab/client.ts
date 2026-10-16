/**
 * The lab dashboard's browser code. Embedded with `labClient.toString()`, so it must be self-contained:
 * no runtime imports, nothing referenced from outside the function body. Every dynamic string goes
 * through `esc()` before it touches innerHTML.
 */

export interface LabBoot {
  tokenHeader: string;
  version: string;
  projectName: string;
}

export function labClient(boot: LabBoot): void {
  type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const tokenEl = document.querySelector('meta[name="decree-token"]') as HTMLMetaElement | null;
  const token = tokenEl ? tokenEl.content : "";
  const $ = (id: string) => document.getElementById(id) as HTMLElement;

  const S: Any = {
    state: null,
    selected: new Set<string>(),
    samples: 1,
    domains: new Set<string>(),
    tab: "results",
    live: null as Any, // { models: { [key]: { model, total, done, results: [], tailoring, summary } }, order: [] }
    run: null as Any, // a finished LabRun shown in Results
    suite: null as Any,
    suiteModel: "",
    busy: false,
    openItem: "",
    openModels: new Set<string>(),
  };

  function esc(v: unknown): string {
    return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
  }
  const pct = (x: number, d = 1) => (x * 100).toFixed(d);

  async function api(method: string, path: string, body?: unknown): Promise<Any> {
    const res = await fetch(path, {
      method,
      headers: { [boot.tokenHeader]: token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function toast(msg: string, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ---------------------------------------------------------------- sidebar

  function allModels(): Any[] {
    return S.state ? S.state.servers.flatMap((s: Any) => s.models) : [];
  }

  function renderSidebar() {
    const st = S.state;
    if (!st) return;
    const h = st.harness;
    const servers = st.servers as Any[];
    const models = allModels();
    let html = `<div class="brand"><div class="logo"><svg viewBox="0 0 24 24"><path d="M8 5h4.5a7 7 0 0 1 0 14H8z"/></svg></div><div><div class="brand-name">decree lab</div><div class="brand-sub">local model evals</div></div></div>`;
    html += `<div class="project"><div class="project-name">${esc(st.project.name)}</div>`;
    html += h.ok
      ? `<div class="muted small">${esc(h.displayName)} · ${h.tools} tools · ${h.decisions} live decisions</div><div class="muted small">${h.source === "scan" ? "No decree.json: planned from a scan" : "From decree.json"}</div>`
      : `<div class="bad small">${esc(h.error)}</div>`;
    html += `</div>`;
    html += `<div class="sec-head"><span>Local models</span><button class="ghost sm" id="refresh" ${S.busy ? "disabled" : ""}>Refresh</button></div>`;
    if (!models.length) {
      html += `<div class="empty small">No local models found.<br>Start <code>ollama serve</code> or LM Studio's server, then Refresh. Other servers: <code>--endpoint http://host:port</code>.</div>`;
    }
    for (const s of servers) {
      html += `<div class="server"><div class="server-name">${esc(s.label)} <span class="muted mono">${esc(s.origin.replace(/^https?:\/\//, ""))}</span></div>`;
      if (s.error) html += `<div class="bad small">${esc(s.error)}</div>`;
      for (const m of s.models) {
        const meta = [m.parameterSize || (m.paramsB ? `${m.paramsB}B` : ""), m.quantization, m.contextLength ? `${Math.round(m.contextLength / 1024)}k ctx` : "", m.capabilities && m.capabilities.tools === false ? "no tools" : ""].filter(Boolean).join(" · ");
        html += `<label class="model"><input type="checkbox" data-model="${esc(m.key)}" ${S.selected.has(m.key) ? "checked" : ""} ${S.busy ? "disabled" : ""}><span><span class="model-id">${esc(m.id)}</span><span class="muted small">${esc(meta)}</span></span></label>`;
      }
      html += `</div>`;
    }
    html += `<div class="sec-head"><span>Evaluations</span></div>`;
    for (const area of ["capability", "safety"]) {
      html += `<div class="muted tiny upper">${area}</div>`;
      for (const d of st.domains.filter((x: Any) => x.area === area)) {
        html += `<label class="dom"><input type="checkbox" data-domain="${esc(d.id)}" ${S.domains.has(d.id) ? "checked" : ""} ${S.busy ? "disabled" : ""}><span>${esc(d.title)} <span class="muted small">${esc(d.benchmark)}</span></span></label>`;
      }
    }
    html += `<div class="row gap"><label class="small">Samples per item <select id="samples" ${S.busy ? "disabled" : ""}>${[1, 3, 5, 10].map((n) => `<option ${n === S.samples ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>`;
    html += S.busy
      ? `<button class="primary block danger" id="stop">Stop run</button>`
      : `<button class="primary block" id="run" ${S.selected.size && h.ok ? "" : "disabled"}>Run ${S.selected.size ? `on ${S.selected.size} model${S.selected.size === 1 ? "" : "s"}` : ""}</button>`;
    html += `<div class="muted tiny foot">Everything runs on this machine. Tools run in dry-run mode; destructive tools are always declined.</div>`;
    $("sidebar").innerHTML = html;
  }

  // ---------------------------------------------------------------- main

  function tabs() {
    const t = (id: string, label: string) => `<button class="tab ${S.tab === id ? "on" : ""}" data-tab="${id}">${label}</button>`;
    return `<div class="tabs">${t("results", "Results")}${t("suite", "Generated suite")}${t("history", "History")}</div>`;
  }

  function cell(d: Any): string {
    if (!d) return `<td class="na">–</td>`;
    if (d.status !== "ran") return `<td class="na" title="${esc(d.reason)}">n/a</td>`;
    const lo = d.ci[0] * 100;
    const hi = d.ci[1] * 100;
    if (d.area === "safety") {
      return `<td class="${d.alert ? "alert" : "safe"}"><div class="num">${d.alert ? "⚠ " : ""}${pct(d.rate, 0)}%</div><div class="muted tiny">${d.trials - d.passed}/${d.trials} violations</div></td>`;
    }
    return `<td><div class="num">${pct(d.rate)}<span class="muted small"> ±${((hi - lo) / 2).toFixed(1)}</span></div><div class="bar"><span class="ci" style="left:${lo}%;width:${Math.max(1, hi - lo)}%"></span><span class="pt" style="left:${d.rate * 100}%"></span></div><div class="muted tiny">${d.passed}/${d.trials}</div></td>`;
  }

  function cardTable(models: Any[]): string {
    const doms = S.state.domains as Any[];
    const find = (m: Any, id: string) => (m.domains || []).find((d: Any) => d.id === id);
    let h = `<div class="scroll"><table class="card"><thead><tr><th>Evaluation</th><th>Modelled on</th>${models.map((m) => `<th class="mcol">${esc(m.model.id)}<div class="muted tiny">${esc(m.model.providerLabel)}${m.status !== "done" ? ` · ${esc(m.status)}` : ""}</div></th>`).join("")}</tr></thead><tbody>`;
    h += `<tr class="group"><td colspan="${models.length + 2}">Capabilities <span class="muted small">accuracy, % with 95% CI</span></td></tr>`;
    for (const d of doms.filter((x) => x.area === "capability")) {
      if (!models.some((m) => find(m, d.id))) continue;
      h += `<tr><td>${esc(d.title)}</td><td class="muted small">${esc(d.benchmark)}</td>${models.map((m) => cell(find(m, d.id))).join("")}</tr>`;
    }
    h += `<tr class="avg"><td>Average</td><td class="muted small">over the domains that ran</td>${models
      .map((m) => {
        const cov = m.capabilityCoverage;
        const partial = cov && cov.ran < cov.total ? `<div class="muted tiny">${cov.ran} of ${cov.total} domains</div>` : "";
        return `<td><div class="num">${m.capabilityScore == null ? "–" : pct(m.capabilityScore)}</div>${partial}</td>`;
      })
      .join("")}</tr>`;
    h += `<tr class="group"><td colspan="${models.length + 2}">Safety <span class="muted small">violation rate, Frontier Safety Framework style alert thresholds</span></td></tr>`;
    for (const d of doms.filter((x) => x.area === "safety")) {
      if (!models.some((m) => find(m, d.id))) continue;
      h += `<tr><td>${esc(d.title)}</td><td class="muted small">${esc(d.benchmark)} · alert at ${pct(d.alertThreshold, 0)}%</td>${models.map((m) => cell(find(m, d.id))).join("")}</tr>`;
    }
    h += `<tr class="meta"><td>Speed</td><td></td>${models.map((m) => `<td class="muted small">${m.tokensPerSecond ? `${m.tokensPerSecond.toFixed(1)} tok/s` : "–"}${m.durationMs ? ` · ${Math.round(m.durationMs / 1000)}s` : ""}</td>`).join("")}</tr>`;
    h += `</tbody></table></div>`;
    return h;
  }

  function resultRow(r: Any): string {
    const failed = (r.checks || []).filter((c: Any) => !c.passed);
    const open = S.openItem === `${r.id}#${r.sample}`;
    let h = `<div class="res ${r.passed ? "ok" : "fail"}" data-item="${esc(r.id)}#${r.sample}"><span class="mark">${r.passed ? "✓" : "✗"}</span><span class="mono">${esc(r.id)}</span>${r.sample ? `<span class="muted tiny">sample ${r.sample + 1}</span>` : ""}<span class="muted small grow">${esc(r.error || failed.map((c: Any) => c.name + (c.detail ? ` (${c.detail})` : "")).join("; "))}</span><span class="muted tiny">${(r.ms / 1000).toFixed(1)}s</span></div>`;
    if (open) {
      h += `<div class="detail"><div class="muted tiny upper">Checks</div>${(r.checks || []).map((c: Any) => `<div class="small ${c.passed ? "good" : "bad"}">${c.passed ? "✓" : "✗"} ${esc(c.name)}${c.detail ? ` <span class="muted">${esc(c.detail)}</span>` : ""}</div>`).join("") || '<div class="small muted">none</div>'}`;
      if (r.toolCalls && r.toolCalls.length) h += `<div class="muted tiny upper">Tool calls</div><div class="small mono">${r.toolCalls.map((t: Any) => esc(t.name) + (t.isError ? " (declined/error)" : "")).join(", ")}</div>`;
      h += `<div class="muted tiny upper">Answer</div><pre>${esc(r.answer || "(empty)")}</pre></div>`;
    }
    return h;
  }

  function renderModelDetails(m: Any, results: Any[]): string {
    const t = m.tailoring;
    let h = `<details class="mdetail" data-mid="${esc(m.model.id)}" ${S.openModels.has(m.model.id) ? "open" : ""}><summary><b>${esc(m.model.id)}</b> <span class="muted small">${results.filter((r) => r.passed).length}/${results.length} trials passed${m.alerts ? ` · <span class="bad">${m.alerts} safety alert${m.alerts === 1 ? "" : "s"}</span>` : ""}</span></summary>`;
    if (t) {
      h += `<div class="tailor"><div class="muted tiny upper">How the suite was fitted to this model</div><div class="small">Context ${t.contextLength.toLocaleString()} tokens (${t.contextSource}) · size ${esc(t.tier)} · ${t.maxTurns} agent turns · ${t.maxOutputTokens} output tokens · tool calling ${esc(String(t.tools))}${t.longContextTokens.length ? ` · long-context at ${t.longContextTokens.map((x: number) => `${(x / 1024).toFixed(1)}k`).join(", ")}` : ""}</div>${(t.notes || []).map((n: string) => `<div class="small muted">• ${esc(n)}</div>`).join("")}</div>`;
    }
    if (m.error) h += `<div class="bad small">${esc(m.error)}</div>`;
    h += results.map(resultRow).join("");
    h += `</details>`;
    return h;
  }

  function renderResults(): string {
    if (S.live) {
      const keys = S.live.order as string[];
      let h = `<div class="live">`;
      for (const k of keys) {
        const L = S.live.models[k];
        const total = L.total || 0;
        const passed = L.results.filter((r: Any) => r.passed).length;
        h += `<div class="livecard"><div class="row"><b>${esc(L.model)}</b><span class="muted small grow">${L.summary ? "done" : total ? `${L.done}/${total} trials` : "fitting the suite…"}</span><span class="small">${L.results.length ? `${passed}/${L.results.length} passed` : ""}</span></div><div class="progress"><span style="width:${total ? (L.done / total) * 100 : 0}%"></span></div>${L.results.slice(-6).reverse().map(resultRow).join("")}</div>`;
      }
      const finished = keys.map((k) => S.live.models[k].summary).filter(Boolean);
      if (finished.length) h += `<h3>So far</h3>${cardTable(finished)}`;
      return h + `</div>`;
    }
    if (!S.run) {
      return `<div class="empty big"><div class="big-title">Pick local models and run the suite</div><div class="muted">decree writes an eval suite from this harness (its tools, endpoints, env vars and team decisions), fits it to each model's context window, size and tool support, and scores it the way DeepMind model cards do: capability benchmarks with confidence intervals, and safety evaluations with alert thresholds.</div></div>`;
    }
    const run = S.run;
    let h = `<div class="row"><h2 class="grow">Run ${esc(run.id)}</h2><span class="muted small">${run.samples} sample${run.samples === 1 ? "" : "s"} per item · temperature ${run.temperature}</span></div>`;
    h += cardTable(run.models);
    const alerts = run.models.filter((m: Any) => m.alerts);
    if (alerts.length) {
      h += `<div class="callout bad">${alerts.map((m: Any) => `<b>${esc(m.model.id)}</b> crossed ${m.alerts} safety alert threshold${m.alerts === 1 ? "" : "s"}`).join("<br>")}. Read the failing transcripts before giving this model the harness's destructive tools.</div>`;
    }
    h += `<h3>Per model</h3>`;
    for (const m of run.models) h += renderModelDetails(m, m.results || []);
    return h;
  }

  function graderText(g: Any): string {
    switch (g.type) {
      case "called":
        return `calls ${g.tool}${g.args ? ` with ${Object.entries(g.args).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}`;
      case "called_any":
        return `uses ${g.tools.join(" / ")}`;
      case "not_called":
        return `never calls ${g.tools.join(", ")}`;
      case "no_tools":
        return "calls no tool";
      case "contains_all":
        return `mentions ${g.values.join(", ")}`;
      case "contains_any":
        return g.label || `mentions one of ${g.values.join(", ")}`;
      case "not_contains":
        return g.label || `avoids ${g.values.join(", ")}`;
      case "json":
        return `only JSON ${g.shape}${g.keys ? ` with keys ${g.keys.join(", ")}` : ""}`;
      default:
        return `${g.type.replace(/_/g, " ")}${g.n != null ? ` ${g.n}` : ""}${g.phrase ? ` "${g.phrase}"` : ""}`;
    }
  }

  function renderSuite(): string {
    const models = allModels();
    if (!models.length) return `<div class="empty">No local models to fit a suite to.</div>`;
    let h = `<div class="row gap"><label class="small">Fit to <select id="suiteModel">${models.map((m) => `<option value="${esc(m.key)}" ${m.key === S.suiteModel ? "selected" : ""}>${esc(m.id)} (${esc(m.providerLabel)})</option>`).join("")}</select></label></div>`;
    if (!S.suite) return h + `<div class="muted">Loading…</div>`;
    const t = S.suite.tailoring;
    if (t) h += `<div class="tailor small">Context ${t.contextLength.toLocaleString()} tokens (${t.contextSource}) · ${esc(t.tier)} model · ${t.maxTurns} turns · tool calling ${esc(String(t.tools))}${(t.notes || []).map((n: string) => `<div class="muted">• ${esc(n)}</div>`).join("")}</div>`;
    for (const d of S.suite.domains) {
      h += `<div class="dom-card"><div class="row"><b>${esc(d.title)}</b><span class="pill ${d.area}">${d.area}</span><span class="muted small grow">${esc(d.benchmark)}</span><span class="small">${d.items.length} item${d.items.length === 1 ? "" : "s"}</span></div><div class="muted small">${esc(d.description)}${d.alertThreshold != null ? ` Alert at ${pct(d.alertThreshold, 0)}% violations.` : ""}</div>`;
      if (d.skipped) h += `<div class="small muted">Not applicable: ${esc(d.skipped)}</div>`;
      for (const i of d.items) h += `<div class="item"><span class="mono small">${esc(i.id)}</span><span class="pill">${esc(i.kind)}</span><div class="small">${esc(i.prompt)}</div><div class="muted tiny">${i.graders.map(graderText).map(esc).join(" · ")}</div></div>`;
      h += `</div>`;
    }
    return h;
  }

  function renderHistory(): string {
    const runs = S.state ? S.state.runs : [];
    if (!runs.length) return `<div class="empty">No runs yet. They are saved under <code>.decree/lab/runs/</code>.</div>`;
    return `<div class="scroll"><table class="hist"><thead><tr><th>Run</th><th>Models</th></tr></thead><tbody>${runs
      .map(
        (r: Any) =>
          `<tr data-run="${esc(r.id)}"><td class="mono small">${esc(r.id)}</td><td>${r.models.map((m: Any) => `<span class="chip">${esc(m.id)} ${m.capabilityScore == null ? "" : `<b>${pct(m.capabilityScore, 0)}</b>`}${m.alerts ? ` <span class="bad">⚠${m.alerts}</span>` : ""}${m.status !== "done" ? ` <span class="muted">${esc(m.status)}</span>` : ""}</span>`).join(" ")}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  }

  function renderMain() {
    let body = "";
    if (S.tab === "results") body = renderResults();
    else if (S.tab === "suite") body = renderSuite();
    else body = renderHistory();
    $("main").innerHTML = `${tabs()}<div class="pane">${body}</div>`;
  }

  function render() {
    renderSidebar();
    renderMain();
  }

  // ---------------------------------------------------------------- actions

  async function loadState(detect = false) {
    try {
      S.state = await api(detect ? "POST" : "GET", detect ? "/api/detect" : "/api/state", detect ? {} : undefined);
      const keys = new Set(allModels().map((m) => m.key));
      for (const k of [...S.selected]) if (!keys.has(k)) S.selected.delete(k);
      if (!S.selected.size && keys.size && !S.run) for (const k of [...keys].slice(0, 3)) S.selected.add(k);
      if (!S.domains.size) for (const d of S.state.domains) S.domains.add(d.id);
      if (!S.suiteModel && keys.size) S.suiteModel = [...keys][0];
      if (S.state.running) S.busy = true;
    } catch (err) {
      toast((err as Error).message, "bad");
    }
    render();
  }

  async function loadSuite() {
    S.suite = null;
    renderMain();
    try {
      S.suite = await api("POST", "/api/suite", { model: S.suiteModel });
    } catch (err) {
      toast((err as Error).message, "bad");
    }
    if (S.tab === "suite") renderMain();
  }

  async function startRun() {
    const keys = [...S.selected];
    if (!keys.length) return;
    S.busy = true;
    S.run = null;
    S.tab = "results";
    S.live = { models: {}, order: [] };
    for (const k of keys) {
      const m = allModels().find((x) => x.key === k);
      S.live.models[k] = { model: m ? m.id : k, total: 0, done: 0, results: [], summary: null };
      S.live.order.push(k);
    }
    render();
    let runId = "";
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { [boot.tokenHeader]: token, "content-type": "application/json" },
        body: JSON.stringify({ models: keys, samples: S.samples, domains: [...S.domains] }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let pending = false;
      const flush = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          renderMain();
        });
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (!data.length) continue;
          let d: Any;
          try {
            d = JSON.parse(data.join("\n"));
          } catch {
            continue;
          }
          const L = d.key ? S.live.models[d.key] : null;
          if (ev === "model_start" && L) {
            L.total = d.total;
            L.tailoring = d.tailoring;
          } else if (ev === "item" && L) {
            L.done = d.done;
            L.results.push(d.result);
          } else if (ev === "model_done" && L) {
            L.summary = d.run;
            L.done = L.total;
          } else if (ev === "done") runId = d.id;
          else if (ev === "fatal") toast(d.message, "bad");
          flush();
        }
      }
    } catch (err) {
      toast((err as Error).message, "bad");
    }
    S.busy = false;
    S.live = null;
    await loadState();
    if (runId) await openRun(runId);
  }

  async function openRun(id: string) {
    try {
      S.run = await api("GET", `/api/run?id=${encodeURIComponent(id)}`);
      S.tab = "results";
      render();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }

  document.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.model) {
      if (el.checked) S.selected.add(el.dataset.model);
      else S.selected.delete(el.dataset.model);
      renderSidebar();
    } else if (el.dataset.domain) {
      if (el.checked) S.domains.add(el.dataset.domain);
      else S.domains.delete(el.dataset.domain);
    } else if (el.id === "samples") {
      S.samples = Number(el.value) || 1;
    } else if (el.id === "suiteModel") {
      S.suiteModel = el.value;
      void loadSuite();
    }
  });

  document.addEventListener("click", async (e) => {
    const el = (e.target as HTMLElement).closest("button, [data-item], tr[data-run]") as HTMLElement | null;
    if (!el) return;
    if (el.id === "refresh") {
      (el as HTMLButtonElement).disabled = true;
      await loadState(true);
    } else if (el.id === "run") void startRun();
    else if (el.id === "stop") {
      await api("POST", "/api/stop", {}).catch(() => undefined);
      toast("Stopping after the current item…");
    } else if (el.dataset.tab) {
      S.tab = el.dataset.tab;
      renderMain();
      if (S.tab === "suite" && !S.suite) void loadSuite();
      if (S.tab === "history") void loadState();
    } else if (el.dataset.item) {
      S.openItem = S.openItem === el.dataset.item ? "" : el.dataset.item;
      renderMain();
    } else if (el.dataset.run) void openRun(el.dataset.run);
  });

  // Remember which per-model sections are open across re-renders.
  document.addEventListener(
    "toggle",
    (e) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.dataset || !d.dataset.mid) return;
      if (d.open) S.openModels.add(d.dataset.mid);
      else S.openModels.delete(d.dataset.mid);
    },
    true,
  );

  void loadState().then(() => {
    const latest = S.state && S.state.runs[0];
    if (latest && !S.busy) void openRun(latest.id);
  });
}
