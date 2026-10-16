import { scriptJson } from "../preview/page.js";
import { TOKEN_HEADER } from "../preview/security.js";
import { DECREE_VERSION } from "../version.js";
import { labClient } from "./client.js";

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderLabPage(opts: { token: string; nonce: string; projectName: string }): string {
  const boot = { tokenHeader: TOKEN_HEADER, version: DECREE_VERSION, projectName: opts.projectName };
  const script = `"use strict";\n(${labClient.toString()})(${scriptJson(boot)});\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="decree-token" content="${escAttr(opts.token)}">
<title>${escAttr(opts.projectName)} · decree lab</title>
<style nonce="${escAttr(opts.nonce)}">${CSS}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar" id="sidebar" aria-label="Models and evaluations"><div class="muted">Looking for local models…</div></aside>
  <main class="main" id="main"></main>
</div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script nonce="${escAttr(opts.nonce)}">${script}</script>
</body>
</html>`;
}

const CSS = String.raw`
:root{--bg:#f7f7f8;--panel:#fff;--panel-2:#f8f9fa;--border:#e7e8ec;--text:#0e1014;--text-2:#4a505c;--text-3:#7d8390;
--accent:#5b5bd6;--accent-soft:#eef0ff;--green:#15803d;--green-soft:#e8f7ee;--red:#c42b2b;--red-soft:#fdeeee;--amber:#b45309;--amber-soft:#fff4e0;
--font:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0a0b0d;--panel:#111317;--panel-2:#15171c;--border:#22252c;--text:#eceef3;--text-2:#a7adba;--text-3:#6e7482;
--accent:#8b8cf8;--accent-soft:rgba(129,130,248,.13);--green:#4ade80;--green-soft:rgba(74,222,128,.1);--red:#f87171;--red-soft:rgba(248,113,113,.1);--amber:#fbbf24;--amber-soft:rgba(251,191,36,.1)}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
code,pre,.mono{font-family:var(--mono);font-size:12.5px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px;margin:6px 0 0;max-height:320px;overflow:auto}
.app{display:grid;grid-template-columns:320px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;padding:16px 14px;border-right:1px solid var(--border);background:var(--panel-2);display:flex;flex-direction:column;gap:6px}
.main{padding:18px 28px 60px;min-width:0}
.brand{display:flex;gap:10px;align-items:center;margin-bottom:6px}
.logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#8182f8,#4f46e5);display:grid;place-items:center}
.logo svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2.6}
.brand-name{font-weight:650}.brand-sub{font-size:11.5px;color:var(--text-3)}
.project{border:1px solid var(--border);background:var(--panel);border-radius:10px;padding:10px 11px;margin-bottom:6px}
.project-name{font-weight:600}
.sec-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-top:10px}
.server{border:1px solid var(--border);background:var(--panel);border-radius:10px;padding:8px 10px}
.server-name{font-size:12.5px;font-weight:600;margin-bottom:4px}
.model,.dom{display:flex;gap:8px;align-items:flex-start;padding:4px 2px;cursor:pointer}
.model input,.dom input{margin-top:3px}
.model>span{display:flex;flex-direction:column}
.model-id{font-family:var(--mono);font-size:12.5px;word-break:break-all}
.muted{color:var(--text-3)}.small{font-size:12.5px}.tiny{font-size:11.5px}.upper{text-transform:uppercase;letter-spacing:.04em;margin-top:8px}
.bad{color:var(--red)}.good{color:var(--green)}
.row{display:flex;align-items:center;gap:10px}.gap{margin:8px 0}.grow{flex:1}
button{cursor:pointer;border:1px solid var(--border);background:var(--panel);border-radius:8px;padding:6px 12px}
button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.danger{background:var(--red);border-color:var(--red)}
button.block{width:100%;padding:9px;margin-top:6px}
button.ghost{background:transparent}button.sm{padding:2px 8px;font-size:12px;text-transform:none;letter-spacing:0}
select{border:1px solid var(--border);background:var(--panel);border-radius:6px;padding:3px 6px;margin-left:6px}
.foot{margin-top:8px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px}
.tab{border:none;background:none;border-bottom:2px solid transparent;border-radius:0;padding:8px 12px;color:var(--text-2)}
.tab.on{border-bottom-color:var(--accent);color:var(--text);font-weight:600}
h2{font-size:17px;margin:0 0 10px}h3{font-size:14px;margin:22px 0 8px}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
th,td{padding:8px 12px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--text-2);font-weight:600;background:var(--panel-2)}
th.mcol{text-align:right;font-family:var(--mono)}
table.card td:nth-child(n+3){text-align:right;min-width:130px}
tr.group td{background:var(--panel-2);font-weight:650;font-size:12.5px}
tr.avg td{font-weight:650}
td.na{color:var(--text-3)}
.num{font-variant-numeric:tabular-nums;font-weight:600}
td.alert{background:var(--red-soft);color:var(--red)}td.safe .num{color:var(--green)}
.bar{position:relative;height:6px;background:var(--panel-2);border:1px solid var(--border);border-radius:3px;margin:5px 0 3px auto;width:110px}
.bar .ci{position:absolute;top:0;bottom:0;background:var(--accent-soft)}
.bar .pt{position:absolute;top:-3px;width:2px;height:10px;background:var(--accent);margin-left:-1px}
.callout{margin:14px 0;padding:10px 12px;border-radius:8px;border:1px solid var(--border)}
.callout.bad{background:var(--red-soft);border-color:var(--red)}
.mdetail{border:1px solid var(--border);background:var(--panel);border-radius:10px;margin:8px 0;padding:8px 12px}
.mdetail summary{cursor:pointer}
.tailor{margin:8px 0;padding:8px 10px;background:var(--panel-2);border-radius:8px}
.res{display:flex;gap:8px;align-items:baseline;padding:5px 2px;border-top:1px solid var(--border);cursor:pointer}
.res .mark{width:14px;font-weight:700}.res.ok .mark{color:var(--green)}.res.fail .mark{color:var(--red)}
.detail{padding:4px 22px 10px}
.live{display:flex;flex-direction:column;gap:10px}
.livecard{border:1px solid var(--border);background:var(--panel);border-radius:10px;padding:10px 12px}
.progress{height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;margin:8px 0}
.progress span{display:block;height:100%;background:var(--accent);transition:width .2s}
.empty{padding:18px;border:1px dashed var(--border);border-radius:10px;color:var(--text-2)}
.empty.big{padding:40px;text-align:center;max-width:720px;margin:40px auto}
.big-title{font-size:18px;font-weight:650;margin-bottom:8px;color:var(--text)}
.dom-card{border:1px solid var(--border);background:var(--panel);border-radius:10px;padding:10px 12px;margin:10px 0}
.item{padding:6px 0;border-top:1px solid var(--border);margin-top:6px}
.pill{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--panel-2);border:1px solid var(--border);margin-left:6px}
.pill.safety{background:var(--amber-soft);color:var(--amber)}.pill.capability{background:var(--accent-soft)}
.chip{display:inline-block;font-size:12px;padding:2px 8px;border:1px solid var(--border);border-radius:999px;margin:2px}
table.hist tr{cursor:pointer}table.hist tr:hover td{background:var(--panel-2)}
.scroll{overflow-x:auto;border-radius:10px}
.toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px}
.toast{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 12px;box-shadow:0 6px 20px rgba(0,0,0,.15)}
.toast.bad{border-color:var(--red);color:var(--red)}
@media (max-width:820px){.app{grid-template-columns:1fr}.sidebar{position:static;height:auto}.main{padding:14px 16px 48px}h2{word-break:break-all}}
`;
