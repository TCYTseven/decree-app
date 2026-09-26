import { clientMain } from "./client.js";
import { renderMarkdown } from "./markdown.js";
import { TOKEN_HEADER } from "./security.js";
import { DECREE_VERSION } from "../version.js";

export interface PageOptions {
  token: string;
  nonce: string;
  projectName: string;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** JSON that is safe inside a <script> element. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

/** The client script: the markdown renderer + the app, both embedded via toString(). */
export function clientScript(boot: Record<string, unknown>): string {
  return `"use strict";\nconst __decreeMarkdown = (${renderMarkdown.toString()});\n(${clientMain.toString()})(${scriptJson(boot)}, __decreeMarkdown);\n`;
}

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c7cf8"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M11 9h5.5a7 7 0 0 1 0 14H11z" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/></svg>`,
  );

export function renderPage(opts: PageOptions): string {
  const boot = { tokenHeader: TOKEN_HEADER, version: DECREE_VERSION, projectName: opts.projectName };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="decree-token" content="${escAttr(opts.token)}">
<title>${escAttr(opts.projectName)} · decree preview</title>
<link rel="icon" href="${FAVICON}">
<style nonce="${escAttr(opts.nonce)}">${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app" id="app">
  <aside class="sidebar" id="sidebar" aria-label="Harness navigation"></aside>
  <main class="main" id="main" tabindex="-1">
    <div class="boot" id="view" aria-busy="true"><div class="spinner" aria-hidden="true"></div><span>Loading harness…</span></div>
  </main>
</div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script nonce="${escAttr(opts.nonce)}">${clientScript(boot)}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CSS = String.raw`
:root{
  --bg:#f7f7f8;--bg-grad:#fbfbfc;--panel:#ffffff;--panel-2:#f8f9fa;--panel-3:#f1f2f4;--hover:#f3f4f6;
  --border:#e7e8ec;--border-2:#dcdee3;--text:#0e1014;--text-2:#4a505c;--text-3:#7d8390;
  --accent:#5b5bd6;--accent-2:#4f46e5;--accent-soft:#eef0ff;--accent-text:#4338ca;--on-accent:#fff;
  --green:#15803d;--green-soft:#e8f7ee;--green-line:#bfe6cc;
  --blue:#1d4ed8;--blue-soft:#eaf1fe;--blue-line:#c7d8fb;
  --amber:#b45309;--amber-soft:#fff4e0;--amber-line:#f5d9a6;
  --red:#c42b2b;--red-soft:#fdeeee;--red-line:#f4c6c6;
  --violet:#7c3aed;--violet-soft:#f3edff;
  --code-bg:#f6f7f9;--shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);
  --shadow-lg:0 12px 32px -8px rgba(16,24,40,.18),0 4px 8px -4px rgba(16,24,40,.08);
  --ring:0 0 0 3px rgba(91,91,214,.28);
  --radius:10px;--radius-sm:7px;
  --font:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,"JetBrains Mono","Cascadia Code",Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0a0b0d;--bg-grad:#0d0e11;--panel:#111317;--panel-2:#15171c;--panel-3:#1b1e24;--hover:#1a1d23;
  --border:#22252c;--border-2:#2c3039;--text:#eceef3;--text-2:#a7adba;--text-3:#6e7482;
  --accent:#8b8cf8;--accent-2:#7c7cf8;--accent-soft:rgba(129,130,248,.13);--accent-text:#b4b5ff;--on-accent:#0b0b1a;
  --green:#4ade80;--green-soft:rgba(74,222,128,.1);--green-line:rgba(74,222,128,.28);
  --blue:#7aa7ff;--blue-soft:rgba(96,145,255,.12);--blue-line:rgba(96,145,255,.3);
  --amber:#fbbf24;--amber-soft:rgba(251,191,36,.1);--amber-line:rgba(251,191,36,.3);
  --red:#f87171;--red-soft:rgba(248,113,113,.1);--red-line:rgba(248,113,113,.3);
  --violet:#c4a5ff;--violet-soft:rgba(167,139,250,.12);
  --code-bg:#0e1013;--shadow:0 1px 2px rgba(0,0,0,.4);--shadow-lg:0 16px 40px -8px rgba(0,0,0,.6),0 0 0 1px var(--border);
  --ring:0 0 0 3px rgba(139,140,248,.35);color-scheme:dark;
}}
:root[data-theme=dark]{
  --bg:#0a0b0d;--bg-grad:#0d0e11;--panel:#111317;--panel-2:#15171c;--panel-3:#1b1e24;--hover:#1a1d23;
  --border:#22252c;--border-2:#2c3039;--text:#eceef3;--text-2:#a7adba;--text-3:#6e7482;
  --accent:#8b8cf8;--accent-2:#7c7cf8;--accent-soft:rgba(129,130,248,.13);--accent-text:#b4b5ff;--on-accent:#0b0b1a;
  --green:#4ade80;--green-soft:rgba(74,222,128,.1);--green-line:rgba(74,222,128,.28);
  --blue:#7aa7ff;--blue-soft:rgba(96,145,255,.12);--blue-line:rgba(96,145,255,.3);
  --amber:#fbbf24;--amber-soft:rgba(251,191,36,.1);--amber-line:rgba(251,191,36,.3);
  --red:#f87171;--red-soft:rgba(248,113,113,.1);--red-line:rgba(248,113,113,.3);
  --violet:#c4a5ff;--violet-soft:rgba(167,139,250,.12);
  --code-bg:#0e1013;--shadow:0 1px 2px rgba(0,0,0,.4);--shadow-lg:0 16px 40px -8px rgba(0,0,0,.6),0 0 0 1px var(--border);
  --ring:0 0 0 3px rgba(139,140,248,.35);color-scheme:dark;
}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:14px/1.55 var(--font);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
button,input,textarea,select{font:inherit;color:inherit}
a{color:var(--accent-text);text-decoration:none}
a:hover{text-decoration:underline}
code,pre,kbd,.mono{font-family:var(--mono);font-size:12.5px}
:focus{outline:none}
:focus-visible{outline:none;box-shadow:var(--ring);border-radius:6px}
::selection{background:var(--accent-soft)}
svg.i{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
svg.i.sm{width:14px;height:14px}svg.i.lg{width:20px;height:20px}
.skip{position:absolute;left:12px;top:-60px;z-index:100;background:var(--panel);padding:8px 12px;border-radius:8px;box-shadow:var(--shadow-lg)}
.skip:focus{top:12px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}

/* ---------- layout ---------- */
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--panel-2) 247px,var(--border) 247px,var(--border) 248px,transparent 248px)}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;padding:14px 12px;border-right:1px solid var(--border);background:var(--panel-2);overflow:auto}
.main{min-width:0;outline:none}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px}
.logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#8182f8,#4f46e5);display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18),0 2px 6px -1px rgba(79,70,229,.45);flex:none}
.logo svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2.6;stroke-linejoin:round}
.brand-name{font-weight:650;letter-spacing:-.01em}
.brand-sub{font-size:11.5px;color:var(--text-3);margin-top:-2px}
.project{margin:0 2px 10px;padding:10px 11px;border:1px solid var(--border);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow)}
.project-name{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.project-path{font-family:var(--mono);font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav{display:flex;flex-direction:column;gap:1px}
.nav-label{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);padding:12px 10px 6px}
.nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;color:var(--text-2);font-weight:500;text-decoration:none;white-space:nowrap}
.nav a:hover{background:var(--hover);color:var(--text)}
.nav a[aria-current=page]{background:var(--panel);color:var(--text);box-shadow:var(--shadow),inset 0 0 0 1px var(--border)}
.nav a[aria-current=page] svg{color:var(--accent)}
.nav .count{margin-left:auto;font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:8px;padding:12px 4px 2px}
.status-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);padding:0 6px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--text-3);flex:none}
.dot.live{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18);animation:pulse 2.4s ease-in-out infinite}
.dot.warn{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.18)}
.dot.off{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}
@keyframes pulse{50%{box-shadow:0 0 0 5px rgba(34,197,94,.06)}}
.theme-btn{display:flex;align-items:center;gap:8px;background:none;border:1px solid var(--border);border-radius:8px;padding:6px 9px;color:var(--text-2);cursor:pointer;font-size:12px}
.theme-btn:hover{background:var(--hover);color:var(--text)}
.side-foot .row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:0 2px}
.ver{font-size:11px;color:var(--text-3);font-family:var(--mono)}

.page{max-width:1180px;margin:0 auto;padding:28px 36px 64px}
.page.wide{max-width:none}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.page-head h1{font-size:22px;line-height:1.25;letter-spacing:-.02em;margin:0;font-weight:650}
.page-head p{margin:4px 0 0;color:var(--text-2);max-width:720px}
.eyebrow{font-size:12px;color:var(--text-3);font-weight:500;margin-bottom:4px;display:flex;align-items:center;gap:6px}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

/* ---------- primitives ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--border-2);background:var(--panel);color:var(--text);font-weight:550;font-size:13px;cursor:pointer;white-space:nowrap;box-shadow:var(--shadow);transition:background .12s,border-color .12s,transform .06s}
.btn:hover{background:var(--hover)}
.btn:active{transform:translateY(.5px)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn.primary{background:var(--text);color:var(--bg);border-color:transparent}
.btn.primary:hover{opacity:.9}
.btn.accent{background:var(--accent-2);color:#fff;border-color:transparent}
.btn.accent:hover{filter:brightness(1.08)}
.btn.danger{color:var(--red);border-color:var(--red-line)}
.btn.danger:hover{background:var(--red-soft)}
.btn.ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--text-2)}
.btn.ghost:hover{background:var(--hover);color:var(--text)}
.btn.sm{height:26px;padding:0 9px;font-size:12px;border-radius:7px}
.btn.icon{width:32px;padding:0}
kbd{display:inline-block;min-width:18px;padding:0 5px;border:1px solid var(--border-2);border-bottom-width:2px;border-radius:5px;font-size:11px;line-height:16px;color:var(--text-3);background:var(--panel);text-align:center}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px;border-bottom:1px solid var(--border)}
.card-head h2,.card-head h3{margin:0;font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px}
.card-head h2 svg,.card-head h3 svg{color:var(--text-3)}
.card-body{padding:14px 16px}
.muted{color:var(--text-2)}.dim{color:var(--text-3)}
.pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:550;border:1px solid var(--border);background:var(--panel-2);color:var(--text-2);white-space:nowrap}
.pill svg{width:12px;height:12px}
.pill.mono{font-family:var(--mono);font-weight:500;font-size:11.5px}
.pill.green{background:var(--green-soft);border-color:var(--green-line);color:var(--green)}
.pill.blue{background:var(--blue-soft);border-color:var(--blue-line);color:var(--blue)}
.pill.amber{background:var(--amber-soft);border-color:var(--amber-line);color:var(--amber)}
.pill.red{background:var(--red-soft);border-color:var(--red-line);color:var(--red)}
.pill.accent{background:var(--accent-soft);border-color:transparent;color:var(--accent-text)}
.pill.violet{background:var(--violet-soft);border-color:transparent;color:var(--violet)}
.kind{font-family:var(--mono);font-size:11px;color:var(--text-3);background:var(--panel-3);border-radius:5px;padding:1px 6px}
.method{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.02em;padding:2px 6px;border-radius:5px;background:var(--panel-3);color:var(--text-2)}
.method.GET{color:var(--green);background:var(--green-soft)}.method.POST{color:var(--blue);background:var(--blue-soft)}
.method.PUT,.method.PATCH{color:var(--amber);background:var(--amber-soft)}.method.DELETE{color:var(--red);background:var(--red-soft)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.callout{display:flex;gap:10px;padding:11px 13px;border-radius:var(--radius);border:1px solid var(--border);background:var(--panel-2);font-size:13px}
.callout svg{margin-top:2px}
.callout.amber{background:var(--amber-soft);border-color:var(--amber-line)}.callout.amber>svg{color:var(--amber)}
.callout.red{background:var(--red-soft);border-color:var(--red-line)}.callout.red>svg{color:var(--red)}
.callout.green{background:var(--green-soft);border-color:var(--green-line)}.callout.green>svg{color:var(--green)}
.callout.blue{background:var(--blue-soft);border-color:var(--blue-line)}.callout.blue>svg{color:var(--blue)}
.callout ul{margin:4px 0 0;padding-left:18px}.callout li{margin:2px 0}
.callout strong{font-weight:600}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:48px 24px;color:var(--text-2)}
.empty .ico{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--panel-3);color:var(--text-3);margin-bottom:6px}
.empty h3{margin:0;color:var(--text);font-size:15px;font-weight:600}
.empty p{margin:0;max-width:420px}
.input{height:34px;border:1px solid var(--border-2);border-radius:8px;background:var(--panel);padding:0 11px;width:100%;transition:border-color .12s,box-shadow .12s}
.input:focus{border-color:var(--accent);box-shadow:var(--ring)}
.search{position:relative;flex:1;min-width:180px}
.search svg{position:absolute;left:10px;top:9px;color:var(--text-3)}
.search .input{padding-left:32px;padding-right:34px}
.search kbd{position:absolute;right:8px;top:8px}
.search .input:focus~kbd,.search .input:not(:placeholder-shown)~kbd{display:none}
.search input::-webkit-search-cancel-button{-webkit-appearance:none;display:none}
.row-desc code,.desc code,.muted code,.params code{font-size:.88em;background:var(--panel-3);border-radius:4px;padding:0 4px}
.seg{display:inline-flex;padding:2px;border-radius:9px;background:var(--panel-3);border:1px solid var(--border);gap:2px;flex-wrap:wrap}
.seg button{border:0;background:transparent;height:26px;padding:0 10px;border-radius:7px;font-size:12.5px;font-weight:550;color:var(--text-2);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.seg button[aria-pressed=true]{background:var(--panel);color:var(--text);box-shadow:var(--shadow)}
.seg .n{color:var(--text-3);font-variant-numeric:tabular-nums;font-size:11.5px}
.kv{display:grid;grid-template-columns:minmax(110px,auto) 1fr;gap:9px 16px;margin:0;font-size:13px}
.kv dt{color:var(--text-3)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--border-2);border-top-color:var(--accent);animation:spin .7s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
.boot{display:flex;gap:10px;align-items:center;justify-content:center;height:60vh;color:var(--text-3)}
.switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;font-size:12.5px;color:var(--text-2);user-select:none}
.switch input{appearance:none;-webkit-appearance:none;width:30px;height:18px;border-radius:999px;background:var(--border-2);position:relative;cursor:pointer;margin:0;transition:background .15s;flex:none}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.switch input:checked{background:var(--accent-2)}
.switch input:checked::after{transform:translateX(12px)}
.switch input:focus-visible{box-shadow:var(--ring)}
table.t{width:100%;border-collapse:collapse;font-size:13px}
table.t th{text-align:left;font-weight:550;color:var(--text-3);font-size:12px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--panel-2)}
table.t td{padding:9px 16px;border-bottom:1px solid var(--border);vertical-align:top}
table.t tr:last-child td{border-bottom:0}
.table-wrap{overflow-x:auto}

/* ---------- overview ---------- */
.hero{display:flex;gap:18px;align-items:flex-start;justify-content:space-between;margin-bottom:22px;flex-wrap:wrap}
.hero h1{font-size:26px;letter-spacing:-.025em;margin:0 0 6px;font-weight:680;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hero p{margin:0;color:var(--text-2);max-width:760px;font-size:14.5px}
.goal{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:var(--radius);background:linear-gradient(135deg,var(--accent-soft),transparent 70%),var(--panel);border:1px solid var(--border);margin-bottom:18px;box-shadow:var(--shadow)}
.goal .gi{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);flex:none}
.goal .gl{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:600}
.goal .gt{font-size:15px;font-weight:550;margin-top:1px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}
.stat{padding:14px 16px;text-decoration:none;color:inherit;display:block;transition:border-color .12s,transform .12s}
a.stat:hover{text-decoration:none;border-color:var(--border-2);transform:translateY(-1px)}
.stat .sl{display:flex;align-items:center;gap:7px;color:var(--text-3);font-size:12.5px;font-weight:500}
.stat .sv{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums}
.stat .ss{font-size:12px;color:var(--text-3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px}
.stack{display:flex;flex-direction:column;gap:14px}
.bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--panel-3);gap:2px}
.bar span{display:block;height:100%}
.bar .g{background:#22c55e}.bar .b{background:#3b82f6}.bar .a{background:#f59e0b}.bar .r{background:#ef4444}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:12.5px;color:var(--text-2)}
.legend span{display:inline-flex;align-items:center;gap:7px}
.legend i{width:9px;height:9px;border-radius:3px;display:inline-block}
.legend b{font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
.notes{margin:0;padding-left:18px;color:var(--text-2)}
.notes li{margin:4px 0}
.env-ok{color:var(--green);display:inline-flex;align-items:center;gap:5px;font-size:12.5px}
.env-miss{color:var(--amber);display:inline-flex;align-items:center;gap:5px;font-size:12.5px}

/* ---------- tools ---------- */
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.split{display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);gap:16px;align-items:start}
.list{padding:6px;max-height:calc(100vh - 210px);overflow:auto;position:sticky;top:20px}
.row-btn{display:flex;flex-direction:column;gap:5px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:9px 10px;cursor:pointer;color:inherit}
.row-btn:hover{background:var(--hover)}
.row-btn[aria-current=true]{background:var(--accent-soft);border-color:transparent}
.row-top{display:flex;align-items:center;gap:8px;min-width:0}
.row-name{font-family:var(--mono);font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-desc{font-size:12.5px;color:var(--text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sdot{width:7px;height:7px;border-radius:50%;flex:none;margin-left:auto}
.sdot.g{background:#22c55e}.sdot.b{background:#3b82f6}.sdot.a{background:#f59e0b}.sdot.r{background:#ef4444}
.detail{min-width:0}
.detail-head{padding:18px 20px 16px;border-bottom:1px solid var(--border)}
.detail-head h2{margin:0;font-family:var(--mono);font-size:17px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere}
.detail-head .chips{margin-top:10px}
.detail-sec{padding:16px 20px;border-bottom:1px solid var(--border)}
.detail-sec:last-child{border-bottom:0}
.sec-title{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:600;margin:0 0 10px;display:flex;align-items:center;gap:6px}
.desc{white-space:pre-wrap;margin:0;color:var(--text);font-size:13.5px}
.binding{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;overflow-x:auto;white-space:nowrap}
.params{width:100%;border-collapse:collapse;font-size:13px}
.params td{padding:9px 0;border-top:1px solid var(--border);vertical-align:top}
.params tr:first-child td{border-top:0}
.params td:first-child{width:36%;padding-right:12px}
.pname{font-family:var(--mono);font-weight:600;font-size:12.5px}
.req{font-size:10.5px;color:var(--amber);font-weight:600;margin-left:6px;text-transform:uppercase;letter-spacing:.03em}
.ptype{font-family:var(--mono);font-size:11.5px;color:var(--violet);margin-top:2px}
.penum{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
.back{display:none}
details.raw summary{cursor:pointer;color:var(--text-2);font-size:12.5px;font-weight:550;display:inline-flex;align-items:center;gap:6px;list-style:none;padding:4px 0;border-radius:6px}
details.raw summary::-webkit-details-marker{display:none}
details.raw summary::before{content:"";width:6px;height:6px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(-45deg);transition:transform .15s;margin:0 3px}
details.raw[open] summary::before{transform:rotate(45deg)}
pre.json,pre.codeblock{margin:10px 0 0;padding:12px 14px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px;overflow:auto;max-height:420px;line-height:1.55}
.j-k{color:var(--accent-text)}.j-s{color:var(--green)}.j-n{color:var(--amber)}.j-b{color:var(--violet)}.j-p{color:var(--text-3)}

/* ---------- markdown ---------- */
.md{font-size:14.5px;line-height:1.7;color:var(--text);overflow-wrap:anywhere}
.md>:first-child{margin-top:0}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{letter-spacing:-.015em;line-height:1.3;margin:1.6em 0 .5em;font-weight:650}
.md h1{font-size:20px;padding-bottom:.35em;border-bottom:1px solid var(--border)}
.md h2{font-size:17px}.md h3{font-size:15px}.md h4,.md h5,.md h6{font-size:14px}
.md p{margin:.6em 0}
.md ul,.md ol{padding-left:1.4em;margin:.5em 0}
.md li{margin:.25em 0}
.md li::marker{color:var(--text-3)}
.md code{background:var(--panel-3);border:1px solid var(--border);padding:.1em .38em;border-radius:5px;font-size:.86em}
.md pre{background:var(--code-bg);border:1px solid var(--border);padding:12px 14px;border-radius:8px;overflow:auto;line-height:1.5}
.md pre code{background:none;border:0;padding:0;font-size:12.5px}
.md blockquote{margin:.8em 0;padding:.1em 1em;border-left:3px solid var(--border-2);color:var(--text-2)}
.md hr{border:0;border-top:1px solid var(--border);margin:1.5em 0}
.md a{text-decoration:underline;text-underline-offset:2px}
.md strong{font-weight:650}
.md .md-table{overflow-x:auto;margin:.8em 0}
.md table{border-collapse:collapse;font-size:13px}
.md th,.md td{border:1px solid var(--border);padding:6px 10px}
.md th{background:var(--panel-2);font-weight:600}
.md li.task{list-style:none;margin-left:-1.3em;display:flex;gap:8px;align-items:baseline}
.md .check{width:13px;height:13px;border:1.5px solid var(--border-2);border-radius:4px;display:inline-block;flex:none;transform:translateY(2px)}
.md .check.done{background:var(--accent-2);border-color:var(--accent-2)}

/* ---------- prompt ---------- */
.doc-wrap{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:24px;align-items:start}
.doc{padding:28px 36px}
.toc{position:sticky;top:24px;font-size:12.5px}
.toc h4{margin:0 0 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)}
.toc button{display:block;width:100%;text-align:left;background:none;border:0;padding:4px 8px;border-radius:6px;color:var(--text-2);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc button:hover{background:var(--hover);color:var(--text)}
.toc button.l2{padding-left:18px}.toc button.l3{padding-left:28px}
.editor{width:100%;min-height:62vh;resize:vertical;border:1px solid var(--border-2);border-radius:var(--radius);background:var(--panel);padding:16px 18px;font:13px/1.65 var(--mono);color:var(--text);tab-size:2;box-shadow:var(--shadow)}
.editor:focus{border-color:var(--accent);box-shadow:var(--ring)}
.editor-foot{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:12px;color:var(--text-3);flex-wrap:wrap}
.meta-line{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-3)}
.meta-line span{display:inline-flex;align-items:center;gap:6px}

/* ---------- subagents ---------- */
.agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
.agent-card{display:flex;flex-direction:column}
.agent-card .card-body{display:flex;flex-direction:column;gap:12px;flex:1}
.avatar{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--violet-soft);color:var(--violet);flex:none}
.agent-title{display:flex;gap:11px;align-items:center}
.agent-title h3{margin:0;font-family:var(--mono);font-size:14px;font-weight:650}
.agent-card .md{font-size:13px;max-height:320px;overflow:auto;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--panel-2);margin-top:10px}
a.chip-link{text-decoration:none}
a.chip-link:hover .pill{border-color:var(--border-2);color:var(--text)}

/* ---------- evals ---------- */
.eval-sum{display:flex;align-items:center;gap:18px;padding:14px 16px;margin-bottom:14px;flex-wrap:wrap}
.eval-sum .big{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.eval-sum .bar{flex:1;min-width:160px}
.evals{display:flex;flex-direction:column;gap:10px}
.eval{padding:14px 16px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 16px}
.eval-id{font-family:var(--mono);font-weight:650;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.eval-input{margin:6px 0 10px;color:var(--text);font-size:13.5px;padding-left:11px;border-left:2px solid var(--border-2)}
.eval-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.checks{grid-column:1/-1;margin:0;padding:10px 12px;list-style:none;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;font-size:12.5px;display:flex;flex-direction:column;gap:5px}
.checks li{display:flex;gap:8px;align-items:flex-start}
.checks .ok{color:var(--green)}.checks .no{color:var(--red)}.checks .sk{color:var(--text-3)}
.checks .cd{color:var(--text-3)}
.final{grid-column:1/-1;font-size:12.5px;color:var(--text-2)}
.final summary{cursor:pointer}

/* ---------- files ---------- */
.files-split{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:16px;align-items:start}
.tree{padding:8px 6px;max-height:calc(100vh - 200px);overflow:auto;position:sticky;top:20px;font-size:13px}
.tree details>summary{list-style:none;display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:6px;cursor:pointer;color:var(--text-2);font-weight:550;white-space:nowrap}
.tree details>summary::-webkit-details-marker{display:none}
.tree details>summary:hover{background:var(--hover)}
.tree details>summary .chev{transition:transform .15s;color:var(--text-3)}
.tree details[open]>summary .chev{transform:rotate(90deg)}
.tree .kids{padding-left:14px;margin-left:10px;border-left:1px solid var(--border)}
.tree button{display:flex;align-items:center;gap:7px;width:100%;background:none;border:0;padding:4px 8px;border-radius:6px;cursor:pointer;text-align:left;color:var(--text-2);white-space:nowrap}
.tree button:hover{background:var(--hover);color:var(--text)}
.tree button[aria-current=true]{background:var(--accent-soft);color:var(--accent-text)}
.tree .fname{overflow:hidden;text-overflow:ellipsis}
.fst{width:6px;height:6px;border-radius:50%;margin-left:auto;flex:none}
.fst.new{background:#22c55e}.fst.changed{background:#3b82f6}.fst.edited{background:#f59e0b}.fst.unchanged{background:transparent}
.viewer{min-width:0;overflow:hidden}
.viewer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--panel-2);flex-wrap:wrap}
.crumbs{font-family:var(--mono);font-size:12.5px;color:var(--text-2);overflow-wrap:anywhere}
.crumbs b{color:var(--text);font-weight:600}
pre.code{margin:0;padding:12px 0;overflow:auto;max-height:calc(100vh - 250px);font-size:12.5px;line-height:1.6;background:var(--code-bg);counter-reset:ln}
pre.code .ln{display:block;padding:0 16px 0 0;white-space:pre}
pre.code .ln::before{counter-increment:ln;content:counter(ln);display:inline-block;width:3.2em;padding-right:1em;margin-right:12px;text-align:right;color:var(--text-3);opacity:.7;user-select:none;border-right:1px solid var(--border)}
.c-com{color:var(--text-3);font-style:italic}.c-str{color:var(--green)}.c-kw{color:var(--violet)}.c-num{color:var(--amber)}
.legend-files{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-2)}
.legend-files span{display:inline-flex;align-items:center;gap:6px}

/* ---------- playground ---------- */
.pg{display:flex;flex-direction:column;height:100vh;max-width:none}
.pg-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 28px;border-bottom:1px solid var(--border);background:var(--panel);flex-wrap:wrap}
.pg-head h1{font-size:15px;margin:0;font-weight:650;display:flex;align-items:center;gap:8px}
.pg-scroll{flex:1;overflow:auto;padding:24px 28px 12px;scroll-behavior:smooth}
.pg-inner{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.msg-user{align-self:flex-end;max-width:80%;background:var(--text);color:var(--bg);padding:9px 14px;border-radius:14px 14px 4px 14px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}
.msg-ai{display:flex;gap:12px;align-items:flex-start}
.msg-ai .av{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#8182f8,#4f46e5);display:grid;place-items:center;flex:none;margin-top:2px}
.msg-ai .av svg{width:14px;height:14px;stroke:#fff;fill:none;stroke-width:2.6;stroke-linejoin:round}
.msg-ai .md{flex:1;min-width:0;font-size:14px}
.caret{display:inline-block;width:7px;height:15px;background:var(--accent);border-radius:2px;vertical-align:-2px;margin-left:2px;animation:blink 1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}
.think{margin-left:38px;font-size:12.5px;color:var(--text-3)}
.think summary{cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.think div{white-space:pre-wrap;padding:8px 12px;border-left:2px solid var(--border-2);margin-top:6px}
.tc{margin-left:38px;border:1px solid var(--border);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow);overflow:hidden}
.tc.approval{border-color:var(--amber-line);box-shadow:0 0 0 3px var(--amber-soft)}
.tc-head{display:flex;align-items:center;gap:9px;padding:9px 12px;font-size:13px;flex-wrap:wrap}
.tc-head .tn{font-family:var(--mono);font-weight:650;font-size:12.5px}
.tc-head .st{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-3)}
.tc-ic{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;background:var(--panel-3);color:var(--text-2);flex:none}
.tc-ic svg{width:13px;height:13px}
.tc details{border-top:1px solid var(--border)}
.tc details summary{cursor:pointer;padding:7px 12px;font-size:12px;color:var(--text-2);font-weight:550;list-style:none;display:flex;align-items:center;gap:6px}
.tc details summary::-webkit-details-marker{display:none}
.tc details summary::before{content:"";width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s;margin:0 3px}
.tc details[open] summary::before{transform:rotate(45deg)}
.tc pre{margin:0;padding:10px 14px;background:var(--code-bg);border-top:1px solid var(--border);max-height:280px;overflow:auto;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.tc pre.err{color:var(--red)}
.approve{display:flex;align-items:center;gap:10px;padding:11px 12px;background:var(--amber-soft);border-top:1px solid var(--amber-line);font-size:13px;flex-wrap:wrap}
.approve svg{color:var(--amber)}
.approve .q{flex:1;min-width:200px}
.approve-btns{display:flex;gap:8px;margin-left:auto}
.pg-err{margin-left:38px}
.stats-line{margin-left:38px;display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-3);font-variant-numeric:tabular-nums}
.stats-line span{display:inline-flex;align-items:center;gap:5px}
.pg-foot{border-top:1px solid var(--border);background:var(--panel);padding:12px 28px 16px}
.composer{max-width:820px;margin:0 auto;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--border-2);border-radius:14px;padding:8px 8px 8px 14px;background:var(--panel);box-shadow:var(--shadow);transition:border-color .12s,box-shadow .12s}
.composer:focus-within{border-color:var(--accent);box-shadow:var(--ring)}
.composer textarea{flex:1;border:0;outline:0;background:transparent;resize:none;min-height:24px;max-height:200px;padding:5px 0;line-height:1.5;font-size:14px}
.composer textarea:focus-visible{box-shadow:none}
.send{width:34px;height:34px;border-radius:10px;border:0;background:var(--text);color:var(--bg);display:grid;place-items:center;cursor:pointer;flex:none}
.send[disabled]{opacity:.35;cursor:not-allowed}
.send.stop{background:var(--red);color:#fff}
.pg-meta{max-width:820px;margin:8px auto 0;display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--text-3);flex-wrap:wrap}
.suggest{display:flex;flex-direction:column;gap:8px;margin-top:18px;width:100%;max-width:560px}
.suggest button{text-align:left;border:1px solid var(--border);background:var(--panel);border-radius:10px;padding:10px 14px;cursor:pointer;color:var(--text);font-size:13.5px;display:flex;gap:10px;align-items:center;box-shadow:var(--shadow)}
.suggest button:hover{border-color:var(--border-2);background:var(--hover)}
.suggest button svg{color:var(--text-3)}
.nokey{max-width:620px;margin:6vh auto;padding:28px}
.nokey h2{margin:12px 0 6px;font-size:18px;letter-spacing:-.01em}
.nokey ol{padding-left:18px;margin:14px 0;color:var(--text-2)}
.nokey li{margin:10px 0}
.nokey pre{margin:6px 0 0;padding:9px 12px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px;overflow:auto}

/* ---------- toasts ---------- */
.toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:50;pointer-events:none}
.toast{pointer-events:auto;display:flex;gap:10px;align-items:flex-start;min-width:260px;max-width:380px;padding:11px 14px;border-radius:10px;background:var(--panel);border:1px solid var(--border);box-shadow:var(--shadow-lg);font-size:13px;animation:tin .18s ease-out}
.toast svg{margin-top:2px}
.toast.ok svg{color:var(--green)}.toast.err svg{color:var(--red)}.toast.info svg{color:var(--accent)}
.toast .tt{font-weight:600}.toast .td{color:var(--text-2);font-size:12.5px}
@keyframes tin{from{opacity:0;transform:translateY(6px)}}
.toasts.lift{bottom:118px}
@media (max-width:860px){.toasts,.toasts.lift{bottom:auto;top:62px;left:12px;right:12px}.toast{min-width:0;max-width:none}}

/* ---------- responsive ---------- */
@media (max-width:1100px){.doc-wrap{grid-template-columns:minmax(0,1fr)}.toc{display:none}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:860px){
  .app{grid-template-columns:minmax(0,1fr);background:none}
  .sidebar{position:sticky;top:0;z-index:20;height:auto;flex-direction:row;align-items:center;gap:8px;padding:8px 10px;border-right:0;border-bottom:1px solid var(--border);overflow:visible;background:color-mix(in srgb,var(--panel-2) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px)}
  .brand{padding:0}.brand-text,.project,.nav-label,.side-foot .status-text,.ver,.side-foot .row .theme-label{display:none}
  .nav{flex-direction:row;overflow-x:auto;scrollbar-width:none;flex:1;gap:2px;padding:2px}
  .nav::-webkit-scrollbar{display:none}
  .nav{-webkit-mask-image:linear-gradient(to right,#000 85%,transparent);mask-image:linear-gradient(to right,#000 85%,transparent)}
  .approve .q{flex-basis:100%}
  .nav a{padding:6px 10px;font-size:13px}
  .nav .count{display:none}
  .side-foot{margin:0;padding:0;flex-direction:row;gap:6px}
  .status-row{padding:0}
  .page{padding:20px 16px 48px}
  .split,.files-split{grid-template-columns:minmax(0,1fr)}
  .list,.tree{position:static;max-height:none}
  .split.has-sel .list-col{display:none}
  .split:not(.has-sel) .detail{display:none}
  .files-split.has-sel .tree-col{display:none}
  .files-split:not(.has-sel) .viewer{display:none}
  .back{display:inline-flex}
  .grid2{grid-template-columns:minmax(0,1fr)}
  .pg{height:calc(100vh - 53px);height:calc(100dvh - 53px)}
  .pg-head,.pg-scroll,.pg-foot{padding-left:14px;padding-right:14px}
  .tc,.think,.stats-line,.pg-err{margin-left:0}
  .doc{padding:20px 18px}
  .eval{grid-template-columns:minmax(0,1fr)}
  .eval-side{flex-direction:row;align-items:center;justify-content:space-between}
  .hero h1{font-size:22px}
  .msg-user{max-width:92%}
  .agents{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:480px){.stats{gap:8px}.stat{padding:12px}.stat .sv{font-size:22px}.page-head h1{font-size:19px}.kv{grid-template-columns:minmax(0,1fr)}.kv dt{margin-top:4px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
