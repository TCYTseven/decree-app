import path from "node:path";
import type { ApiParam, JSONSchema } from "../../core/types.js";
import { lineIndex } from "../context.js";
import {
  HTTP_METHODS,
  joinPath,
  matchBracket,
  normalizePath,
  resolveJsImport,
  splitTopLevel,
  toMethod,
  tsTypeToSchema,
  type Method,
  type RouteHit,
} from "./util.js";

const JS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Receivers that are HTTP clients or maps, not routers. */
const DENY_RECEIVERS = new Set([
  "axios", "http", "https", "client", "httpClient", "api_client", "request", "fetch", "got", "ky", "superagent",
  "supertest", "agent", "cy", "page", "map", "cache", "store", "params", "headers", "searchParams", "url", "res",
  "req", "ctx", "c", "context", "response", "cookies", "session", "localStorage", "sessionStorage", "redis", "db",
  "Reflect", "Map", "WeakMap", "formData", "query", "config", "settings", "env", "$http", "instance", "service",
]);

const ROUTER_HINT = /\b(express|fastify|hono|koa|@koa\/router|koa-router|Router\s*\(|elysia|polka|restify|h3|itty-router|@hono\/)/;

interface JsRoute extends RouteHit {
  receiver?: string;
  /** NestJS controller route (global prefix / URI versioning apply). */
  nest?: boolean;
  version?: string;
}

interface NestApp {
  /** Directory the Nest app lives in ("" = root); routes below it get its global prefix. */
  root: string;
  prefix: string;
  exclude: string[];
  /** URI versioning: prefix before the version ("v" by default) and the default version. */
  uriVersioning?: { prefix: string; defaultVersion?: string };
}

/** App root for a Nest bootstrap file: `apps/api/src/main.ts` -> `apps/api`. */
function appRootOf(file: string): string {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const m = /^(.*?)(?:^|\/)src(?:\/.*)?$/.exec(dir);
  return m ? m[1]! : dir;
}

/** `app.setGlobalPrefix('api', { exclude: [...] })` and `app.enableVersioning({ type: VersioningType.URI })`. */
function nestAppConfig(file: string, text: string): NestApp | undefined {
  const gp = /\.setGlobalPrefix\(\s*(['"`])([^'"`$]*)\1/.exec(text);
  const ev = /\.enableVersioning\(/.exec(text);
  if (!gp && !ev) return undefined;
  const app: NestApp = { root: appRootOf(file), prefix: gp ? normalizePath(gp[2]!).path : "", exclude: [] };
  if (gp) {
    const open = text.indexOf("(", gp.index!);
    const close = matchBracket(text, open);
    const args = close > 0 ? text.slice(open + 1, close) : "";
    const ex = /\bexclude\s*:\s*\[([^\]]*)\]/.exec(args)?.[1];
    if (ex) for (const x of ex.matchAll(/(['"`])([^'"`]+)\1|\bpath\s*:\s*(['"`])([^'"`]+)\3/g)) app.exclude.push(normalizePath(x[2] ?? x[4]!).path);
  }
  if (ev) {
    const open = text.indexOf("(", ev.index!);
    const close = matchBracket(text, open);
    const args = close > 0 ? text.slice(open + 1, close) : "";
    // enableVersioning() without a type defaults to URI versioning.
    if (/VersioningType\.URI\b/.test(args) || !/\btype\s*:/.test(args)) {
      const pre = /\bprefix\s*:\s*(['"`])([^'"`]*)\1/.exec(args)?.[2];
      const noPrefix = /\bprefix\s*:\s*false/.test(args);
      app.uriVersioning = { prefix: noPrefix ? "" : (pre ?? "v") };
      const dv = /\bdefaultVersion\s*:\s*\[?\s*(['"`])([^'"`]+)\1/.exec(args)?.[2];
      if (dv) app.uriVersioning.defaultVersion = dv;
    }
  }
  return app;
}

/**
 * @fastify/autoload: `register(autoload, { dir: path.join(__dirname, 'routes'), options: { prefix: '/api' } })`.
 * Every file below that directory is registered with its directory path as prefix (`_id` dirs become `{id}`).
 */
interface AutoloadDir {
  dir: string;
  prefix: string;
}

function fastifyAutoloadDirs(file: string, text: string): AutoloadDir[] {
  if (!/@fastify\/autoload|fastify-autoload/.test(text)) return [];
  const out: AutoloadDir[] = [];
  const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  for (const m of text.matchAll(/\.register\(\s*[\w$]+\s*,\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const obj = text.slice(open, close + 1);
    const d =
      /\bdir\s*:\s*(?:path\.)?(?:join|resolve)\(\s*(?:__dirname|import\.meta\.dirname|dirname\([^)]*\)|[\w$]+)\s*,\s*((?:(['"`])[^'"`$]*\2\s*,?\s*)+)\)/.exec(obj);
    if (!d) continue;
    const segs = [...d[1]!.matchAll(/(['"`])([^'"`$]*)\1/g)].map((x) => x[2]!);
    const dir = path.posix.normalize(path.posix.join(base || ".", ...segs)).replace(/^\.\/?/, "").replace(/\/$/, "");
    if (dir.startsWith("..")) continue;
    const prefix = /\boptions\s*:\s*\{[^}]*?\bprefix\s*:\s*(['"`])([^'"`$]*)\1/.exec(obj)?.[2] ?? "";
    out.push({ dir, prefix: prefix ? normalizePath(prefix).path : "" });
  }
  return out;
}

interface Mount {
  from: string;
  prefix: string;
  target?: string; // other file
  receiver?: string; // same-file router variable
}

function importsOf(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of text.matchAll(/import\s+([\w$]+)(?:\s*,\s*\{([^}]*)\})?\s+from\s+['"]([^'"]+)['"]/g)) {
    map.set(m[1]!, m[3]!);
    if (m[2]) for (const n of m[2].split(",")) addNamed(map, n, m[3]!);
  }
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g))
    for (const n of m[1]!.split(",")) addNamed(map, n, m[2]!);
  for (const m of text.matchAll(/import\s*\*\s*as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/g)) map.set(m[1]!, m[2]!);
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) map.set(m[1]!, m[2]!);
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g))
    for (const n of m[1]!.split(",")) {
      const local = n.split(":").pop()!.trim();
      if (local) map.set(local, m[2]!);
    }
  return map;
}

function addNamed(map: Map<string, string>, spec: string, from: string) {
  const parts = spec.trim().split(/\s+as\s+/);
  const local = (parts[1] ?? parts[0] ?? "").trim().replace(/^type\s+/, "");
  if (local) map.set(local, from);
}

function stringArg(s: string): string | undefined {
  const m = /^\s*(['"`])([^'"`$]*)\1/.exec(s);
  return m ? m[2] : undefined;
}

/** Express / Fastify / Hono / Koa style route calls. */
function scanRouterCalls(file: string, text: string, lineOf: (i: number) => number): { routes: JsRoute[]; mounts: Mount[] } {
  const routes: JsRoute[] = [];
  const mounts: Mount[] = [];
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|del|head|options)\s*(?:<[^>()]*>)?\(\s*(['"`])(\/[^'"`$]*)\3/g;
  for (const m of text.matchAll(callRe)) {
    const receiver = m[1]!;
    if (DENY_RECEIVERS.has(receiver) || /client|http|fetch|axios|request|cache|store|map$/i.test(receiver) && !/router|app|server|routes/i.test(receiver)) continue;
    const method = toMethod(m[2]!);
    if (!method) continue;
    const { path, types } = normalizePath(m[4]!);
    routes.push({ method, path, file, line: lineOf(m.index!), receiver, pathTypes: types });
  }
  // router.route('/x').get(...).post(...)
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*route\(\s*(['"`])(\/[^'"`$]*)\2\s*\)/g)) {
    const start = m.index! + m[0].length;
    let end = text.indexOf(";", start);
    const nextRoute = text.indexOf(".route(", start);
    if (end < 0 || (nextRoute >= 0 && nextRoute < end)) end = nextRoute >= 0 ? nextRoute : Math.min(text.length, start + 2000);
    const chain = text.slice(start, end);
    const { path, types } = normalizePath(m[3]!);
    for (const c of chain.matchAll(/(?:^|\)|\n)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(/g)) {
      const method = toMethod(c[1]!);
      if (method) routes.push({ method, path, file, line: lineOf(m.index!), receiver: m[1]!, pathTypes: types });
    }
  }
  // fastify.route({ method: 'POST', url: '/x' })
  for (const m of text.matchAll(/\.\s*route\(\s*\{/g)) {
    const chunk = text.slice(m.index!, m.index! + 600);
    const url = /\b(?:url|path)\s*:\s*(['"`])(\/[^'"`$]*)\1/.exec(chunk);
    const meth = /\bmethod\s*:\s*(\[[^\]]*\]|(['"`])\w+\2)/.exec(chunk);
    if (!url || !meth) continue;
    const { path, types } = normalizePath(url[2]!);
    for (const mm of meth[1]!.matchAll(/['"`](\w+)['"`]/g)) {
      const method = toMethod(mm[1]!);
      if (method) routes.push({ method, path, file, line: lineOf(m.index!), pathTypes: types });
    }
  }
  // mounts: app.use('/api', router) | app.route('/users', users) | router.use('/x', sub.routes())
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(use|route)\(\s*(['"`])(\/[^'"`$]*)\3\s*,/g)) {
    const open = text.indexOf("(", m.index! + m[1]!.length);
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const args = splitTopLevel(text.slice(open + 1, close));
    const last = args[args.length - 1] ?? "";
    const v = /^([A-Za-z_$][\w$]*)(?:\.routes\(\)|\.router)?$/.exec(last.trim());
    if (v) mounts.push({ from: file, prefix: normalizePath(m[4]!).path, receiver: v[1]! });
  }
  // hono: const api = new Hono().basePath('/api')  |  const v1 = app.basePath('/v1')
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+Hono\s*(?:<[^>()]*>)?\(\s*\)|[A-Za-z_$][\w$]*)\s*\.\s*basePath\(\s*(['"`])(\/[^'"`$]*)\2/g))
    mounts.push({ from: file, prefix: normalizePath(m[3]!).path, receiver: m[1]! });
  // fastify.register(plugin, { prefix: '/x' })
  for (const m of text.matchAll(/\.\s*register\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[^}]*?\bprefix\s*:\s*(['"`])(\/[^'"`$]*)\2/g))
    mounts.push({ from: file, prefix: normalizePath(m[3]!).path, receiver: m[1]! });
  return { routes, mounts };
}

// ---------------------------------------------------------------------------
// NestJS
// ---------------------------------------------------------------------------

/** Collect DTO-ish classes/interfaces into JSON schemas. */
export function collectTsModels(sources: Map<string, string>): Map<string, JSONSchema> {
  const models = new Map<string, JSONSchema>();
  const pending: [string, string][] = [];
  for (const [file, text] of sources) {
    if (!JS_EXT.test(file)) continue;
    if (!/\b(class|interface)\s+\w*(Dto|DTO|Input|Request|Body|Payload|Params|Query)\b/.test(text)) continue;
    for (const m of text.matchAll(/\b(?:class|interface)\s+(\w*(?:Dto|DTO|Input|Request|Body|Payload|Params|Query))\b[^{]*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(text, open);
      if (close > open) pending.push([m[1]!, text.slice(open + 1, close)]);
    }
  }
  // two passes so nested DTO references resolve
  for (let pass = 0; pass < 2; pass++)
    for (const [name, body] of pending) {
      const props: Record<string, JSONSchema> = {};
      const required: string[] = [];
      let optionalNext = false;
      for (const rawLine of body.split("\n")) {
        if (/@IsOptional\b|@ApiPropertyOptional\b/.test(rawLine)) optionalNext = true;
        const line = rawLine.replace(/@\w+\((?:[^()]|\([^()]*\))*\)\s*/g, "").replace(/\/\/.*$/, "");
        const f = /^\s*(?:readonly\s+|public\s+)*([A-Za-z_]\w*)\s*(\?)?\s*!?\s*:\s*([^;=]+)/.exec(line);
        if (!f) continue;
        props[f[1]!] = tsTypeToSchema(f[3]!.trim().replace(/[,;]$/, ""), models);
        if (!f[2] && !optionalNext) required.push(f[1]!);
        optionalNext = false;
      }
      if (Object.keys(props).length) models.set(name, { type: "object", properties: props, ...(required.length ? { required } : {}) });
    }
  return models;
}

/** First version string in a Nest `version: '1'` / `version: ['1', '2']` option or `@Version('1')` argument. */
function nestVersion(arg: string, key = true): string | undefined {
  const re = key ? /\bversion\s*:\s*\[?\s*(['"`])([^'"`]+)\1/ : /^\s*\[?\s*(['"`])([^'"`]+)\1/;
  return re.exec(arg)?.[2];
}

function scanNest(file: string, text: string, lineOf: (i: number) => number, models: Map<string, JSONSchema>): JsRoute[] {
  const routes: JsRoute[] = [];
  let prefix = "";
  let ctrlVersion: string | undefined;
  const re = /@(Controller|Get|Post|Put|Patch|Delete|Head|Options)\(/g;
  for (const m of text.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const arg = text.slice(open + 1, close).trim();
    let p = stringArg(arg) ?? /\bpath\s*:\s*(['"`])([^'"`]*)\1/.exec(arg)?.[2] ?? /^\[\s*(['"`])([^'"`]*)\1/.exec(arg)?.[2] ?? "";
    if (m[1] === "Controller") {
      prefix = normalizePath(p).path;
      ctrlVersion = nestVersion(arg);
      continue;
    }
    const method = toMethod(m[1]!);
    if (!method) continue;
    const { path, types } = normalizePath(joinPath(prefix, normalizePath(p).path));
    const hit: JsRoute = { method, path, file, line: lineOf(m.index!), pathTypes: types, nest: true };
    // @Version('2') among the handler's decorators overrides the controller version.
    const decoBlock = /^(?:\s*@\w+(?:\((?:[^()]|\([^()]*\))*\))?)*/.exec(text.slice(close + 1, close + 1500))?.[0] ?? "";
    const before = text.slice(Math.max(0, m.index! - 600), m.index!);
    const preBlock = before.slice(Math.max(before.lastIndexOf("}"), before.lastIndexOf(";"), before.lastIndexOf("{")) + 1);
    const methodVersion = /@Version\(([^)]*)\)/.exec(preBlock + decoBlock)?.[1];
    const version = (methodVersion !== undefined ? nestVersion(methodVersion, false) : undefined) ?? ctrlVersion;
    if (version) hit.version = version;
    // handler signature: skip following decorators, find `name(...)`
    const after = text.slice(close + 1, close + 1500);
    const sig = /^(?:\s*@\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/.exec(after);
    if (sig) {
      hit.operationId = sig[1]!;
      const pOpen = close + 1 + sig.index + sig[0].length - 1;
      const pClose = matchBracket(text, pOpen);
      if (pClose > pOpen) {
        const params: ApiParam[] = [];
        for (const arg of splitTopLevel(text.slice(pOpen + 1, pClose))) {
          const d = /^@(Body|Query|Param|Headers)\(\s*(?:(['"`])([^'"`]*)\2)?[^)]*\)\s*(\w+)\s*\??\s*:\s*(.+)$/s.exec(arg);
          if (!d) continue;
          const [, kind, , key, , type] = d;
          const schema = tsTypeToSchema(type!.trim(), models);
          if (kind === "Body") {
            if (key) {
              const body = hit.requestBody ?? { type: "object", properties: {}, required: [] };
              body.properties![key] = schema;
              (body.required as string[]).push(key);
              hit.requestBody = body;
            } else hit.requestBody = schema;
          } else if (kind === "Query") {
            if (key) params.push({ name: key, in: "query", required: false, schema });
            else if (schema.properties)
              for (const [k, v] of Object.entries(schema.properties))
                params.push({ name: k, in: "query", required: (schema.required ?? []).includes(k), schema: v });
          } else if (kind === "Param" && key && schema.type && schema.type !== "object") {
            hit.pathTypes = { ...hit.pathTypes, [key]: schema };
          } else if (kind === "Headers" && key) {
            params.push({ name: key, in: "header", required: false, schema });
          }
        }
        if (params.length) hit.params = params;
      }
    }
    routes.push(hit);
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------

function nextAppPath(file: string): string | undefined {
  const m = /^(?:.*?\/)?(?:src\/)?app\/((?:.*\/)?)route\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (!m) return undefined;
  const segs = m[1]!.split("/").filter(Boolean);
  if (segs.some((s) => s.startsWith("_") || /^\(\.+\)/.test(s))) return undefined;
  const kept = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + kept.join("/");
}

function nextPagesApiPath(file: string): string | undefined {
  const m = /^(?:.*?\/)?(?:src\/)?pages\/(api\/.*)\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (!m) return undefined;
  return "/" + m[1]!.replace(/\/index$/, "");
}

function scanNext(file: string, text: string, lineOf: (i: number) => number): JsRoute[] {
  const routes: JsRoute[] = [];
  const appPath = nextAppPath(file);
  if (appPath !== undefined) {
    const { path, types } = normalizePath(appPath);
    const found = new Map<Method, number>();
    for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) found.set(m[1] as Method, m.index!);
    for (const m of text.matchAll(/export\s+(?:const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) found.set(m[1] as Method, m.index!);
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g))
      for (const part of m[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()!.trim();
        if ((HTTP_METHODS as string[]).includes(name)) found.set(name as Method, m.index!);
      }
    for (const [method, idx] of found) {
      const hit: JsRoute = { method, path, file, line: lineOf(idx), pathTypes: types };
      const body = inferNextBody(text.slice(idx, idx + 3000));
      if (body && method !== "GET" && method !== "HEAD") hit.requestBody = body;
      const qp = [...text.slice(idx, idx + 3000).matchAll(/searchParams\.get\(\s*['"`](\w+)['"`]\s*\)/g)].map((q) => q[1]!);
      if (qp.length) hit.params = [...new Set(qp)].map((name) => ({ name, in: "query" as const, required: false, schema: { type: "string" } }));
      routes.push(hit);
    }
    return routes;
  }
  const apiPath = nextPagesApiPath(file);
  if (apiPath !== undefined) {
    const { path, types } = normalizePath(apiPath);
    const methods = new Set<Method>();
    for (const m of text.matchAll(/(?:req\.method\s*[!=]==?\s*|case\s+|methods?\s*[:=]\s*\[?[^\]\n]*?)['"`](GET|POST|PUT|PATCH|DELETE)['"`]/g)) methods.add(m[1] as Method);
    if (!methods.size) methods.add("GET");
    const idx = text.search(/export\s+default/);
    for (const method of methods) routes.push({ method, path, file, line: lineOf(Math.max(0, idx)), pathTypes: types });
  }
  return routes;
}

/** `const { name, email } = await req.json()` -> body schema with those keys. */
function inferNextBody(chunk: string): JSONSchema | undefined {
  const m = /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:req|request)\.json\(\)/.exec(chunk);
  if (!m) return undefined;
  const props: Record<string, JSONSchema> = {};
  for (const part of m[1]!.split(",")) {
    const name = part.split(/[:=]/)[0]!.trim();
    if (/^\w+$/.test(name)) props[name] = {};
  }
  return Object.keys(props).length ? { type: "object", properties: props } : undefined;
}

// ---------------------------------------------------------------------------

export function detectJsRoutes(sources: Map<string, string>): RouteHit[] {
  const known = new Set(sources.keys());
  const all: JsRoute[] = [];
  const mounts: Mount[] = [];
  let models: Map<string, JSONSchema> | undefined;
  const nestApps: NestApp[] = [];
  const autoload: AutoloadDir[] = [];
  for (const [file, text] of sources) {
    if (!JS_EXT.test(file)) continue;
    if (/setGlobalPrefix|enableVersioning/.test(text)) {
      const app = nestAppConfig(file, text);
      if (app) nestApps.push(app);
    }
    if (/autoload/i.test(text)) autoload.push(...fastifyAutoloadDirs(file, text));
    let lines: ((i: number) => number) | undefined;
    const lineOf = (i: number) => (lines ??= lineIndex(text))(i);
    if (nextAppPath(file) !== undefined || nextPagesApiPath(file) !== undefined) {
      all.push(...scanNext(file, text, lineOf));
      continue;
    }
    if (/@Controller\(/.test(text) && /@nestjs\/common/.test(text)) {
      models ??= collectTsModels(sources);
      all.push(...scanNest(file, text, lineOf, models));
      continue;
    }
    if (!ROUTER_HINT.test(text) && !/\.(get|post|put|patch|delete)\(\s*['"`]\//.test(text)) continue;
    const r = scanRouterCalls(file, text, lineOf);
    // Without a router import, only accept conventional receiver names.
    const hinted = ROUTER_HINT.test(text);
    all.push(...r.routes.filter((x) => hinted || /^(app|router|server|api|routes?|\w*Router|\w*App)$/.test(x.receiver ?? "")));
    // resolve mount targets
    const imports = importsOf(text);
    for (const mt of r.mounts) {
      const spec = imports.get(mt.receiver!);
      const target = spec ? resolveJsImport(file, spec, known) : undefined;
      if (target) mounts.push({ from: file, prefix: mt.prefix, target });
      else mounts.push(mt); // same-file router variable
    }
  }

  // Resolve file prefixes transitively: prefix(target) = prefix(from) + mount.prefix
  const filePrefix = new Map<string, string>();
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (const mt of mounts) {
      if (!mt.target || mt.target === mt.from) continue;
      const next = joinPath(filePrefix.get(mt.from) ?? "", mt.prefix);
      if (filePrefix.get(mt.target) !== next) {
        filePrefix.set(mt.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const r of all) {
    if (nextAppPath(r.file) !== undefined || nextPagesApiPath(r.file) !== undefined) continue;
    if (r.nest) {
      r.path = nestPath(r, nestApps);
      continue;
    }
    let p = r.path;
    const local = mounts.find((mt) => !mt.target && mt.from === r.file && mt.receiver === r.receiver);
    if (local) p = joinPath(local.prefix, p);
    const fp = filePrefix.get(r.file);
    if (fp) p = joinPath(fp, p);
    // @fastify/autoload: the file's directory below the routes dir is its prefix.
    const al = fp ? undefined : autoloadPrefix(r.file, autoload);
    if (al !== undefined) p = joinPath(al, p);
    r.path = p;
  }
  return all.map(({ receiver: _r, nest: _n, version: _v, ...hit }) => hit);
}

function autoloadPrefix(file: string, dirs: AutoloadDir[]): string | undefined {
  let best: AutoloadDir | undefined;
  for (const d of dirs)
    if ((d.dir === "" || file.startsWith(d.dir + "/")) && (!best || d.dir.length > best.dir.length)) best = d;
  if (!best) return undefined;
  const rel = best.dir ? file.slice(best.dir.length + 1) : file;
  const segs = rel.split("/").slice(0, -1).map((seg) => (seg.startsWith("_") ? `{${seg.slice(1)}}` : seg));
  return joinPath(best.prefix, segs.length ? "/" + segs.join("/") : "");
}

/** Apply the owning Nest app's global prefix and URI version to a controller route. */
function nestPath(r: JsRoute, apps: NestApp[]): string {
  let app: NestApp | undefined;
  for (const a of apps) if ((a.root === "" || r.file.startsWith(a.root + "/")) && (!app || a.root.length > app.root.length)) app = a;
  if (!app) return r.path;
  let p = r.path;
  const version = r.version ?? app.uriVersioning?.defaultVersion;
  if (app.uriVersioning && version && version !== "VERSION_NEUTRAL") p = joinPath(`/${app.uriVersioning.prefix}${version}`, p);
  if (app.prefix && !app.exclude.some((x) => x === r.path)) p = joinPath(app.prefix, p);
  const { path: norm } = normalizePath(p);
  return norm;
}
