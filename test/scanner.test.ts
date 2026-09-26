import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiEndpoint, ProjectProfile } from "../src/core/types.js";
import { scanProject } from "../src/scanner/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => path.join(FIXTURES, name);

function ep(p: ProjectProfile, method: string, route: string): ApiEndpoint {
  const found = p.apis.find((a) => a.method === method && a.path === route);
  if (!found) throw new Error(`missing ${method} ${route}; have:\n${p.apis.map((a) => `${a.method} ${a.path}`).join("\n")}`);
  return found;
}

function script(p: ProjectProfile, name: string) {
  return p.scripts.find((s) => s.name === name);
}

describe("scanProject: express-openapi fixture", () => {
  let p: ProjectProfile;
  const progress: string[] = [];
  beforeAll(async () => {
    p = await scanProject(fixture("express-openapi"), { onProgress: (m) => progress.push(m) });
  });

  it("reads package.json identity, scripts and package manager", () => {
    expect(p.name).toBe("acme-orders");
    expect(p.description).toMatch(/orders service/i);
    expect(p.root).toBe(fixture("express-openapi"));
    expect(p.primaryLanguage).toBe("TypeScript");
    expect(p.languages[0]!.name).toBe("TypeScript");
    expect(p.packageManager).toBe("npm");
    expect(p.frameworks).toContain("express");
    expect(script(p, "test")).toEqual({ name: "test", command: "vitest run", source: "package.json" });
    expect(script(p, "deploy")?.command).toBe("fly deploy --remote-only");
    const express = p.dependencies.find((d) => d.name === "express");
    expect(express).toMatchObject({ ecosystem: "npm", version: "^4.19.2" });
    expect(p.dependencies.find((d) => d.name === "vitest")?.dev).toBe(true);
  });

  it("parses OpenAPI 3 with $ref resolution", () => {
    expect(p.openapiSpecs).toEqual(["openapi.yaml"]);
    const list = ep(p, "GET", "/orders");
    expect(list.operationId).toBe("listOrders");
    expect(list.tags).toEqual(["orders"]);
    expect(list.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "status", in: "query", required: false, schema: expect.objectContaining({ enum: ["pending", "paid", "shipped", "cancelled"] }) }),
        expect.objectContaining({ name: "limit", in: "query", schema: expect.objectContaining({ type: "integer" }) }),
      ]),
    );
    const create = ep(p, "POST", "/orders");
    expect(create.requestBody?.required).toEqual(["customerId", "items"]);
    expect((create.requestBody?.properties?.items as { items: { properties: Record<string, unknown> } }).items.properties).toHaveProperty("sku");
    const del = ep(p, "DELETE", "/orders/{id}");
    expect(del.params).toEqual([expect.objectContaining({ name: "id", in: "path", required: true })]);
    expect(del.summary).toMatch(/delete/i);
    const cancel = ep(p, "POST", "/orders/{id}/cancel");
    expect(cancel.params.map((x) => `${x.in}:${x.name}`).sort()).toEqual(["header:Idempotency-Key", "path:id"]);
    expect(cancel.requestBody).toMatchObject({ type: "object", required: ["reason"] });
    expect(cancel.source).toBe("openapi.yaml");
  });

  it("adds code-only routes and dedupes the rest", () => {
    const events = ep(p, "GET", "/orders/{id}/events");
    expect(events.source).toBe("src/routes/orders.ts:46");
    expect(events.params).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
    const keys = p.apis.map((a) => `${a.method} ${a.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(9);
  });

  it("collects env vars without leaking secret-looking example values", () => {
    const byName = Object.fromEntries(p.envVars.map((e) => [e.name, e]));
    expect(byName.DATABASE_URL).toMatchObject({ source: ".env.example", secret: false, example: "postgres://postgres:postgres@localhost:5432/acme" });
    expect(byName.ACME_API_TOKEN).toMatchObject({ secret: true, example: "your-api-token-here" });
    expect(byName.STRIPE_SECRET_KEY!.secret).toBe(true);
    expect(byName.STRIPE_SECRET_KEY!.example).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("a8f5f167f44f4964e6c998dee827110c");
    expect(byName.NODE_ENV?.source).toBe("src/index.ts");
  });

  it("detects prisma models, docs, tree and key files", () => {
    expect(p.database).toEqual({ kind: "prisma", schemaFiles: ["prisma/schema.prisma"], models: ["Customer", "Order", "LineItem"] });
    expect(p.docs.readme).toMatch(/^# Acme Orders/);
    expect(p.docs.files).toContain("README.md");
    expect(p.existingAgentConfig).toEqual({ claudeMd: false, agentsMd: false, mcpJson: false, cursorRules: false, claudeDir: false });
    expect(p.tree.split("\n")[0]).toBe("express-openapi/");
    expect(p.tree).toContain("│   ├── routes/");
    expect(p.tree).toContain("orders.ts");
    const kf = p.keyFiles.map((k) => k.path);
    expect(kf[0]).toBe("src/routes/orders.ts");
    expect(kf).toEqual(expect.arrayContaining(["src/index.ts", "prisma/schema.prisma", "src/routes/customers.ts"]));
    for (const k of p.keyFiles) expect(k.excerpt.length).toBeLessThanOrEqual(3100);
    expect(p.stats).toMatchObject({ truncated: false, files: 16 });
    expect(p.stats.scanMs).toBeGreaterThanOrEqual(0);
    expect(progress.length).toBeGreaterThan(5);
    expect(p.git).toBeUndefined();
  });
});

describe("scanProject: fastapi-app fixture", () => {
  let p: ProjectProfile;
  beforeAll(async () => {
    p = await scanProject(fixture("fastapi-app"));
  });

  it("reads pyproject + requirements", () => {
    expect(p.name).toBe("inventory-api");
    expect(p.primaryLanguage).toBe("Python");
    expect(p.packageManager).toBe("uv");
    expect(p.frameworks).toEqual(["fastapi"]);
    const names = p.dependencies.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["fastapi", "uvicorn", "sqlalchemy", "alembic"]));
    expect(p.dependencies.find((d) => d.name === "pytest")?.dev).toBe(true);
    expect(script(p, "test")).toEqual({ name: "test", command: "pytest -q", source: "pyproject.toml" });
    expect(script(p, "deploy")?.command).toBe("fly deploy --remote-only");
    expect(p.cli).toEqual({ bin: "inventory", commands: ["seed", "reset-db"] });
  });

  it("detects FastAPI routes with router prefixes, include_router prefixes and pydantic bodies", () => {
    const keys = p.apis.map((a) => `${a.method} ${a.path}`).sort();
    expect(keys).toEqual(
      [
        "DELETE /items/{item_id}",
        "GET /health",
        "GET /items/",
        "GET /items/{item_id}",
        "GET /users/",
        "GET /users/{user_id}",
        "POST /admin/reindex",
        "POST /items/",
        "POST /users/",
        "PUT /items/{item_id}",
      ].sort(),
    );
    const list = ep(p, "GET", "/items/");
    expect(list.operationId).toBe("list_items");
    expect(list.summary).toBe("List items, optionally filtered by a name query.");
    expect(list.params).toEqual([
      { name: "q", in: "query", required: false, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer" } },
    ]);
    const get = ep(p, "GET", "/items/{item_id}");
    expect(get.params).toEqual([{ name: "item_id", in: "path", required: true, schema: { type: "integer" } }]);
    expect(get.source).toBe("app/routers/items.py:20");
    const create = ep(p, "POST", "/items/");
    expect(create.requestBody?.required).toEqual(["name", "price", "owner_id"]);
    expect(create.requestBody?.properties?.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(ep(p, "POST", "/users/").requestBody?.properties?.email).toEqual({ type: "string", format: "email" });
    expect(ep(p, "POST", "/admin/reindex").params).toEqual([{ name: "x-api-key", in: "header", required: true, schema: { type: "string" } }]);
    expect(ep(p, "DELETE", "/items/{item_id}").summary).toBe("Permanently delete an item.");
  });

  it("detects env, sqlalchemy models, agent config", () => {
    const env = Object.fromEntries(p.envVars.map((e) => [e.name, e]));
    expect(env.INVENTORY_API_KEY).toMatchObject({ secret: true, example: "changeme" });
    expect(env.DATABASE_URL?.secret).toBe(false);
    expect(p.database?.kind).toBe("sqlalchemy");
    expect(p.database?.models).toEqual(["User", "Item"]);
    expect(p.database?.schemaFiles).toContain("alembic/versions/");
    expect(p.existingAgentConfig.agentsMd).toBe(true);
    expect(p.keyFiles[0]!.path).toBe("AGENTS.md");
    expect(p.keyFiles.map((k) => k.path)).toEqual(expect.arrayContaining(["app/main.py", "app/routers/items.py"]));
  });
});

describe("scanProject: nextjs-app fixture", () => {
  let p: ProjectProfile;
  beforeAll(async () => {
    p = await scanProject(fixture("nextjs-app"));
  });

  it("detects app-router and pages/api handlers", () => {
    expect(p.frameworks).toEqual(["nextjs", "react"]);
    expect(p.packageManager).toBe("pnpm");
    const keys = p.apis.map((a) => `${a.method} ${a.path}`).sort();
    expect(keys).toEqual(
      [
        "DELETE /api/notes/{id}",
        "GET /api/notes",
        "GET /api/notes/{id}",
        "GET /api/search",
        "GET /api/session",
        "PATCH /api/notes/{id}",
        "POST /api/notes",
        "POST /api/webhooks/{provider}",
      ].sort(),
    );
    expect(ep(p, "POST", "/api/notes").requestBody).toEqual({ type: "object", properties: { title: {}, body: {} } });
    expect(ep(p, "GET", "/api/search").params).toEqual([{ name: "q", in: "query", required: false, schema: { type: "string" } }]);
    expect(ep(p, "DELETE", "/api/notes/{id}").source).toBe("app/api/notes/[id]/route.ts:19");
  });

  it("detects drizzle, public vs secret env, CLAUDE.md", () => {
    expect(p.database).toMatchObject({ kind: "drizzle", models: ["users", "notes"] });
    const env = Object.fromEntries(p.envVars.map((e) => [e.name, e]));
    expect(env.NEXTAUTH_SECRET?.secret).toBe(true);
    expect(env.NEXT_PUBLIC_APP_URL?.secret).toBe(false);
    expect(env.WEBHOOK_SIGNING_SECRET).toMatchObject({ secret: true, source: "pages/api/webhooks/[provider].ts" });
    expect(env.DATABASE_URL?.example).toBe("postgres://localhost:5432/notes");
    expect(p.existingAgentConfig.claudeMd).toBe(true);
    expect(p.keyFiles[0]).toMatchObject({ path: "CLAUDE.md" });
    expect(script(p, "deploy")?.command).toBe("vercel deploy --prod");
  });
});

describe("scanProject: go-gin fixture", () => {
  let p: ProjectProfile;
  beforeAll(async () => {
    p = await scanProject(fixture("go-gin"));
  });

  it("reads go.mod and Makefile", () => {
    expect(p.name).toBe("tasks-api");
    expect(p.primaryLanguage).toBe("Go");
    expect(p.packageManager).toBe("go");
    expect(p.frameworks).toEqual(["gin"]);
    expect(p.dependencies.map((d) => d.name)).toEqual(["github.com/gin-gonic/gin", "gorm.io/driver/postgres", "gorm.io/gorm"]);
    expect(script(p, "test")).toEqual({ name: "test", command: "go test ./...", source: "Makefile" });
    expect(script(p, "lint")?.command).toBe("golangci-lint run ./...");
    // recipes that use make variables are run through make
    expect(script(p, "deploy")?.command).toBe("make deploy");
    expect(p.scripts.some((s) => s.name === "BINARY" || s.name === ".PHONY")).toBe(false);
  });

  it("detects gin routes with groups", () => {
    const keys = p.apis.map((a) => `${a.method} ${a.path}`);
    expect(keys).toEqual([
      "GET /healthz",
      "GET /api/v1/tasks",
      "POST /api/v1/tasks",
      "GET /api/v1/tasks/{id}",
      "PUT /api/v1/tasks/{id}",
      "DELETE /api/v1/tasks/{id}",
      "POST /api/v1/admin/purge",
    ]);
    expect(ep(p, "DELETE", "/api/v1/tasks/{id}")).toMatchObject({ operationId: "DeleteTask", source: "main.go:26" });
  });

  it("detects gorm models and env", () => {
    expect(p.database).toMatchObject({ kind: "gorm", models: ["Task"] });
    expect(p.envVars.map((e) => e.name)).toEqual(["DATABASE_URL", "TASKS_API_TOKEN", "PORT"]);
    expect(p.envVars.find((e) => e.name === "TASKS_API_TOKEN")).toMatchObject({ secret: true, example: "replace-me" });
    expect(p.keyFiles[0]!.path).toBe("main.go");
  });
});

describe("scanProject: walking", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "decree-scan-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (rel: string, content = "x") => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  it("honors .gitignore (root and nested, with negation) and always-skipped dirs", async () => {
    write(".gitignore", "generated/\n*.log\nsecret-*.ts\n!secret-ok.ts\n");
    write("src/index.ts", "export const a = 1;\n");
    write("src/secret-a.ts", "process.env.SHOULD_NOT_APPEAR;\n");
    write("src/secret-ok.ts", "process.env.VISIBLE_VAR;\n");
    write("generated/big.ts", "process.env.GENERATED_VAR;\n");
    write("debug.log", "log");
    write("pkg/.gitignore", "local.ts\n");
    write("pkg/local.ts", "process.env.NESTED_IGNORED;\n");
    write("pkg/kept.ts", "export {};\n");
    write("node_modules/dep/index.js", "process.env.DEP_VAR;\n");
    write("dist/index.js", "x");
    write("coverage/lcov.info", "x");
    write(".venv/lib/x.py", "x");
    write("__pycache__/x.pyc", "x");
    write(".git/HEAD", "ref: refs/heads/main\n");
    write(".git/config", '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://user:ghp_secret@github.com/acme/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');

    const p = await scanProject(dir);
    const files = p.tree;
    expect(files).toContain("index.ts");
    expect(files).toContain("secret-ok.ts");
    expect(files).toContain("kept.ts");
    for (const hidden of ["secret-a.ts", "generated", "debug.log", "local.ts", "node_modules", "dist", "coverage", ".venv", "__pycache__", ".git/"])
      expect(files).not.toContain(hidden);
    const names = p.envVars.map((e) => e.name);
    expect(names).toContain("VISIBLE_VAR");
    expect(names).not.toContain("SHOULD_NOT_APPEAR");
    expect(names).not.toContain("GENERATED_VAR");
    expect(names).not.toContain("NESTED_IGNORED");
    expect(names).not.toContain("DEP_VAR");
    expect(p.git).toEqual({ branch: "main", remote: "https://github.com/acme/demo.git" });
    expect(p.name).toBe(path.basename(dir));
  });

  it("never reads values from .env, only names", async () => {
    write(".env", "REAL_SECRET_TOKEN=super-secret-value-123\nPLAIN=hello\n");
    const p = await scanProject(dir);
    const v = p.envVars.find((e) => e.name === "REAL_SECRET_TOKEN");
    expect(v).toMatchObject({ source: ".env", secret: true });
    expect(v?.example).toBeUndefined();
    expect(p.envVars.find((e) => e.name === "PLAIN")?.example).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("super-secret-value-123");
  });

  it("truncates at maxFiles", async () => {
    const big = mkdtempSync(path.join(tmpdir(), "decree-big-"));
    try {
      writeFileSync(path.join(big, "package.json"), JSON.stringify({ name: "big" }));
      for (let d = 0; d < 10; d++) {
        mkdirSync(path.join(big, `d${d}`));
        for (let i = 0; i < 30; i++) writeFileSync(path.join(big, `d${d}`, `f${i}.ts`), "export {};\n");
      }
      const p = await scanProject(big, { maxFiles: 50 });
      expect(p.stats.truncated).toBe(true);
      expect(p.stats.files).toBe(50);
      expect(p.name).toBe("big"); // root manifests are walked first
      const full = await scanProject(big);
      expect(full.stats).toMatchObject({ files: 301, dirs: 10, truncated: false });
      expect(full.tree).toMatch(/… \d+ more/);
      expect(full.tree.split("\n").length).toBeLessThanOrEqual(150);
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });

  it("scans this repository without crashing and ignores test fixtures as project metadata", async () => {
    const root = path.resolve(FIXTURES, "../..");
    const p = await scanProject(root);
    expect(p.name).toBe("decree-harness");
    expect(p.primaryLanguage).toBe("TypeScript");
    expect(p.cli?.bin).toBe("decree-harness");
    expect(p.openapiSpecs).toEqual([]);
    expect(p.dependencies.some((d) => d.name === "express")).toBe(false);
    expect(p.database).toBeUndefined();
    // Terminal plumbing read by the CLI UI is not app configuration.
    expect(p.envVars.map((v) => v.name)).not.toEqual(expect.arrayContaining(["TERM_PROGRAM"]));
    expect(p.envVars.some((v) => v.name === "WT_SESSION")).toBe(false);
    const total = p.keyFiles.reduce((n, k) => n + k.excerpt.length, 0);
    expect(total).toBeLessThanOrEqual(31000);
    expect(p.keyFiles.length).toBeLessThanOrEqual(12);
  });
});
