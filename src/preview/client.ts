/**
 * The preview dashboard's browser code.
 *
 * `clientMain` is embedded in the page with `clientMain.toString()`, so it must be fully self-contained:
 * no imports at runtime and no references to anything outside the function body (type-only imports are
 * fine; they are erased). Everything dynamic is escaped with `esc()` before it touches innerHTML, and
 * markdown goes through the renderer in ./markdown.ts, which escapes first.
 */
import type { EvalResult, HarnessSpec, LLMUsage, ToolSpec } from "../core/types.js";

export interface ClientBoot {
  tokenHeader: string;
  version: string;
  projectName: string;
}

interface StateOk {
  ok: true;
  version: string;
  project: { root: string; name: string; specFile: string; outDir: string };
  apiKey: { available: boolean; source: string | null };
  baseUrlOverride: boolean;
  spec: HarnessSpec;
  warnings: string[];
  hash: string;
  env: Record<string, boolean>;
}
interface StateErr {
  ok: false;
  version: string;
  project: { root: string; name: string; specFile: string; outDir: string };
  apiKey: { available: boolean; source: string | null };
  kind: "missing" | "parse" | "invalid";
  errors: string[];
  hash: string | null;
}
type State = StateOk | StateErr;

interface FileEntry {
  path: string;
  size: number;
  lines: number;
  status: string;
}

type ChatItem =
  | { k: "user"; id: number; text: string }
  | { k: "ai"; id: number; text: string; live: boolean }
  | { k: "think"; id: number; text: string }
  | {
      k: "tool";
      id: number;
      toolId: string;
      name: string;
      input: unknown;
      output?: string;
      isError?: boolean;
      ms?: number;
      status: "running" | "ok" | "error" | "denied" | "approval";
      approvalId?: string;
      busy?: boolean;
    }
  | { k: "note"; id: number; tone: "amber" | "red" | "info"; text: string; hint?: string }
  | { k: "stats"; id: number; turns: number; tools: number; usage: LLMUsage; cost: number; stopped?: boolean };

export function clientMain(boot: ClientBoot, md: (src: string) => string): void {
  const tokenMeta = document.querySelector('meta[name="decree-token"]') as HTMLMetaElement | null;
  const TOKEN = tokenMeta ? tokenMeta.content : "";
  const SECTIONS = ["overview", "tools", "prompt", "subagents", "evals", "files", "playground"] as const;
  type Section = (typeof SECTIONS)[number];

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  const esc = (v: unknown): string =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  /** Escape, then render `code` spans (tool descriptions often use backticks). */
  const ic = (v: unknown): string => esc(v).replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const shortPath = (p: string): string => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
  };
  const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector(sel) as T | null;

  const ICONS: Record<string, string> = {
    logo: '<path d="M7 5h5.5a7 7 0 0 1 0 14H7z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    check2: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    search: '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/>',
    play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
    pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    shieldAlert: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17v4M17 19h4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    brain: '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2z"/>',
    dollar: '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  };
  const icon = (name: string, cls = ""): string =>
    `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] ?? ""}</svg>`;

  const plural = (n: number, w: string, p = w + "s") => `${n} ${n === 1 ? w : p}`;
  const fmtUsd = (n: number) => (!isFinite(n) || n <= 0 ? "$0.00" : n < 0.01 ? "$" + n.toFixed(4) : n < 1 ? "$" + n.toFixed(3) : "$" + n.toFixed(2));
  const fmtTok = (n: number) => (n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k" : (n / 1e6).toFixed(2) + "M");
  const fmtBytes = (n: number) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const fmtMs = (ms: number) => (ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s");
  const relTime = (iso?: string) => {
    if (!iso) return "unknown";
    const t = Date.parse(iso);
    if (!isFinite(t)) return iso;
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return plural(Math.round(s / 60), "minute") + " ago";
    if (s < 86400) return plural(Math.round(s / 3600), "hour") + " ago";
    return plural(Math.round(s / 86400), "day") + " ago";
  };
  const uid = () => (crypto && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  const totalTokens = (u?: LLMUsage) => (u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0);

  const jsonHtml = (v: unknown): string => {
    const text = JSON.stringify(v, null, 2) ?? "undefined";
    return esc(text).replace(
      /(&quot;(?:[^&\\]|\\.|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, str: string | undefined, colon: string | undefined, lit: string | undefined, num: string | undefined) => {
        if (str) return colon ? `<span class="j-k">${str}</span><span class="j-p">${colon}</span>` : `<span class="j-s">${str}</span>`;
        if (lit) return `<span class="j-b">${lit}</span>`;
        if (num) return `<span class="j-n">${num}</span>`;
        return m;
      },
    );
  };

  type Safety = { cls: "g" | "b" | "a" | "r"; label: string; icon: string; pill: string };
  const safety = (t: ToolSpec): Safety => {
    if (t.destructive) return { cls: "r", label: "destructive", icon: "trash", pill: "red" };
    if (t.requiresApproval) return { cls: "a", label: "needs approval", icon: "shieldAlert", pill: "amber" };
    if (t.readOnly) return { cls: "g", label: "read-only", icon: "eye", pill: "green" };
    return { cls: "b", label: "writes", icon: "pencil", pill: "blue" };
  };
  const needsApproval = (t: ToolSpec, mode: string) =>
    mode === "never" ? false : mode === "always" ? !t.readOnly || t.requiresApproval : t.requiresApproval || t.destructive;
  const badges = (t: ToolSpec, mode: string): string => {
    const out: string[] = [];
    if (t.readOnly) out.push(`<span class="pill green">${icon("eye")}read-only</span>`);
    else out.push(`<span class="pill blue">${icon("pencil")}writes</span>`);
    if (needsApproval(t, mode) || t.requiresApproval) out.push(`<span class="pill amber">${icon("shieldAlert")}needs approval</span>`);
    if (t.destructive) out.push(`<span class="pill red">${icon("trash")}destructive</span>`);
    return out.join("");
  };
  const kindIcon = (k: string) =>
    k === "http" ? "globe" : k === "shell" ? "terminal" : k === "memory" ? "brain" : k === "web_search" || k === "web_fetch" ? "globe" : k.includes("file") || k === "search" ? "file" : "wrench";
  const bindingText = (t: ToolSpec): string => {
    if (t.kind === "http" && t.http) return `${t.http.method} ${t.http.path}`;
    if (t.kind === "shell" && t.shell) return t.shell.command;
    if (t.fs) return `${t.kind} ${t.fs.root}`;
    return t.kind;
  };

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  class ApiError extends Error {
    status: number;
    data: Record<string, unknown>;
    constructor(status: number, data: Record<string, unknown>) {
      super(String(data.error ?? (Array.isArray(data.errors) ? data.errors[0] : "") ?? `HTTP ${status}`));
      this.status = status;
      this.data = data;
    }
  }
  const headers = (json: boolean): Record<string, string> => {
    const h: Record<string, string> = { [boot.tokenHeader]: TOKEN };
    if (json) h["content-type"] = "application/json";
    return h;
  };
  async function api<T = Record<string, unknown>>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: headers(opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      /* empty */
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }
  /** POST (or GET) an SSE endpoint via fetch so the token travels in a header, never in the URL. */
  async function sse(path: string, body: unknown | undefined, onEvent: (ev: string, data: any) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      let data: Record<string, unknown> = {};
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        /* empty */
      }
      throw new ApiError(res.status, data);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const c = line.indexOf(":");
          const f = c === -1 ? line : line.slice(0, c);
          const v = c === -1 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (f === "event") ev = v;
          else if (f === "data") data.push(v);
        }
        if (!data.length) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.join("\n"));
        } catch {
          parsed = data.join("\n");
        }
        onEvent(ev, parsed);
      }
    }
  }

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------
  const S = {
    data: null as State | null,
    loadError: "" as string,
    section: "overview" as Section,
    param: "",
    live: "connecting" as "live" | "connecting" | "off",
    toolQuery: "",
    toolFilter: "all" as "all" | "ro" | "writes" | "approval" | "destructive",
    editing: false,
    draft: "",
    draftBaseHash: "",
    promptErrors: [] as string[],
    promptConflict: false,
    promptStale: false,
    saving: false,
    files: null as null | { hash: string; outDir: string; targets: string[]; files: FileEntry[]; summary: Record<string, number> },
    filesLoading: false,
    filesError: "",
    fileContent: null as null | { path: string; content: string },
    generating: false,
    evals: { results: {} as Record<string, EvalResult>, running: {} as Record<string, boolean>, active: false, summary: null as null | Record<string, number>, error: "" },
    chat: {
      conversationId: uid(),
      items: [] as ChatItem[],
      running: false,
      runId: "",
      dryRun: true,
      abort: null as AbortController | null,
      totals: { cost: 0, tokens: 0, replies: 0 },
      draft: "",
    },
    focusAfter: "" as string,
  };
  let itemSeq = 0;

  const view = document.getElementById("view") as HTMLElement;
  const sidebar = document.getElementById("sidebar") as HTMLElement;
  const spec = (): HarnessSpec | null => (S.data && S.data.ok ? S.data.spec : null);

  // -------------------------------------------------------------------------
  // theme
  // -------------------------------------------------------------------------
  const THEMES = ["system", "light", "dark"] as const;
  let theme: (typeof THEMES)[number] = "system";
  try {
    const t = localStorage.getItem("decree-preview-theme");
    if (t === "light" || t === "dark") theme = t;
  } catch {
    /* storage unavailable */
  }
  const applyTheme = () => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  };
  applyTheme();

  // -------------------------------------------------------------------------
  // toasts
  // -------------------------------------------------------------------------
  function toast(kind: "ok" | "err" | "info", title: string, desc = "", ms = 4200): void {
    const host = document.getElementById("toasts");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = `${icon(kind === "ok" ? "check" : kind === "err" ? "alert" : "info")}<div><div class="tt">${esc(title)}</div>${desc ? `<div class="td">${esc(desc)}</div>` : ""}</div>`;
    host.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // -------------------------------------------------------------------------
  // routing
  // -------------------------------------------------------------------------
  function parseRoute(): void {
    const h = location.hash.replace(/^#\/?/, "");
    const [sec, ...rest] = h.split("/");
    S.section = (SECTIONS as readonly string[]).includes(sec) ? (sec as Section) : "overview";
    try {
      S.param = decodeURIComponent(rest.join("/"));
    } catch {
      S.param = "";
    }
  }
  const go = (hash: string) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  // -------------------------------------------------------------------------
  // sidebar
  // -------------------------------------------------------------------------
  function renderSidebar(): void {
    const sp = spec();
    const counts: Partial<Record<Section, string>> = sp
      ? { tools: String(sp.tools.length), subagents: String(sp.subagents.length), evals: String(sp.evals.length), files: S.files ? String(S.files.files.length) : "" }
      : {};
    const items: [Section, string, string][] = [
      ["overview", "Overview", "grid"],
      ["tools", "Tools", "wrench"],
      ["prompt", "System prompt", "doc"],
      ["subagents", "Subagents", "users"],
      ["evals", "Evals", "check2"],
      ["files", "Files", "folder"],
      ["playground", "Playground", "chat"],
    ];
    const liveCls = S.live === "live" ? "live" : S.live === "connecting" ? "warn" : "off";
    const liveText = S.live === "live" ? "Watching decree.json" : S.live === "connecting" ? "Connecting…" : "Disconnected: is preview still running?";
    const keyOk = S.data?.apiKey.available;
    const themeIcon = theme === "light" ? "sun" : theme === "dark" ? "moon" : "monitor";
    sidebar.innerHTML = `
      <div class="brand">
        <div class="logo" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS.logo}</svg></div>
        <div class="brand-text"><div class="brand-name">decree</div><div class="brand-sub">harness preview</div></div>
      </div>
      <div class="project" title="${esc(S.data?.project.root ?? "")}">
        <div class="project-name">${esc(sp?.displayName ?? S.data?.project.name ?? boot.projectName)}</div>
        <div class="project-path">${esc(shortPath(S.data?.project.root ?? ""))}</div>
      </div>
      <nav class="nav" aria-label="Sections">
        <div class="nav-label">Harness</div>
        ${items
          .map(
            ([id, label, ic]) =>
              `<a href="#/${id}" ${S.section === id ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span>${counts[id] ? `<span class="count">${counts[id]}</span>` : ""}</a>`,
          )
          .join("")}
      </nav>
      <div class="side-foot">
        <div class="status-row" title="${esc(liveText)}"><span class="dot ${liveCls}" aria-hidden="true"></span><span class="status-text">${esc(liveText)}</span><span class="sr-only">${esc(liveText)}</span></div>
        <div class="status-row status-text" title="Anthropic API key"><span class="dot ${keyOk ? "live" : "warn"}" style="animation:none" aria-hidden="true"></span>${keyOk ? `API key from ${esc(S.data?.apiKey.source ?? "env")}` : "No API key: playground off"}</div>
        <div class="row">
          <button class="theme-btn" type="button" data-act="theme" aria-label="Theme: ${theme}. Click to change.">${icon(themeIcon)}<span class="theme-label">${theme === "system" ? "System" : theme === "light" ? "Light" : "Dark"}</span></button>
          <span class="ver">v${esc(boot.version)}</span>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // shared bits
  // -------------------------------------------------------------------------
  const pageHead = (eyebrow: string, title: string, sub: string, actions = "") =>
    `<header class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1 tabindex="-1" id="page-title">${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${actions ? `<div class="actions">${actions}</div>` : ""}</header>`;
  const empty = (ic: string, title: string, body: string, extra = "") =>
    `<div class="empty"><div class="ico">${icon(ic, "lg")}</div><h3>${title}</h3><p>${body}</p>${extra}</div>`;

  function errorView(st: StateErr): string {
    const title = st.kind === "missing" ? "No decree.json yet" : st.kind === "parse" ? "decree.json is not valid JSON" : "decree.json has problems";
    const body =
      st.kind === "missing"
        ? `Run <code>npx decree-harness init</code> in <code>${esc(st.project.root)}</code> to create a harness. This page updates as soon as the file appears.`
        : "Fix the file in your editor. This page reloads automatically when you save.";
    return `<div class="page">${pageHead(`${icon("alert", "sm")} ${esc(st.project.specFile)}`, title, "")}
      <div class="callout red" role="alert">${icon("alert")}<div><div>${body}</div>${st.kind !== "missing" ? `<ul>${st.errors.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>` : ""}</div></div></div>`;
  }

  // -------------------------------------------------------------------------
  // overview
  // -------------------------------------------------------------------------
  function overview(sp: HarnessSpec, st: StateOk): string {
    const mode = sp.guardrails.approvalMode;
    const cats = { g: 0, b: 0, a: 0, r: 0 };
    for (const t of sp.tools) cats[safety(t).cls]++;
    const n = sp.tools.length || 1;
    const gated = sp.tools.filter((t) => needsApproval(t, mode)).length;
    const ro = sp.tools.filter((t) => t.readOnly).length;
    const envRows = sp.env
      .map((e) => {
        const set = st.env[e.name];
        return `<tr><td><code>${esc(e.name)}</code>${e.secret ? ` <span class="pill" title="Secret: redacted from tool output">${icon("key")}secret</span>` : ""}</td>
          <td class="muted">${esc(e.description || "")}${e.default ? ` <span class="dim">(default <code>${esc(e.default)}</code>)</span>` : ""}</td>
          <td>${e.required ? '<span class="pill amber">required</span>' : '<span class="pill">optional</span>'}</td>
          <td>${set ? `<span class="env-ok">${icon("check", "sm")}set</span>` : `<span class="env-miss">${icon("alert", "sm")}not set</span>`}</td></tr>`;
      })
      .join("");
    const ctx = sp.context;
    const onoff = (on: boolean, label: string) => `<span class="pill ${on ? "green" : ""}">${icon(on ? "check" : "x")}${label}</span>`;
    const prov = sp.provenance;
    const warnings = st.warnings;
    return `<div class="page">
      <section class="hero" aria-labelledby="page-title">
        <div>
          <div class="eyebrow">${icon("box", "sm")} Harness overview</div>
          <h1 id="page-title" tabindex="-1">${esc(sp.displayName)} <span class="pill mono">${esc(sp.name)}</span></h1>
          <p>${esc(sp.description)}</p>
        </div>
        <div class="actions">
          <span class="pill ${prov.generator === "llm" ? "violet" : ""}">${icon(prov.generator === "llm" ? "spark" : "cpu")}${prov.generator === "llm" ? "Designed by Claude" : "Heuristic plan"}</span>
          <a class="btn accent" href="#/playground">${icon("chat")}Try it</a>
        </div>
      </section>
      ${sp.goal ? `<div class="goal"><div class="gi">${icon("target")}</div><div><div class="gl">Goal</div><div class="gt">${esc(sp.goal)}</div></div></div>` : ""}
      ${
        warnings.length
          ? `<div class="callout amber" style="margin-bottom:18px" role="note">${icon("alert")}<div><strong>${plural(warnings.length, "validation warning")}</strong><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div></div>`
          : ""
      }
      <div class="stats">
        <a class="card stat" href="#/tools"><div class="sl">${icon("wrench")}Tools</div><div class="sv">${sp.tools.length}</div><div class="ss">${ro} read-only · ${gated} gated</div></a>
        <a class="card stat" href="#/subagents"><div class="sl">${icon("users")}Subagents</div><div class="sv">${sp.subagents.length}</div><div class="ss">${esc(sp.model.subagentId)}</div></a>
        <a class="card stat" href="#/evals"><div class="sl">${icon("check2")}Evals</div><div class="sv">${sp.evals.length}</div><div class="ss">${sp.evals.filter((e) => e.expect.rubric).length} with rubric</div></a>
        <a class="card stat" href="#/files"><div class="sl">${icon("layers")}Targets</div><div class="sv">${sp.targets.length}</div><div class="ss">${esc(sp.targets.join(", ") || "none")}</div></a>
      </div>
      <div class="grid2">
        <section class="card" aria-labelledby="h-model">
          <div class="card-head"><h2 id="h-model">${icon("cpu")}Model</h2></div>
          <div class="card-body"><dl class="kv">
            <dt>Agent model</dt><dd><code>${esc(sp.model.id)}</code></dd>
            <dt>Effort</dt><dd>${esc(sp.model.effort)}</dd>
            <dt>Thinking</dt><dd>${sp.model.thinking === "adaptive" ? "Adaptive" : "Off"}</dd>
            <dt>Subagent model</dt><dd><code>${esc(sp.model.subagentId)}</code></dd>
            <dt>Context</dt><dd><div class="chips">${onoff(ctx.caching, "caching")}${onoff(ctx.compaction, "compaction")}${onoff(ctx.contextEditing, "context editing")}${onoff(ctx.memory, "memory")}</div></dd>
          </dl></div>
        </section>
        <section class="card" aria-labelledby="h-guard">
          <div class="card-head"><h2 id="h-guard">${icon("shield")}Guardrails</h2><span class="pill ${mode === "never" ? "red" : mode === "always" ? "green" : "amber"}">approval: ${esc(mode)}</span></div>
          <div class="card-body"><dl class="kv">
            <dt>Max turns</dt><dd>${sp.guardrails.maxTurns}</dd>
            <dt>Max cost</dt><dd>${sp.guardrails.maxCostUsd !== undefined ? "$" + sp.guardrails.maxCostUsd.toFixed(2) + " per run" : '<span class="dim">no cap</span>'}</dd>
            <dt>Output / turn</dt><dd>${fmtTok(sp.guardrails.maxOutputTokensPerTurn)} tokens</dd>
            <dt>Allowed paths</dt><dd><div class="chips">${sp.guardrails.allowedPaths.map((p) => `<span class="pill mono">${esc(p)}</span>`).join("")}</div></dd>
            <dt>Blocked commands</dt><dd><details class="raw"><summary>${plural(sp.guardrails.blockedCommands.length, "pattern")}</summary><div class="chips" style="margin-top:6px">${sp.guardrails.blockedCommands.map((p) => `<span class="pill mono">${esc(p)}</span>`).join("")}</div></details></dd>
            <dt>Redacted env</dt><dd>${sp.guardrails.redactEnv.length ? `<div class="chips">${sp.guardrails.redactEnv.map((p) => `<span class="pill mono">${esc(p)}</span>`).join("")}</div>` : '<span class="dim">none</span>'}</dd>
          </dl></div>
        </section>
      </div>
      <section class="card" style="margin-bottom:14px" aria-labelledby="h-safety">
        <div class="card-head"><h2 id="h-safety">${icon("shieldAlert")}Tool safety</h2><a class="btn sm ghost" href="#/tools">All tools ${icon("chevR", "sm")}</a></div>
        <div class="card-body">
          <div class="bar" role="img" aria-label="${cats.g} read-only, ${cats.b} writes, ${cats.a} need approval, ${cats.r} destructive">
            ${cats.g ? `<span class="g" style="width:${(cats.g / n) * 100}%"></span>` : ""}${cats.b ? `<span class="b" style="width:${(cats.b / n) * 100}%"></span>` : ""}${cats.a ? `<span class="a" style="width:${(cats.a / n) * 100}%"></span>` : ""}${cats.r ? `<span class="r" style="width:${(cats.r / n) * 100}%"></span>` : ""}
          </div>
          <div class="legend"><span><i style="background:#22c55e"></i>Read-only <b>${cats.g}</b></span><span><i style="background:#3b82f6"></i>Writes <b>${cats.b}</b></span><span><i style="background:#f59e0b"></i>Needs approval <b>${cats.a}</b></span><span><i style="background:#ef4444"></i>Destructive <b>${cats.r}</b></span></div>
        </div>
      </section>
      ${
        sp.env.length
          ? `<section class="card" style="margin-bottom:14px" aria-labelledby="h-env"><div class="card-head"><h2 id="h-env">${icon("key")}Environment</h2><span class="dim" style="font-size:12.5px">${sp.env.filter((e) => st.env[e.name]).length}/${sp.env.length} set</span></div>
          <div class="table-wrap"><table class="t"><thead><tr><th scope="col">Variable</th><th scope="col">Purpose</th><th scope="col">Required</th><th scope="col">Status</th></tr></thead><tbody>${envRows}</tbody></table></div></section>`
          : ""
      }
      <section class="card" aria-labelledby="h-prov">
        <div class="card-head"><h2 id="h-prov">${icon("clock")}Provenance</h2></div>
        <div class="card-body">
          <dl class="kv">
            <dt>Planner</dt><dd>${prov.generator === "llm" ? "Claude (architect + critic)" : "Offline heuristics"}</dd>
            <dt>decree</dt><dd>v${esc(prov.decreeVersion)}</dd>
            <dt>Created</dt><dd>${esc(relTime(prov.createdAt))}${prov.createdAt ? ` <span class="dim">· ${esc(new Date(prov.createdAt).toLocaleString())}</span>` : ""}</dd>
            <dt>Project</dt><dd>${esc(prov.profileName || st.project.name)}</dd>
            <dt>Spec file</dt><dd><code>${esc(st.project.root)}/${esc(st.project.specFile)}</code></dd>
          </dl>
          ${prov.notes && prov.notes.length ? `<div class="sec-title" style="margin-top:16px">Design notes</div><ul class="notes">${prov.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        </div>
      </section>
      ${!warnings.length ? `<p class="dim" style="margin-top:14px;font-size:12.5px;display:flex;gap:6px;align-items:center">${icon("check", "sm")}decree.json is valid.</p>` : ""}
    </div>`;
  }

  // -------------------------------------------------------------------------
  // tools
  // -------------------------------------------------------------------------
  const filterTools = (sp: HarnessSpec) => {
    const q = S.toolQuery.trim().toLowerCase();
    const mode = sp.guardrails.approvalMode;
    return sp.tools.filter((t) => {
      if (S.toolFilter === "ro" && !t.readOnly) return false;
      if (S.toolFilter === "writes" && t.readOnly) return false;
      if (S.toolFilter === "approval" && !needsApproval(t, mode)) return false;
      if (S.toolFilter === "destructive" && !t.destructive) return false;
      if (!q) return true;
      return [t.name, t.kind, t.description, t.source ?? "", bindingText(t)].some((s) => s.toLowerCase().includes(q));
    });
  };

  function toolListHtml(sp: HarnessSpec, selected: string): string {
    const list = filterTools(sp);
    if (!list.length) return `<div class="empty" style="padding:32px 12px">${icon("search", "lg")}<h3>No matching tools</h3><p>Try a different search or filter.</p></div>`;
    return `<ul role="list" style="list-style:none;margin:0;padding:0">${list
      .map((t) => {
        const s = safety(t);
        return `<li><button type="button" class="row-btn" data-act="tool" data-name="${esc(t.name)}" aria-current="${t.name === selected}" aria-label="${esc(t.name)}, ${esc(t.kind)}, ${s.label}">
          <span class="row-top"><span class="row-name">${esc(t.name)}</span><span class="kind">${esc(t.kind)}</span><span class="sdot ${s.cls}" title="${s.label}"></span></span>
          <span class="row-desc">${ic(t.description)}</span></button></li>`;
      })
      .join("")}</ul>`;
  }

  function schemaRows(t: ToolSpec): string {
    const props = (t.inputSchema && (t.inputSchema.properties as Record<string, Record<string, unknown>> | undefined)) || {};
    const req = new Set((t.inputSchema?.required as string[] | undefined) ?? []);
    const names = Object.keys(props);
    if (!names.length) return `<p class="dim" style="margin:0">${["web_search", "web_fetch", "memory"].includes(t.kind) ? "Server-defined input (Anthropic tool type)." : "No parameters."}</p>`;
    const typeOf = (p: Record<string, unknown>): string => {
      const ty = p.type;
      if (Array.isArray(ty)) return ty.join(" | ");
      if (ty === "array" && p.items && typeof p.items === "object") return typeOf(p.items as Record<string, unknown>) + "[]";
      if (typeof ty === "string") return ty + (p.format ? ` (${String(p.format)})` : "");
      if (Array.isArray(p.anyOf)) return (p.anyOf as Record<string, unknown>[]).map(typeOf).join(" | ");
      return "any";
    };
    return `<table class="params">${names
      .map((k) => {
        const p = props[k] ?? {};
        const en = Array.isArray(p.enum) ? `<div class="penum">${(p.enum as unknown[]).map((v) => `<span class="pill mono">${esc(JSON.stringify(v))}</span>`).join("")}</div>` : "";
        const def = p.default !== undefined ? ` <span class="dim">Default <code>${esc(JSON.stringify(p.default))}</code>.</span>` : "";
        return `<tr><td><span class="pname">${esc(k)}</span>${req.has(k) ? '<span class="req">required</span>' : ""}<div class="ptype">${esc(typeOf(p))}</div></td>
          <td class="muted">${ic(p.description ?? "")}${def}${en}</td></tr>`;
      })
      .join("")}</table>`;
  }

  function bindingHtml(t: ToolSpec): string {
    if (t.kind === "http" && t.http) {
      const h = t.http;
      const extra: string[] = [];
      extra.push(`<dt>Base URL</dt><dd><code>$${esc(h.baseUrlEnv)}</code>${h.defaultBaseUrl ? ` <span class="dim">defaults to</span> <code>${esc(h.defaultBaseUrl)}</code>` : ""}</dd>`);
      if (h.queryParams?.length) extra.push(`<dt>Query</dt><dd><div class="chips">${h.queryParams.map((p) => `<span class="pill mono">${esc(p)}</span>`).join("")}</div></dd>`);
      if (h.headerParams?.length) extra.push(`<dt>Headers</dt><dd><div class="chips">${h.headerParams.map((p) => `<span class="pill mono">${esc(p)}</span>`).join("")}</div></dd>`);
      if (h.bodyParam) extra.push(`<dt>Body</dt><dd><code>${esc(h.bodyParam)}</code></dd>`);
      if (h.auth && h.auth.type !== "none") extra.push(`<dt>Auth</dt><dd>${h.auth.type === "bearer" ? "Bearer token" : `Header <code>${esc(h.auth.header ?? "")}</code>`} from <code>$${esc(h.auth.env ?? "")}</code></dd>`);
      return `<div class="binding"><span class="method ${esc(h.method)}">${esc(h.method)}</span><span>${esc(h.path)}</span></div><dl class="kv" style="margin-top:12px">${extra.join("")}</dl>`;
    }
    if (t.kind === "shell" && t.shell) {
      const s = t.shell;
      return `<div class="binding">${icon("terminal", "sm")}<span>${esc(s.command)}</span></div><dl class="kv" style="margin-top:12px"><dt>Working dir</dt><dd><code>${esc(s.cwd ?? ".")}</code></dd><dt>Timeout</dt><dd>${fmtMs(s.timeoutMs ?? 120000)}</dd></dl>`;
    }
    if (t.fs) return `<div class="binding">${icon("folder", "sm")}<span>${esc(t.fs.root)}</span></div><dl class="kv" style="margin-top:12px"><dt>Operation</dt><dd>${esc(t.kind)}</dd>${t.fs.maxBytes ? `<dt>Max bytes</dt><dd>${fmtBytes(t.fs.maxBytes)}</dd>` : ""}</dl>`;
    if (t.kind === "web_search" || t.kind === "web_fetch") return `<p class="muted" style="margin:0">Anthropic server tool: runs on Anthropic's side, no local binding.</p>`;
    if (t.kind === "memory") return `<p class="muted" style="margin:0">Client-side memory tool, stored in <code>.decree/memory</code>.</p>`;
    return `<p class="dim" style="margin:0">No binding.</p>`;
  }

  function toolDetail(sp: HarnessSpec, t: ToolSpec): string {
    const mode = sp.guardrails.approvalMode;
    const usedBy = sp.subagents.filter((s) => s.tools.includes(t.name));
    const asks = needsApproval(t, mode);
    return `<article class="card detail" aria-labelledby="tool-title">
      <div class="detail-head">
        <a class="btn sm ghost back" href="#/tools" data-act="tools-back" style="margin:-4px 0 10px -8px">${icon("chevL", "sm")}All tools</a>
        <div class="eyebrow">${icon(kindIcon(t.kind), "sm")}${esc(t.kind)} tool</div>
        <h2 id="tool-title" tabindex="-1">${esc(t.name)}</h2>
        <div class="chips">${badges(t, mode)}</div>
      </div>
      <section class="detail-sec"><h3 class="sec-title">Description</h3><p class="desc">${ic(t.description || "No description.")}</p></section>
      <section class="detail-sec"><h3 class="sec-title">${icon("link", "sm")}Binding</h3>${bindingHtml(t)}</section>
      <section class="detail-sec"><h3 class="sec-title">${icon("braces", "sm")}Parameters</h3>${schemaRows(t)}
        <details class="raw" style="margin-top:10px"><summary>Input schema JSON</summary><pre class="json"><code>${jsonHtml(t.inputSchema ?? {})}</code></pre></details></section>
      <section class="detail-sec"><h3 class="sec-title">${icon("shield", "sm")}Safety</h3>
        <dl class="kv">
          <dt>Approval</dt><dd>${asks ? `<span class="env-miss">${icon("shieldAlert", "sm")}Asks a human before running</span>` : `<span class="env-ok">${icon("check", "sm")}Runs without asking</span>`} <span class="dim">(mode: ${esc(mode)})</span></dd>
          <dt>Flags</dt><dd><code>readOnly: ${t.readOnly}</code> · <code>destructive: ${t.destructive}</code> · <code>requiresApproval: ${t.requiresApproval}</code></dd>
          <dt>Source</dt><dd><code>${esc(t.source ?? "unknown")}</code></dd>
          ${usedBy.length ? `<dt>Subagents</dt><dd><div class="chips">${usedBy.map((s) => `<a class="chip-link" href="#/subagents"><span class="pill mono">${esc(s.name)}</span></a>`).join("")}</div></dd>` : ""}
        </dl>
      </section>
    </article>`;
  }

  /** Re-render the tool list (and, with no explicit selection on desktop, the detail) without touching the search box. */
  function refreshToolPanes(): void {
    const sp = spec();
    const list = document.getElementById("tool-list");
    if (!sp || !list) return;
    const narrow = window.matchMedia("(max-width: 860px)").matches;
    const first = filterTools(sp)[0];
    const selName = S.param || (narrow ? "" : first?.name ?? "");
    list.innerHTML = toolListHtml(sp, selName);
    if (!S.param && !narrow) {
      const det = document.querySelector(".split > .detail");
      const t = sp.tools.find((x) => x.name === selName);
      if (det) det.outerHTML = t ? toolDetail(sp, t) : `<div class="card detail">${empty("search", "No matching tools", "Try a different search or filter.")}</div>`;
    }
  }
  function toolsView(sp: HarnessSpec): string {
    const all = sp.tools;
    const mode = sp.guardrails.approvalMode;
    const narrow = window.matchMedia("(max-width: 860px)").matches;
    const selName = S.param || (narrow ? "" : filterTools(sp)[0]?.name ?? all[0]?.name ?? "");
    const sel = all.find((t) => t.name === selName);
    const count = (f: (t: ToolSpec) => boolean) => all.filter(f).length;
    const segs: [typeof S.toolFilter, string, number][] = [
      ["all", "All", all.length],
      ["ro", "Read-only", count((t) => t.readOnly)],
      ["writes", "Writes", count((t) => !t.readOnly)],
      ["approval", "Approval", count((t) => needsApproval(t, mode))],
      ["destructive", "Destructive", count((t) => t.destructive)],
    ];
    if (!all.length) return `<div class="page">${pageHead(icon("wrench", "sm") + " Tools", "Tools", "")}<div class="card">${empty("wrench", "No tools", "This harness has no tools yet. Add some with <code>decree-harness refine</code>.")}</div></div>`;
    return `<div class="page">
      ${pageHead(icon("wrench", "sm") + " Tools", "Tools", `${plural(all.length, "tool")} bound to your API, scripts and files. Approval mode <b>${esc(mode)}</b>.`)}
      <div class="toolbar">
        <div class="search"><label class="sr-only" for="tool-search">Search tools</label>${icon("search")}<input id="tool-search" class="input" type="search" placeholder="Search by name, path, command…" value="${esc(S.toolQuery)}" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></div>
        <div class="seg" role="group" aria-label="Filter by safety">${segs
          .map(([id, label, c]) => `<button type="button" data-act="tool-filter" data-filter="${id}" aria-pressed="${S.toolFilter === id}">${label}<span class="n">${c}</span></button>`)
          .join("")}</div>
      </div>
      <div class="split ${S.param ? "has-sel" : ""}">
        <div class="list-col"><nav class="card list" id="tool-list" aria-label="Tool list">${toolListHtml(sp, sel?.name ?? "")}</nav></div>
        ${sel ? toolDetail(sp, sel) : `<div class="card detail">${empty("wrench", "Select a tool", "Pick a tool on the left to see its binding, schema and safety flags.")}</div>`}
      </div>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // prompt
  // -------------------------------------------------------------------------
  const promptMeta = (text: string): string => {
    const words = (text.match(/\S+/g) ?? []).length;
    const lines = text.split("\n").length;
    return `<div class="meta-line"><span>${icon("hash", "sm")}${plural(words, "word")}</span><span>${icon("cpu", "sm")}~${fmtTok(Math.ceil(text.length / 4))} tokens</span><span>${icon("doc", "sm")}${plural(lines, "line")}</span></div>`;
  };
  function promptView(sp: HarnessSpec): string {
    const meta = promptMeta(S.editing ? S.draft : sp.systemPrompt);
    if (S.editing) {
      const dirty = S.draft !== sp.systemPrompt;
      return `<div class="page">
        ${pageHead(icon("doc", "sm") + " System prompt", "Edit system prompt", "Markdown. Saved to <code>decree.json</code> › <code>systemPrompt</code> after validation.", `<button class="btn" type="button" data-act="prompt-cancel">Cancel <kbd>Esc</kbd></button><button class="btn primary" type="button" data-act="prompt-save" ${S.saving ? "disabled" : ""}>${S.saving ? '<span class="spinner"></span>' : icon("check")}Save <kbd style="background:transparent;color:inherit;border-color:currentColor;opacity:.6">⌘S</kbd></button>`)}
        <div id="prompt-errors" aria-live="assertive">${promptErrorsHtml()}</div>
        <label class="sr-only" for="prompt-editor">System prompt (markdown)</label>
        <textarea id="prompt-editor" class="editor" spellcheck="true">${esc(S.draft)}</textarea>
        <div class="editor-foot"><span id="prompt-meta">${meta}</span><span id="prompt-dirty">${dirty ? "Unsaved changes" : "No changes"} · Ctrl/⌘+S to save</span></div>
      </div>`;
    }
    const html = md(sp.systemPrompt);
    const heads = [...sp.systemPrompt.matchAll(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/gm)].map((m) => ({ level: m[1].length, text: m[2] }));
    return `<div class="page">
      ${pageHead(icon("doc", "sm") + " System prompt", "System prompt", "What the agent reads before every conversation.", `<button class="btn" type="button" data-act="copy-prompt">${icon("copy")}Copy</button><button class="btn primary" type="button" data-act="prompt-edit">${icon("pencil")}Edit</button>`)}
      <div class="doc-wrap">
        <article class="card"><div class="card-head">${meta}</div><div class="doc md" id="prompt-doc">${html}</div></article>
        ${heads.length > 1 ? `<nav class="toc" aria-label="Prompt outline"><h4>Outline</h4>${heads.map((h) => `<button type="button" class="l${h.level}" data-act="toc" data-text="${esc(h.text)}">${esc(h.text.replace(/[*_`]/g, ""))}</button>`).join("")}</nav>` : ""}
      </div>
    </div>`;
  }
  function promptErrorsHtml(): string {
    if (S.promptStale && !S.promptErrors.length)
      return `<div class="callout amber" style="margin-bottom:12px">${icon("alert")}<div><strong>decree.json changed on disk</strong> while you were editing. Saving will be refused; <button class="btn sm" type="button" data-act="prompt-reload">Discard draft and load latest</button></div></div>`;
    if (!S.promptErrors.length) return "";
    return `<div class="callout red" role="alert" style="margin-bottom:12px">${icon("alert")}<div><strong>Not saved.</strong> ${S.promptConflict ? "" : "decree.json would be invalid:"}<ul>${S.promptErrors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>${S.promptConflict ? `<button class="btn sm" type="button" data-act="prompt-reload" style="margin-top:8px">Discard draft and load latest</button>` : ""}</div></div>`;
  }

  // -------------------------------------------------------------------------
  // subagents
  // -------------------------------------------------------------------------
  function subagentsView(sp: HarnessSpec): string {
    const head = pageHead(icon("users", "sm") + " Subagents", "Subagents", "Focused helpers the main agent delegates to. Subagents are kept read-only.");
    if (!sp.subagents.length) return `<div class="page">${head}<div class="card">${empty("users", "No subagents", "This harness runs as a single agent.")}</div></div>`;
    return `<div class="page">${head}<div class="agents">${sp.subagents
      .map(
        (s) => `<article class="card agent-card" aria-labelledby="sa-${esc(s.name)}">
        <div class="card-body">
          <div class="agent-title"><div class="avatar">${icon("users")}</div><div><h3 id="sa-${esc(s.name)}">${esc(s.name)}</h3><div class="dim" style="font-size:12px">delegate_to_${esc(s.name.replace(/-/g, "_"))}</div></div></div>
          <p style="margin:0" class="muted">${ic(s.description)}</p>
          <div class="chips"><span class="pill mono">${icon("cpu")}${esc(s.model ?? sp.model.subagentId)}</span>${s.effort ? `<span class="pill">effort ${esc(s.effort)}</span>` : ""}</div>
          <div><div class="sec-title">${plural(s.tools.length, "tool")}</div><div class="chips">${s.tools.map((n) => `<a class="chip-link" href="#/tools/${encodeURIComponent(n)}"><span class="pill mono">${esc(n)}</span></a>`).join("")}</div></div>
          <details class="raw"><summary>System prompt</summary><div class="md">${md(s.systemPrompt)}</div></details>
        </div></article>`,
      )
      .join("")}</div></div>`;
  }

  // -------------------------------------------------------------------------
  // evals
  // -------------------------------------------------------------------------
  function evalCard(c: HarnessSpec["evals"][number]): string {
    const r = S.evals.results[c.id];
    const running = S.evals.running[c.id];
    const ex = c.expect;
    const chips: string[] = [];
    for (const t of ex.toolsCalled ?? []) chips.push(`<span class="pill green" title="Must call">${icon("check")}calls <code>${esc(t)}</code></span>`);
    const never = ex.toolsNotCalled ?? [];
    if (never.length > 2) chips.push(`<span class="pill red" title="Must not call: ${esc(never.join(", "))}">${icon("x")}never calls ${never.length} gated tools</span>`);
    else for (const t of never) chips.push(`<span class="pill red" title="Must not call">${icon("x")}never <code>${esc(t)}</code></span>`);
    for (const s of ex.contains ?? []) chips.push(`<span class="pill" title="Answer contains">mentions “${esc(s)}”</span>`);
    for (const s of ex.notContains ?? []) chips.push(`<span class="pill" title="Answer must not contain">avoids “${esc(s)}”</span>`);
    if (ex.rubric) chips.push(`<span class="pill violet" title="${esc(ex.rubric)}">${icon("spark")}rubric</span>`);
    let status = `<span class="pill">Not run</span>`;
    if (running) status = `<span class="pill accent"><span class="spinner" style="width:11px;height:11px;border-width:1.5px"></span>Running</span>`;
    else if (r?.error) status = `<span class="pill red">${icon("alert")}Error</span>`;
    else if (r) status = r.passed ? `<span class="pill green">${icon("check")}Passed · ${Math.round(r.score * 100)}%</span>` : `<span class="pill red">${icon("x")}Failed · ${Math.round(r.score * 100)}%</span>`;
    const checks = r
      ? r.error
        ? `<ul class="checks"><li><span class="no">${icon("alert", "sm")}</span><span>${esc(r.error)}</span></li></ul>`
        : r.checks.length
          ? `<details class="final raw" ${r.passed ? "" : "open"}><summary>${r.checks.filter((ch) => ch.passed).length}/${r.checks.length} checks passed</summary><ul class="checks" style="margin-top:8px">${[...r.checks]
              .sort((a, b) => Number(a.passed) - Number(b.passed))
              .map((ch) => {
                const sk = (ch.detail ?? "").startsWith("skipped:");
                return `<li><span class="${sk ? "sk" : ch.passed ? "ok" : "no"}">${icon(sk ? "info" : ch.passed ? "check" : "x", "sm")}</span><span>${esc(ch.name)}${ch.detail ? ` <span class="cd">· ${esc(ch.detail)}</span>` : ""}</span></li>`;
              })
              .join("")}</ul></details>`
          : ""
      : "";
    const final =
      r?.run && !r.error
        ? `<details class="final raw"><summary>Final answer · ${plural(r.run.turns, "turn")} · ${plural(r.run.toolCalls.length, "tool call")} · ${fmtUsd(r.run.costUsd)}</summary><div class="md" style="margin-top:8px">${md(r.run.finalText || "_(empty)_")}</div></details>`
        : "";
    return `<article class="card eval" id="eval-${esc(c.id)}" aria-labelledby="eh-${esc(c.id)}">
      <div><div class="eval-id" id="eh-${esc(c.id)}">${esc(c.id)}${(c.tags ?? []).map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</div>
      <p class="eval-input">${esc(c.input)}</p><div class="chips">${chips.join("")}</div></div>
      <div class="eval-side">${status}<button class="btn sm" type="button" data-act="eval-one" data-id="${esc(c.id)}" ${S.evals.active || !S.data?.apiKey.available ? "disabled" : ""} aria-label="Run eval ${esc(c.id)}">${icon("play", "sm")}Run</button></div>
      ${checks}${final}
    </article>`;
  }
  function evalSummaryHtml(sp: HarnessSpec): string {
    const res = Object.values(S.evals.results);
    if (!res.length && !S.evals.active) return "";
    const done = res.length;
    const passed = res.filter((r) => r.passed).length;
    const cost = res.reduce((a, r) => a + (r.run?.costUsd ?? 0), 0);
    const total = S.evals.active ? Object.keys(S.evals.running).length + done : done;
    const pct = total ? (passed / total) * 100 : 0;
    const failPct = total ? ((done - passed) / total) * 100 : 0;
    return `<div class="card eval-sum" role="status"><div><div class="big">${passed}/${total || sp.evals.length}</div><div class="dim" style="font-size:12px">passed</div></div>
      <div class="bar" aria-hidden="true"><span class="g" style="width:${pct}%"></span><span class="r" style="width:${failPct}%"></span></div>
      <div class="meta-line"><span>${icon("dollar", "sm")}${fmtUsd(cost)}</span>${S.evals.active ? `<span><span class="spinner"></span>Running…</span>` : ""}</div></div>`;
  }
  function evalsView(sp: HarnessSpec): string {
    const keyOk = !!S.data?.apiKey.available;
    const head = pageHead(
      icon("check2", "sm") + " Evals",
      "Evals",
      `${plural(sp.evals.length, "case")}. Runs use the live model with tools in dry-run mode; approval-gated tools are declined.`,
      `<button class="btn accent" type="button" data-act="evals-run" ${!keyOk || S.evals.active || !sp.evals.length ? "disabled" : ""}>${S.evals.active ? '<span class="spinner" style="border-top-color:#fff"></span>Running…' : icon("play") + "Run evals"}</button>`,
    );
    const nokey = keyOk
      ? ""
      : `<div class="callout amber" style="margin-bottom:14px">${icon("key")}<div><strong>Running evals needs an Anthropic API key.</strong> Set <code>ANTHROPIC_API_KEY</code> in your shell or in <code>.env</code> at the project root, then <button class="btn sm" type="button" data-act="recheck-key">Check again</button></div></div>`;
    if (!sp.evals.length) return `<div class="page">${head}<div class="card">${empty("check2", "No evals", 'Add some with <code>decree-harness refine "add evals for …"</code>.')}</div></div>`;
    return `<div class="page">${head}${nokey}<div id="eval-summary">${evalSummaryHtml(sp)}</div>${S.evals.error ? `<div class="callout red" role="alert" style="margin-bottom:14px">${icon("alert")}<div>${esc(S.evals.error)}</div></div>` : ""}<div class="evals">${sp.evals.map(evalCard).join("")}</div></div>`;
  }
  async function runEvals(filter?: string): Promise<void> {
    const sp = spec();
    if (!sp || S.evals.active) return;
    S.evals.active = true;
    S.evals.error = "";
    const ids = sp.evals.filter((c) => !filter || c.id.includes(filter)).map((c) => c.id);
    for (const id of ids) {
      delete S.evals.results[id];
      S.evals.running[id] = true;
    }
    if (S.section === "evals") render();
    const refresh = (id?: string) => {
      if (S.section !== "evals") return;
      const s2 = spec();
      if (!s2) return;
      const sum = document.getElementById("eval-summary");
      if (sum) sum.innerHTML = evalSummaryHtml(s2);
      const c = id ? s2.evals.find((e) => e.id === id) : undefined;
      const el = id ? document.getElementById("eval-" + id) : null;
      if (c && el) el.outerHTML = evalCard(c);
    };
    try {
      await sse("/api/evals", { filter }, (ev, data) => {
        if (ev === "result") {
          const r = data as EvalResult;
          S.evals.results[r.id] = r;
          delete S.evals.running[r.id];
          refresh(r.id);
        } else if (ev === "done") {
          const d = data as { passed: number; total: number; costUsd: number };
          toast(d.passed === d.total ? "ok" : "err", `${d.passed}/${d.total} evals passed`, fmtUsd(d.costUsd) + " spent");
        } else if (ev === "fatal") {
          S.evals.error = (data as { message: string }).message;
        }
      });
    } catch (err) {
      S.evals.error = (err as Error).message || "Eval run failed";
    } finally {
      S.evals.active = false;
      S.evals.running = {};
      if (S.section === "evals") render();
    }
  }

  // -------------------------------------------------------------------------
  // files
  // -------------------------------------------------------------------------
  interface TreeNode {
    name: string;
    path: string;
    dirs: Map<string, TreeNode>;
    files: FileEntry[];
  }
  function buildTree(files: FileEntry[]): TreeNode {
    const root: TreeNode = { name: "", path: "", dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        let next = cur.dirs.get(p);
        if (!next) {
          next = { name: p, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
          cur.dirs.set(p, next);
        }
        cur = next;
      }
      cur.files.push(f);
    }
    return root;
  }
  function treeHtml(node: TreeNode, depth: number, selected: string): string {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    return (
      dirs
        .map((d) => {
          const open = depth < 1 || selected.startsWith(d.path + "/");
          return `<details ${open ? "open" : ""}><summary>${icon("chevR", "sm chev")}${icon("folder", "sm")}<span class="fname">${esc(d.name)}</span></summary><div class="kids">${treeHtml(d, depth + 1, selected)}</div></details>`;
        })
        .join("") +
      files
        .map((f) => {
          const name = f.path.split("/").pop() ?? f.path;
          return `<button type="button" data-act="file" data-path="${esc(f.path)}" aria-current="${f.path === selected}" title="${esc(f.path)} · ${esc(f.status)}">${icon("file", "sm")}<span class="fname">${esc(name)}</span><span class="fst ${esc(f.status)}" aria-label="${esc(f.status)}"></span></button>`;
        })
        .join("")
    );
  }
  function highlight(path: string, content: string): string {
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    const base = path.split("/").pop() ?? "";
    const slash = ["ts", "tsx", "js", "mjs", "cjs", "jsx", "json", "jsonc"].includes(ext);
    const hashc = ["py", "sh", "toml", "yaml", "yml", "cfg", "ini", "txt"].includes(ext) || base.startsWith(".env") || base === "Dockerfile" || base === ".gitignore";
    const kw =
      ext === "py"
        ? /^(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|async|await|yield|lambda|None|True|False|pass|break|continue|self)$/
        : slash
          ? /^(const|let|var|function|return|if|else|for|while|of|in|new|import|from|export|default|async|await|class|extends|interface|type|throw|try|catch|finally|true|false|null|undefined|typeof|as|switch|case|break|continue|void)$/
          : null;
    if (!slash && !hashc) return content.split("\n").map((l) => `<span class="ln">${esc(l) || " "}</span>`).join("");
    let inBlock = false;
    let inTriple = "";
    return content
      .split("\n")
      .map((line) => {
        let out = "";
        let i = 0;
        const push = (cls: string, s: string) => (out += cls ? `<span class="${cls}">${esc(s)}</span>` : esc(s));
        while (i < line.length) {
          if (inBlock) {
            const e = line.indexOf("*/", i);
            const end = e === -1 ? line.length : e + 2;
            push("c-com", line.slice(i, end));
            i = end;
            if (e !== -1) inBlock = false;
            continue;
          }
          if (inTriple) {
            const e = line.indexOf(inTriple, i);
            const end = e === -1 ? line.length : e + 3;
            push("c-str", line.slice(i, end));
            i = end;
            if (e !== -1) inTriple = "";
            continue;
          }
          const rest = line.slice(i);
          if (slash && rest.startsWith("/*")) {
            inBlock = true;
            continue;
          }
          if ((slash && rest.startsWith("//")) || (hashc && rest.startsWith("#"))) {
            push("c-com", rest);
            break;
          }
          if (ext === "py" && (rest.startsWith('"""') || rest.startsWith("'''"))) {
            const q = rest.slice(0, 3);
            const e = rest.indexOf(q, 3);
            if (e === -1) {
              inTriple = q;
              push("c-str", rest);
              break;
            }
            push("c-str", rest.slice(0, e + 3));
            i += e + 3;
            continue;
          }
          const ch = line[i];
          if (ch === '"' || ch === "'" || (slash && ch === "`")) {
            let j = i + 1;
            while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
            push("c-str", line.slice(i, j + 1));
            i = j + 1;
            continue;
          }
          const m = /^[A-Za-z_$][\w$]*|^\d+(?:\.\d+)?/.exec(rest);
          if (m) {
            const w = m[0];
            push(/^\d/.test(w) ? "c-num" : kw && kw.test(w) ? "c-kw" : "", w);
            i += w.length;
            continue;
          }
          push("", ch);
          i++;
        }
        return `<span class="ln">${out || " "}</span>`;
      })
      .join("");
  }
  function filesView(): string {
    const f = S.files;
    const head = pageHead(
      icon("folder", "sm") + " Files",
      "Generated files",
      f ? `What <code>decree-harness generate</code> writes to <code>${esc(f.outDir)}/</code> for ${esc(f.targets.join(", "))}.` : "Rendering targets…",
      `<button class="btn primary" type="button" data-act="regenerate" ${S.generating || !f ? "disabled" : ""}>${S.generating ? '<span class="spinner"></span>' : icon("refresh")}Regenerate</button>`,
    );
    if (S.filesError) return `<div class="page wide">${head}<div class="callout red" role="alert">${icon("alert")}<div>${esc(S.filesError)}</div></div></div>`;
    if (!f) return `<div class="page wide">${head}<div class="boot" style="height:30vh"><span class="spinner"></span>Rendering…</div></div>`;
    const narrowF = window.matchMedia("(max-width: 860px)").matches;
    const sel = S.param || (narrowF ? "" : f.files.find((x) => x.path === "README.md")?.path ?? f.files[0]?.path ?? "");
    const cur = f.files.find((x) => x.path === sel);
    const s = f.summary;
    const legend = `<div class="legend-files" style="margin-bottom:12px"><span><i class="fst new" style="margin:0"></i>${s.new ?? 0} new</span><span><i class="fst changed" style="margin:0"></i>${s.changed ?? 0} will update</span><span><i class="fst edited" style="margin:0"></i>${s.edited ?? 0} edited by you (kept)</span><span class="dim">${s.unchanged ?? 0} up to date</span></div>`;
    const content = S.fileContent && S.fileContent.path === sel ? S.fileContent.content : null;
    const statusLabel: Record<string, string> = { new: "not written yet", changed: "differs from disk", edited: "edited by you: regenerate keeps your version", unchanged: "up to date" };
    const viewer = cur
      ? `<article class="card viewer" aria-labelledby="file-title">
          <div class="viewer-head"><div style="display:flex;gap:8px;align-items:center;min-width:0"><a class="btn sm ghost back" href="#/files" style="margin-left:-6px">${icon("chevL", "sm")}Files</a><span class="crumbs" id="file-title" tabindex="-1">${esc(f.outDir)}/${esc(cur.path.split("/").slice(0, -1).join("/"))}${cur.path.includes("/") ? "/" : ""}<b>${esc(cur.path.split("/").pop() ?? "")}</b></span></div>
          <div class="actions"><span class="dim" style="font-size:12px">${plural(cur.lines, "line")} · ${fmtBytes(cur.size)} · ${esc(statusLabel[cur.status] ?? cur.status)}</span><button class="btn sm" type="button" data-act="copy-file">${icon("copy", "sm")}Copy</button></div></div>
          ${content === null ? `<div class="boot" style="height:200px"><span class="spinner"></span></div>` : `<pre class="code" tabindex="0" aria-label="File contents"><code>${highlight(cur.path, content)}</code></pre>`}
        </article>`
      : `<div class="card viewer">${empty("file", "Pick a file", `${plural(f.files.length, "file")} across ${plural(f.targets.length, "target")}. Select one to read the generated code.`)}</div>`;
    return `<div class="page wide">${head}${legend}<div class="files-split ${cur && S.param ? "has-sel" : ""}"><div class="tree-col"><nav class="card tree" aria-label="Generated file tree">${treeHtml(buildTree(f.files), 0, sel)}</nav></div>${viewer}</div></div>`;
  }
  async function loadFiles(force = false): Promise<void> {
    const st = S.data;
    if (!st || !st.ok) return;
    if (!force && S.files && S.files.hash === st.hash) return;
    if (S.filesLoading) return;
    S.filesLoading = true;
    S.filesError = "";
    try {
      S.files = await api("/api/files");
    } catch (err) {
      S.filesError = (err as Error).message;
    } finally {
      S.filesLoading = false;
    }
    renderSidebar();
    if (S.section === "files") render();
  }
  async function loadFile(path: string): Promise<void> {
    if (S.fileContent?.path === path) return;
    try {
      const r = await api<{ path: string; content: string }>("/api/file?path=" + encodeURIComponent(path));
      S.fileContent = { path: r.path, content: r.content };
    } catch (err) {
      S.fileContent = { path, content: "Could not load: " + (err as Error).message };
    }
    if (S.section === "files") render();
  }

  // -------------------------------------------------------------------------
  // playground
  // -------------------------------------------------------------------------
  function chatItemHtml(it: ChatItem): string {
    const sp = spec();
    switch (it.k) {
      case "user":
        return `<div class="msg-user" id="ci-${it.id}">${esc(it.text)}</div>`;
      case "ai":
        return `<div class="msg-ai" id="ci-${it.id}"><div class="av" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS.logo}</svg></div><div class="md">${md(it.text)}${it.live ? '<span class="caret" aria-hidden="true"></span>' : ""}</div></div>`;
      case "think":
        return `<details class="think" id="ci-${it.id}"><summary>${icon("brain", "sm")}Thinking</summary><div>${esc(it.text)}</div></details>`;
      case "note":
        return `<div class="callout ${it.tone === "info" ? "blue" : it.tone} pg-err" id="ci-${it.id}" ${it.tone === "red" ? 'role="alert"' : ""}>${icon(it.tone === "info" ? "info" : "alert")}<div>${esc(it.text)}${it.hint ? `<div class="dim" style="margin-top:3px">${esc(it.hint)}</div>` : ""}</div></div>`;
      case "stats":
        return `<div class="stats-line" id="ci-${it.id}"><span>${icon("refresh", "sm")}${plural(it.turns, "turn")}</span><span>${icon("wrench", "sm")}${plural(it.tools, "tool call")}</span><span>${icon("cpu", "sm")}${fmtTok(totalTokens(it.usage))} tokens</span><span>${icon("dollar", "sm")}${fmtUsd(it.cost)}</span>${it.stopped ? "<span>stopped</span>" : ""}</div>`;
      case "tool": {
        const tool = sp?.tools.find((t) => t.name === it.name);
        const isSub = it.name.startsWith("delegate_to_");
        const st =
          it.status === "running"
            ? `<span class="spinner"></span>running`
            : it.status === "approval"
              ? `<span class="pill amber">${icon("shieldAlert")}awaiting approval</span>`
              : it.status === "denied"
                ? `<span class="pill red">${icon("x")}denied</span>`
                : it.status === "error"
                  ? `<span class="pill red">${icon("alert")}error</span>${it.ms !== undefined ? " " + fmtMs(it.ms) : ""}`
                  : `<span class="pill green">${icon("check")}done</span>${it.ms !== undefined ? " " + fmtMs(it.ms) : ""}`;
        const inputJson = it.input === undefined ? "" : jsonHtml(it.input);
        const approve =
          it.status === "approval"
            ? `<div class="approve" role="group" aria-label="Approval for ${esc(it.name)}">${icon("shieldAlert")}<span class="q"><strong>Allow <code>${esc(it.name)}</code> to run?</strong> ${tool?.destructive ? "This tool is marked destructive." : "This tool needs your approval."}${S.chat.dryRun ? (tool && tool.readOnly ? " Dry run is on, but this tool only reads, so it runs for real." : " Dry run is on, so it will only describe what it would do.") : " Dry run is off: this runs for real."}</span>
                <span class="approve-btns"><button class="btn sm danger" type="button" data-act="deny" data-approval="${esc(it.approvalId)}" ${it.busy ? "disabled" : ""}>${icon("x", "sm")}Deny</button>
                <button class="btn sm primary" type="button" data-act="approve" data-approval="${esc(it.approvalId)}" ${it.busy ? "disabled" : ""}>${icon("check", "sm")}Approve</button></span></div>`
            : "";
        return `<div class="tc ${it.status === "approval" ? "approval" : ""}" id="ci-${it.id}">
          <div class="tc-head"><span class="tc-ic">${icon(isSub ? "users" : kindIcon(tool?.kind ?? ""))}</span><span class="tn">${esc(it.name)}</span>${tool ? `<span class="kind">${esc(tool.kind)}</span>` : isSub ? '<span class="kind">subagent</span>' : ""}<span class="st">${st}</span></div>
          ${inputJson ? `<details data-part="in" ${it.status === "approval" ? "open" : ""}><summary>Input</summary><pre><code>${inputJson}</code></pre></details>` : ""}
          ${it.output !== undefined ? `<details data-part="out"><summary>Output${it.isError ? " (error)" : ""}</summary><pre class="${it.isError ? "err" : ""}">${esc(it.output)}</pre></details>` : ""}
          ${approve}
        </div>`;
      }
    }
  }
  function updateItem(it: ChatItem): void {
    const el = document.getElementById("ci-" + it.id);
    if (!el) return;
    const open = new Set<string>();
    el.querySelectorAll("details[data-part]").forEach((d) => {
      if ((d as HTMLDetailsElement).open) open.add((d as HTMLElement).dataset.part ?? "");
    });
    const scroller = document.getElementById("pg-scroll");
    const stick = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 : false;
    el.outerHTML = chatItemHtml(it);
    const fresh = document.getElementById("ci-" + it.id);
    fresh?.querySelectorAll("details[data-part]").forEach((d) => {
      if (open.has((d as HTMLElement).dataset.part ?? "")) (d as HTMLDetailsElement).open = true;
    });
    if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
  }
  function appendItem(it: ChatItem): void {
    S.chat.items.push(it);
    const inner = document.getElementById("pg-inner");
    if (!inner) return;
    const emptyEl = document.getElementById("pg-empty");
    if (emptyEl) emptyEl.remove();
    const scroller = document.getElementById("pg-scroll");
    inner.insertAdjacentHTML("beforeend", chatItemHtml(it));
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
  function pgMeta(): string {
    const t = S.chat.totals;
    return `<span>${S.chat.dryRun ? `${icon("shield", "sm")} Dry run: reads run for real; writes, commands and non-GET requests only describe what they would do.` : `<span style="color:var(--amber)">${icon("alert", "sm")} Live tools: calls hit your API and run commands.</span>`}</span><span>${t.replies ? `${plural(t.replies, "reply", "replies")} · ${fmtTok(t.tokens)} tokens · ${fmtUsd(t.cost)}` : "Enter to send · Shift+Enter for a new line"}</span>`;
  }
  function playgroundView(sp: HarnessSpec): string {
    const st = S.data as StateOk;
    if (!st.apiKey.available) {
      return `<div class="page"><div class="card nokey">
        <div class="ico" style="width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)">${icon("key", "lg")}</div>
        <h2 id="page-title" tabindex="-1">Connect Claude to try your agent</h2>
        <p class="muted" style="margin:0">The playground runs <b>${esc(sp.displayName)}</b> live against the Anthropic API with your harness's tools. Everything else in this dashboard works without a key.</p>
        <ol>
          <li>Create a key in the Anthropic Console (console.anthropic.com → API keys).</li>
          <li>Either export it and restart preview:<pre><code>export ANTHROPIC_API_KEY=sk-ant-…\nnpx decree-harness preview</code></pre></li>
          <li>Or add it to <code>.env</code> in <code>${esc(st.project.root)}</code> (no restart needed):<pre><code>ANTHROPIC_API_KEY=sk-ant-…</code></pre></li>
        </ol>
        <button class="btn primary" type="button" data-act="recheck-key">${icon("refresh")}Check again</button>
      </div></div>`;
    }
    const suggestions = sp.evals.slice(0, 3).map((e) => e.input);
    const emptyState = `<div class="empty" id="pg-empty" style="padding-top:8vh"><div class="ico" style="background:var(--accent-soft);color:var(--accent)">${icon("spark", "lg")}</div><h3>Talk to ${esc(sp.displayName)}</h3><p>Messages run the real agent loop with <code>${esc(sp.model.id)}</code> and your ${plural(sp.tools.length, "tool")}. Approval-gated tools ask you first.</p>
      ${suggestions.length ? `<div class="suggest">${suggestions.map((s) => `<button type="button" data-act="suggest" data-text="${esc(s)}">${icon("chat", "sm")}<span>${esc(s)}</span></button>`).join("")}</div>` : ""}</div>`;
    const running = S.chat.running;
    return `<div class="pg">
      <header class="pg-head">
        <h1 id="page-title" tabindex="-1">${icon("chat")}Playground <span class="pill mono">${esc(sp.model.id)}</span></h1>
        <div class="actions">
          <label class="switch"><input type="checkbox" id="dry-run" ${S.chat.dryRun ? "checked" : ""}><span>Dry-run tools</span></label>
          <button class="btn sm" type="button" data-act="chat-reset" ${running ? "disabled" : ""}>${icon("reset", "sm")}New chat</button>
        </div>
      </header>
      <div class="pg-scroll" id="pg-scroll" aria-live="polite" aria-busy="${running}"><div class="pg-inner" id="pg-inner" role="log" aria-label="Conversation">${S.chat.items.length ? S.chat.items.map(chatItemHtml).join("") : emptyState}</div></div>
      <div class="pg-foot">
        <form class="composer" id="composer">
          <label class="sr-only" for="chat-input">Message</label>
          <textarea id="chat-input" rows="1" placeholder="Ask ${esc(sp.displayName)} something…" ${running ? "" : ""}>${esc(S.chat.draft)}</textarea>
          ${running ? `<button class="send stop" type="button" data-act="chat-stop" aria-label="Stop">${icon("stop")}</button>` : `<button class="send" type="submit" aria-label="Send" ${S.chat.draft.trim() ? "" : "disabled"}>${icon("up")}</button>`}
        </form>
        <div class="pg-meta" id="pg-meta">${pgMeta()}</div>
      </div>
    </div>`;
  }
  function refreshComposer(): void {
    if (S.section !== "playground") return;
    const form = document.getElementById("composer");
    const btn = form?.querySelector(".send");
    if (btn) {
      btn.outerHTML = S.chat.running
        ? `<button class="send stop" type="button" data-act="chat-stop" aria-label="Stop">${icon("stop")}</button>`
        : `<button class="send" type="submit" aria-label="Send" ${S.chat.draft.trim() ? "" : "disabled"}>${icon("up")}</button>`;
    }
    const meta = document.getElementById("pg-meta");
    if (meta) meta.innerHTML = pgMeta();
    const reset = document.querySelector('[data-act="chat-reset"]') as HTMLButtonElement | null;
    if (reset) reset.disabled = S.chat.running;
    const sc = document.getElementById("pg-scroll");
    if (sc) sc.setAttribute("aria-busy", String(S.chat.running));
  }
  async function sendChat(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || S.chat.running) return;
    S.chat.running = true;
    S.chat.draft = "";
    const input = document.getElementById("chat-input") as HTMLTextAreaElement | null;
    if (input) {
      input.value = "";
      input.style.height = "";
    }
    appendItem({ k: "user", id: ++itemSeq, text: prompt });
    refreshComposer();
    const ac = new AbortController();
    S.chat.abort = ac;
    let ai: Extract<ChatItem, { k: "ai" }> | null = null;
    let think: Extract<ChatItem, { k: "think" }> | null = null;
    const endAi = () => {
      if (ai) {
        ai.live = false;
        updateItem(ai);
        ai = null;
      }
    };
    const findTool = (id: string | null, name: string) =>
      [...S.chat.items].reverse().find((x) => x.k === "tool" && ((id && x.toolId === id) || (!id && x.name === name && x.status === "running"))) as
        | Extract<ChatItem, { k: "tool" }>
        | undefined;
    let raf = 0;
    const flushAi = () => {
      raf = 0;
      if (ai) updateItem(ai);
    };
    try {
      await sse(
        "/api/chat",
        { prompt, conversationId: S.chat.conversationId, dryRun: S.chat.dryRun },
        (ev, d) => {
          switch (ev) {
            case "start":
              S.chat.runId = d.runId;
              break;
            case "thinking":
              if (!think) {
                think = { k: "think", id: ++itemSeq, text: "" };
                appendItem(think);
              }
              think.text += d.text;
              updateItem(think);
              break;
            case "text":
              think = null;
              if (!ai) {
                ai = { k: "ai", id: ++itemSeq, text: "", live: true };
                appendItem(ai);
              }
              ai.text += d.text;
              if (!raf) raf = requestAnimationFrame(flushAi);
              break;
            case "tool_call":
              endAi();
              think = null;
              appendItem({ k: "tool", id: ++itemSeq, toolId: d.id, name: d.name, input: d.input, status: "running" });
              break;
            case "approval_request": {
              const t = findTool(d.toolUseId, d.name);
              if (t) {
                t.status = "approval";
                t.approvalId = d.approvalId;
                if (t.input === undefined) t.input = d.input;
                updateItem(t);
              } else {
                const it: ChatItem = { k: "tool", id: ++itemSeq, toolId: d.toolUseId ?? "", name: d.name, input: d.input, status: "approval", approvalId: d.approvalId };
                appendItem(it);
              }
              const btn = document.querySelector(`[data-act="approve"][data-approval="${CSS.escape(d.approvalId)}"]`) as HTMLButtonElement | null;
              btn?.focus({ preventScroll: true });
              if (S.section !== "playground") toast("info", `${d.name} needs your approval`, "Open the Playground to approve or deny it.", 8000);
              break;
            }
            case "approval_resolved": {
              const t = S.chat.items.find((x) => x.k === "tool" && x.approvalId === d.approvalId) as Extract<ChatItem, { k: "tool" }> | undefined;
              if (t) {
                t.status = d.approved ? "running" : "denied";
                t.busy = false;
                updateItem(t);
              }
              const inputEl = document.getElementById("chat-input");
              if (document.activeElement === document.body) inputEl?.focus();
              break;
            }
            case "approval_denied": {
              const t = findTool(d.id, d.name);
              if (t) {
                t.status = "denied";
                updateItem(t);
              }
              break;
            }
            case "tool_result": {
              const t = findTool(d.id, d.name);
              if (t) {
                if (t.status !== "denied") t.status = d.isError ? "error" : "ok";
                t.output = d.output;
                t.isError = d.isError;
                t.ms = d.ms;
                updateItem(t);
              }
              break;
            }
            case "error":
              endAi();
              appendItem({ k: "note", id: ++itemSeq, tone: "amber", text: d.message });
              break;
            case "fatal":
              endAi();
              appendItem({ k: "note", id: ++itemSeq, tone: "red", text: d.message, hint: d.hint });
              break;
            case "result":
              endAi();
              S.chat.totals.cost += d.costUsd;
              S.chat.totals.tokens += totalTokens(d.usage);
              S.chat.totals.replies++;
              appendItem({ k: "stats", id: ++itemSeq, turns: d.turns, tools: d.toolCalls, usage: d.usage, cost: d.costUsd });
              break;
            case "stopped":
              endAi();
              if (d.costUsd) S.chat.totals.cost += d.costUsd;
              appendItem({ k: "note", id: ++itemSeq, tone: "info", text: "Stopped. The conversation keeps its previous state." });
              break;
          }
        },
        ac.signal,
      );
    } catch (err) {
      endAi();
      if (!ac.signal.aborted) {
        const e = err as ApiError;
        if (e.data && e.data.code === "no_api_key") {
          await loadState();
          return;
        }
        appendItem({ k: "note", id: ++itemSeq, tone: "red", text: e.message || "Request failed" });
      }
    } finally {
      endAi();
      for (const it of S.chat.items) if (it.k === "tool" && (it.status === "running" || it.status === "approval")) {
        it.status = it.status === "approval" ? "denied" : it.status;
        updateItem(it);
      }
      S.chat.running = false;
      S.chat.abort = null;
      S.chat.runId = "";
      refreshComposer();
      const inputEl = document.getElementById("chat-input") as HTMLTextAreaElement | null;
      if (inputEl && (document.activeElement === document.body || !document.activeElement)) inputEl.focus();
    }
  }
  async function stopChat(): Promise<void> {
    if (!S.chat.running) return;
    try {
      if (S.chat.runId) await api("/api/chat/stop", { body: { runId: S.chat.runId } });
    } catch {
      S.chat.abort?.abort();
    }
  }

  // -------------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------------
  let lastSection = "";
  function render(): void {
    renderSidebar();
    const st = S.data;
    const changed = lastSection !== S.section + "/" + S.param;
    const sectionChanged = lastSection.split("/")[0] !== S.section;
    lastSection = S.section + "/" + S.param;
    document.getElementById("toasts")?.classList.toggle("lift", S.section === "playground");
    view.removeAttribute("aria-busy");
    view.className = "";
    if (!st) {
      view.className = "boot";
      view.innerHTML = S.loadError
        ? `<div class="callout red" role="alert">${icon("alert")}<div><strong>Could not load the harness.</strong> ${esc(S.loadError)}</div></div>`
        : `<div class="spinner"></div><span>Loading harness…</span>`;
      return;
    }
    document.title = `${st.ok ? st.spec.displayName : st.project.name} · ${S.section === "overview" ? "" : S.section + " · "}decree preview`;
    if (!st.ok) {
      view.innerHTML = errorView(st);
      return;
    }
    const sp = st.spec;
    switch (S.section) {
      case "overview":
        view.innerHTML = overview(sp, st);
        break;
      case "tools":
        view.innerHTML = toolsView(sp);
        break;
      case "prompt":
        view.innerHTML = promptView(sp);
        break;
      case "subagents":
        view.innerHTML = subagentsView(sp);
        break;
      case "evals":
        view.innerHTML = evalsView(sp);
        break;
      case "files":
        view.innerHTML = filesView();
        if (!S.files || S.files.hash !== st.hash) void loadFiles();
        {
          const cur = document.querySelector('.tree button[aria-current="true"]') as HTMLElement | null;
          const p = cur?.dataset.path ?? "";
          if (p && S.fileContent?.path !== p) void loadFile(p);
        }
        break;
      case "playground":
        view.innerHTML = playgroundView(sp);
        {
          const sc = document.getElementById("pg-scroll");
          if (sc) sc.scrollTop = sc.scrollHeight;
          autoGrow();
        }
        break;
    }
    if (sectionChanged) window.scrollTo(0, 0);
    if (S.focusAfter) {
      const el = document.querySelector(S.focusAfter) as HTMLElement | null;
      S.focusAfter = "";
      el?.focus({ preventScroll: !changed });
    } else if (sectionChanged && document.activeElement && document.activeElement.closest("#sidebar")) {
      // keep focus on the nav link the user activated
    }
  }

  function autoGrow(): void {
    const ta = document.getElementById("chat-input") as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  // -------------------------------------------------------------------------
  // data loading + live reload
  // -------------------------------------------------------------------------
  async function loadState(): Promise<void> {
    try {
      const st = await api<State>("/api/state");
      S.data = st;
      S.loadError = "";
      if (st.ok && S.editing && S.draftBaseHash !== st.hash) S.promptStale = true;
    } catch (err) {
      S.loadError = (err as Error).message;
    }
    if (S.editing && S.section === "prompt") {
      const box = document.getElementById("prompt-errors");
      if (box) box.innerHTML = promptErrorsHtml();
      renderSidebar();
      return;
    }
    if (S.section === "playground" && S.chat.running) {
      renderSidebar();
      return;
    }
    render();
  }

  async function connectEvents(): Promise<void> {
    let delay = 500;
    for (;;) {
      try {
        await sse("/api/events", undefined, (ev, d) => {
          if (ev === "hello") {
            const wasOff = S.live !== "live";
            S.live = "live";
            delay = 500;
            renderSidebar();
            if (wasOff && S.data && d.hash && S.data.hash !== d.hash) void loadState();
          } else if (ev === "spec") {
            if (d.source === "ui" && S.data && S.data.hash === d.hash) return;
            S.files = null;
            S.fileContent = null;
            void loadState().then(() => {
              if (d.source !== "ui") toast("info", "decree.json changed", S.data && !S.data.ok ? "The file has errors; showing details." : "Reloaded from disk.");
            });
          }
        });
      } catch {
        /* fall through to reconnect */
      }
      S.live = "off";
      renderSidebar();
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
      S.live = "connecting";
    }
  }

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------
  async function savePrompt(): Promise<void> {
    const sp = spec();
    if (!sp || S.saving) return;
    const ta = document.getElementById("prompt-editor") as HTMLTextAreaElement | null;
    if (ta) S.draft = ta.value;
    S.saving = true;
    S.promptErrors = [];
    S.promptConflict = false;
    const btn = document.querySelector('[data-act="prompt-save"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      const r = await api<{ ok: true; spec: HarnessSpec; warnings: string[]; hash: string }>("/api/spec", {
        method: "PATCH",
        body: { patch: { systemPrompt: S.draft }, baseHash: S.draftBaseHash },
      });
      if (S.data && S.data.ok) {
        S.data.spec = r.spec;
        S.data.warnings = r.warnings;
        S.data.hash = r.hash;
      }
      S.editing = false;
      S.promptStale = false;
      S.saving = false;
      S.files = null;
      S.focusAfter = '[data-act="prompt-edit"]';
      render();
      toast("ok", "Saved decree.json", "System prompt updated. Run Regenerate in Files to update generated code.");
    } catch (err) {
      S.saving = false;
      const e = err as ApiError;
      S.promptErrors = Array.isArray(e.data?.errors) ? (e.data.errors as string[]) : [e.message || "Save failed"];
      S.promptConflict = e.status === 409;
      const box = document.getElementById("prompt-errors");
      if (box) box.innerHTML = promptErrorsHtml();
      if (btn) btn.disabled = false;
      (document.getElementById("prompt-editor") as HTMLTextAreaElement | null)?.focus();
    }
  }
  function startEdit(): void {
    const st = S.data;
    if (!st || !st.ok) return;
    if (!S.editing) {
      S.draft = st.spec.systemPrompt;
      S.draftBaseHash = st.hash;
    }
    S.editing = true;
    S.promptErrors = [];
    S.promptStale = false;
    S.focusAfter = "#prompt-editor";
    render();
  }
  function cancelEdit(): void {
    const sp = spec();
    if (sp && S.draft !== sp.systemPrompt && !confirm("Discard your changes to the system prompt?")) return;
    S.editing = false;
    S.promptErrors = [];
    S.promptStale = false;
    S.focusAfter = '[data-act="prompt-edit"]';
    render();
  }
  async function copyText(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast("ok", `Copied ${what}`);
    } catch {
      toast("err", "Copy failed", "Your browser blocked clipboard access.");
    }
  }

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const el = target.closest("[data-act]") as HTMLElement | null;
    if (!el) return;
    const act = el.dataset.act;
    const sp = spec();
    switch (act) {
      case "theme":
        theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
        try {
          localStorage.setItem("decree-preview-theme", theme);
        } catch {
          /* ignore */
        }
        applyTheme();
        renderSidebar();
        (document.querySelector('[data-act="theme"]') as HTMLElement | null)?.focus();
        break;
      case "tool": {
        const name = el.dataset.name ?? "";
        S.focusAfter = window.matchMedia("(max-width: 860px)").matches ? "#tool-title" : `[data-act="tool"][data-name="${CSS.escape(name)}"]`;
        go("#/tools/" + encodeURIComponent(name));
        break;
      }
      case "tools-back":
        S.focusAfter = S.param ? `[data-act="tool"][data-name="${CSS.escape(S.param)}"]` : "";
        break;
      case "tool-filter": {
        S.toolFilter = (el.dataset.filter ?? "all") as typeof S.toolFilter;
        document.querySelectorAll('[data-act="tool-filter"]').forEach((b) => b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.filter === S.toolFilter)));
        refreshToolPanes();
        break;
      }
      case "prompt-edit":
        startEdit();
        break;
      case "prompt-cancel":
        cancelEdit();
        break;
      case "prompt-save":
        void savePrompt();
        break;
      case "prompt-reload":
        S.editing = false;
        S.promptErrors = [];
        S.promptConflict = false;
        S.promptStale = false;
        void loadState();
        break;
      case "copy-prompt":
        if (sp) void copyText(sp.systemPrompt, "system prompt");
        break;
      case "toc": {
        const text = el.dataset.text ?? "";
        const heads = document.querySelectorAll("#prompt-doc h1, #prompt-doc h2, #prompt-doc h3");
        for (const h of heads) {
          if ((h.textContent ?? "").trim() === text.replace(/[*_`]/g, "").trim()) {
            h.scrollIntoView({ behavior: "smooth", block: "start" });
            (h as HTMLElement).setAttribute("tabindex", "-1");
            (h as HTMLElement).focus({ preventScroll: true });
            break;
          }
        }
        break;
      }
      case "evals-run":
        void runEvals();
        break;
      case "eval-one":
        void runEvals(el.dataset.id);
        break;
      case "recheck-key":
        void loadState().then(() => {
          if (!S.data?.apiKey.available) toast("err", "Still no API key", "Set ANTHROPIC_API_KEY or add it to .env, then try again.");
          else toast("ok", "API key found");
        });
        break;
      case "file": {
        const p = el.dataset.path ?? "";
        S.focusAfter = window.matchMedia("(max-width: 860px)").matches ? "#file-title" : `[data-act="file"][data-path="${CSS.escape(p)}"]`;
        go("#/files/" + p.split("/").map(encodeURIComponent).join("/"));
        break;
      }
      case "copy-file":
        if (S.fileContent) void copyText(S.fileContent.content, S.fileContent.path.split("/").pop() ?? "file");
        break;
      case "regenerate":
        void (async () => {
          S.generating = true;
          render();
          try {
            const r = await api<{ report: { created: string[]; updated: string[]; unchanged: string[]; skipped: string[]; removed: string[] }; outDir: string }>("/api/generate", { body: {} });
            const rep = r.report;
            const changedN = rep.created.length + rep.updated.length;
            toast(
              "ok",
              changedN ? `Wrote ${plural(changedN, "file")} to ${r.outDir}/` : `${r.outDir}/ is up to date`,
              `${rep.created.length} created · ${rep.updated.length} updated · ${rep.unchanged.length} unchanged${rep.skipped.length ? ` · ${rep.skipped.length} kept (you edited them; use generate --force)` : ""}`,
              6000,
            );
          } catch (err) {
            toast("err", "Regenerate failed", (err as Error).message);
          } finally {
            S.generating = false;
            S.fileContent = null;
            await loadFiles(true);
            render();
          }
        })();
        break;
      case "suggest": {
        const text = el.dataset.text ?? "";
        void sendChat(text);
        break;
      }
      case "chat-stop":
        void stopChat();
        break;
      case "chat-reset":
        void api("/api/chat/reset", { body: { conversationId: S.chat.conversationId } }).catch(() => undefined);
        S.chat.conversationId = uid();
        S.chat.items = [];
        S.chat.totals = { cost: 0, tokens: 0, replies: 0 };
        S.focusAfter = "#chat-input";
        render();
        break;
      case "approve":
      case "deny": {
        const approvalId = el.dataset.approval ?? "";
        const t = S.chat.items.find((x) => x.k === "tool" && x.approvalId === approvalId) as Extract<ChatItem, { k: "tool" }> | undefined;
        if (t) {
          t.busy = true;
          updateItem(t);
        }
        void api("/api/approval", { body: { approvalId, approved: act === "approve" } }).catch((err: Error) => {
          toast("err", "Could not send your answer", err.message);
          if (t) {
            t.busy = false;
            updateItem(t);
          }
        });
        break;
      }
    }
  });

  document.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "tool-search") {
      S.toolQuery = (t as HTMLInputElement).value;
      refreshToolPanes();
    } else if (t.id === "prompt-editor") {
      S.draft = (t as HTMLTextAreaElement).value;
      const sp = spec();
      const m = document.getElementById("prompt-meta");
      if (m) m.innerHTML = promptMeta(S.draft);
      const d = document.getElementById("prompt-dirty");
      if (d && sp) d.textContent = (S.draft !== sp.systemPrompt ? "Unsaved changes" : "No changes") + " · Ctrl/⌘+S to save";
    } else if (t.id === "chat-input") {
      S.chat.draft = (t as HTMLTextAreaElement).value;
      autoGrow();
      const btn = document.querySelector("#composer .send:not(.stop)") as HTMLButtonElement | null;
      if (btn) btn.disabled = !S.chat.draft.trim();
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === "dry-run") {
      S.chat.dryRun = t.checked;
      const meta = document.getElementById("pg-meta");
      if (meta) meta.innerHTML = pgMeta();
    }
  });
  document.addEventListener("submit", (e) => {
    const f = e.target as HTMLElement;
    if (f.id === "composer") {
      e.preventDefault();
      void sendChat(S.chat.draft);
    }
  });
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const typing = t.closest("input, textarea, select, [contenteditable]") !== null;
    if (t.id === "chat-input" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendChat((t as HTMLTextAreaElement).value);
      return;
    }
    if (S.editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void savePrompt();
      return;
    }
    if (S.editing && e.key === "Escape" && S.section === "prompt") {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (t.id === "tool-search" && e.key === "Escape") {
      (t as HTMLInputElement).value = "";
      S.toolQuery = "";
      refreshToolPanes();
      return;
    }
    if (t.id === "tool-search" && e.key === "ArrowDown") {
      e.preventDefault();
      (document.querySelector("#tool-list .row-btn") as HTMLElement | null)?.focus();
      return;
    }
    if (t.classList.contains("row-btn") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const btns = [...document.querySelectorAll("#tool-list .row-btn")] as HTMLElement[];
      const i = btns.indexOf(t);
      const n = btns[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (n) n.focus();
      else if (e.key === "ArrowUp") (document.getElementById("tool-search") as HTMLElement | null)?.focus();
      return;
    }
    if (!typing && e.key === "/" && !e.metaKey && !e.ctrlKey) {
      const s = (document.getElementById("tool-search") ?? document.getElementById("chat-input")) as HTMLElement | null;
      if (s) {
        e.preventDefault();
        s.focus();
      }
    }
    if (e.key === "Escape" && S.chat.running && S.section === "playground") void stopChat();
  });

  window.addEventListener("hashchange", () => {
    parseRoute();
    render();
  });
  window.addEventListener("beforeunload", (e) => {
    const sp = spec();
    if (S.editing && sp && S.draft !== sp.systemPrompt) {
      e.preventDefault();
    }
  });
  let lastNarrow = window.matchMedia("(max-width: 860px)").matches;
  window.addEventListener("resize", () => {
    const n = window.matchMedia("(max-width: 860px)").matches;
    if (n !== lastNarrow && (S.section === "tools" || S.section === "files")) {
      lastNarrow = n;
      render();
    }
    lastNarrow = n;
  });

  parseRoute();
  render();
  void loadState();
  void connectEvents();
}
