import type { ApiEndpoint } from "../../core/types.js";
import { stripComments } from "../context.js";
import { detectJsRoutes } from "./js.js";
import { detectGoRoutes, detectJvmRoutes, detectPhpRoutes, detectRubyRoutes, detectRustRoutes } from "./other.js";
import { detectPythonRoutes } from "./python.js";
import { toEndpoint, type RouteHit } from "./util.js";

export { normalizePath } from "./util.js";

/** Detect HTTP routes declared in source code. `sources` maps relative path -> content. */
export function detectRoutes(rawSources: Map<string, string>): ApiEndpoint[] {
  const sources = new Map<string, string>();
  for (const [file, text] of rawSources) sources.set(file, stripComments(file, text));
  const hits: RouteHit[] = [];
  const run = (fn: (s: Map<string, string>) => RouteHit[]) => {
    try {
      hits.push(...fn(sources));
    } catch {
      /* a detector bug must never break the scan */
    }
  };
  run(detectJsRoutes);
  run(detectPythonRoutes);
  run(detectGoRoutes);
  run(detectRubyRoutes);
  run(detectPhpRoutes);
  run(detectJvmRoutes);
  run(detectRustRoutes);
  return dedupeEndpoints(hits.map(toEndpoint));
}

export function endpointKey(e: Pick<ApiEndpoint, "method" | "path">): string {
  // Treat /users and /users/ and differently-named params as the same route.
  const p = e.path.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "") || "/";
  return `${e.method} ${p.toLowerCase()}`;
}

/** Keep the first endpoint per method+path; later duplicates only fill in missing details. */
export function dedupeEndpoints(eps: ApiEndpoint[]): ApiEndpoint[] {
  const map = new Map<string, ApiEndpoint>();
  for (const e of eps) {
    const k = endpointKey(e);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, e);
      continue;
    }
    if (!prev.summary && e.summary) prev.summary = e.summary;
    if (!prev.operationId && e.operationId) prev.operationId = e.operationId;
    if (!prev.requestBody && e.requestBody) prev.requestBody = e.requestBody;
    if (/:\d+$/.test(prev.source))
      for (const p of e.params) if (!prev.params.some((x) => x.name === p.name && x.in === p.in) && p.in !== "path") prev.params.push(p);
  }
  return [...map.values()];
}
