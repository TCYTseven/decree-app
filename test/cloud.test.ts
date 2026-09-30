import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken, isTokenShape, newToken } from "../src/cloud/api.js";
import { apiUrlFor, configDir, credentialsPath, normalizeApiUrl, resolveAuth } from "../src/cloud/credentials.js";
import { gitInfo, sanitizeRemote } from "../src/cloud/git.js";
import { buildSyncPayload, evalResultsForUpload, isCI, specForUpload } from "../src/cloud/payload.js";
import { runCli } from "../src/commands/program.js";
import { stripAnsi } from "../src/ui/theme.js";
import { startFakeDecree, seedToken, type FakeDecree } from "./helpers/fake-decree.js";
import { sampleSpec } from "./helpers/sample-spec.js";

let stdout = "";
let stderr = "";
let root: string;
let configHome: string;
let fake: FakeDecree;
const ENV_KEYS = ["DECREE_CONFIG_DIR", "DECREE_API_URL", "DECREE_TOKEN", "CI", "GITHUB_ACTIONS", "DECREE_MIN_POLL_MS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(async () => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => ((stdout += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => ((stderr += String(chunk)), true));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-cloud-"));
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), "decree-config-"));
  await fs.writeFile(path.join(root, "decree.json"), JSON.stringify(sampleSpec(), null, 2));
  fake = await startFakeDecree();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DECREE_CONFIG_DIR = configHome;
  process.env.DECREE_API_URL = fake.url;
  process.env.DECREE_MIN_POLL_MS = "10";
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(configHome, { recursive: true, force: true });
});

const cli = (...args: string[]) => runCli(["node", "decree-harness", "--no-color", "--cwd", root, ...args]);
const out = () => stripAnsi(stdout + stderr);

async function savedToken(): Promise<string> {
  return JSON.parse(await fs.readFile(credentialsPath(), "utf8")).token;
}

describe("tokens", () => {
  it("are dk_ + 48 hex and hash to sha256 hex", () => {
    const t = newToken();
    expect(isTokenShape(t)).toBe(true);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(t);
  });
});

describe("credentials", () => {
  it("resolve DECREE_CONFIG_DIR, then XDG_CONFIG_HOME", () => {
    expect(configDir({ DECREE_CONFIG_DIR: "/x/y" })).toBe(path.resolve("/x/y"));
    if (process.platform !== "win32") expect(configDir({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/decree");
  });

  it("DECREE_TOKEN wins over the saved login, and DECREE_API_URL over the saved URL", async () => {
    expect(await resolveAuth({ DECREE_TOKEN: "dk_env", DECREE_API_URL: "https://d.test/" })).toMatchObject({ token: "dk_env", source: "env", apiUrl: "https://d.test" });
    expect(await resolveAuth({ DECREE_TOKEN: "dk_env" })).toMatchObject({ token: "dk_env", source: "env", apiUrl: undefined });
    expect(apiUrlFor(undefined, {})).toBeUndefined();
    expect(apiUrlFor({ apiUrl: "https://a.test/" }, {})).toBe("https://a.test");
    expect(apiUrlFor({ apiUrl: "https://a.test" }, { DECREE_API_URL: "http://localhost:3000/" })).toBe("http://localhost:3000");
  });
});

describe("dashboard URL", () => {
  it("normalizes http(s) URLs and rejects anything else", () => {
    expect(normalizeApiUrl("https://decree.example.com/")).toBe("https://decree.example.com");
    expect(normalizeApiUrl(" http://localhost:3000 ")).toBe("http://localhost:3000");
    expect(normalizeApiUrl("decree.example.com")).toBeUndefined();
    expect(normalizeApiUrl("ftp://x.test")).toBeUndefined();
  });

  it("login without --url or DECREE_API_URL explains self-hosting and calls nothing", async () => {
    delete process.env.DECREE_API_URL;
    expect(await cli("login", "--no-browser")).toBe(1);
    expect(out()).toContain("No dashboard to log in to");
    expect(out()).toContain("login --url");
    expect(fake.requests).toHaveLength(0);
  });

  it("login --url saves that dashboard, and push uses it", async () => {
    delete process.env.DECREE_API_URL;
    expect(await cli("login", "--no-browser", "--url", `${fake.url}/`)).toBe(0);
    expect(JSON.parse(await fs.readFile(credentialsPath(), "utf8")).apiUrl).toBe(fake.url);
    expect(await cli("push")).toBe(0);
    expect(fake.requests.some((r) => r.path === "/api/v1/harnesses")).toBe(true);
  });

  it("push with DECREE_TOKEN but no DECREE_API_URL asks for the URL", async () => {
    delete process.env.DECREE_API_URL;
    process.env.DECREE_TOKEN = newToken();
    expect(await cli("push")).toBe(1);
    expect(out()).toContain("DECREE_API_URL");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("login", () => {
  it("registers only the token hash, waits for approval, and saves the token 0600", async () => {
    expect(await cli("login", "--no-browser")).toBe(0);
    const token = await savedToken();
    expect(isTokenShape(token)).toBe(true);
    const start = fake.requests.find((r) => r.path === "/api/v1/cli/login")!;
    expect(start.body).toMatchObject({ tokenHash: hashToken(token), tokenPrefix: token.slice(0, 7) });
    expect(JSON.stringify(start.body)).not.toContain(token);
    expect(out()).toContain("ABCD-2345");
    expect(out()).toContain("Logged in as dev@example.com");
    if (process.platform !== "win32") {
      expect((await fs.stat(credentialsPath())).mode & 0o777).toBe(0o600);
    }
  });

  it("a denied login saves nothing and exits 1", async () => {
    fake.decide = "denied";
    expect(await cli("login", "--no-browser")).toBe(1);
    expect(stderr).toContain("denied");
    await expect(fs.access(credentialsPath())).rejects.toThrow();
  });

  it("an expired code tells you to run login again", async () => {
    fake.decide = "expired";
    expect(await cli("login", "--no-browser")).toBe(1);
    expect(stderr).toContain("expired");
    expect(stderr).toContain("login");
  });

  it("--token verifies and saves an existing token", async () => {
    const token = newToken();
    seedToken(fake, token, "ci@example.com");
    expect(await cli("login", "--token", token)).toBe(0);
    expect(await savedToken()).toBe(token);
    expect(out()).toContain("ci@example.com");
  });

  it("--token rejects malformed tokens without calling the server", async () => {
    expect(await cli("login", "--token", "nope")).toBe(1);
    expect(stderr).toContain("doesn't look like a Decree token");
    expect(fake.requests).toHaveLength(0);
  });

  it("does nothing when already logged in", async () => {
    expect(await cli("login", "--no-browser")).toBe(0);
    const before = fake.requests.length;
    expect(await cli("login", "--no-browser")).toBe(0);
    expect(out()).toContain("Already logged in");
    expect(fake.requests.slice(before).map((r) => r.path)).toEqual(["/api/v1/whoami"]);
  });
});

describe("whoami / logout", () => {
  it("whoami shows the account, logout revokes and forgets the token", async () => {
    await cli("login", "--no-browser");
    stdout = "";
    expect(await cli("whoami", "--json")).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ email: "dev@example.com", source: "file" });

    const token = await savedToken();
    expect(await cli("logout")).toBe(0);
    expect(out()).toContain("Logged out of dev@example.com");
    expect(fake.requests.at(-1)).toMatchObject({ path: "/api/v1/logout", auth: token });
    await expect(fs.access(credentialsPath())).rejects.toThrow();

    expect(await cli("whoami")).toBe(1);
    expect(stderr).toContain("Not logged in");
  });

  it("a revoked token gets a login hint", async () => {
    const token = newToken();
    process.env.DECREE_TOKEN = token;
    expect(await cli("whoami")).toBe(1);
    expect(stderr).toContain("invalid or was revoked");
    expect(stderr).toContain("login");
  });
});

describe("push", () => {
  it("needs a login and says how to get one", async () => {
    expect(await cli("push")).toBe(1);
    expect(stderr).toContain("Not logged in");
    expect(stderr).toContain("DECREE_TOKEN");
    expect(fake.requests).toHaveLength(0);
  });

  it("uploads decree.json, then reports up to date when nothing changed", async () => {
    await cli("login", "--no-browser");
    stdout = "";
    expect(await cli("push", "-m", "first sync")).toBe(0);
    expect(out()).toContain(`Pushed ${sampleSpec().name} v1`);
    expect(out()).toContain(`/dashboard/harnesses/${sampleSpec().name}`);
    const req = fake.requests.find((r) => r.path === "/api/v1/harnesses")!;
    const body = req.body as { spec: { name: string; $schema?: string }; message: string; source: string; cliVersion: string };
    expect(body.spec.name).toBe(sampleSpec().name);
    expect(body.spec.$schema).toBeUndefined();
    expect(body).toMatchObject({ message: "first sync", source: "cli" });

    stdout = "";
    expect(await cli("push")).toBe(0);
    expect(out()).toContain("is up to date (v1)");

    const spec = sampleSpec();
    spec.systemPrompt += "\nBe brief.";
    await fs.writeFile(path.join(root, "decree.json"), JSON.stringify(spec));
    stdout = "";
    expect(await cli("push", "--json")).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ version: 2, created: true });
  });

  it("uses DECREE_TOKEN in CI and marks the push as ci", async () => {
    const token = newToken();
    seedToken(fake, token);
    process.env.DECREE_TOKEN = token;
    process.env.CI = "true";
    expect(await cli("push", "--name", "orders-prod")).toBe(0);
    const req = fake.requests.find((r) => r.path === "/api/v1/harnesses")!;
    expect(req.auth).toBe(token);
    expect(req.body).toMatchObject({ slug: "orders-prod", source: "ci" });
  });

  it("--dry-run shows what would be sent without a login or network call", async () => {
    expect(await cli("push", "--dry-run")).toBe(0);
    expect(out()).toContain(`Would push ${sampleSpec().name}`);
    stdout = "";
    expect(await cli("push", "--dry-run", "--json")).toBe(0);
    expect(JSON.parse(stdout).spec.name).toBe(sampleSpec().name);
    expect(fake.requests).toHaveLength(0);
  });

  it("an unreachable server is a friendly error", async () => {
    const token = newToken();
    process.env.DECREE_TOKEN = token;
    process.env.DECREE_API_URL = "http://127.0.0.1:9";
    expect(await cli("push")).toBe(1);
    expect(stderr).toContain("Could not reach 127.0.0.1:9");
    expect(stderr).toContain("hint:");
    expect(stderr).not.toContain("    at ");
  });
});

describe("upload payloads", () => {
  it("drop $schema and secret env defaults, and mask credentials in base URLs", () => {
    const spec = sampleSpec();
    spec.$schema = "./.decree/schema.json";
    spec.env = [
      { name: "API_TOKEN", description: "", required: true, secret: true, default: "sk-live-123" },
      { name: "BASE_URL", description: "", required: false, secret: false, default: "http://localhost:3000" },
    ];
    const http = spec.tools.find((t) => t.http)!;
    http.http!.defaultBaseUrl = "https://admin:hunter2@api.internal";
    const up = specForUpload(spec);
    expect("$schema" in up).toBe(false);
    expect(up.env[0]).not.toHaveProperty("default");
    expect(up.env[1].default).toBe("http://localhost:3000");
    expect(JSON.stringify(up)).not.toContain("hunter2");
    expect(JSON.stringify(up)).not.toContain("sk-live-123");
  });

  it("eval results keep tool names but not tool inputs or outputs", () => {
    const [r] = evalResultsForUpload([
      {
        id: "e1",
        passed: false,
        score: 0.5,
        checks: [{ name: "rubric", passed: false, detail: "x".repeat(900) }],
        run: {
          finalText: "Your key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
          turns: 2,
          toolCalls: [{ name: "get_customer", input: { email: "a@b.c" }, output: "SSN 123-45-6789", isError: false }],
          costUsd: 0.01,
        },
      },
    ]);
    expect(r.toolCalls).toEqual(["get_customer"]);
    expect(JSON.stringify(r)).not.toContain("123-45-6789");
    expect(JSON.stringify(r)).not.toContain("a@b.c");
    expect(r.finalText).not.toContain("sk-ant-api03");
    expect(r.checks[0].detail!.length).toBeLessThanOrEqual(500);
  });

  it("detects CI and records source", () => {
    expect(isCI({ CI: "true" })).toBe(true);
    expect(isCI({ CI: "false" })).toBe(false);
    expect(isCI({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCI({})).toBe(false);
    expect(buildSyncPayload(sampleSpec(), { git: {}, env: {} }).source).toBe("cli");
  });
});

describe("git info", () => {
  it("strips credentials from remotes", () => {
    expect(sanitizeRemote("https://x-access-token:ghs_abc@github.com/acme/orders.git")).toBe("https://github.com/acme/orders.git");
    expect(sanitizeRemote("git@github.com:acme/orders.git")).toBe("git@github.com:acme/orders.git");
    expect(sanitizeRemote("deploy:s3cret@git.acme.dev:acme/orders.git")).toBe("deploy@git.acme.dev:acme/orders.git");
    expect(sanitizeRemote("ssh://git:pw@host.dev/acme/orders.git")).toBe("ssh://host.dev/acme/orders.git");
  });

  it("prefers GitHub Actions variables over a detached checkout", async () => {
    const info = await gitInfo(root, {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "abc123",
      GITHUB_REF_NAME: "main",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/orders",
    });
    expect(info).toMatchObject({ commit: "abc123", branch: "main", remote: "https://github.com/acme/orders" });
  });

  it("is empty outside a repository", async () => {
    const info = await gitInfo(root, {});
    expect(info.commit).toBeUndefined();
    expect(info.branch).toBeUndefined();
  });
});
