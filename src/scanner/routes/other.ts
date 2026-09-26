import { lineIndex } from "../context.js";
import { joinPath, matchBracket, normalizePath, toMethod, type Method, type RouteHit } from "./util.js";

function hit(method: Method, raw: string, file: string, line: number, extra: Partial<RouteHit> = {}, keepTrailingSlash = false): RouteHit {
  const { path, types } = normalizePath(raw, { keepTrailingSlash });
  return { method, path, file, line, pathTypes: types, ...extra };
}

// ---------------------------------------------------------------------------
// Go: gin / echo / fiber / chi / gorilla mux / net/http
// ---------------------------------------------------------------------------

const GO_DENY = new Set(["http", "client", "os", "viper", "c", "ctx", "req", "resp", "r2", "cache", "m", "sync", "cfg", "config"]);

export function detectGoRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith(".go")) continue;
    if (!/"net\/http"|gin-gonic|labstack\/echo|gofiber|go-chi|gorilla\/mux|httprouter/.test(text)) continue;
    const lineOf = lineIndex(text);
    const prefix = new Map<string, string>();
    for (const m of text.matchAll(/\b(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/g))
      prefix.set(m[1]!, joinPath(prefix.get(m[2]!) ?? "", m[3]!));
    for (const m of text.matchAll(/\b(\w+)\s*:?=\s*(\w+)\.PathPrefix\(\s*"([^"]*)"\s*\)\.Subrouter\(\)/g))
      prefix.set(m[1]!, joinPath(prefix.get(m[2]!) ?? "", m[3]!));
    // chi: r.Route("/x", func(r chi.Router) { ... }) -> scoped prefix ranges
    const scopes: { start: number; end: number; v: string; prefix: string }[] = [];
    for (const m of text.matchAll(/\b(\w+)\.Route\(\s*"([^"]*)"\s*,\s*func\s*\(\s*(\w+)\s+[\w.]+\)\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(text, open);
      if (close > open) scopes.push({ start: open, end: close, v: m[3]!, prefix: m[2]! });
    }
    const scopedPrefix = (v: string, idx: number) => {
      let p = "";
      for (const s of scopes) if (s.start < idx && idx < s.end && s.v === v) p = joinPath(p, s.prefix);
      return p;
    };
    for (const m of text.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options)\(\s*"(\/[^"]*)"/g)) {
      if (GO_DENY.has(m[1]!)) continue;
      const method = toMethod(m[2]!)!;
      const raw = joinPath(joinPath(scopedPrefix(m[1]!, m.index!), prefix.get(m[1]!) ?? ""), m[3]!);
      const handler = /^\s*,\s*([\w.]+)\s*[,)]/.exec(text.slice(m.index! + m[0].length, m.index! + m[0].length + 200))?.[1];
      out.push(hit(method, raw, file, lineOf(m.index!), handler ? { operationId: handler.split(".").pop() } : {}));
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
      const raw = joinPath(prefix.get(m[1]!) ?? "", pattern);
      const handler = /,\s*([\w.]+)\s*\)/.exec(rest)?.[1];
      for (const me of methods.length ? methods : (["GET"] as Method[]))
        out.push(hit(me, raw, file, lineOf(m.index!), handler ? { operationId: handler.split(".").pop() } : {}));
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
  const cur = () => stack.reduce((p, f) => (f.kind === "member" ? f.prefix : joinPath(p, f.prefix)), "");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/^\s*#.*$/, "").replace(/\s#[^'"]*$/, "").trim();
    if (!line) continue;
    const opensBlock = /\bdo(\s*\|[^|]*\|)?\s*$/.test(line);
    if (line === "end") {
      stack.pop();
      continue;
    }
    const base = cur();
    let m: RegExpExecArray | null;
    if ((m = /^namespace\s+:(\w+)/.exec(line))) {
      if (opensBlock) stack.push({ prefix: "/" + m[1], kind: "ns" });
      continue;
    }
    if ((m = /^scope\s+(?:path:\s*)?['"]([^'"]*)['"]|^scope\s+.*\bpath:\s*['"]([^'"]*)['"]/.exec(line))) {
      if (opensBlock) stack.push({ prefix: "/" + (m[1] ?? m[2] ?? "").replace(/^\//, ""), kind: "ns" });
      continue;
    }
    if ((m = /^(resources|resource)\s+:(\w+)(.*)$/.exec(line))) {
      const plural = m[1] === "resources";
      const name = m[2]!;
      const opts = m[3]!;
      const only = symbolList(/only:\s*(\[[^\]]*\]|%i\[[^\]]*\]|:\w+)/.exec(opts)?.[1]);
      const except = symbolList(/except:\s*(\[[^\]]*\]|%i\[[^\]]*\]|:\w+)/.exec(opts)?.[1]);
      const pathOpt = /path:\s*['"]([^'"]+)['"]/.exec(opts)?.[1];
      const coll = joinPath(base, "/" + (pathOpt ?? name));
      const member = plural ? `${coll}/{id}` : coll;
      for (const [action, method, isMember] of RAILS_ACTIONS) {
        if (only && !only.includes(action)) continue;
        if (except && except.includes(action)) continue;
        if (!plural && action === "index") continue;
        const p = plural && isMember ? member : coll;
        out.push(hit(method, p, file, i + 1, { operationId: `${name}#${action}` }));
      }
      if (opensBlock) {
        const nestedMember = plural ? `${coll}/{${singular(name)}_id}` : coll;
        stack.push({ prefix: nestedMember.slice(base.length) || "/", kind: "resource", memberPrefix: member });
      }
      continue;
    }
    if (/^member\b/.test(line) && opensBlock) {
      const top = stack[stack.length - 1];
      const parentBase = stack.slice(0, -1).reduce((p, f) => joinPath(p, f.prefix), "");
      stack.push({ prefix: top?.memberPrefix ?? joinPath(parentBase, "/{id}"), kind: "member" });
      continue;
    }
    if (/^collection\b/.test(line) && opensBlock) {
      const top = stack[stack.length - 1];
      const parentBase = stack.slice(0, -1).reduce((p, f) => joinPath(p, f.prefix), "");
      const collPath = top?.memberPrefix ? top.memberPrefix.replace(/\/\{id\}$/, "") : parentBase;
      stack.push({ prefix: collPath, kind: "member" });
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
      for (const me of methods) out.push(hit(me, joinPath(base, "/" + m[2]!.replace(/^\//, "")), file, i + 1, target ? { operationId: target } : {}));
      if (opensBlock) stack.push({ prefix: "", kind: "other" });
      continue;
    }
    if ((m = /^(get|post|put|patch|delete)\s+:(\w+)/.exec(line))) {
      out.push(hit(toMethod(m[1]!)!, joinPath(base, "/" + m[2]!), file, i + 1));
      continue;
    }
    if (opensBlock) stack.push({ prefix: "", kind: "other" });
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

export function detectPhpRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith(".php") || !/Route::/.test(text)) continue;
    const lineOf = lineIndex(text);
    const base = /(^|\/)routes\/api\.php$/.test(file) ? "/api" : "";
    for (const m of text.matchAll(/Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]*)['"]/g)) {
      const method = toMethod(m[1] === "any" ? "GET" : m[1]!)!;
      out.push(hit(method, joinPath(base, "/" + m[2]!.replace(/^\//, "")), file, lineOf(m.index!)));
    }
    for (const m of text.matchAll(/Route::(apiResource|resource)\(\s*['"]([^'"]+)['"]/g)) {
      const coll = joinPath(base, "/" + m[2]!);
      const param = singular(m[2]!.split(/[./]/).pop()!).replace(/-/g, "_");
      for (const [action, method, isMember] of RAILS_ACTIONS)
        out.push(hit(method, isMember ? `${coll}/{${param}}` : coll, file, lineOf(m.index!), { operationId: `${m[2]}.${action === "create" ? "store" : action}` }));
    }
  }
  return out;
}

export function detectJvmRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  for (const [file, text] of sources) {
    if (!/\.(java|kt)$/.test(file) || !/@(Rest)?Controller\b/.test(text)) continue;
    const lineOf = lineIndex(text);
    const classIdx = text.search(/\bclass\s+\w+/);
    const classMapping = /@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/.exec(text.slice(0, Math.max(0, classIdx)));
    const prefix = classMapping?.[1] ?? "";
    const re = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b(\(([^)]*)\))?/g;
    for (const m of text.matchAll(re)) {
      if (m.index! < classIdx) continue;
      const args = m[3] ?? "";
      const p = /(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/.exec(args)?.[1] ?? "";
      let methods: Method[];
      if (m[1] === "Request") {
        methods = [...args.matchAll(/RequestMethod\.(\w+)/g)].map((x) => toMethod(x[1]!)).filter((x): x is Method => !!x);
        if (!methods.length) methods = ["GET"];
      } else methods = [toMethod(m[1]!)!];
      const fn = /(?:public|private|protected|fun)\s+(?:[\w<>,\s?]+\s+)?(\w+)\s*\(/.exec(text.slice(m.index! + m[0].length, m.index! + m[0].length + 400));
      for (const me of methods) out.push(hit(me, joinPath(prefix, p), file, lineOf(m.index!), fn ? { operationId: fn[1] } : {}));
    }
  }
  return out;
}

export function detectRustRoutes(sources: Map<string, string>): RouteHit[] {
  const out: RouteHit[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith(".rs") || !/actix_web|axum|rocket|warp/.test(text)) continue;
    const lineOf = lineIndex(text);
    for (const m of text.matchAll(/#\[(get|post|put|patch|delete)\(\s*"([^"]*)"[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g))
      out.push(hit(toMethod(m[1]!)!, m[2]!, file, lineOf(m.index!), { operationId: m[3] }));
    for (const m of text.matchAll(/\.route\(\s*"([^"]*)"\s*,/g)) {
      const open = m.index! + m[0].indexOf("(");
      const close = matchBracket(text, open);
      if (close < 0) continue;
      const arg = text.slice(m.index! + m[0].length, close);
      const methods = new Set<Method>();
      for (const mm of arg.matchAll(/\b(get|post|put|patch|delete)\s*\(/g)) methods.add(toMethod(mm[1]!)!);
      for (const me of methods) out.push(hit(me, m[1]!, file, lineOf(m.index!)));
    }
  }
  return out;
}
