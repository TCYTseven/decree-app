import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where `decree push` sends harnesses unless DECREE_API_URL says otherwise. */
export const DEFAULT_API_URL = "https://trydecree.com";

export interface Credentials {
  token: string;
  apiUrl: string;
  email?: string;
  createdAt: string;
}

export interface ResolvedAuth {
  token: string;
  apiUrl: string;
  email?: string;
  /** "env" for DECREE_TOKEN (CI), "file" for a `decree login` token. */
  source: "env" | "file";
}

/** `$DECREE_CONFIG_DIR`, else the platform config dir + `/decree`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DECREE_CONFIG_DIR) return path.resolve(env.DECREE_CONFIG_DIR);
  if (process.platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "decree");
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "decree");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "credentials.json");
}

/** API base URL: DECREE_API_URL, else the one the token was issued by, else trydecree.com. */
export function apiUrlFor(creds?: Pick<Credentials, "apiUrl">, env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DECREE_API_URL?.trim() || creds?.apiUrl || DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}

export async function readCredentials(env: NodeJS.ProcessEnv = process.env): Promise<Credentials | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(credentialsPath(env), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (typeof parsed.token !== "string" || !parsed.token) return undefined;
    return {
      token: parsed.token,
      apiUrl: typeof parsed.apiUrl === "string" ? parsed.apiUrl : DEFAULT_API_URL,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return undefined;
  }
}

/** Write credentials readable only by the current user (0600 in a 0700 dir). */
export async function writeCredentials(creds: Credentials, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = credentialsPath(env);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}

/** Remove stored credentials. Resolves to false when there were none. */
export async function deleteCredentials(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await fs.unlink(credentialsPath(env));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** DECREE_TOKEN wins (CI), then the token from `decree login`. */
export async function resolveAuth(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedAuth | undefined> {
  const fromEnv = env.DECREE_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, apiUrl: apiUrlFor(undefined, env), source: "env" };
  const creds = await readCredentials(env);
  if (!creds) return undefined;
  return { token: creds.token, apiUrl: apiUrlFor(creds, env), email: creds.email, source: "file" };
}
