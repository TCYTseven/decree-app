#!/usr/bin/env python3
"""Generates the static decree-harness site (site/) from real CLI output captured by capture.sh."""
import html, json, os, re

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "site")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
DEMO_DECREE = os.path.join(OUT, "demo-decree.json")
GH = "https://github.com/TCYTseven/decree-app"
VERSION = "0.1.0"

def esc(s): return html.escape(s, quote=False)
def attr(s): return html.escape(s, quote=True)
def read(p): return open(p, encoding="utf-8").read()

# ---------------------------------------------------------------- icons
I = {
 "copy": '<svg class="i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
 "check": '<svg class="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
 "gh": '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.35 1.11 2.92.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.84c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9l-.01 2.81c0 .27.18.6.69.49A10.24 10.24 0 0 0 22 12.23C22 6.58 17.52 2 12 2z"/></svg>',
 "sun": '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
 "moon": '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
 "arrow": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
 "chev": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
 "replay": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
}
LOGO = ('<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="var(--accent)"/>'
        '<circle cx="16" cy="16" r="10.5" fill="none" stroke="var(--accent-fg)" stroke-width="1.5" stroke-dasharray="2.2 2.2"/>'
        '<path d="M11.5 16.4l3.1 3.1 6-6.6" fill="none" stroke="var(--accent-fg)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>')

def copy_btn(label="Copy", data=None, sr=None):
    d = f' data-copy="{attr(data)}"' if data else ""
    aria = f' aria-label="{attr(sr)}"' if sr else ""
    return f'<button type="button" class="copy-btn"{d}{aria}>{I["copy"]}{I["check"]}<span class="copy-label">{label}</span></button>'

# ---------------------------------------------------------------- highlighting
def hl_json(src):
    out = []
    tok = re.compile(r'(//[^\n]*)|("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b|([^"/\-\dtfn]+|.)', re.S)
    for m in tok.finditer(src):
        com, s, colon, num, kw, other = m.groups()
        if com: out.append(f'<span class="c-com">{esc(com)}</span>')
        elif s is not None:
            if colon: out.append(f'<span class="c-key">{esc(s)}</span>{esc(colon)}')
            else: out.append(f'<span class="c-str">{esc(s)}</span>')
        elif num is not None: out.append(f'<span class="c-num">{esc(num)}</span>')
        elif kw: out.append(f'<span class="c-kw">{kw}</span>')
        else: out.append(esc(other))
    return "".join(out)

def hl_sh(src):
    lines = []
    for line in src.split("\n"):
        if line.startswith("$ "):
            body = line[2:]
            m = re.match(r"^(.*?)(\s+#.*)?$", body)
            cmd, com = m.group(1), m.group(2) or ""
            cmd_h = re.sub(r"(\s)(--?[a-zA-Z][\w-]*)", lambda mm: mm.group(1) + f'<span class="c-flag">{mm.group(2)}</span>', esc(cmd))
            lines.append(f'<span class="c-prompt">$ </span>{cmd_h}' + (f'<span class="c-com">{esc(com)}</span>' if com else ""))
        elif line.lstrip().startswith("#"):
            lines.append(f'<span class="c-com">{esc(line)}</span>')
        else:
            lines.append(esc(line))
    return "\n".join(lines)

def code(src, lang="sh", title=None, copy=True, raw=False):
    if not title and copy and lang == "sh": title = "Terminal"
    body = src if raw else (hl_json(src) if lang == "json" else hl_sh(src) if lang == "sh" else esc(src))
    if title:
        head = f'<div class="code-head"><span>{esc(title)}</span>{copy_btn("Copy", sr=("Copy commands" if title == "Terminal" else "Copy " + title)) if copy else ""}</div>'
        return f'<div class="code">{head}<pre><code>{body}</code></pre></div>'
    cls = "code no-head" if copy else "code"
    return f'<div class="{cls}">{copy_btn("Copy", sr="Copy code") if copy else ""}<pre><code>{body}</code></pre></div>'

# ---------------------------------------------------------------- page shell
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500;600&amp;family=Instrument+Serif:ital@0;1&amp;display=swap">')

def head(title, desc, pre):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{attr(desc)}">
<meta property="og:title" content="{attr(title)}">
<meta property="og:description" content="{attr(desc)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#faf9f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f0f0d" media="(prefers-color-scheme: dark)">
<link rel="icon" href="{pre}assets/favicon.svg" type="image/svg+xml">
<script>(function(){{var d=document.documentElement;d.classList.add("js");try{{var t=localStorage.getItem("decree-theme");if(t==="light"||t==="dark")d.setAttribute("data-theme",t);}}catch(e){{}}}})();</script>
{FONTS}
<link rel="stylesheet" href="{pre}assets/style.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div id="live" class="sr-only" aria-live="polite"></div>
'''

def header(pre, active):
    def nav(href, label, key, cls=""):
        cur = ' aria-current="page"' if key == active else ""
        c = f' class="{cls}"' if cls else ""
        return f'<a href="{href}"{cur}{c}>{label}</a>'
    return f'''<header class="site-header">
  <div class="container header-inner">
    <a class="brand" href="{pre}index.html">{LOGO}<span>decree</span><span class="brand-tag">v{VERSION}</span></a>
    <nav class="nav" aria-label="Primary">
      {nav(pre + "docs/index.html", "Docs", "docs")}
      {nav(pre + "docs/commands.html", "Commands", "commands", "nav-hide-sm")}
      {nav(pre + "docs/config.html", "decree.json", "config", "nav-hide-sm")}
      <a class="icon-btn gh-link" href="{GH}">{I["gh"]}<span class="gh-label">GitHub</span><span class="sr-only"> (decree-app repository)</span></a>
      <button type="button" class="icon-btn theme-toggle" data-theme-toggle aria-label="Toggle color theme">{I["moon"]}{I["sun"]}</button>
    </nav>
  </div>
</header>
'''

def footer(pre):
    return f'''<footer class="site-footer">
  <div class="container footer-inner">
    <div>
      <a class="brand" href="{pre}index.html">{LOGO}<span>decree</span></a>
      <p>Open source under the MIT license. Built for Claude on the Anthropic API.</p>
    </div>
    <nav aria-label="Footer">
      <ul class="footer-links">
        <li><a href="{pre}docs/index.html">Quickstart</a></li>
        <li><a href="{pre}docs/commands.html">Commands</a></li>
        <li><a href="{pre}docs/config.html">decree.json</a></li>
        <li><a href="{pre}docs/targets.html">Targets</a></li>
        <li><a href="{pre}docs/safety.html">Safety</a></li>
        <li><a href="{pre}docs/faq.html">FAQ</a></li>
        <li><a href="{GH}">GitHub</a></li>
      </ul>
    </nav>
  </div>
</footer>
<script src="{pre}assets/site.js" defer></script>
</body>
</html>
'''

# ---------------------------------------------------------------- terminal
BOX = "┌┐└┘├┤┬┴┼─│"

def color_term_line(raw):
    h = esc(raw)
    # clack gutter / markers at the start of the line
    m = re.match(r"^(\|)(.*)$", h)
    prefix = ""
    if raw.startswith("T   decree"):
        return re.sub(r"^T(\s+)decree(\s+)(v[\d.]+)(.*)$", r'<span class="t-r">T</span>\1<span class="t-bold">decree</span>\2<span class="t-dim">\3\4</span>', h)
    if m:
        prefix, h = '<span class="t-dim">|</span>', m.group(2)
    else:
        mm = re.match(r"^([*o•—])(\s.*)?$", h)
        if mm:
            sym = mm.group(1)
            cls = {"*": "t-g", "o": "t-g", "•": "t-b", "—": "t-dim"}[sym]
            prefix, h = f'<span class="{cls}">{sym}</span>', mm.group(2) or ""
    # box drawing
    h = re.sub("([" + BOX + "+]+)", r'<span class="t-dim">\1</span>', h)
    h = re.sub(r"(-{6,})", r'<span class="t-dim">\1</span>', h)
    h = h.replace("● read-only", '<span class="t-g">● read-only</span>')
    h = h.replace("• writes", '<span class="t-b">• writes</span>')
    h = re.sub(r"(▲ approval[^ <]*(?: destruc…)?)", r'<span class="t-a">\1</span>', h)
    h = re.sub(r"\b(GET|POST|DELETE|PUT|PATCH)(?= /)", r'<span class="t-c">\1</span>', h)
    h = re.sub(r"(\d+(?:\.\d+)?m?s)(\s*)$", r'<span class="t-dim">\1</span>\2', h)
    h = re.sub(r" (created)", r' <span class="t-dim">\1</span>', h)
    h = h.replace("✓", '<span class="t-g">✓</span>').replace("▲ ", '<span class="t-a">▲</span> ').replace("○", '<span class="t-dim">○</span>')
    h = re.sub(r"(›)", r'<span class="t-dim">\1</span>', h)
    return prefix + h

def term_panel(pid, command, lines, pauses, hidden):
    out = [f'<span class="ln"><span class="t-g">❯</span> <span class="t-cmd" data-type>{esc(command)}</span>\n</span>']
    for raw in lines:
        p = 0
        for key, ms in pauses:
            if key in raw: p = ms
        pa = f' data-pause="{p}"' if p else ""
        out.append(f'<span class="ln"{pa}>{color_term_line(raw)}\n</span>')
    out.append('<span class="ln"><span class="t-g">❯</span> <span class="t-caret"></span></span>')
    hid = " hidden" if hidden else ""
    return f'<pre id="{pid}" role="tabpanel" aria-labelledby="{pid}-tab"{hid}>{"".join(out)}</pre>'

def load_init_lines():
    lines = read(os.path.join(OUT, "init.txt")).rstrip("\n").split("\n")
    res = []
    skip = 0
    for ln in lines:
        if skip: skip -= 1; continue
        if ln.startswith("o  Project acme-orders "):
            ln = "o  Project acme-orders"
        if ln.strip().startswith("|  cd /tmp/"):
            skip = 1; continue
        res.append(ln)
    return res

def terminal():
    init = load_init_lines()
    tools = read(os.path.join(OUT, "tools.txt")).rstrip("\n").split("\n")
    doctor = read(os.path.join(OUT, "doctor.txt")).rstrip("\n").split("\n")
    p_init = [("Scanned", 420), ("Stack ", 60), ("Goal ›", 300), ("Planned", 650), ("Wrote decree.json", 300), ("Wrote agent/", 350), ("Next steps", 200), ("Your harness is ready", 250)]
    p_tools = [("Subagents", 150)]
    p_doc = [("Node.js", 250), ("Anthropic API key", 120), ("decree.json", 120), ("Tool env vars", 120), ("Generated code", 120), ("Network", 120), ("OK with", 250)]
    tabs = [("init", "npx decree-harness init --yes --offline --targets all", init, p_init),
            ("tools", "npx decree-harness tools", tools, p_tools),
            ("doctor", "npx decree-harness doctor", doctor, p_doc)]
    tab_html, panels = [], []
    for i, (name, cmd, lines, pauses) in enumerate(tabs):
        sel = "true" if i == 0 else "false"
        ti = "0" if i == 0 else "-1"
        tab_html.append(f'<button type="button" role="tab" id="term-{name}-tab" aria-controls="term-{name}" aria-selected="{sel}" tabindex="{ti}" class="term-tab">{name}</button>')
        panels.append(term_panel(f"term-{name}", cmd, lines, pauses, i != 0))
    return f'''<figure class="term-fig" style="margin:0">
  <div class="terminal" data-term>
    <div class="term-bar">
      <div class="term-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="term-tabs" role="tablist" aria-label="Example commands">{"".join(tab_html)}</div>
      <button type="button" class="term-replay">{I["replay"]}Replay</button>
    </div>
    <div class="term-body" tabindex="0" role="region" aria-label="Terminal output">{"".join(panels)}</div>
  </div>
  <figcaption class="term-caption">Real output from decree-harness {VERSION} on <a href="{GH}/tree/main/test/fixtures/express-openapi">test/fixtures/express-openapi</a>, an Express + OpenAPI orders service. Offline planner, no API key. Local paths removed.</figcaption>
</figure>'''

# ---------------------------------------------------------------- decree.json snippet (real, trimmed)
def decree_snippet():
    d = json.load(open(DEMO_DECREE))
    tool = dict(next(t for t in d["tools"] if t["name"] == "delete_order"))
    tool["description"] = tool["description"].split(". ")[0] + ". Calls DELETE /orders/{id}. …"
    tool["inputSchema"] = "__IS__"
    g = d["guardrails"]
    out = {
        "$schema": d["$schema"],
        "version": d["version"],
        "name": d["name"],
        "goal": d["goal"],
        "model": d["model"],
        "tools": [tool],
        "guardrails": {k: g[k] for k in ["maxTurns", "maxCostUsd", "approvalMode", "allowedPaths", "redactEnv"]},
        "targets": d["targets"],
    }
    s = json.dumps(out, indent=2, ensure_ascii=False)
    # compact short arrays/objects onto one line like a human would trim it
    def compact(m):
        inner = re.sub(r"\s*\n\s*", " ", m.group(0))
        return inner if len(inner) < 96 else m.group(0)
    s = re.sub(r'\[[^\[\]{}]*\]', compact, s)
    s = re.sub(r'\{[^\[\]{}]*\}', lambda m: compact(m) if '"type"' in m.group(0) or '"id": "claude' in m.group(0) else m.group(0), s)
    s = s.replace('"inputSchema": "__IS__"', '"inputSchema": {\n        "type": "object",\n        "properties": { "id": { "type": "string" } },\n        "required": [ "id" ]\n      }')
    n = len(d["tools"]) - 1
    s = s.replace('"source": "openapi:DELETE /orders/{id}"\n    }\n  ]',
                  '"source": "openapi:DELETE /orders/{id}"\n    }\n    // … ' + str(n) + ' more tools, plus subagents, evals, env\n  ]')
    return s, d

# ---------------------------------------------------------------- landing page
APPROVAL_NARROW = None
def index():
    global APPROVAL_NARROW
    APPROVAL_NARROW = code('''needsApproval(tool) =
  approvalMode == "never"       -> false
  approvalMode == "always"      -> !tool.readOnly
                                   || tool.requiresApproval
  approvalMode == "destructive" -> tool.requiresApproval
                                   || tool.destructive''', "text", "approval rule, from docs/ARCHITECTURE.md", copy=False)
    snippet, spec = decree_snippet()
    ntools = len(spec["tools"]); nsub = len(spec["subagents"]); nevals = len(spec["evals"])
    h = head("decree: generate an agent harness for your codebase",
             "decree-harness scans your repo and writes a system prompt, tools bound to your real endpoints and scripts, subagents, guardrails and evals as runnable TypeScript, Python, an MCP server and Claude Code config.", "")
    h += header("", "home")
    h += f'''<main id="main">
<section class="hero" aria-labelledby="hero-title">
  <div class="container hero-grid">
    <div>
      <p class="eyebrow"><span class="dot" aria-hidden="true"></span>Open source CLI · MIT · v{VERSION}</p>
      <h1 id="hero-title" class="display">An agent harness for your codebase, in <em>one command</em>.</h1>
      <p class="lede">decree scans your repo, then writes a system prompt, tools bound to the endpoints and scripts that actually exist, subagents, guardrails and evals. You get runnable TypeScript, Python, an MCP server and Claude Code config, all generated from one file you can edit.</p>
      <div class="hero-actions">
        <div class="cmd"><span class="prompt" aria-hidden="true">$</span><code>npx decree-harness</code>{copy_btn("Copy", "npx decree-harness", "Copy command: npx decree-harness")}</div>
        <div class="hero-links">
          <a class="btn btn-primary" href="docs/index.html">Read the quickstart {I["arrow"]}</a>
          <a class="btn btn-ghost" href="{GH}">{I["gh"]} View on GitHub</a>
        </div>
        <p class="hero-note">No API key yet? Add <code>--offline</code> for the heuristic planner.</p>
      </div>
      <ul class="facts" aria-label="At a glance">
        <li>Scans locally, no network</li>
        <li>Claude designs and critiques the plan</li>
        <li>Destructive tools always ask first</li>
        <li>Regenerate any time from decree.json</li>
      </ul>
    </div>
    {terminal()}
  </div>
</section>

<section class="section" id="how" aria-labelledby="how-title">
  <div class="container">
    <div class="section-head">
      <span class="sec-num">§ 1 &nbsp;How it works</span>
      <h2 id="how-title" class="h2">Scan, plan, generate, then run it.</h2>
      <p>Every tool in the harness points at something real in your repo: an OpenAPI operation, a route in code, a package script, or a file. A grounding pass drops anything that does not exist.</p>
    </div>
    <ol class="steps">
      <li class="step">
        <div class="step-k"><span>01</span><span class="tagline">local</span></div>
        <h3>Scan</h3>
        <p>Reads your project without touching the network.</p>
        <ul>
          <li>OpenAPI and Swagger specs</li>
          <li>Routes in Express, Fastify, Hono, NestJS, Next.js, FastAPI, Flask, Django, Gin, Echo, Chi, Rails</li>
          <li>Scripts, env var names, database models, README</li>
        </ul>
        <div class="step-cmd">decree-harness scan</div>
      </li>
      <li class="step">
        <div class="step-k"><span>02</span><span class="tagline">Claude</span></div>
        <h3>Plan</h3>
        <p>An architect pass designs the tools, prompt, subagents, guardrails and evals. A critic scores the draft on grounding, safety flags and eval coverage, then revises it.</p>
        <div class="step-cmd">decree-harness plan</div>
      </li>
      <li class="step">
        <div class="step-k"><span>03</span><span class="tagline">pure rendering</span></div>
        <h3>Generate</h3>
        <p>Renders <code>decree.json</code> into code for each target you pick. Files you edited by hand are left alone unless you pass <code>--force</code>.</p>
        <div class="step-cmd">decree-harness generate</div>
      </li>
      <li class="step">
        <div class="step-k"><span>04</span><span class="tagline">your terminal</span></div>
        <h3>Run and eval</h3>
        <p>Chat with the agent right away, run a one-shot prompt, or run the generated eval cases. Tools run in dry-run mode during evals by default.</p>
        <div class="step-cmd">decree-harness chat · run · eval</div>
      </li>
    </ol>
  </div>
</section>

<section class="section section-alt" id="targets" aria-labelledby="targets-title">
  <div class="container">
    <div class="section-head">
      <span class="sec-num">§ 2 &nbsp;What you get</span>
      <h2 id="targets-title" class="h2">Four targets from the same spec.</h2>
      <p>Pick any combination with <code>--targets typescript,python,mcp,claude-code</code> or <code>all</code>. On the orders fixture above, <code>--targets all</code> wrote {ntools} tools, {nsub} subagents and {nevals} evals into 66 files under <code>agent/</code>.</p>
    </div>
    <div class="targets">
      <article class="target">
        <div class="target-head"><h3>TypeScript agent</h3><span class="pill">typescript</span></div>
        <p>A standalone agent on the Anthropic TypeScript SDK: streaming loop, tools, subagents, CLI with a REPL, and an eval runner. Plain code you can read and change.</p>
        <div class="files" role="img" aria-label="Files: src/agent.ts, loop.ts, cli.ts, tools/http.ts, shell.ts, fs.ts, subagents.ts, evals.ts">src/agent.ts   loop.ts   cli.ts
src/tools/http.ts   shell.ts   fs.ts
src/subagents.ts   evals.ts</div>
        <div class="run"><span>run</span><code>cd agent/typescript &amp;&amp; npm install &amp;&amp; npm start</code></div>
      </article>
      <article class="target">
        <div class="target-head"><h3>Python agent</h3><span class="pill">python</span></div>
        <p>The same harness on the Anthropic Python SDK, packaged with <code>pyproject.toml</code>, a console script, an eval runner and pytest tool tests. Python 3.10 or newer.</p>
        <div class="files" role="img" aria-label="Files: acme_orders_agent/agent.py, cli.py, evals.py, tools/http.py, shell.py, fs.py, tests/test_tools.py">acme_orders_agent/agent.py   cli.py   evals.py
acme_orders_agent/tools/http.py   shell.py   fs.py
tests/test_tools.py</div>
        <div class="run"><span>run</span><code>cd agent/python &amp;&amp; uv sync &amp;&amp; uv run acme-orders-agent</code></div>
      </article>
      <article class="target">
        <div class="target-head"><h3>MCP server</h3><span class="pill">mcp</span></div>
        <p>A stdio Model Context Protocol server that exposes the harness tools and prompts to any MCP client, such as Claude Code, Claude Desktop or Cursor.</p>
        <div class="files" role="img" aria-label="Files: src/server.ts, src/tools.ts, src/harness.ts, src/config.ts">src/server.ts   tools.ts
src/harness.ts   config.ts</div>
        <div class="run"><span>run</span><code>cd agent/mcp-server &amp;&amp; npm install &amp;&amp; npm start</code></div>
      </article>
      <article class="target">
        <div class="target-head"><h3>Claude Code config</h3><span class="pill">claude-code</span></div>
        <p>A <code>CLAUDE.md</code>, agent and subagent files, skills, slash commands and a <code>settings.json</code> that allows read-only tools, asks before destructive ones and denies blocked commands.</p>
        <div class="files" role="img" aria-label="Files: CLAUDE.md, .mcp.json, .claude/agents, .claude/skills, .claude/commands, .claude/settings.json">CLAUDE.md   .mcp.json
.claude/agents/   skills/   commands/
.claude/settings.json</div>
        <div class="run"><span>use</span><code>cp -R agent/claude-code/CLAUDE.md agent/claude-code/.claude .</code></div>
      </article>
    </div>
    <div class="shared" aria-label="Files written for every target">
      <div><code>harness.md</code><p>Design doc: prompt, every tool, safety flags, planner notes. Review it in PRs.</p></div>
      <div><code>evals.json</code><p>Eval cases with expected tool calls, text checks and a rubric.</p></div>
      <div><code>.env.example</code><p>Every env var the tools read, with which ones are secret.</p></div>
      <div><code>.decree/manifest.json</code><p>Hashes of generated files, so <code>generate</code> skips files you edited.</p></div>
    </div>
  </div>
</section>

<section class="section" id="safety" aria-labelledby="safety-title">
  <div class="container split">
    <div>
      <div class="section-head" style="margin-bottom:28px">
        <span class="sec-num">§ 3 &nbsp;Safety model</span>
        <h2 id="safety-title" class="h2">The agent can read freely. Anything destructive waits for a human.</h2>
        <p>Guardrails are enforced by the generated code, not only by the prompt. Every target implements the same rules.</p>
      </div>
      <ul class="flags" aria-label="Tool flags">
        <li class="flag ro"><i aria-hidden="true"></i>readOnly</li>
        <li class="flag wr"><i aria-hidden="true"></i>writes</li>
        <li class="flag ap"><i aria-hidden="true"></i>destructive · requiresApproval</li>
      </ul>
      {APPROVAL_NARROW}
    </div>
    <ol class="rules">
      <li><span class="ix">01</span><div><strong>Approval on destructive tools</strong><p>Every tool carries <code>readOnly</code>, <code>destructive</code> and <code>requiresApproval</code>. The grounding pass forces approval on destructive tools, and a declined call goes back to the model as an error.</p></div></li>
      <li><span class="ix">02</span><div><strong>Files stay inside allowed paths</strong><p>File tools are confined to <code>guardrails.allowedPaths</code>, with a realpath check that catches symlink escapes.</p></div></li>
      <li><span class="ix">03</span><div><strong>Shell parameters are quoted</strong><p>Parameters are substituted with POSIX single quotes, values starting with <code>-</code> are refused, and commands containing a <code>blockedCommands</code> entry never run.</p></div></li>
      <li><span class="ix">04</span><div><strong>Secrets are redacted</strong><p>Values of env vars in <code>redactEnv</code> are replaced with <code>[REDACTED:NAME]</code> in tool output before the model sees it.</p></div></li>
      <li><span class="ix">05</span><div><strong>Runs are capped</strong><p><code>maxTurns</code> and <code>maxCostUsd</code> stop every run. Subagents only get read-only tools, since they cannot ask you to confirm.</p></div></li>
      <li><span class="ix">06</span><div><strong>Auth stays on your API's origin</strong><p>HTTP tools follow at most 5 redirects, and only on the same origin, so auth headers never leave your API.</p></div></li>
    </ol>
  </div>
</section>

<section class="section section-alt" id="config" aria-labelledby="config-title">
  <div class="container split">
    <div>
      <div class="section-head" style="margin-bottom:8px">
        <span class="sec-num">§ 4 &nbsp;decree.json</span>
        <h2 id="config-title" class="h2">One file is the source of truth.</h2>
        <p>Like a docs config for your agent. It sits at the root of your repo, it is readable in review, and every generated file comes from it.</p>
      </div>
      <ol class="loop">
        <li><strong>Edit</strong> <code>decree.json</code> by hand, with editor autocomplete from <code>.decree/schema.json</code>.</li>
        <li><strong>Or describe the change</strong>: <code>decree-harness refine "make it read-only"</code>.</li>
        <li><strong>Regenerate</strong> with <code>decree-harness generate</code>. Use <code>--dry-run</code> to preview and <code>--clean</code> to remove files that are no longer produced.</li>
        <li><strong>Check</strong> with <code>decree-harness doctor</code> and <code>decree-harness eval</code>.</li>
      </ol>
      <p style="margin:8px 0 0"><a class="btn btn-ghost" href="docs/config.html">decree.json reference {I["arrow"]}</a></p>
    </div>
    <div>
      {code(snippet, "json", "decree.json (trimmed)")}
      <p class="code-cap">From the fixture run above. The full file has {ntools} tools, {nsub} subagents, {nevals} evals and the env var list.</p>
    </div>
  </div>
</section>

<section class="section" id="commands" aria-labelledby="commands-title">
  <div class="container">
    <div class="section-head">
      <span class="sec-num">§ 5 &nbsp;Commands</span>
      <h2 id="commands-title" class="h2">Small CLI, one job per command.</h2>
      <p>Useful flags everywhere: <code>--yes</code> for non-interactive runs, <code>--offline</code>, <code>--model &lt;id&gt;</code>, <code>--goal "&lt;text&gt;"</code>, <code>--no-critique</code> and <code>-C &lt;dir&gt;</code>.</p>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Command</th><th scope="col">What it does</th></tr></thead>
        <tbody>
          <tr><td><a href="docs/commands.html#init"><code>init</code></a></td><td>Interactive wizard: scan, ask for the goal and targets, plan, generate. The default command.</td></tr>
          <tr><td><a href="docs/commands.html#scan"><code>scan</code></a></td><td>Scan only. Writes <code>.decree/profile.json</code>.</td></tr>
          <tr><td><a href="docs/commands.html#plan"><code>plan</code></a></td><td>Scan and plan. Writes <code>decree.json</code> only.</td></tr>
          <tr><td><a href="docs/commands.html#generate"><code>generate</code></a></td><td>Render <code>decree.json</code> into code.</td></tr>
          <tr><td><a href="docs/commands.html#refine"><code>refine "&lt;feedback&gt;"</code></a></td><td>Change the harness in plain English, then regenerate.</td></tr>
          <tr><td><a href="docs/commands.html#chat"><code>chat</code></a></td><td>Talk to the agent in your terminal. Tools run locally with approval prompts.</td></tr>
          <tr><td><a href="docs/commands.html#run"><code>run "&lt;prompt&gt;"</code></a></td><td>One-shot run. <code>--json</code> for machine output.</td></tr>
          <tr><td><a href="docs/commands.html#eval"><code>eval</code></a></td><td>Run the eval cases and report pass/fail.</td></tr>
          <tr><td><a href="docs/commands.html#doctor"><code>doctor</code></a></td><td>Check Node, API key, <code>decree.json</code>, env vars and generated output.</td></tr>
          <tr><td><a href="docs/commands.html#tools"><code>tools</code></a> · <a href="docs/commands.html#schema"><code>schema</code></a></td><td>List the tools in <code>decree.json</code>, or print its JSON schema.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<section class="section section-alt" id="faq" aria-labelledby="faq-title">
  <div class="container split">
    <div class="section-head">
      <span class="sec-num">§ 6 &nbsp;FAQ</span>
      <h2 id="faq-title" class="h2">Questions people ask first.</h2>
      <p>More in the <a href="docs/faq.html">full FAQ</a>.</p>
    </div>
    <div class="faq">
      {faq_items(short=True)}
    </div>
  </div>
</section>

<section class="cta" aria-labelledby="cta-title">
  <div class="container"><div class="cta-box">
    <div>
      <span class="sec-num">§ 7 &nbsp;Try it</span>
      <h2 id="cta-title" class="h2" style="margin:0">Point it at your repo.</h2>
      <p class="lede" style="margin:14px 0 0">Node 20.12 or newer. Everything it writes is plain code in your project.</p>
    </div>
    <div class="cmd"><span class="prompt" aria-hidden="true">$</span><code>npx decree-harness</code>{copy_btn("Copy", "npx decree-harness", "Copy command: npx decree-harness")}</div>
  </div></div>
</section>
</main>
'''
    h += footer("")
    return h

# ---------------------------------------------------------------- FAQ content
FAQ = [
 ("key", "Do I need an Anthropic API key?", '''
<p>Not to try it. <code>--offline</code> uses a heuristic planner that builds the same kind of spec from the scan alone, and <code>scan</code>, <code>generate</code>, <code>tools</code>, <code>schema</code> and <code>doctor</code> never call the API. The demo on the home page ran offline.</p>
<p>You need a key for a Claude-designed plan, and for <code>refine</code>, <code>chat</code>, <code>run</code> and <code>eval</code>. decree reads <code>ANTHROPIC_API_KEY</code>, then a <code>.env</code> file, or <code>--api-key</code>. With a key set, <code>decree-harness init --force</code> re-plans an offline spec with Claude.</p>'''),
 ("cost", "What drives the cost?", '''
<ul>
<li><strong>Planning.</strong> <code>init</code> and <code>plan</code> make an architect call and a critic call on the planner model (default <code>claude-opus-5</code>, $5 input and $25 output per million tokens). <code>--no-critique</code> skips the critic. After planning, decree prints the tokens used and the estimated cost.</li>
<li><strong>Refining.</strong> Each <code>refine</code> is one more planning call.</li>
<li><strong>Running the agent.</strong> <code>chat</code>, <code>run</code> and the generated agents bill per turn on <code>model.id</code>. Subagents default to <code>claude-sonnet-5</code> ($2 and $10). Prompt caching is on by default, and cache reads cost 0.1x the input price.</li>
<li><strong>Evals.</strong> <code>eval</code> runs the agent once per case, plus a judge call for cases that have a rubric.</li>
</ul>
<p><code>guardrails.maxCostUsd</code> stops any run once its estimated cost passes the cap. In chat, <code>/cost</code> shows the spend so far.</p>'''),
 ("offline", "What does offline mode do differently?", '''
<p>The offline planner derives tools, the system prompt, subagents, guardrails and evals from the scan with fixed rules instead of asking Claude. The spec has the same shape and passes through the same grounding and validation, and <code>provenance.generator</code> is set to <code>heuristic</code> so you can tell them apart.</p>
<p>A Claude plan adds an architect and a critic: better tool descriptions, a prompt written for your goal, and evals chosen for your project. You can start offline and re-plan later.</p>'''),
 ("models", "Which models does it use?", '''
<p>Claude only: the planner and the generated agents use the Anthropic API. Defaults are <code>claude-opus-5</code> with adaptive thinking for the planner and the agent, and <code>claude-sonnet-5</code> for subagents. Change them with <code>--model</code> or in <code>decree.json</code> (<code>model.id</code>, <code>model.subagentId</code>, <code>model.effort</code>, <code>model.thinking</code>, and per-subagent <code>model</code>).</p>'''),
 ("edits", "Will regenerating overwrite my changes?", '''
<p>No. decree records a hash of every file it writes in <code>.decree/manifest.json</code>. If you edited a generated file, <code>generate</code> leaves it alone and tells you, unless you pass <code>--force</code>. The intended loop is to change <code>decree.json</code> and regenerate.</p>'''),
 ("data", "What leaves my machine?", '''
<p>Scanning is local. Offline mode sends nothing. With Claude planning, the scan profile (file list, endpoints, scripts, env var names, excerpts of key files and your README) goes to the Anthropic API. Hardcoded secrets in those excerpts are masked with <code>[REDACTED]</code> first. For env vars, the scanner keeps names and non-secret example values (for example from <code>.env.example</code>); values of secret-looking variables are left out.</p>'''),
 ("stacks", "What stacks does the scanner understand?", '''
<p>Scripts from package.json, Makefile, pyproject, justfile and Taskfile; OpenAPI and Swagger specs; routes in Express, Fastify, Hono, NestJS, Next.js, FastAPI, Flask, Django, Gin, Echo, Chi, Rails and more; env var names; database models; the README; and existing agent config. See <a href="%%PRE%%docs/faq.html#stacks">the FAQ</a> and the <a href="%%GH%%">repository</a> for details.</p>'''),
 ("api", "Can I call it from code?", '''
<p>Yes. The package exports <code>scanProject</code>, <code>planHarness</code>, <code>generateTargets</code>, <code>runAgent</code> and <code>createLLM</code>. See the example in the <a href="%%PRE%%docs/faq.html#api">FAQ</a>.</p>'''),
]

def faq_items(short=False, pre=""):
    keys = ["key", "cost", "offline", "models"] if short else [k for k, *_ in FAQ]
    out = []
    for k, q, a in FAQ:
        if k not in keys: continue
        a = a.replace("%%PRE%%", pre).replace("%%GH%%", GH)
        if k == "stacks" and not short:
            a = a.replace(' See <a href="' + pre + 'docs/faq.html#stacks">the FAQ</a> and the <a href="' + GH + '">repository</a> for details.', "")
        if k == "api" and not short:
            a = '<p>Yes. The package exports the same building blocks the CLI uses:</p>' + code('''import { scanProject, planHarness, generateTargets, runAgent, createLLM } from "decree-harness";

const profile = await scanProject(process.cwd());
const spec = await planHarness(profile, { goal: "Triage failing tests", targets: ["typescript"], llm: createLLM() });
const files = generateTargets(spec, spec.targets, { outDir: "agent", decreeVersion: "0.1.0" });''', "text", "example.ts")
        op = " open" if short and k == "key" else ""
        out.append(f'<details id="{k}"{op}><summary>{esc(q)}</summary><div class="a">{a.strip()}</div></details>')
    return "\n".join(out)

# ---------------------------------------------------------------- docs
DOCS = [
    ("Get started", [("index.html", "Quickstart", "quickstart")]),
    ("Reference", [("commands.html", "Commands", "commands"), ("config.html", "decree.json", "config"), ("targets.html", "Targets", "targets")]),
    ("Concepts", [("safety.html", "Safety model", "safety"), ("faq.html", "FAQ", "faq")]),
]
ORDER = [p for _, items in DOCS for p in items]

def slug(s): return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def h2(title, id=None, code_title=False):
    id = id or slug(title)
    inner = f"<code>{esc(title)}</code>" if code_title else esc(title)
    return f'<h2 id="{id}"><a class="anchor" href="#{id}">{inner}</a></h2>'

def h3(title, id=None, code_title=False):
    id = id or slug(title)
    inner = f"<code>{esc(title)}</code>" if code_title else esc(title)
    return f'<h3 id="{id}"><a class="anchor" href="#{id}">{inner}</a></h3>'

def table(headers, rows):
    th = "".join(f'<th scope="col">{h}</th>' for h in headers)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="table-wrap"><table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'

def doc_page(fname, key, title, lead, body, desc):
    pre = "../"
    toc = re.findall(r'<h2 id="([^"]+)"><a class="anchor" href="#[^"]+">(.*?)</a></h2>', body)
    side = []
    for group, items in DOCS:
        lis = "".join(f'<li><a href="{f}"{" aria-current=\"page\"" if k == key else ""}>{esc(t)}</a></li>' for f, t, k in items)
        side.append(f'<h2>{esc(group)}</h2><ul>{lis}</ul>')
    toc_html = ""
    if toc:
        lis = "".join(f'<li><a href="#{i}">{t}</a></li>' for i, t in toc)
        toc_html = f'<aside class="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>{lis}</ul></aside>'
    idx = [k for _, _, k in ORDER].index(key)
    prev_ = ORDER[idx - 1] if idx > 0 else None
    next_ = ORDER[idx + 1] if idx < len(ORDER) - 1 else None
    pager = '<nav class="pager" aria-label="Previous and next page">'
    if prev_: pager += f'<a class="prev" href="{prev_[0]}"><span>Previous</span><strong>{esc(prev_[1])}</strong></a>'
    if next_: pager += f'<a class="next" href="{next_[0]}"><span>Next</span><strong>{esc(next_[1])}</strong></a>'
    pager += "</nav>"
    group = next(g for g, items in DOCS if any(k == key for _, _, k in items))
    active_nav = key if key in ("commands", "config") else "docs"
    h = head(f"{title} · decree docs", desc, pre)
    h += header(pre, active_nav)
    h += f'''<div class="docs-shell">
  <nav class="docs-side" aria-label="Documentation">
    <button type="button" class="docs-menu-btn" aria-expanded="false" aria-controls="docs-nav-lists">Docs menu: {esc(title)} {I["chev"]}</button>
    <div class="docs-nav-lists" id="docs-nav-lists">{"".join(side)}</div>
  </nav>
  <main id="main" class="docs-main">
    <article class="prose">
      <p class="crumb">{esc(group)}</p>
      <h1>{esc(title)}</h1>
      <p class="lead">{lead}</p>
      {body}
    </article>
    {pager}
  </main>
  {toc_html}
</div>
'''
    h += footer(pre)
    return h

def page_quickstart():
    tree = read(os.path.join(OUT, "tree.txt"))
    body = f'''
{h2("Requirements")}
<ul>
<li>Node.js 20.12 or newer.</li>
<li>An Anthropic API key for Claude planning, <code>chat</code>, <code>run</code>, <code>refine</code> and <code>eval</code>. Not needed with <code>--offline</code>.</li>
</ul>

{h2("Run it")}
<p>From the root of the project you want an agent for:</p>
{code("$ export ANTHROPIC_API_KEY=sk-ant-...     # or put it in .env\n$ npx decree-harness")}
<p>The wizard scans the project, asks what the agent should do and which targets to write, plans the harness, and generates code. To skip the questions:</p>
{code('$ npx decree-harness init --yes --goal "Triage failing CI runs" --targets typescript,mcp')}
<p>No key yet? The offline planner builds a spec from the scan alone:</p>
{code("$ npx decree-harness init --yes --offline --targets all")}

{h2("What it writes")}
<p>On <a href="{GH}/tree/main/test/fixtures/express-openapi">test/fixtures/express-openapi</a>, an Express + OpenAPI orders service, <code>init --yes --offline --targets all</code> writes:</p>
{code(tree, "text", "project root", copy=False)}
<p>Commit <code>decree.json</code>. Whether you commit <code>agent/</code> is up to you; it can always be regenerated.</p>

{h2("Talk to your agent")}
<p>The CLI runs the harness directly, with tools executing locally and approval prompts for anything destructive:</p>
{code('''$ npx decree-harness chat                         # interactive
$ npx decree-harness run "How many orders are pending?" --json
$ npx decree-harness eval                         # tools run in dry-run mode by default''')}
<p>In <code>chat</code>, <code>/cost</code> shows token usage and spend so far.</p>

{h2("Change the harness")}
<p><code>decree.json</code> is the source of truth. Edit it, or describe the change and let Claude edit it:</p>
{code('''$ npx decree-harness refine "make every tool read-only"
$ npx decree-harness generate --dry-run           # preview
$ npx decree-harness generate                     # write''')}
<p>Files you edited by hand are tracked in <code>.decree/manifest.json</code> and are not overwritten unless you pass <code>--force</code>.</p>

{h2("Ship a target")}
<p>Each target in <code>agent/</code> is a standalone project with its own README. For example:</p>
{code('''$ cd agent/typescript && npm install && npm start
$ cd agent/python && uv sync && uv run acme-orders-agent --root ../..
$ cd agent/mcp-server && npm install && npm start''')}
<p>See <a href="targets.html">Targets</a> for what each one contains, and <a href="doctor.html" hidden></a><a href="commands.html#doctor"><code>doctor</code></a> to check that env vars and generated code are in place.</p>
'''
    body = body.replace('<a href="doctor.html" hidden></a>', "")
    return doc_page("index.html", "quickstart", "Quickstart",
                    "Generate a harness for your project, talk to it, and change it.", body,
                    "Install and run decree-harness: requirements, first run, offline mode, chat, eval and regenerate.")

CMD_NOTES = {
    "init": ("The default command. Running <code>npx decree-harness</code> with no command runs <code>init</code>. Interactive in a terminal; non-interactive with <code>--yes</code> or when stdin is not a TTY.",
             '$ npx decree-harness init --yes --offline\n$ npx decree-harness init --goal "Triage failing CI runs" --targets typescript,mcp'),
    "scan": ("Deterministic and local. Prints a summary of what was found and writes <code>.decree/profile.json</code>.", "$ npx decree-harness scan --json"),
    "plan": ("Like <code>init</code> without the code generation step. Useful for reviewing the spec before you generate anything.", '$ npx decree-harness plan --yes --goal "Answer questions about orders"'),
    "generate": ("Pure rendering from <code>decree.json</code>, no network. Alias <code>gen</code>.", "$ npx decree-harness generate --dry-run\n$ npx decree-harness generate --targets python --clean"),
    "refine": ("Sends your feedback and the current spec to Claude, validates the result, then regenerates. Requires an API key.", '$ npx decree-harness refine "make every tool read-only"\n$ npx decree-harness refine "add an eval for refunds" --dry-run'),
    "chat": ("Runs the harness in your terminal. Tools execute locally; tools that need approval ask first. <code>/cost</code> shows spend so far.", "$ npx decree-harness chat\n$ npx decree-harness chat --dry-run-tools"),
    "run": ("One prompt, one answer. Reads the prompt from stdin when none is given.", '$ npx decree-harness run "How many orders are pending?" --json'),
    "eval": ("Runs each case in <code>evals</code> and checks expected tool calls, text, and the rubric (graded by a Claude judge). Tools are dry-run unless you pass <code>--live-tools</code>.", "$ npx decree-harness eval --filter orders"),
    "doctor": ("Checks Node, the API key, <code>decree.json</code>, env vars the tools need, and the generated output.", "$ npx decree-harness doctor --online"),
    "tools": ("Prints the tool table: kind, safety flags, what each tool binds to and where it came from.", "$ npx decree-harness tools --json"),
    "schema": ("Prints the JSON schema for <code>decree.json</code>. decree also writes it to <code>.decree/schema.json</code> for editors.", "$ npx decree-harness schema > decree.schema.json"),
}

def page_commands():
    g = read(os.path.join(OUT, "help.txt")).rstrip()
    body = f'''<div class="callout"><p>Every block on this page is the literal <code>--help</code> output of decree-harness {VERSION}.</p></div>
{h2("Global options")}
{code(g, "text", "decree-harness --help", copy=False)}
'''
    for c in ["init", "scan", "plan", "generate", "refine", "chat", "run", "eval", "doctor", "tools", "schema"]:
        note, ex = CMD_NOTES[c]
        helptxt = read(os.path.join(OUT, f"help-{c}.txt")).rstrip()
        body += f'''{h2(c, c, code_title=True)}
<p>{note}</p>
{code(helptxt, "text", f"decree-harness {c} --help", copy=False)}
{code(ex)}
'''
    return doc_page("commands.html", "commands", "Commands",
                    "Every command and flag, taken from the CLI's own help output.", body,
                    "decree-harness command reference: init, scan, plan, generate, refine, chat, run, eval, doctor, tools, schema.")

DESC = {
 "$schema": "Path to the JSON schema. decree writes <code>./.decree/schema.json</code> so editors can validate and autocomplete.",
 "version": "Spec format version.",
 "name": "Kebab-case slug. Used for package names, the MCP server name and the Claude Code agent file.",
 "displayName": "Human-readable name used in prompts and READMEs.",
 "description": "Short summary of the agent.",
 "goal": "What the agent is for, in your words. Set with <code>--goal</code>.",
 "model": "Models and reasoning settings. See <a href=\"#model\">model</a>.",
 "systemPrompt": "The main agent's system prompt (Markdown).",
 "tools": "The tool surface. See <a href=\"#tools\">tools</a>.",
 "subagents": "Agents the main agent can delegate to. See <a href=\"#subagents\">subagents</a>.",
 "guardrails": "Limits and approval rules. See <a href=\"#guardrails\">guardrails</a>.",
 "context": "Context management. See <a href=\"#context\">context</a>.",
 "evals": "Eval cases. See <a href=\"#evals\">evals</a>.",
 "targets": "What <code>generate</code> renders.",
 "env": "Environment variables the harness reads. Written to <code>.env.example</code> and checked by <code>doctor</code>.",
 "provenance": "Written by decree: planner type (<code>heuristic</code> or <code>llm</code>), decree version, timestamp and planner notes.",
 "model.id": "Model for the main agent.",
 "model.effort": "Sent as <code>output_config.effort</code>.",
 "model.subagentId": "Default model for subagents.",
 "model.thinking": "<code>adaptive</code> sends <code>thinking: {type: \"adaptive\"}</code>; <code>off</code> omits it.",
 "tools[].name": "Name the model sees.",
 "tools[].description": "When and how to use the tool. This is what the model reads to choose tools.",
 "tools[].kind": "How the tool runs. See <a href=\"#tool-kinds\">tool kinds</a>.",
 "tools[].inputSchema": "JSON Schema (<code>type: object</code>) for the input. Keys starting with <code>x-</code> are decree annotations and are stripped before the API sees the schema.",
 "tools[].http": "Binding for <code>http</code> tools.",
 "tools[].http.method": "HTTP method.",
 "tools[].http.baseUrlEnv": "Env var holding the base URL. Defaults to <code>&lt;NAME&gt;_BASE_URL</code>.",
 "tools[].http.defaultBaseUrl": "Used when the env var is not set.",
 "tools[].http.path": "Path template, for example <code>/users/{id}</code>. Each <code>{name}</code> is URL-encoded from the input.",
 "tools[].http.queryParams": "Input keys sent as query parameters.",
 "tools[].http.headerParams": "Input keys sent as headers.",
 "tools[].http.bodyParam": "Input key sent as the JSON body. Without it, every input key not used elsewhere goes in the body.",
 "tools[].http.auth": "Auth for the request.",
 "tools[].http.auth.type": "<code>bearer</code> sends <code>Authorization: Bearer $ENV</code>; <code>header</code> sends <code>auth.header: $ENV</code>.",
 "tools[].http.auth.env": "Env var holding the credential.",
 "tools[].http.auth.header": "Header name for <code>header</code> auth.",
 "tools[].shell": "Binding for <code>shell</code> tools.",
 "tools[].shell.command": "Command template. <code>{{param}}</code> placeholders are POSIX-quoted and must be bare shell words.",
 "tools[].shell.cwd": "Working directory, relative to the project root.",
 "tools[].shell.timeoutMs": "Timeout. Default 120000.",
 "tools[].fs": "Binding for file tools.",
 "tools[].fs.root": "Root the tool resolves paths against.",
 "tools[].fs.maxBytes": "Max bytes <code>read_file</code> returns. Default 200000.",
 "tools[].readOnly": "The tool does not change anything.",
 "tools[].destructive": "Hard to undo. Always needs approval under <code>approvalMode: destructive</code>.",
 "tools[].requiresApproval": "Ask a human before every call.",
 "tools[].source": "Where the tool came from, for example <code>openapi:GET /orders</code> or <code>package.json#scripts.test</code>.",
 "subagents[].name": "Subagent name. Exposed to the main agent as <code>delegate_to_&lt;name&gt;</code>.",
 "subagents[].description": "When the main agent should delegate.",
 "subagents[].systemPrompt": "The subagent's system prompt.",
 "subagents[].tools": "Names of tools from <code>tools</code> the subagent may use.",
 "subagents[].model": "Defaults to <code>model.subagentId</code>.",
 "subagents[].effort": "Defaults to <code>medium</code>.",
 "guardrails.maxTurns": "Stop after this many model turns.",
 "guardrails.maxOutputTokensPerTurn": "Sent as <code>max_tokens</code>.",
 "guardrails.maxCostUsd": "Stop once the estimated cost of a run passes this.",
 "guardrails.blockedCommands": "Shell commands containing any of these substrings are refused.",
 "guardrails.allowedPaths": "File tools refuse paths outside these.",
 "guardrails.redactEnv": "Values of these env vars are replaced with <code>[REDACTED:NAME]</code> in tool output.",
 "guardrails.approvalMode": "Which tools ask first. See <a href=\"safety.html#approval\">approval</a>.",
 "context.caching": "Prompt caching on the system prompt and conversation tail.",
 "context.compaction": "Server-side compaction for long sessions.",
 "context.contextEditing": "Clears old tool results from the context.",
 "context.memory": "Adds the Anthropic memory tool.",
 "evals[].id": "Unique id. <code>eval --filter</code> matches on it.",
 "evals[].input": "The user message.",
 "evals[].expect": "What must be true of the run.",
 "evals[].expect.toolsCalled": "Tools that must be called.",
 "evals[].expect.toolsNotCalled": "Tools that must not be called.",
 "evals[].expect.contains": "Strings the final answer must contain.",
 "evals[].expect.notContains": "Strings the final answer must not contain.",
 "evals[].expect.rubric": "Graded by a Claude judge.",
 "evals[].tags": "Free-form labels.",
 "env[].name": "Variable name.",
 "env[].description": "What it is for.",
 "env[].required": "<code>doctor</code> warns when it is missing.",
 "env[].secret": "Marks the value as a secret.",
 "env[].default": "Default value.",
}

def fmt_type(v):
    if "enum" in v and "type" in v and v["type"] != "array":
        return "one of " + " ".join(f"<code>{esc(json.dumps(e))}</code>" for e in v["enum"])
    t = v.get("type", "")
    if t == "array":
        it = v.get("items", {})
        if "enum" in it: return "array of " + " ".join(f"<code>{esc(json.dumps(e))}</code>" for e in it["enum"])
        return f"{it.get('type', 'object')}[]"
    return t or "object"

def fmt_default(v):
    if "default" not in v: return ""
    d = v["default"]
    s = json.dumps(d)
    if isinstance(d, list) and len(s) > 40: return f"{len(d)} entries"
    if isinstance(d, dict): return "" if not d else ""
    return f"<code>{esc(s)}</code>"

def rows_for(node, prefix, strip=""):
    rows = []
    req = node.get("required", [])
    for k, v in node.get("properties", {}).items():
        full = prefix + k
        rows.append({"id": "f-" + slug(full), "name": full, "type": fmt_type(v), "req": k in req, "default": fmt_default(v), "desc": DESC.get(full, esc(v.get("description", "")))})
    return rows

def fields(rows, skip=()):
    out = []
    for r in rows:
        if r["name"] in skip: continue
        meta = f'<span class="ftype">{r["type"]}</span>'
        if r["req"]: meta += '<span class="freq">required</span>'
        if r["default"]: meta += f'<span class="fdef">default {r["default"]}</span>'
        out.append(f'<div class="field" id="{r["id"]}"><div class="field-head"><code class="fname">{esc(r["name"])}</code>{meta}</div><div class="fdesc">{r["desc"]}</div></div>')
    return '<div class="fields">' + "".join(out) + "</div>"

def page_config():
    s = json.load(open(os.path.join(OUT, "schema.json")))
    P = s["properties"]
    top = rows_for(s, "")
    tools_items = P["tools"]["items"]
    tool_rows = rows_for(tools_items, "tools[].")
    http = tools_items["properties"]["http"]
    http_rows = rows_for(http, "tools[].http.") + rows_for(http["properties"]["auth"], "tools[].http.auth.")
    shell_rows = rows_for(tools_items["properties"]["shell"], "tools[].shell.")
    fs_rows = rows_for(tools_items["properties"]["fs"], "tools[].fs.")
    sub_rows = rows_for(P["subagents"]["items"], "subagents[].")
    gr = P["guardrails"]
    gr_rows = rows_for(gr, "guardrails.")
    ctx_rows = rows_for(P["context"], "context.")
    ev = P["evals"]["items"]
    ev_rows = rows_for(ev, "evals[].") + rows_for(ev["properties"]["expect"], "evals[].expect.")
    env_rows = rows_for(P["env"]["items"], "env[].")
    model_rows = rows_for(P["model"], "model.")
    blocked = ", ".join(f"<code>{esc(b)}</code>" for b in gr["properties"]["blockedCommands"]["default"])
    kinds = [
        ("http", "Calls an endpoint of your API. Bound from OpenAPI operations and routes found in code."),
        ("shell", "Runs a command template, usually a package script, with <code>/bin/sh -c</code>."),
        ("read_file", "Reads a file under <code>fs.root</code>, redacted and truncated."),
        ("write_file", "Writes a file under <code>fs.root</code>. Left out when the goal does not call for code changes."),
        ("list_files", "Globs files, skipping <code>node_modules</code>, <code>.git</code>, build output and the generated <code>agent/</code> directory."),
        ("search", "Regex search across files, up to 200 matches as <code>path:line: text</code>."),
        ("web_search", "Anthropic server tool, up to 5 uses per request."),
        ("web_fetch", "Anthropic server tool, up to 5 uses per request."),
        ("memory", "Anthropic memory tool, confined to a memory directory."),
    ]
    snippet, _ = decree_snippet()
    body = f'''<p><code>decree.json</code> lives at the root of your project. <code>init</code> and <code>plan</code> write it, <code>refine</code> changes it, <code>generate</code> renders it, and <code>chat</code>, <code>run</code> and <code>eval</code> execute it. It is validated on every load. Print the full schema with <code>decree-harness schema</code>.</p>
{code(snippet, "json", "decree.json (trimmed, from the orders fixture)")}

{h2("Top-level fields")}
{fields(top)}

{h2("model")}
{fields(model_rows)}

{h2("tools")}
<p>Each entry is one tool. The <code>kind</code> decides which binding object applies.</p>
{fields(tool_rows, skip=("tools[].http", "tools[].shell", "tools[].fs"))}
{h3("Tool kinds")}
{table(["Kind", "What it does"], [[f"<code>{k}</code>", d] for k, d in kinds])}
{h3("tools[].http")}
{fields(http_rows, skip=("tools[].http.auth",))}
{h3("tools[].shell")}
{fields(shell_rows)}
{h3("tools[].fs")}
<p>Used by <code>read_file</code>, <code>write_file</code>, <code>list_files</code> and <code>search</code>.</p>
{fields(fs_rows)}

{h2("subagents")}
<p>Each subagent becomes a tool on the main agent named <code>delegate_to_&lt;name&gt;</code> (dashes become underscores) that takes <code>{{ "task": string }}</code> and returns the subagent's final text.</p>
{fields(sub_rows)}

{h2("guardrails")}
{fields(gr_rows)}
<p>Default <code>blockedCommands</code>: {blocked}.</p>

{h2("context")}
{fields(ctx_rows)}

{h2("evals")}
{fields(ev_rows)}

{h2("targets")}
<p>Array of <code>"typescript"</code>, <code>"python"</code>, <code>"mcp"</code>, <code>"claude-code"</code>. The schema default is <code>["typescript", "claude-code"]</code>; the <code>--targets</code> flag on <code>init</code>, <code>plan</code> and <code>generate</code> overrides it. See <a href="targets.html">Targets</a>.</p>

{h2("env")}
{fields(env_rows)}

{h2("provenance")}
<p>Written by decree; you do not need to edit it. <code>generator</code> is <code>heuristic</code> for offline plans and <code>llm</code> for Claude plans, and <code>notes</code> records the planner's reasoning, for example which scripts were skipped and why.</p>
'''
    return doc_page("config.html", "config", "decree.json",
                    "The harness spec. Every field, its type and default, taken from the JSON schema.", body,
                    "decree.json reference: model, tools, subagents, guardrails, context, evals, targets, env.")

def page_targets():
    body = f'''<p>Choose targets with <code>--targets</code> (comma-separated, or <code>all</code>) or the <code>targets</code> array in <code>decree.json</code>. All targets implement the same tool semantics and guardrails, so a tool behaves the same way everywhere. Output goes to <code>agent/</code> unless you pass <code>--out</code>.</p>

{h2("Shared files")}
{table(["File", "What it is"], [
 ["<code>agent/README.md</code>", "Overview of the harness and how to run each target."],
 ["<code>agent/harness.md</code>", "Design doc: system prompt, every tool, safety flags, planner notes. Review this in PRs."],
 ["<code>agent/evals.json</code>", "Eval cases consumed by the generated eval runners."],
 ["<code>agent/.env.example</code>", "Env vars the tools need."],
 ["<code>agent/.decree-generated</code>", "Marker file. decree's file tools and scanner skip this directory."],
])}

{h2("TypeScript", "typescript")}
<p>A standalone agent on the Anthropic TypeScript SDK (<code>@anthropic-ai/sdk</code>). Streaming agent loop, the tool registry, subagents, a CLI with a REPL, and an eval runner.</p>
{code('''$ cd agent/typescript
$ npm install
$ cp .env.example .env   # then fill in the values
$ npm start -- "your request"   # one-shot
$ npm start                     # interactive chat''')}
<p>In chat, <code>/reset</code> clears the conversation, <code>/cost</code> shows estimated spend and <code>/exit</code> quits. Tools that need approval ask <code>[y/N]</code>; <code>--yes</code> approves everything. Without a terminal, such tools are declined. Node 18.17 or newer (20.12 to load <code>.env</code> automatically).</p>
{code("src/agent.ts   cli.ts   client.ts   config.ts   evals.ts   loop.ts\nsrc/prompt.ts   session.ts   subagents.ts   types.ts   validate.ts\nsrc/tools/index.ts   http.ts   shell.ts   fs.ts", "text", "agent/typescript/src", copy=False)}

{h2("Python", "python")}
<p>The same harness on the Anthropic Python SDK (<code>anthropic</code>, <code>httpx</code>). Python 3.10 or newer. Includes a console script, an eval runner, and pytest tool tests that need no API key.</p>
{code('''$ cd agent/python
$ uv sync
$ uv run acme-orders-agent "your question"
$ uv run --group dev pytest    # tool smoke tests, no API key needed''')}
<p>Or <code>pip install -e .</code> and run <code>python -m acme_orders_agent</code>. The package name comes from <code>decree.json</code>'s <code>name</code>.</p>

{h2("MCP server", "mcp")}
<p>A Model Context Protocol server on stdio (<code>@modelcontextprotocol/sdk</code>) that exposes the harness tools and prompts to any MCP client: Claude Code, Claude Desktop, Cursor and others.</p>
{code('''$ cd agent/mcp-server
$ npm install
$ cp .env.example .env
$ npm start              # runs the server on stdio

# register it with Claude Code
$ claude mcp add acme-orders-agent -- npx tsx /abs/path/to/agent/mcp-server/src/server.ts''')}

{h2("Claude Code", "claude-code")}
<p>Project configuration for Claude Code: a <code>CLAUDE.md</code> with working rules, the main agent and subagents in <code>.claude/agents/</code>, skills, slash commands, a <code>settings.json</code> with permissions, and a <code>.mcp.json</code> that starts the generated MCP server for API tools.</p>
{code("$ cp -R agent/claude-code/CLAUDE.md agent/claude-code/.claude agent/claude-code/.mcp.json .")}
<p>Merge by hand if you already have these files. Then run <code>claude --agent acme-orders-agent</code>, or ask Claude Code to use the agent.</p>
<p>Permissions map from the harness flags: read-only tools and checks go to <code>allow</code>, destructive tools to <code>ask</code>, and blocked commands to <code>deny</code>. Shell rules with a generic prefix such as <code>npm run</code>, <code>npx</code> or <code>make</code> alone always go to <code>ask</code>, never <code>allow</code>.</p>
{code(json.dumps({"permissions": {"allow": ["mcp__acme-orders-agent__list_orders", "Bash(npm run test:*)", "Read", "Glob", "Grep"], "ask": ["mcp__acme-orders-agent__delete_order", "Bash(npm run deploy:*)"], "deny": ["Bash(git push --force:*)", "Bash(*git push --force*)"]}}, indent=2), "json", ".claude/settings.json (excerpt)", copy=False)}
'''
    return doc_page("targets.html", "targets", "Targets",
                    "What each generated target contains and how to run it.", body,
                    "decree-harness targets: TypeScript agent, Python agent, MCP server, Claude Code config.")

def page_safety():
    body = f'''<p>These rules are implemented by decree's own runtime (<code>chat</code>, <code>run</code>, <code>eval</code>) and by every generated target. They are enforced in code, not only described in the prompt.</p>

{h2("Tool flags")}
<p>Every tool has three flags:</p>
<ul>
<li><code>readOnly</code>: the tool does not change anything.</li>
<li><code>destructive</code>: the change is hard to undo, like deleting an order, deploying, or running a migration.</li>
<li><code>requiresApproval</code>: a human confirms each call.</li>
</ul>
<p>The planner sets them; the grounding pass then forces approval on every destructive tool and keeps subagents read-only.</p>

{h2("Approval", "approval")}
{code('''needsApproval(tool) =
  approvalMode == "never"       -> false
  approvalMode == "always"      -> !tool.readOnly || tool.requiresApproval
  approvalMode == "destructive" -> tool.requiresApproval || tool.destructive''', "text", "guardrails.approvalMode", copy=False)}
<p>The default is <code>destructive</code>. A declined call returns an error result to the model with the text <code>The user declined this action. Ask them how to proceed.</code> In <code>eval</code>, tools run in dry-run mode unless you pass <code>--live-tools</code>.</p>

{h2("Shell tools")}
<ul>
<li><code>{{{{param}}}}</code> placeholders are replaced with POSIX single-quoted values. Placeholders must be bare shell words: a placeholder inside quotes, backticks, <code>${{...}}</code> or a comment is rejected when the spec is validated, and every target re-checks the template before running it.</li>
<li>A value that starts with <code>-</code> is refused, so input cannot inject flags, unless the input schema property sets <code>"x-allow-flags": true</code>.</li>
<li>If the final command contains any <code>guardrails.blockedCommands</code> substring, it is refused.</li>
<li>Commands run with a timeout (<code>shell.timeoutMs</code>, default 120000 ms). Output is redacted, then the last 30,000 characters are kept.</li>
</ul>

{h2("File tools")}
<p><code>read_file</code>, <code>write_file</code>, <code>list_files</code> and <code>search</code> resolve every path against the tool root and refuse anything that escapes it, with a lexical check and a realpath check that catches symlinks. Paths outside <code>guardrails.allowedPaths</code> are refused too. The generated <code>agent/</code> directory is skipped by listing and search.</p>

{h2("HTTP tools")}
<ul>
<li>Path parameters are URL-encoded. Parameters are read from the input's own properties only.</li>
<li>Redirects are followed manually: at most 5, and only when the target stays on the same origin, so auth headers never leave your API. A cross-origin redirect is returned to the model, not followed.</li>
<li>Requests time out after 60 seconds. Bodies are redacted, then truncated to 50,000 characters.</li>
</ul>

{h2("Secrets")}
<p>Values of env vars listed in <code>guardrails.redactEnv</code> are replaced with <code>[REDACTED:NAME]</code> in all tool output before the model sees it. Redaction happens before truncation, so a cut never leaves part of a secret behind. The scanner also masks hardcoded secrets in file excerpts it sends to the planner. The generated Claude Code settings deny reading <code>.env</code>.</p>

{h2("Limits")}
<p><code>guardrails.maxTurns</code> ends a run after that many turns, and <code>guardrails.maxCostUsd</code> ends it once estimated cost passes the cap. Each subagent run is also capped at <code>maxTurns</code>, and subagents only get read-only tools, because they cannot ask you to confirm anything.</p>

{h2("Your edits")}
<p>decree records a sha256 of every file it generates in <code>.decree/manifest.json</code>. If a generated file changed since, <code>generate</code> does not overwrite it unless you pass <code>--force</code>.</p>
'''
    return doc_page("safety.html", "safety", "Safety model",
                    "What an agent generated by decree can and cannot do, and where each rule is enforced.", body,
                    "decree-harness safety model: approval, shell quoting, path confinement, redirects, secret redaction, cost caps.")

def page_faq():
    body = f'<div class="faq">{faq_items(short=False, pre="../")}</div>'
    body = body.replace('<details id=', '<details open id=')
    # h2 anchors are not used on this page; build a TOC from summaries instead
    return doc_page("faq.html", "faq", "FAQ", "API keys, cost, offline mode, models, and what happens to your code.", body,
                    "decree-harness FAQ: API key, cost drivers, offline mode, models, data handling.")

def main():
    # tree for quickstart (from README, matches the run)
    tree = """decree.json          the harness spec (edit it, then `decree-harness generate`)
.decree/             profile.json, manifest.json, schema.json
agent/
  README.md          how to run each target
  harness.md         design doc: prompt, every tool, safety flags, planner notes
  evals.json         eval cases
  .env.example       env vars the tools need
  typescript/        standalone agent (Anthropic TS SDK)
  python/            standalone agent (Anthropic Python SDK)
  mcp-server/        MCP server for Claude Code, Claude Desktop, Cursor
  claude-code/       CLAUDE.md, .claude/{agents,commands,skills,settings.json}, .mcp.json"""
    open(os.path.join(OUT, "tree.txt"), "w").write(tree)
    pages = {
        "index.html": index(),
        "docs/index.html": page_quickstart(),
        "docs/commands.html": page_commands(),
        "docs/config.html": page_config(),
        "docs/targets.html": page_targets(),
        "docs/safety.html": page_safety(),
        "docs/faq.html": page_faq(),
    }
    for p, c in pages.items():
        path = os.path.join(SITE, p)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w", encoding="utf-8").write(c)
    fav = LOGO.replace('aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"').replace("var(--accent)", "#b4321c").replace("var(--accent-fg)", "#ffffff")
    open(os.path.join(SITE, "assets/favicon.svg"), "w").write(fav)
    print("wrote", len(pages), "pages")

if __name__ == "__main__":
    main()
