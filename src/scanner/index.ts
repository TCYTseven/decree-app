import type { ProjectProfile } from "../core/types.js";

export interface ScanOptions {
  maxFiles?: number; // default 20000; stop walking after this many files and set stats.truncated
  onProgress?: (message: string) => void;
}

/** Deterministically scan a repository. No network access. */
export async function scanProject(root: string, opts: ScanOptions = {}): Promise<ProjectProfile> {
  throw new Error("scanProject: not implemented");
}
