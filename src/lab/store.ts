import { promises as fs } from "node:fs";
import path from "node:path";
import { CACHE_DIRNAME } from "../version.js";
import { modelSlug, type LocalModel } from "./endpoints.js";
import type { LabRun, LabSuite } from "./types.js";

/**
 * Lab files live under .decree/lab/:
 *   suites/<model>.json   the suite generated for each model (regenerated before every run)
 *   runs/<run id>.json    every run, newest last
 * Nothing here is uploaded anywhere.
 */

export function labDir(root: string): string {
  return path.join(root, CACHE_DIRNAME, "lab");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export async function saveSuite(root: string, model: Pick<LocalModel, "provider" | "id">, suite: LabSuite): Promise<string> {
  const file = path.join(labDir(root), "suites", `${modelSlug(model)}.json`);
  await writeJson(file, suite);
  return file;
}

export async function saveRun(root: string, run: LabRun): Promise<string> {
  const file = path.join(labDir(root), "runs", `${run.id.replace(/[^\w.-]/g, "_")}.json`);
  await writeJson(file, run);
  return file;
}

export interface RunListing {
  id: string;
  startedAt: string;
  finishedAt?: string;
  models: { id: string; provider: string; status: string; capabilityScore?: number; alerts: number }[];
}

export async function listRuns(root: string, limit = 50): Promise<RunListing[]> {
  const dir = path.join(labDir(root), "runs");
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  names.sort().reverse();
  const out: RunListing[] = [];
  for (const n of names.slice(0, limit)) {
    try {
      const run = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as LabRun;
      out.push({
        id: run.id,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        models: run.models.map((m) => ({ id: m.model.id, provider: m.model.provider, status: m.status, capabilityScore: m.capabilityScore, alerts: m.alerts })),
      });
    } catch {
      /* skip unreadable files */
    }
  }
  return out;
}

export async function loadRun(root: string, id: string): Promise<LabRun | undefined> {
  if (!/^[\w.-]{1,120}$/.test(id)) return undefined;
  try {
    return JSON.parse(await fs.readFile(path.join(labDir(root), "runs", `${id}.json`), "utf8")) as LabRun;
  } catch {
    return undefined;
  }
}
