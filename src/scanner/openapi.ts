import { parse as parseYaml } from "yaml";
import type { ApiEndpoint, ApiParam, JSONSchema } from "../core/types.js";
import { isFixturePath, type ScanContext } from "./context.js";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const SPEC_NAME_RE = /(openapi|swagger|api[-_.]?spec|api[-_.]?docs?)/i;
const MAX_SPEC_BYTES = 10 * 1024 * 1024;
const MAX_CANDIDATES = 1500;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Cheap check on the head of a file: is this an OpenAPI/Swagger document? */
export function looksLikeOpenApi(head: string, ext: string): boolean {
  if (ext === ".json") return /"(openapi|swagger)"\s*:\s*"[23]\./.test(head);
  return /^(openapi|swagger)\s*:\s*["']?[23]\./m.test(head);
}

export async function findOpenApiSpecs(ctx: ScanContext): Promise<string[]> {
  const candidates = ctx.files.filter(
    (f) =>
      (f.ext === ".yaml" || f.ext === ".yml" || f.ext === ".json") &&
      f.size > 20 &&
      f.size <= MAX_SPEC_BYTES &&
      !isFixturePath(f.path) &&
      !/(^|\/)(package(-lock)?|tsconfig.*|composer(\.lock)?|\.eslintrc|renovate|pnpm-lock|jsconfig|decree)\.(json|ya?ml)$/.test(f.path) &&
      !/(^|\/)(\.github|\.vscode|\.devcontainer|locales?|i18n)\//.test(f.path),
  );
  // Named-like-a-spec first, then shallow files first.
  candidates.sort((a, b) => {
    const an = SPEC_NAME_RE.test(a.path) ? 0 : 1;
    const bn = SPEC_NAME_RE.test(b.path) ? 0 : 1;
    return an - bn || a.depth - b.depth || a.path.localeCompare(b.path);
  });
  const out: string[] = [];
  for (const f of candidates.slice(0, MAX_CANDIDATES)) {
    // Non-spec-named files larger than 1MB are skipped (content-analysis cap).
    if (f.size > 1024 * 1024 && !SPEC_NAME_RE.test(f.path)) continue;
    const head = await ctx.head(f.path, 2048);
    if (head && looksLikeOpenApi(head, f.ext)) out.push(f.path);
  }
  return out;
}

class RefResolver {
  constructor(private doc: Json) {}

  lookup(ref: string): unknown {
    if (!ref.startsWith("#/")) return undefined;
    let cur: unknown = this.doc;
    for (const raw of ref.slice(2).split("/")) {
      const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObj(cur) && !Array.isArray(cur)) return undefined;
      cur = (cur as Json)[key];
    }
    return cur;
  }

  /** Resolve a single top-level $ref chain (for parameters / requestBodies). */
  shallow<T = Json>(v: unknown): T | undefined {
    let cur = v;
    for (let i = 0; i < 10 && isObj(cur) && typeof cur.$ref === "string"; i++) cur = this.lookup(cur.$ref);
    return isObj(cur) ? (cur as T) : undefined;
  }

  /** Deep-resolve local $refs in a schema, breaking cycles and bounding depth. */
  schema(v: unknown, depth = 0, stack: string[] = []): JSONSchema {
    if (!isObj(v)) return {};
    if (depth > 8) return { type: "object", description: "(nested schema truncated)" };
    if (typeof v.$ref === "string") {
      const ref = v.$ref;
      const name = ref.split("/").pop() ?? ref;
      if (stack.includes(ref)) return { type: "object", description: `Recursive reference to ${name}` };
      const target = this.lookup(ref);
      if (!isObj(target)) return { description: `Unresolved reference ${ref}` };
      const resolved = this.schema(target, depth + 1, [...stack, ref]);
      const { $ref: _, ...siblings } = v;
      return { ...resolved, ...(this.schema(siblings, depth, stack) as Json) };
    }
    const out: JSONSchema = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "properties" && isObj(val)) {
        const props: Record<string, JSONSchema> = {};
        for (const [pk, pv] of Object.entries(val)) props[pk] = this.schema(pv, depth + 1, stack);
        out.properties = props;
      } else if ((k === "items" || k === "additionalProperties" || k === "not") && isObj(val)) {
        out[k] = this.schema(val, depth + 1, stack);
      } else if ((k === "allOf" || k === "anyOf" || k === "oneOf") && Array.isArray(val)) {
        out[k] = val.map((x) => this.schema(x, depth + 1, stack));
      } else if (k === "discriminator" || k === "xml" || k === "externalDocs" || k.startsWith("x-")) {
        continue;
      } else {
        out[k] = val;
      }
    }
    // Merge simple allOf compositions into one object schema (common for "Base & Extra").
    if (Array.isArray(out.allOf) && out.allOf.every((s) => isObj(s) && (s.type === "object" || s.properties))) {
      const merged: JSONSchema = { type: "object", properties: { ...(out.properties ?? {}) }, required: [...(out.required ?? [])] };
      for (const s of out.allOf as JSONSchema[]) {
        Object.assign(merged.properties!, s.properties ?? {});
        merged.required!.push(...(s.required ?? []));
        if (s.description && !merged.description) merged.description = s.description;
      }
      delete out.allOf;
      Object.assign(out, merged);
      if (!out.required?.length) delete out.required;
    }
    // Swagger 2 / OAS 3.0 nullable -> keep as-is; strip readOnly props from required lists is left to the planner.
    return out;
  }
}

function pathPrefixFromServer(doc: Json): string {
  if (typeof doc.swagger === "string") {
    const bp = typeof doc.basePath === "string" ? doc.basePath : "";
    return bp && bp !== "/" ? "/" + bp.replace(/^\/+|\/+$/g, "") : "";
  }
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const first = servers.find(isObj);
  if (!first || typeof first.url !== "string") return "";
  let url = first.url;
  // substitute server variables with their defaults
  if (isObj(first.variables))
    url = url.replace(/\{(\w+)\}/g, (m, n: string) => {
      const v = (first.variables as Json)[n];
      return isObj(v) && typeof v.default === "string" ? v.default : m;
    });
  let p: string;
  if (/^[a-z]+:\/\//i.test(url)) {
    try {
      p = new URL(url).pathname;
    } catch {
      return "";
    }
  } else p = url;
  if (/\{/.test(p)) return "";
  p = p.replace(/\/+$/, "");
  return p && p !== "/" ? (p.startsWith("/") ? p : "/" + p) : "";
}

function paramFrom(r: RefResolver, raw: unknown): (ApiParam & { _body?: JSONSchema; _form?: boolean }) | undefined {
  const p = r.shallow(raw);
  if (!p || typeof p.name !== "string" || typeof p.in !== "string") return undefined;
  const description = typeof p.description === "string" ? p.description : undefined;
  if (p.in === "body") {
    return { name: p.name, in: "body", required: p.required === true, description, _body: r.schema(p.schema) };
  }
  if (p.in === "formData") {
    const schema: JSONSchema = { type: typeof p.type === "string" ? (p.type === "file" ? "string" : p.type) : "string" };
    if (description) schema.description = description;
    return { name: p.name, in: "body", required: p.required === true, description, schema, _form: true };
  }
  if (p.in !== "path" && p.in !== "query" && p.in !== "header") return undefined;
  let schema: JSONSchema | undefined;
  if (isObj(p.schema)) schema = r.schema(p.schema);
  else if (typeof p.type === "string") {
    schema = { type: p.type };
    if (isObj(p.items)) schema.items = r.schema(p.items);
    if (Array.isArray(p.enum)) schema.enum = p.enum;
    if (p.default !== undefined) schema.default = p.default;
    if (typeof p.format === "string") schema.format = p.format;
  }
  return { name: p.name, in: p.in, required: p.in === "path" ? true : p.required === true, schema, description };
}

function jsonBodySchema(r: RefResolver, body: unknown): { schema?: JSONSchema; required: boolean } | undefined {
  const b = r.shallow(body);
  if (!b || !isObj(b.content)) return undefined;
  const content = b.content;
  const key =
    Object.keys(content).find((k) => /^application\/json/i.test(k)) ??
    Object.keys(content).find((k) => /\+json|json/i.test(k)) ??
    Object.keys(content).find((k) => /form/i.test(k));
  if (!key) return undefined;
  const media = content[key];
  if (!isObj(media)) return undefined;
  const schema = r.schema(media.schema);
  if (typeof b.description === "string" && !schema.description) schema.description = b.description;
  return { schema, required: b.required === true };
}

/** Parse one OpenAPI 3.x / Swagger 2.0 document into endpoints. */
export function parseOpenApiDoc(text: string, source: string): ApiEndpoint[] {
  let doc: unknown;
  try {
    doc = source.endsWith(".json") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 1000 });
  } catch {
    try {
      doc = parseYaml(text, { maxAliasCount: 1000 });
    } catch {
      return [];
    }
  }
  if (!isObj(doc) || !isObj(doc.paths)) return [];
  const r = new RefResolver(doc);
  const prefix = pathPrefixFromServer(doc);
  const out: ApiEndpoint[] = [];

  for (const [rawPath, itemRaw] of Object.entries(doc.paths)) {
    const item = r.shallow(itemRaw);
    if (!item) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      const params = new Map<string, ApiParam & { _body?: JSONSchema; _form?: boolean }>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = paramFrom(r, raw);
        if (p) params.set(`${p.in}:${p.name}`, p); // operation-level overrides path-level
      }
      const fullPath = (prefix + (rawPath.startsWith("/") ? rawPath : "/" + rawPath)).replace(/\/{2,}/g, "/");
      // Ensure every {x} in the path has a path param.
      for (const pm of fullPath.matchAll(/\{([^}]+)\}/g)) {
        if (!params.has(`path:${pm[1]}`)) params.set(`path:${pm[1]}`, { name: pm[1]!, in: "path", required: true, schema: { type: "string" } });
      }

      let requestBody: JSONSchema | undefined;
      const oas3Body = jsonBodySchema(r, op.requestBody);
      if (oas3Body?.schema) requestBody = oas3Body.schema;
      const finalParams: ApiParam[] = [];
      const formProps: Record<string, JSONSchema> = {};
      const formRequired: string[] = [];
      for (const p of params.values()) {
        if (p._body) {
          requestBody = p._body;
          continue;
        }
        if (p._form) {
          formProps[p.name] = p.schema ?? { type: "string" };
          if (p.required) formRequired.push(p.name);
          continue;
        }
        const { _body, _form, ...clean } = p;
        if (clean.schema === undefined) delete clean.schema;
        if (clean.description === undefined) delete clean.description;
        finalParams.push(clean);
      }
      if (!requestBody && Object.keys(formProps).length)
        requestBody = { type: "object", properties: formProps, ...(formRequired.length ? { required: formRequired } : {}) };

      const summary =
        typeof op.summary === "string" ? op.summary.trim() : typeof op.description === "string" ? op.description.trim().split("\n")[0]!.slice(0, 200) : undefined;
      const ep: ApiEndpoint = {
        method: m.toUpperCase() as ApiEndpoint["method"],
        path: fullPath,
        params: finalParams,
        source,
      };
      if (summary) ep.summary = summary;
      if (typeof op.operationId === "string") ep.operationId = op.operationId;
      if (requestBody) ep.requestBody = requestBody;
      if (Array.isArray(op.tags)) {
        const tags = op.tags.filter((t): t is string => typeof t === "string");
        if (tags.length) ep.tags = tags;
      }
      if (op.deprecated === true) ep.summary = `${ep.summary ?? ""} (deprecated)`.trim();
      out.push(ep);
    }
  }
  return out;
}

export async function extractOpenApi(ctx: ScanContext): Promise<{ specs: string[]; endpoints: ApiEndpoint[] }> {
  const specs = await findOpenApiSpecs(ctx);
  const endpoints: ApiEndpoint[] = [];
  for (const s of specs) {
    const text = await ctx.read(s, MAX_SPEC_BYTES);
    if (text) endpoints.push(...parseOpenApiDoc(text, s));
  }
  return { specs, endpoints };
}
