import { execFile } from "node:child_process";

export interface GitInfo {
  commit?: string;
  branch?: string;
  dirty?: boolean;
  remote?: string;
}

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, timeout: 3000, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
}

/** Drop credentials from a remote URL: `https://user:tok@host/x` -> `https://host/x`. */
export function sanitizeRemote(remote: string): string {
  const trimmed = remote.trim();
  // scp-style (git@github.com:org/repo.git): keep only the user name
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.replace(/^[^@/]*:[^@/]*@/, (m) => `${m.split(":")[0]}@`);
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/\/[^@/]*@/, "//");
  }
}

/**
 * Commit, branch, dirty flag and origin of the project. CI checkouts are often
 * a detached HEAD, so the GitHub Actions variables win when present.
 */
export async function gitInfo(root: string, env: NodeJS.ProcessEnv = process.env): Promise<GitInfo> {
  const [commit, branch, status, remote] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
    git(root, ["config", "--get", "remote.origin.url"]),
  ]);
  const info: GitInfo = {};
  const ghCommit = env.GITHUB_ACTIONS ? env.GITHUB_SHA : undefined;
  const ghBranch = env.GITHUB_ACTIONS ? env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME : undefined;
  const ghRemote =
    env.GITHUB_ACTIONS && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : undefined;
  info.commit = ghCommit || commit || undefined;
  const localBranch = branch && branch !== "HEAD" ? branch : undefined;
  info.branch = ghBranch || localBranch;
  if (status !== undefined) info.dirty = status.length > 0;
  const origin = ghRemote || remote;
  if (origin) info.remote = sanitizeRemote(origin);
  return info;
}
