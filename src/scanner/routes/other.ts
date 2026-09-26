import { lineIndex } from "../context.js";
import { chargeScan, joinPath, matchBracket, normalizePath, splitTopLevel, toMethod, type Method, type RouteHit } from "./util.js";

function hit(method: Method, raw: string, file: string, line: number, extra: Partial<RouteHit> = {}, keepTrailingSlash = false): RouteHit {
  const { path, types } = normalizePath(raw, { keepTrailingSlash });
  return { method, path, file, line, pathTypes: types, ...extra };
}

// ---------------------------------------------------------------------------
// Go: gin / echo / fiber / chi / gorilla mux / net/http
// ---------------------------------------------------------------------------

const GO_DENY = new Set(["http", "client", "os", "viper", "c", "ctx", "req", "resp", "r2", "cache", "m", "sync", "cfg", "config"]);

/** Parameter types that carry a router / route group into a registration function. */
const GO_ROUTER_TYPE = /^\*?(?:gin\.(?:RouterGroup|Engine|IRouter|IRoutes)|echo\.(?:Group|Echo)|chi\.(?:Router|Mux)|fiber\.(?:Router|App)|mux\.Router|http\.ServeMux)$/;

interface GoFunc {
  file: string;
  name: string;
  start: number;
  end: number;
  /** Router-typed params: name -> position. */
  routerParams: Map<string, number>;
}

function goFuncs(file: string, text: string): GoFunc[] {
  const out: GoFunc[] = [];
  for (const m of text.matchAll(/\bfunc\s*(?:\([^)]*\)\s*)?(\w+)\s*\(/g)) {
    const pOpen = m.index! + m[0].length - 1;
    const pClose = matchBracket(text, pOpen);
    if (pClose < 0) continue;
    const bodyOpen = text.indexOf("{", pClose);
    const nl = text.indexOf("\n", pClose);
    if (bodyOpen < 0 || (nl >= 0 && nl < bodyOpen && !/\($/.test(text.slice(pClose, nl).trim()))) {
      if (bodyOpen < 0) continue;
    }
    const end = matchBracket(text, bodyOpen);
    if (end < 0) continue;
    // Go groups names: `a, b *gin.RouterGroup` -> both typed; walk right to left carrying the type.
    const parts = splitTopLevel(text.slice(pOpen + 1, pClose));
    const routerParams = new Map<string, number>();
    let carried = "";
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i]!.trim().split(/\s+/);
      if (seg.length >= 2) carried = seg.slice(1).join("");
      if (seg[0] && GO_ROUTER_TYPE.test(carried)) routerParams.set(seg[0], i);
    }
    out.push({ file, name: m[1]!, start: bodyOpen, end, routerParams });
  }
  return out;
}

export function detectGoRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  type FileInfo = {
    file: string;
    text: string;
    funcs: GoFunc[];
    groups: { v: string; parent: string; path: string; idx: number }[];
    scopes: { start: number; end: number; v: string; prefix: string }[];
  };
  const infos: FileInfo[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith(".go")) continue;
    // Files that only wire groups together (main.go: v1 := r.Group("/api"); h.Register(v1)) need no router import.
    if (!/"net\/http"|gin-gonic|labstack\/echo|gofiber|go-chi|gorilla\/mux|httprouter/.test(text) && !/\.(?:Group|Mount|PathPrefix)\(\s*"\//.test(text)) continue;
    const groups: FileInfo["groups"] = [];
    for (const m of text.matchAll(/\b(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/g)) groups.push({ v: m[1]!, parent: m[2]!, path: m[3]!, idx: m.index! });
    for (const m of text.matchAll(/\b(\w+)\s*:?=\s*(\w+)\.PathPrefix\(\s*"([^"]*)"\s*\)\.Subrouter\(\)/g)) groups.push({ v: m[1]!, parent: m[2]!, path: m[3]!, idx: m.index! });
    // chi: r.Route("/x", func(r chi.Router) { ... }) -> scoped prefix ranges
    const scopes: FileInfo["scopes"] = [];
    for (const m of text.matchAll(/\b(\w+)\.(?:Route|Group)\(\s*"([^"]*)"\s*,\s*func\s*\(\s*(\w+)\s+[\w.*]+\)\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(text, open);
      if (close > open) scopes.push({ start: open, end: close, v: m[3]!, prefix: m[2]! });
    }
    infos.push({ file, text, funcs: goFuncs(file, text), groups, scopes });
  }
  const byName = new Map<string, GoFunc[]>();
  for (const i of infos) for (const f of i.funcs) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const paramBases = new Map<string, Set<string>>(); // "file#func#param" -> prefixes
  const mountBases = new Map<string, Set<string>>(); // func name -> prefixes (chi Mount("/x", sub()))
  const add = (map: Map<string, Set<string>>, k: string, vals: string[]) => {
    const set = map.get(k) ?? new Set<string>();
    for (const v of vals) if (set.size < 4) set.add(v);
    map.set(k, set);
  };
  const enclosing = (info: FileInfo, idx: number) => {
    let best: GoFunc | undefined;
    for (const f of info.funcs) if (f.start < idx && idx < f.end && (!best || f.start > best.start)) best = f;
    return best;
  };
  const resolve = (info: FileInfo, v: string, idx: number, depth = 0): string[] => {
    if (depth > 8) return [""];
    const fn = enclosing(info, idx);
    // latest group definition of v before idx, preferring the enclosing function
    const inFn = info.groups.filter((g) => g.v === v && g.idx < idx && (!fn || (g.idx > fn.start && g.idx < fn.end)));
    const def = inFn[inFn.length - 1] ?? (fn ? undefined : info.groups.filter((g) => g.v === v).pop());
    let base: string[];
    if (def) base = resolve(info, def.parent, def.idx, depth + 1).map((p) => joinPath(p, def.path));
    else if (fn?.routerParams.has(v)) base = [...(paramBases.get(`${info.file}#${fn.name}#${v}`) ?? new Set([""]))];
    else base = fn && mountBases.has(fn.name) ? [...mountBases.get(fn.name)!] : [""];
    // chi Route closures
    let scoped = "";
    for (const sc of info.scopes) if (sc.start < idx && idx < sc.end && sc.v === v) scoped = joinPath(scoped, sc.prefix);
    return base.map((b) => joinPath(b, scoped));
  };
  // Propagate router prefixes through calls: users.Register(v1.Group("/users")), h.Register(v1), r.Mount("/x", sub())
  for (let pass = 0; pass < 3; pass++) {
    for (const info of infos) {
      const { text } = info;
      for (const m of text.matchAll(/\b(\w+)\(/g)) {
        const cands = byName.get(m[1]!);
        if (!cands?.some((f) => f.routerParams.size)) continue;
        if (/func\s*(?:\([^)]*\)\s*)?$/.test(text.slice(Math.max(0, m.index! - 80), m.index!))) continue;
        const open = m.index! + m[0].length - 1;
        const close = matchBracket(text, open);
        if (close < 0) continue;
        const args = splitTopLevel(text.slice(open + 1, close));
        for (const f of cands)
          for (const [pname, pos] of f.routerParams) {
            const a = args[pos]?.trim();
            if (!a) continue;
            const g = /^(\w+)\.Group\(\s*"([^"]*)"/.exec(a);
            const vals = g ? resolve(info, g[1]!, m.index!).map((p) => joinPath(p, g[2]!)) : /^\w+$/.test(a) ? resolve(info, a, m.index!) : [];
            if (vals.length) add(paramBases, `${f.file}#${f.name}#${pname}`, vals);
          }
      }
      for (const m of text.matchAll(/\b(\w+)\.Mount\(\s*"([^"]*)"\s*,\s*(?:\w+\.)?(\w+)\(/g)) {
        const vals = resolve(info, m[1]!, m.index!).map((p) => joinPath(p, m[2]!));
        add(mountBases, m[3]!, vals);
      }
    }
  }

  for (const info of infos) {
    const { file, text } = info;
    const lineOf = lineIndex(text);
    const seen = new Set<string>();
    const emit = (me: Method, raw: string, idx: number, extra: Partial<RouteHit>) => {
      const k = `${me} ${raw} ${idx}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(hit(me, raw, file, lineOf(idx), extra));
    };
    for (const m of text.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options)\(\s*"(\/[^"]*|)"/g)) {
      if (GO_DENY.has(m[1]!)) continue;
      const method = toMethod(m[2]!)!;
      const handler = /^\s*,\s*([\w.]+)\s*[,)]/.exec(text.slice(m.index! + m[0].length, m.index! + m[0].length + 200))?.[1];
      for (const pre of resolve(info, m[1]!, m.index!))
        emit(method, joinPath(pre, m[3]!) || "/", m.index!, handler ? { operationId: handler.split(".").pop() } : {});
    }
    // net/http + gorilla mux
    for (const m of text.matchAll(/\b(\w+)\.(HandleFunc|Handle)\(\s*"([^"]+)"/g)) {
      let pattern = m[3]!;
      let method: Method | undefined;
      const mm = /^([A-Z]+)\s+(\S+)$/.exec(pattern);
      if (mm) {
        method = toMethod(mm[1]!);
        pattern = mm[2]!;
      }
      if (!pattern.startsWith("/")) continue;
      const lineEnd = text.indexOf("\n", m.index!);
      const rest = text.slice(m.index!, lineEnd < 0 ? undefined : lineEnd);
      const methodsCall = /\.Methods\(([^)]*)\)/.exec(rest);
      const methods: Method[] = method
        ? [method]
        : methodsCall
          ? [...methodsCall[1]!.matchAll(/"(\w+)"|http\.Method(\w+)/g)].map((x) => toMethod(x[1] ?? x[2]!)).filter((x): x is Method => !!x)
          : ["GET"];
      const handler = /,\s*([\w.]+)\s*\)/.exec(rest)?.[1];
      for (const pre of resolve(info, m[1]!, m.index!))
        for (const me of methods.length ? methods : (["GET"] as Method[]))
          emit(me, joinPath(pre, pattern), m.index!, handler ? { operationId: handler.split(".").pop() } : {});
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ruby: Rails config/routes.rb and Sinatra
// ---------------------------------------------------------------------------

const RAILS_ACTIONS: [action: string, method: Method, member: boolean, suffix?: string][] = [
  ["index", "GET", false],
  ["create", "POST", false],
  ["show", "GET", true],
  ["update", "PATCH", true],
  ["update", "PUT", true],
  ["destroy", "DELETE", true],
];

function singular(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function symbolList(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  return [...s.matchAll(/:(\w+)|%i\[([^\]]*)\]|['"](\w+)['"]/g)].flatMap((m) => (m[2] ? m[2].split(/\s+/) : [m[1] ?? m[3]!])).filter(Boolean);
}

export function detectRailsRoutes(file: string, text: string): RouteHit[] {
  const out: RouteHit[] = [];
  type Frame = { prefix: string; kind: "ns" | "resource" | "member" | "collection" | "other"; memberPrefix?: string };
  const stack: Frame[] = [];
  // Cumulative prefix per frame, so each line costs O(1) instead of re-reducing the whole stack.
  const cum: string[] = [];
  const push = (f: Frame) => {
    // Real route files nest a handful of levels; beyond that (generated / corrupt input) stop growing paths.
    if (stack.length >= 24) f = { prefix: "", kind: "other" };
    stack.push(f);
    cum.push(f.kind === "member" ? f.prefix : joinPath(cum[cum.length - 1] ?? "", f.prefix));
  };
  const cur = () => cum[cum.length - 1] ?? "";
  const lines = text.split(/\r?\n/);
  // `get :feed, on: :collection` / `on: :member` inside a resources block
  const onBase = (rest: string): string | undefined => {
    const on = /\bon:\s*:(collection|member)\b/.exec(rest)?.[1];
    const top = stack[stack.length - 1];
    if (!on || top?.kind !== "resource" || !top.memberPrefix) return undefined;
    return on === "member" ? top.memberPrefix : top.memberPrefix.replace(/\/\{\w+\}$/, "");
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/^\s*#.*$/, "").replace(/\s#[^'"]*$/, "").trim();
    if (!line) continue;
    const opensBlock = /\bdo(\s*\|[^|]*\|)?\s*$/.test(line);
    if (line === "end") {
      stack.pop();
      cum.pop();
      continue;
    }
    const base = cur();
    let m: RegExpExecArray | null;
    if ((m = /^namespace\s+:(\w+)/.exec(line))) {
      if (opensBlock) push({ prefix: "/" + m[1], kind: "ns" });
      continue;
    }
    if ((m = /^scope\s*\(?\s*(?:path:\s*)?['"]([^'"]*)['"]|^scope\s*\(?\s*:(\w+)|^scope\s+.*\bpath:\s*['"]([^'"]*)['"]/.exec(line))) {
      if (opensBlock) push({ prefix: "/" + (m[1] ?? m[2] ?? m[3] ?? "").replace(/^\//, ""), kind: "ns" });
      continue;
    }
    if (/^scope\b/.test(line)) {
      // scope module: 'x' / scope constraints: ... -> no path segment
      if (opensBlock) push({ prefix: "", kind: "other" });
      continue;
    }
    if ((m = /^(resources|resource)\s+:(\w+)(.*)$/.exec(line))) {
      const plural = m[1] === "resources";
      const name = m[2]!;
      const opts = m[3]!;
      const only = symbolList(/only:\s*(\[[^\]]*\]|%i\[[^\]]*\]|:\w+)/.exec(opts)?.[1]);
      const except = symbolList(/except:\s*(\[[^\]]*\]|%i\[[^\]]*\]|:\w+)/.exec(opts)?.[1]);
      const pathOpt = /path:\s*['"]([^'"]+)['"]/.exec(opts)?.[1];
      const param = /\bparam:\s*:?['"]?(\w+)/.exec(opts)?.[1] ?? "id";
      const coll = joinPath(base, "/" + (pathOpt ?? name));
      const member = plural ? `${coll}/{${param}}` : coll;
      for (const [action, method, isMember] of RAILS_ACTIONS) {
        if (only && !only.includes(action)) continue;
        if (except && except.includes(action)) continue;
        if (!plural && action === "index") continue;
        const p = plural && isMember ? member : coll;
        out.push(hit(method, p, file, i + 1, { operationId: `${name}#${action}` }));
      }
      if (opensBlock) {
        const nestedMember = plural ? `${coll}/{${singular(name)}_${param}}` : coll;
        push({ prefix: nestedMember.slice(base.length) || "/", kind: "resource", memberPrefix: member });
      }
      continue;
    }
    if (/^member\b/.test(line) && opensBlock) {
      const top = stack[stack.length - 1];
      const parentBase = cum[cum.length - 2] ?? "";
      push({ prefix: top?.memberPrefix ?? joinPath(parentBase, "/{id}"), kind: "member" });
      continue;
    }
    if (/^collection\b/.test(line) && opensBlock) {
      const top = stack[stack.length - 1];
      const parentBase = cum[cum.length - 2] ?? "";
      const collPath = top?.memberPrefix ? top.memberPrefix.replace(/\/\{\w+\}$/, "") : parentBase;
      push({ prefix: collPath, kind: "member" });
      continue;
    }
    if ((m = /^root\s+(?:to:\s*)?['"]([^'"]+)['"]/.exec(line))) {
      out.push(hit("GET", base || "/", file, i + 1, { operationId: m[1] }));
      continue;
    }
    if ((m = /^(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"](.*)$/.exec(line))) {
      const rest = m[3]!;
      const target = /(?:=>|to:)\s*['"]([^'"]+)['"]/.exec(rest)?.[1];
      let methods: Method[] = [];
      if (m[1] === "match") {
        methods = (symbolList(/via:\s*(\[[^\]]*\]|:\w+)/.exec(rest)?.[1]) ?? ["get"]).map((x) => toMethod(x)).filter((x): x is Method => !!x);
      } else methods = [toMethod(m[1]!)!];
      for (const me of methods) out.push(hit(me, joinPath(onBase(rest) ?? base, "/" + m[2]!.replace(/^\//, "")), file, i + 1, target ? { operationId: target } : {}));
      if (opensBlock) push({ prefix: "", kind: "other" });
      continue;
    }
    if ((m = /^(get|post|put|patch|delete)\s+:(\w+)(.*)$/.exec(line))) {
      out.push(hit(toMethod(m[1]!)!, joinPath(onBase(m[3]!) ?? base, "/" + m[2]!), file, i + 1));
      continue;
    }
    if (opensBlock) push({ prefix: "", kind: "other" });
  }
  return out;
}

export function detectRubyRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith(".rb")) continue;
    if (/(^|\/)config\/routes\.rb$/.test(file)) {
      out.push(...detectRailsRoutes(file, text));
      continue;
    }
    if (!/sinatra|Sinatra::Base|Roda|Grape::API/.test(text)) continue;
    const lineOf = lineIndex(text);
    for (const m of text.matchAll(/^\s*(get|post|put|patch|delete)\s*\(?\s*['"](\/[^'"]*)['"]\s*\)?\s*(do|\{)/gm))
      out.push(hit(toMethod(m[1]!)!, m[2]!, file, lineOf(m.index!) + (text[m.index!] === "\n" ? 1 : 0)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// PHP Laravel, Java/Kotlin Spring, Rust actix/axum
// ---------------------------------------------------------------------------

const LARAVEL_RESOURCE: [action: string, method: Method, member: boolean, suffix: string][] = [
  ["index", "GET", false, ""],
  ["create", "GET", false, "/create"],
  ["store", "POST", false, ""],
  ["show", "GET", true, ""],
  ["edit", "GET", true, "/edit"],
  ["update", "PUT", true, ""],
  ["update", "PATCH", true, ""],
  ["destroy", "DELETE", true, ""],
];

function phpStringList(s: string | undefined): string[] | undefined {
  if (s === undefined) return undefined;
  return [...s.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]!);
}

/** Laravel: Route::get/post/..., match, any, resource/apiResource, and prefix groups (closure or array form). */
export function detectPhpRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith(".php") || !/Route::/.test(text)) continue;
    const lineOf = lineIndex(text);
    const base = /(^|\/)routes\/api\.php$/.test(file) ? "/api" : "";
    // Prefix groups: Route::prefix('x')->...->group(function () { ... })  |  Route::group(['prefix' => 'x'], function () { ... })
    const scopes: { start: number; end: number; prefix: string }[] = [];
    for (const g of text.matchAll(/(?:->|Route::)group\(/g)) {
      const open = g.index! + g[0].length - 1;
      const close = matchBracket(text, open);
      if (close < 0) continue;
      const stmtStart = Math.max(text.lastIndexOf(";", g.index!), text.lastIndexOf("{", g.index!), text.lastIndexOf("}", g.index!)) + 1;
      const chain = text.slice(stmtStart, g.index!);
      const args = text.slice(open + 1, close);
      const bodyOpen = args.search(/function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{|fn\s*\(/);
      if (bodyOpen < 0) continue;
      const pre =
        /->prefix\(\s*['"]([^'"]*)['"]|Route::prefix\(\s*['"]([^'"]*)['"]/.exec(chain) ??
        /^\s*\[[^\]]*?['"]prefix['"]\s*=>\s*['"]([^'"]*)['"]/.exec(args);
      const prefix = pre ? (pre[1] ?? pre[2] ?? pre[3] ?? "") : "";
      if (prefix) scopes.push({ start: open + 1 + bodyOpen, end: close, prefix: "/" + prefix.replace(/^\/+/, "") });
    }
    const prefixAt = (idx: number) => scopes.filter((sc) => sc.start < idx && idx < sc.end).sort((a, b) => a.start - b.start).reduce((p, sc) => joinPath(p, sc.prefix), base);
    const action = (rest: string) => {
      const at = /^\s*,\s*['"]([\w\\]+@\w+)['"]/.exec(rest)?.[1];
      if (at) return at.split("\\").pop();
      const arr = /^\s*,\s*\[\s*([\w\\]+)::class\s*,\s*['"](\w+)['"]/.exec(rest);
      return arr ? `${arr[1]!.split("\\").pop()}@${arr[2]}` : undefined;
    };
    for (const m of text.matchAll(/Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]*)['"]/g)) {
      const method = toMethod(m[1] === "any" ? "GET" : m[1]!)!;
      const op = action(text.slice(m.index! + m[0].length, m.index! + m[0].length + 200));
      out.push(hit(method, joinPath(prefixAt(m.index!), "/" + m[2]!.replace(/^\//, "")), file, lineOf(m.index!), op ? { operationId: op } : {}));
    }
    for (const m of text.matchAll(/Route::match\(\s*\[([^\]]*)\]\s*,\s*['"]([^'"]*)['"]/g)) {
      const op = action(text.slice(m.index! + m[0].length, m.index! + m[0].length + 200));
      for (const verb of phpStringList(m[1]) ?? []) {
        const method = toMethod(verb);
        if (method) out.push(hit(method, joinPath(prefixAt(m.index!), "/" + m[2]!.replace(/^\//, "")), file, lineOf(m.index!), op ? { operationId: op } : {}));
      }
    }
    for (const m of text.matchAll(/Route::(apiResource|resource)\(\s*['"]([^'"]+)['"]/g)) {
      const open = text.indexOf("(", m.index!);
      const close = matchBracket(text, open);
      const args = close > 0 ? text.slice(open + 1, close) : "";
      const tail = close > 0 ? /^(?:\s*->\s*\w+\((?:[^()]|\([^()]*\))*\))*/.exec(text.slice(close + 1, close + 600))?.[0] ?? "" : "";
      const only = phpStringList(/['"]only['"]\s*=>\s*\[([^\]]*)\]/.exec(args)?.[1] ?? /->only\(\s*\[?([^)\]]*)/.exec(tail)?.[1]);
      const except = phpStringList(/['"]except['"]\s*=>\s*\[([^\]]*)\]/.exec(args)?.[1] ?? /->except\(\s*\[?([^)\]]*)/.exec(tail)?.[1]);
      // "photos.comments" -> /photos/{photo}/comments ; "articles/{article}/comments" is kept as written
      const parts = m[2]!.split(".");
      let coll = prefixAt(m.index!);
      parts.forEach((part, i) => {
        coll = joinPath(coll, "/" + part.replace(/^\//, ""));
        if (i < parts.length - 1) coll = `${coll}/{${singular(part.split("/").pop()!).replace(/-/g, "_")}}`;
      });
      const param = singular(parts[parts.length - 1]!.split("/").pop()!).replace(/-/g, "_");
      const api = m[1] === "apiResource";
      for (const [act, method, isMember, suffix] of LARAVEL_RESOURCE) {
        if (api && (act === "create" || act === "edit")) continue;
        if (only && !only.includes(act)) continue;
        if (except?.includes(act)) continue;
        out.push(hit(method, (isMember ? `${coll}/{${param}}` : coll) + suffix, file, lineOf(m.index!), { operationId: `${m[2]}.${act}` }));
      }
    }
  }
  return out;
}

/** Paths in a Spring mapping argument: "/x", {"/a", "/b"} (Java), ["/a"] (Kotlin), value = / path = forms. */
function springPaths(args: string): string[] {
  const named = /\b(?:value|path)\s*=\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*")/.exec(args)?.[1];
  const src = named ?? /^\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*")/.exec(args)?.[1];
  if (!src) return [""];
  const paths = [...src.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  return paths.length ? paths : [""];
}

export function detectJvmRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  for (const [file, text] of sources) {
    if (!/\.(java|kt)$/.test(file) || !/@(Rest)?Controller\b/.test(text)) continue;
    const lineOf = lineIndex(text);
    // Class-level @RequestMapping: each class keeps the prefix from its own annotation block.
    const classes: { idx: number; prefixes: string[] }[] = [];
    for (const c of text.matchAll(/\b(?:class|interface)\s+\w+/g)) {
      const before = text.slice(Math.max(0, c.index! - 800), c.index!);
      // Only the annotations directly above the class (after the previous statement / block).
      const block = before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("}\n"), before.lastIndexOf("*/")) + 1);
      const rm = /@RequestMapping\s*\(/.exec(block);
      let prefixes = [""];
      if (rm) {
        const open = rm.index! + rm[0].length - 1;
        const close = matchBracket(block, open);
        if (close > 0) prefixes = springPaths(block.slice(open + 1, close));
      }
      classes.push({ idx: c.index!, prefixes });
    }
    const firstClass = classes[0]?.idx ?? 0;
    const re = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b\s*(\()?/g;
    for (const m of text.matchAll(re)) {
      if (m.index! < firstClass) continue;
      let args = "";
      let end = m.index! + m[0].length;
      if (m[2]) {
        const open = m.index! + m[0].length - 1;
        const close = matchBracket(text, open);
        if (close < 0) continue;
        args = text.slice(open + 1, close);
        end = close + 1;
      }
      // A @RequestMapping that annotates a class is its prefix, not a route.
      if (m[1] === "Request" && /^(?:\s*@\w+(?:\([^)]*\))?)*\s*(?:public\s+|abstract\s+|final\s+|open\s+|internal\s+)*(?:class|interface)\b/.test(text.slice(end, end + 400))) continue;
      let methods: Method[];
      if (m[1] === "Request") {
        methods = [...args.matchAll(/RequestMethod\.(\w+)/g)].map((x) => toMethod(x[1]!)).filter((x): x is Method => !!x);
        if (!methods.length) methods = ["GET"];
      } else methods = [toMethod(m[1]!)!];
      let owner = classes[0]!;
      for (const c of classes) if (c.idx < m.index!) owner = c;
      const fn = /(?:public|private|protected|fun)\s+(?:[\w<>,\s?]+\s+)?(\w+)\s*\(/.exec(text.slice(end, end + 400));
      for (const prefix of owner.prefixes)
        for (const p of springPaths(args))
          for (const me of methods) out.push(hit(me, joinPath(prefix, p), file, lineOf(m.index!), fn ? { operationId: fn[1] } : {}));
    }
  }
  return out;
}

/** Bracket matching for Rust: `'a` lifetimes are not quotes; char literals ('x', '\\n', '"') are skipped. */
function rustMatch(text: string, openIdx: number): number {
  const r = rustMatchRaw(text, openIdx);
  return chargeScan(text, (r < 0 ? text.length : r) - openIdx + 1) ? r : -1;
}

function rustMatchRaw(text: string, openIdx: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const close = pairs[text[openIdx]!];
  if (!close || !chargeScan(text, 0)) return -1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "'") {
      const lit = /^'(?:\\.[^']*|[^'\\])'/.exec(text.slice(i, i + 12));
      if (lit) i += lit[0].length - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === close ? i : -1;
    }
  }
  return -1;
}

/** Blank out `#[cfg(test)] mod x { ... }` blocks: axum/actix unit tests declare throwaway routers. */
function stripRustTests(text: string): string {
  let out = text;
  for (const m of text.matchAll(/#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = rustMatch(text, open);
    if (close < 0) continue;
    out = out.slice(0, m.index!) + text.slice(m.index!, close + 1).replace(/[^\n]/g, " ") + out.slice(close + 1);
  }
  return out;
}

export function detectRustRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  type Info = { file: string; text: string; fns: { name: string; start: number; end: number }[]; nests: { start: number; end: number; prefix: string }[] };
  const infos: Info[] = [];
  const fnPrefix = new Map<string, Set<string>>(); // fn name -> nest prefixes of the router it returns
  for (const [file, raw] of sources) {
    if (!file.endsWith(".rs") || !/actix_web|axum|rocket|warp|poem|Router/.test(raw)) continue;
    const text = stripRustTests(raw);
    const fns: Info["fns"] = [];
    for (const m of text.matchAll(/\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
      const pClose = rustMatch(text, m.index! + m[0].length - 1);
      if (pClose < 0) continue;
      const open = text.indexOf("{", pClose);
      const semi = text.indexOf(";", pClose);
      if (open < 0 || (semi >= 0 && semi < open)) continue;
      const close = rustMatch(text, open);
      if (close > open) fns.push({ name: m[1]!, start: open, end: close });
    }
    // .nest("/api", <router expr>)  |  web::scope("/api")...  (actix)
    const nests: Info["nests"] = [];
    for (const m of text.matchAll(/\.nest\(\s*"([^"]*)"\s*,/g)) {
      const open = m.index! + m[0].indexOf("(");
      const close = rustMatch(text, open);
      if (close < 0) continue;
      const arg = text.slice(m.index! + m[0].length, close).trim();
      nests.push({ start: m.index! + m[0].length, end: close, prefix: m[1]! });
      // .nest("/api", api::router()) -> routes inside fn router() get the prefix
      const call = /^(?:[\w:]+::)?(\w+)\s*\(/.exec(arg);
      if (call && !/^Router::/.test(arg)) {
        const set = fnPrefix.get(call[1]!) ?? new Set<string>();
        set.add(m[1]!);
        fnPrefix.set(call[1]!, set);
      }
    }
    for (const m of text.matchAll(/web::scope\(\s*"([^"]*)"\s*\)/g)) {
      // actix: the scope's routes are chained right after it, up to the enclosing call's end
      let depth = 0;
      let end = text.length;
      for (let i = m.index! + m[0].length; i < text.length; i++) {
        const c = text[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") {
          if (depth === 0) {
            end = i;
            break;
          }
          depth--;
        }
      }
      nests.push({ start: m.index!, end, prefix: m[1]! });
    }
    nests.sort((a, b) => a.start - b.start);
    infos.push({ file, text, fns, nests });
  }
  // A nested router fn can itself be nested: resolve fn prefixes transitively (bounded).
  for (let pass = 0; pass < 3; pass++)
    for (const info of infos)
      for (const n of info.nests) {
        const outer = info.fns.find((f) => f.start < n.start && n.start < f.end);
        const outerPre = outer ? fnPrefix.get(outer.name) : undefined;
        if (!outerPre) continue;
        const call = /^\s*(?:[\w:]+::)?(\w+)\s*\(/.exec(info.text.slice(n.start, n.end));
        if (!call) continue;
        const set = fnPrefix.get(call[1]!) ?? new Set<string>();
        for (const p of outerPre) set.add(joinPath(p, n.prefix));
        fnPrefix.set(call[1]!, set);
      }
  const prefixesAt = (info: Info, idx: number): string[] => {
    let local = "";
    for (const n of info.nests) {
      if (n.start >= idx) break;
      if (idx < n.end) local = joinPath(local, n.prefix);
    }
    const fn = info.fns.filter((f) => f.start < idx && idx < f.end).sort((a, b) => b.start - a.start)[0];
    const outer = fn ? fnPrefix.get(fn.name) : undefined;
    return outer?.size ? [...outer].map((p) => joinPath(p, local)) : [local];
  };
  for (const info of infos) {
    const { file, text } = info;
    const lineOf = lineIndex(text);
    for (const m of text.matchAll(/#\[(get|post|put|patch|delete)\(\s*"([^"]*)"[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g))
      out.push(hit(toMethod(m[1]!)!, m[2]!, file, lineOf(m.index!), { operationId: m[3] }));
    for (const m of text.matchAll(/\.(?:route|to)\(\s*"([^"]*)"\s*,/g)) {
      const open = m.index! + m[0].indexOf("(");
      const close = rustMatch(text, open);
      if (close < 0) continue;
      const arg = text.slice(m.index! + m[0].length, close);
      const methods = new Set<Method>();
      for (const mm of arg.matchAll(/\b(get|post|put|patch|delete)(?:_service)?\s*\(/g)) methods.add(toMethod(mm[1]!)!);
      for (const pre of prefixesAt(info, m.index!)) for (const me of methods) out.push(hit(me, joinPath(pre, m[1]!), file, lineOf(m.index!)));
    }
  }
  return out;
}
