import { promises as fs } from "node:fs";
import path from "node:path";

/** Strip credentials from a remote URL (https://user:token@host/x -> https://host/x). */
export function sanitizeRemote(url: string): string {
  return url.replace(/^([a-z+]+:\/\/)[^/@]+@/i, "$1");
}

/** Read remote + branch straight from .git (no git binary). Supports worktree/submodule `.git` files. */
export async function readGitInfo(root: string): Promise<{ remote?: string; branch?: string } | undefined> {
  let gitDir = path.join(root, ".git");
  try {
    const st = await fs.stat(gitDir);
    if (st.isFile()) {
      const text = await fs.readFile(gitDir, "utf8");
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (!m) return undefined;
      gitDir = path.resolve(root, m[1]!.trim());
    }
  } catch {
    return undefined;
  }
  const info: { remote?: string; branch?: string } = {};
  try {
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (m) info.branch = m[1];
    else if (/^[0-9a-f]{7,40}$/.test(head)) info.branch = `(detached ${head.slice(0, 7)})`;
  } catch {
    /* ignore */
  }
  // Worktrees keep config in the common dir.
  let configDir = gitDir;
  try {
    const common = (await fs.readFile(path.join(gitDir, "commondir"), "utf8")).trim();
    configDir = path.resolve(gitDir, common);
  } catch {
    /* not a worktree */
  }
  try {
    const config = await fs.readFile(path.join(configDir, "config"), "utf8");
    const remotes = new Map<string, string>();
    let current: string | undefined;
    for (const line of config.split(/\r?\n/)) {
      const sec = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
      if (sec) {
        current = sec[1];
        continue;
      }
      if (/^\s*\[/.test(line)) {
        current = undefined;
        continue;
      }
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (current && url && !remotes.has(current)) remotes.set(current, url[1]!);
    }
    const remote = remotes.get("origin") ?? remotes.values().next().value;
    if (remote) info.remote = sanitizeRemote(remote);
  } catch {
    /* ignore */
  }
  return info.remote || info.branch ? info : undefined;
}
