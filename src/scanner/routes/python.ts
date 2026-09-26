import path from "node:path";
import type { ApiParam, JSONSchema } from "../../core/types.js";
import { lineIndex } from "../context.js";
import { joinPath, matchBracket, normalizePath, pathParamNames, pyTypeToSchema, splitTopLevel, toMethod, type Method, type RouteHit } from "./util.js";

const SKIP_TYPES = /^(Request|Response|HTTPConnection|WebSocket|BackgroundTasks|Session|AsyncSession|Connection|SecurityScopes|HttpRequest)\b/;

/** Pydantic / SQLModel / ninja Schema classes -> JSON schema. */
export function collectPyModels(sources: Map<string, string>): Map<string, JSONSchema> {
  const classes: { name: string; bases: string[]; fields: [string, string, string | undefined][] }[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith(".py") || !/\b(BaseModel|SQLModel|Schema|TypedDict)\b/.test(text)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/.exec(lines[i]!);
      if (!m) continue;
      const fields: [string, string, string | undefined][] = [];
      let bodyIndent = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (!l.trim() || l.trim().startsWith("#")) continue;
        const indent = l.length - l.trimStart().length;
        if (indent === 0) break;
        if (bodyIndent < 0) bodyIndent = indent;
        if (indent !== bodyIndent) continue;
        const f = /^\s+([a-z_]\w*)\s*:\s*([^=]+?)\s*(?:=\s*(.+))?$/.exec(l);
        if (f && f[1] !== "model_config" && !f[1]!.startsWith("_")) fields.push([f[1]!, f[2]!, f[3]]);
      }
      classes.push({ name: m[1]!, bases: m[2]!.split(",").map((b) => b.trim().split("[")[0]!.split(".").pop()!), fields });
    }
  }
  const models = new Map<string, JSONSchema>();
  const isRoot = (b: string) => b === "BaseModel" || b === "SQLModel" || b === "Schema" || b === "TypedDict";
  for (let pass = 0; pass < 3; pass++)
    for (const c of classes) {
      if (!c.bases.some((b) => isRoot(b) || models.has(b))) continue;
      const props: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const b of c.bases) {
        const parent = models.get(b);
        if (parent && b !== c.name) {
          Object.assign(props, parent.properties ?? {});
          required.push(...(parent.required ?? []));
        }
      }
      for (const [name, type, def] of c.fields) {
        const { schema, optional } = pyTypeToSchema(type, models);
        const desc = def ? /description\s*=\s*["']([^"']+)["']/.exec(def)?.[1] : undefined;
        props[name] = desc ? { ...schema, description: desc } : schema;
        const hasDefault = def !== undefined && !/^(Field\(\s*\.\.\.|\.\.\.)/.test(def.trim());
        if (!hasDefault && !optional) {
          if (!required.includes(name)) required.push(name);
        } else {
          const idx = required.indexOf(name);
          if (idx >= 0) required.splice(idx, 1);
        }
      }
      models.set(c.name, { type: "object", properties: props, ...(required.length ? { required } : {}) });
    }
  return models;
}

interface PyImport {
  module: string; // dotted, possibly relative (".routers")
  attr?: string;
}

function pyImports(text: string): Map<string, PyImport> {
  const map = new Map<string, PyImport>();
  for (const m of text.matchAll(/^from\s+([.\w]+)\s+import\s+(?:\(([^)]*)\)|([^\n(]+))/gm)) {
    for (const part of (m[2] ?? m[3]!).replace(/#.*$/gm, "").split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      if (name && /^\w+$/.test(name)) map.set(alias || name, { module: m[1]!, attr: name });
    }
  }
  for (const m of text.matchAll(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) map.set(m[2] ?? m[1]!.split(".")[0]!, { module: m[1]! });
  return map;
}

function absModule(fromFile: string, mod: string): string {
  if (!mod.startsWith(".")) return mod;
  const dots = /^\.+/.exec(mod)![0].length;
  let dir = path.posix.dirname(fromFile);
  for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
  const rest = mod.slice(dots);
  const base = dir === "." ? "" : dir.replace(/\//g, ".");
  return [base, rest].filter(Boolean).join(".");
}

function findModuleFile(mod: string, known: string[]): string | undefined {
  const rel = mod.replace(/\./g, "/");
  for (const suffix of [`${rel}.py`, `${rel}/__init__.py`]) {
    const hit = known.find((k) => k === suffix || k.endsWith("/" + suffix));
    if (hit) return hit;
  }
  return undefined;
}

/** Resolve `users.router` / `users_router` in `fromFile` to the file defining it. */
function resolveTarget(fromFile: string, expr: string, imports: Map<string, PyImport>, known: string[]): string | undefined {
  const [head, ...rest] = expr.split(".");
  const imp = imports.get(head!);
  if (!imp) return undefined;
  const mod = absModule(fromFile, imp.module);
  const cands: string[] = [];
  if (imp.attr) cands.push(`${mod}.${imp.attr}`, mod);
  else cands.push(mod);
  if (rest.length > 1) cands.unshift(`${cands[0]}.${rest.slice(0, -1).join(".")}`);
  for (const c of cands) {
    const f = findModuleFile(c, known);
    if (f) return f;
  }
  return undefined;
}

function kwarg(args: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*[rf]?(['"])([^'"]*)\\1`).exec(args)?.[2];
}

function docstringAfter(text: string, from: number): string | undefined {
  const chunk = text.slice(from, from + 800);
  const m = /^[^\n]*:\s*\n\s*[rbu]?("""|''')\s*([\s\S]*?)\1/.exec(chunk);
  if (!m) return undefined;
  const first = m[2]!.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  return first ? first.slice(0, 200) : undefined;
}

interface PyRoute extends RouteHit {
  receiver: string;
  rawPath: string;
}

function scanDecorators(file: string, text: string, models: Map<string, JSONSchema>): PyRoute[] {
  const out: PyRoute[] = [];
  const lineOf = lineIndex(text);
  const re = /^[ \t]*@(\w+)\.(get|post|put|patch|delete|head|options|route|api_route)\(/gm;
  for (const m of text.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const args = text.slice(open + 1, close);
    const pm = /^\s*(?:(?:path|rule)\s*=\s*)?[rf]?(['"])(.*?)\1/.exec(args);
    if (!pm) continue;
    let methods: Method[];
    if (m[2] === "route" || m[2] === "api_route") {
      const ms = /methods\s*=\s*[\[({]([^\])}]*)/.exec(args);
      methods = ms ? [...ms[1]!.matchAll(/['"](\w+)['"]/g)].map((x) => toMethod(x[1]!)).filter((x): x is Method => !!x) : ["GET"];
      if (!methods.length) methods = ["GET"];
    } else methods = [toMethod(m[2]!)!];

    // handler
    const after = text.slice(close + 1);
    const def = /^(?:\s*@[^\n]*)*\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(after);
    let operationId: string | undefined;
    let summary = kwarg(args, "summary");
    const params: ApiParam[] = [];
    const pathTypes: Record<string, JSONSchema> = {};
    let requestBody: JSONSchema | undefined;
    const pathNames = new Set(pathParamNames(normalizePath(pm[2]!).path));
    if (def) {
      operationId = def[1]!;
      const sOpen = close + 1 + def.index + def[0].length - 1;
      const sClose = matchBracket(text, sOpen);
      if (sClose > sOpen) {
        summary ??= docstringAfter(text, sClose + 1);
        const bodyParts: [string, JSONSchema, boolean][] = [];
        for (const raw of splitTopLevel(text.slice(sOpen + 1, sClose))) {
          const pmm = /^(\*{0,2}\w+)\s*(?::\s*(.+?))?\s*(?:=\s*(.+))?$/s.exec(raw);
          if (!pmm) continue;
          const [, name, type, def] = pmm;
          if (!name || name.startsWith("*") || name === "self" || name === "cls") continue;
          if (def && /\b(Depends|Security)\(/.test(def)) continue;
          if (type && (SKIP_TYPES.test(type.trim()) || /\bDepends\b/.test(type))) continue;
          const { schema, optional } = pyTypeToSchema(type, models);
          const noDefault = def === undefined || /^(\.\.\.|\w+\(\s*\.\.\.)/.test(def.trim());
          const required = noDefault && !optional;
          const desc = def ? /description\s*=\s*["']([^"']+)["']/.exec(def)?.[1] : undefined;
          if (desc) schema.description = desc;
          if (pathNames.has(name) || (def && /^Path\(/.test(def.trim()))) {
            if (schema.type && schema.type !== "object") pathTypes[name] = schema;
          } else if (def && /^Header\(/.test(def.trim())) {
            params.push({ name: name.replace(/_/g, "-"), in: "header", required, schema });
          } else if (def && /^(Body|Form|File)\(/.test(def.trim())) {
            bodyParts.push([name, schema, required]);
          } else if (type && /UploadFile/.test(type)) {
            bodyParts.push([name, { type: "string", format: "binary" }, required]);
          } else if (schema.type === "object" && schema.properties) {
            bodyParts.push([name, schema, required]);
          } else if (type || def !== undefined) {
            if (m[2] === "route") continue; // flask: non-path args are not request params
            params.push({ name, in: "query", required, schema });
          }
        }
        if (bodyParts.length === 1 && bodyParts[0]![1].properties) requestBody = bodyParts[0]![1];
        else if (bodyParts.length)
          requestBody = {
            type: "object",
            properties: Object.fromEntries(bodyParts.map(([n, s]) => [n, s])),
            required: bodyParts.filter(([, , r]) => r).map(([n]) => n),
          };
      }
    }
    for (const method of methods) {
      out.push({
        method,
        path: "",
        rawPath: pm[2]!,
        receiver: m[1]!,
        file,
        line: lineOf(m.index!) + (text[m.index!] === "\n" ? 1 : 0),
        operationId,
        summary,
        params: params.length ? params : undefined,
        pathTypes,
        requestBody: method === "GET" || method === "HEAD" ? undefined : requestBody,
      });
    }
  }
  return out;
}

const REST_ACTIONS: [string, Method, boolean][] = [
  ["list", "GET", false],
  ["create", "POST", false],
  ["retrieve", "GET", true],
  ["update", "PUT", true],
  ["partial_update", "PATCH", true],
  ["destroy", "DELETE", true],
];

function scanDjangoUrls(file: string, text: string, known: string[], filePrefix: Map<string, string>, edges: [string, string, string][]): PyRoute[] {
  const out: PyRoute[] = [];
  const lineOf = lineIndex(text);
  const prefix = filePrefix.get(file) ?? "";
  let routerPrefix = "";
  const inc = /\b(?:re_)?path\(\s*r?(['"])([^'"]*)\1\s*,\s*include\(\s*(\w+)\.urls/.exec(text);
  if (inc) routerPrefix = inc[2]!;
  for (const m of text.matchAll(/\b(re_path|path|url)\(\s*r?(['"])([^'"]*)\2\s*,\s*([^\n]*)/g)) {
    const rest = m[4]!;
    const incStr = /^include\(\s*(['"])([\w.]+)\1/.exec(rest);
    if (incStr) {
      const target = findModuleFile(incStr[2]!, known);
      if (target) edges.push([file, target, m[3]!]);
      continue;
    }
    if (/^include\(/.test(rest)) continue;
    const view = /^([\w.]+)(?:\.as_view\(|,|\))/.exec(rest)?.[1];
    const name = /name\s*=\s*['"]([\w-]+)['"]/.exec(rest)?.[1];
    out.push({
      method: "GET",
      path: "",
      rawPath: joinPath(prefix, m[3]!.startsWith("^") ? m[3]! : "/" + m[3]!, true),
      receiver: "",
      file,
      line: lineOf(m.index!),
      operationId: name ?? view?.split(".").pop(),
      summary: view ? `Django view ${view}` : undefined,
    });
  }
  // DRF routers
  for (const m of text.matchAll(/\b\w+\.register\(\s*r?(['"])([^'"]*)\1\s*,\s*(\w+)/g)) {
    const base = joinPath(joinPath(prefix, "/" + routerPrefix, true), "/" + m[2]!, true).replace(/\/$/, "");
    const viewset = m[3]!;
    const readOnly = /ReadOnly/.test(viewset);
    for (const [action, method, detail] of REST_ACTIONS) {
      if (readOnly && method !== "GET") continue;
      out.push({
        method,
        path: "",
        rawPath: detail ? `${base}/{id}/` : `${base}/`,
        receiver: "",
        file,
        line: lineOf(m.index!),
        operationId: `${viewset}.${action}`,
      });
    }
  }
  return out;
}

export function detectPythonRoutes(sources: Map<string, string>): RouteHit[] {
  const pyFiles = [...sources.keys()].filter((f) => f.endsWith(".py"));
  if (!pyFiles.length) return [];
  const needsModels = pyFiles.some((f) => /fastapi|ninja/.test(sources.get(f)!));
  const models = needsModels ? collectPyModels(sources) : new Map<string, JSONSchema>();
  const routes: PyRoute[] = [];
  const receiverPrefix = new Map<string, Map<string, string>>(); // file -> var -> prefix
  const edges: [from: string, to: string, prefix: string][] = [];

  for (const file of pyFiles) {
    const text = sources.get(file)!;
    if (!/@\w+\.(get|post|put|patch|delete|route|api_route)\(|include_router|register_blueprint|urlpatterns/.test(text)) continue;
    const vars = new Map<string, string>();
    for (const m of text.matchAll(/^(\w+)\s*(?::\s*\w+\s*)?=\s*(?:\w+\.)?(APIRouter|Blueprint|FastAPI|Flask|Router|NinjaAPI)\(/gm)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(text, open);
      const args = close > 0 ? text.slice(open + 1, close) : "";
      vars.set(m[1]!, kwarg(args, "prefix") ?? kwarg(args, "url_prefix") ?? kwarg(args, "root_path") ?? "");
    }
    receiverPrefix.set(file, vars);
    const imports = pyImports(text);
    for (const m of text.matchAll(/\.(include_router|register_blueprint|add_router)\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(text, open);
      if (close < 0) continue;
      const args = splitTopLevel(text.slice(open + 1, close));
      let targetExpr = args[0] ?? "";
      let prefix = kwarg(args.join(","), "prefix") ?? kwarg(args.join(","), "url_prefix") ?? "";
      if (m[1] === "add_router") {
        prefix = /^[rf]?['"]([^'"]*)['"]$/.exec(args[0] ?? "")?.[1] ?? "";
        targetExpr = args[1] ?? "";
      }
      if (!/^[\w.]+$/.test(targetExpr)) continue;
      const target = resolveTarget(file, targetExpr, imports, pyFiles);
      if (target) edges.push([file, target, prefix]);
      else if (!targetExpr.includes(".")) {
        // same-file router variable
        const cur = vars.get(targetExpr) ?? "";
        vars.set(targetExpr, joinPath(prefix, cur, true));
      }
    }
    routes.push(...scanDecorators(file, text, models));
  }

  // Django urls.py (include chains need a prefix pass first)
  const urlFiles = pyFiles.filter((f) => /(^|\/)urls\.py$/.test(f));
  const djangoPrefix = new Map<string, string>();
  if (urlFiles.length) {
    const djEdges: [string, string, string][] = [];
    for (const f of urlFiles) scanDjangoUrls(f, sources.get(f)!, pyFiles, djangoPrefix, djEdges);
    for (let i = 0; i < 6; i++)
      for (const [from, to, p] of djEdges) djangoPrefix.set(to, joinPath(djangoPrefix.get(from) ?? "", "/" + p, true));
    for (const f of urlFiles) routes.push(...scanDjangoUrls(f, sources.get(f)!, pyFiles, djangoPrefix, []));
  }

  const filePrefix = new Map<string, string>();
  for (let i = 0; i < 6; i++) {
    let changed = false;
    for (const [from, to, p] of edges) {
      if (from === to) continue;
      const next = joinPath(filePrefix.get(from) ?? "", p, true);
      if (filePrefix.get(to) !== next) {
        filePrefix.set(to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const out: RouteHit[] = [];
  for (const r of routes) {
    let raw = r.rawPath;
    if (r.receiver) {
      raw = joinPath(receiverPrefix.get(r.file)?.get(r.receiver) ?? "", raw, true);
      raw = joinPath(filePrefix.get(r.file) ?? "", raw, true);
    }
    const { path: p, types } = normalizePath(raw, { keepTrailingSlash: true });
    const { receiver: _r, rawPath: _p, ...hit } = r;
    out.push({ ...hit, path: p, pathTypes: { ...types, ...(r.pathTypes ?? {}) } });
  }
  return out;
}
