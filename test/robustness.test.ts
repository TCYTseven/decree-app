import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectRoutes } from "../src/scanner/routes/index.js";
import { dropPrefixlessDuplicates, scanProject } from "../src/scanner/index.js";
import { stripComments } from "../src/scanner/context.js";
import { goModuleName } from "../src/scanner/manifests.js";
import { parseOpenApiDoc } from "../src/scanner/openapi.js";
import { planHarness } from "../src/planner/index.js";
import { generateTargets } from "../src/generators/index.js";
import type { ApiEndpoint, ProjectProfile } from "../src/core/types.js";

/**
 * Robustness of the scanner on hostile / unusual inputs, and the framework detectors added from scanning real
 * repositories (see the scanner section of docs/ARCHITECTURE.md). Fixtures are synthesized under test/.tmp
 * (gitignored) so nothing binary or permission-less is ever committed.
 */

const TMP = path.join(__dirname, ".tmp", `robustness-${process.pid}`);
let n = 0;

async function project(files: Record<string, string | Buffer>): Promise<string> {
  const root = path.join(TMP, `p${n++}`);
  await fs.mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

const routes = (files: Record<string, string>) =>
  detectRoutes(new Map(Object.entries(files))).map((e) => `${e.method} ${e.path}`);

/** The whole pipeline (scan -> offline plan -> generate) must survive whatever the scan produced. */
async function pipeline(root: string): Promise<ProjectProfile> {
  const profile = await scanProject(root);
  const spec = await planHarness(profile, { goal: "Help maintain this project", targets: ["typescript", "claude-code"] });
  const files = generateTargets(spec, ["typescript", "claude-code"], { outDir: "agent", decreeVersion: "0.0.0-test" });
  expect(files.length).toBeGreaterThan(0);
  JSON.stringify(profile); // serializable (no cycles, no BigInt)
  return profile;
}

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
});
afterAll(async () => {
  // restore permissions so the cleanup can remove everything
  await fs.chmod(path.join(TMP), 0o755).catch(() => undefined);
  const chmodAll = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[] = [];
    try {
      await fs.chmod(dir, 0o755);
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await chmodAll(abs);
      else if (e.isFile()) await fs.chmod(abs, 0o644).catch(() => undefined);
    }
  };
  await chmodAll(TMP);
  await fs.rm(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Synthetic edge cases: none may crash, all must stay bounded.
// ---------------------------------------------------------------------------

describe("scanner edge cases", () => {
  it("scans an empty directory", async () => {
    const root = await project({});
    const p = await pipeline(root);
    expect(p.stats.files).toBe(0);
    expect(p.apis).toEqual([]);
    expect(p.name).toBe(path.basename(root));
    expect(p.primaryLanguage).toBeUndefined();
    expect(p.git).toBeUndefined(); // not a git dir
  });

  it("rejects a missing root or a file with a clear error", async () => {
    await expect(scanProject(path.join(TMP, "does-not-exist"))).rejects.toThrow(/no such directory/);
    const root = await project({ "file.txt": "x" });
    await expect(scanProject(path.join(root, "file.txt"))).rejects.toThrow(/not a directory/);
  });

  it("scans a directory holding only a README", async () => {
    const root = await project({ "README.md": "# Widget\n\nA tiny widget service.\n" });
    const p = await pipeline(root);
    expect(p.description).toBe("A tiny widget service.");
    expect(p.docs.readme).toContain("Widget");
    expect(p.frameworks).toEqual([]);
  });

  it("skips binary files, including binaries with code extensions", async () => {
    const noise = Buffer.alloc(64 * 1024);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 256;
    const root = await project({
      "package.json": JSON.stringify({ name: "bin-heavy", dependencies: { express: "^4" } }),
      "src/app.js": "const express = require('express');\nconst app = express();\napp.get('/health', (q, s) => s.send('ok'));\n",
      "src/evil.js": Buffer.concat([Buffer.from("app.get('/from-binary', h)\n"), Buffer.from([0, 1, 2, 0]), noise]),
      "assets/logo.png": noise,
      "assets/video.mp4": Buffer.alloc(3 * 1024 * 1024, 0),
      "data/blob.json": Buffer.concat([Buffer.from('{"openapi":"3.0.0"'), Buffer.from([0]), noise]),
      "README.md": Buffer.concat([Buffer.from("# Bin\n\n"), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from(" latin-1 bytes\n")]),
    });
    const p = await pipeline(root);
    expect(p.apis.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /health"]);
    expect(p.openapiSpecs).toEqual([]);
    expect(p.keyFiles.every((k) => !k.excerpt.includes("\u0000"))).toBe(true);
  });

  it("does not follow symlink loops or dangling links", async () => {
    const root = await project({ "src/main.py": "from flask import Flask\napp = Flask(__name__)\n@app.route('/ping')\ndef ping():\n    return 'pong'\n" });
    await fs.symlink(".", path.join(root, "loop"));
    await fs.symlink("..", path.join(root, "src", "up"));
    await fs.symlink(path.join(root, "nowhere"), path.join(root, "dangling"));
    await fs.symlink("self", path.join(root, "self")).catch(() => undefined);
    const p = await pipeline(root);
    expect(p.stats.files).toBe(1);
    expect(p.apis.map((e) => e.path)).toEqual(["/ping"]);
  });

  it("survives unreadable files and directories", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "perms", scripts: { test: "vitest" } }),
      "locked/secret.ts": "export const x = process.env.LOCKED_VAR;",
      "unreadable.ts": "export const y = process.env.UNREADABLE_VAR;",
      "ok.ts": "export const z = process.env.OK_VAR;",
    });
    await fs.chmod(path.join(root, "locked"), 0o000);
    await fs.chmod(path.join(root, "unreadable.ts"), 0o000);
    const p = await pipeline(root);
    expect(p.envVars.map((e) => e.name)).toContain("OK_VAR");
    // As root the permissions are not enforced; either way nothing crashes and the readable file is scanned.
    expect(p.scripts.map((s) => s.name)).toContain("test");
  });

  it("tolerates non-UTF-8 file names", async () => {
    const root = await project({ "ok.py": "import os\nX = os.environ.get('GOOD_VAR')\n" });
    const bad = Buffer.concat([Buffer.from(path.join(root, "bad")), Buffer.from([0xff, 0xfe]), Buffer.from(".py")]);
    await fs.writeFile(bad, "import os\nY = os.environ.get('BAD_NAME_VAR')\n");
    const badDir = Buffer.concat([Buffer.from(path.join(root, "d")), Buffer.from([0xc3, 0x28])]);
    await fs.mkdir(badDir);
    const p = await pipeline(root);
    expect(p.envVars.map((e) => e.name)).toContain("GOOD_VAR");
    expect(() => JSON.stringify(p)).not.toThrow();
  });

  it("stays fast on minified files and extremely long lines", async () => {
    const minified = "var e=require('express'),a=e();" + Array.from({ length: 5000 }, (_, i) => `a.get("/r${i}",function(q,s){s.send(${i})});`).join("");
    const root = await project({
      "package.json": JSON.stringify({ name: "long-lines", dependencies: { express: "^4" } }),
      "public/vendor.min.js": "x".repeat(900_000),
      "src/generated.js": minified,
      "src/long.ts": "const s = '" + "a".repeat(800_000) + "';\n" + "/*".repeat(20_000),
      "src/unclosed.ts": "import { Controller, Get } from '@nestjs/common';\n@Controller('x')\nclass X {\n" + "@Get(".repeat(20_000),
    });
    const started = Date.now();
    const p = await pipeline(root);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(p.apis.length).toBeGreaterThan(1000);
    expect(p.keyFiles.every((k) => k.excerpt.length < 20_000)).toBe(true);
  });

  it("honors .gitignore negations and nested .gitignore files", async () => {
    const root = await project({
      ".gitignore": "*.log\n!keep.log\n/generated/*\n!/generated/api.ts\nsecrets/\n",
      "debug.log": "noise",
      "keep.log": "kept",
      "generated/junk.ts": "export const junk = process.env.JUNK_VAR;",
      "generated/api.ts": "export const api = process.env.API_VAR;",
      "secrets/key.ts": "export const k = process.env.SECRET_DIR_VAR;",
      "pkg/.gitignore": "tmp/\n!important.ts\n*.ts\n",
      "pkg/important.ts": "export const i = process.env.IMPORTANT_VAR;",
      "pkg/other.ts": "export const o = process.env.OTHER_VAR;",
    });
    const p = await scanProject(root);
    expect(p.tree).toContain("keep.log");
    expect(p.tree).not.toContain("debug.log");
    const env = p.envVars.map((e) => e.name);
    expect(env).toContain("API_VAR");
    expect(env).not.toContain("JUNK_VAR");
    expect(env).not.toContain("SECRET_DIR_VAR");
    // in pkg/.gitignore the later `*.ts` wins over the earlier negation
    expect(env).not.toContain("IMPORTANT_VAR");
    expect(env).not.toContain("OTHER_VAR");
  });

  it("parses Windows CRLF files everywhere", async () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const root = await project({
      "package.json": crlf(JSON.stringify({ name: "crlf-app", scripts: { dev: "node server.js", test: "node --test" } }, null, 2)),
      ".env.example": crlf("PORT=3000\nAPI_KEY=your-api-key\n# comment\nDATABASE_URL=postgres://localhost/db\n"),
      "Makefile": crlf("build:\n\tgo build ./...\n\nlint:\n\tgolangci-lint run\n"),
      "requirements.txt": crlf("flask==3.0\nrequests>=2\n"),
      "config/routes.rb": crlf("Rails.application.routes.draw do\n  resources :posts, only: [:index, :show]\nend\n"),
      "app.py": crlf("from flask import Flask\napp = Flask(__name__)\n\n@app.route('/items/<int:item_id>', methods=['GET', 'DELETE'])\ndef item(item_id):\n    return ''\n"),
      "server.js": crlf("const express = require('express')\nconst app = express()\napp.post('/login', (q, s) => s.end())\n"),
      "openapi.yaml": crlf("openapi: 3.0.0\ninfo:\n  title: x\n  version: '1'\npaths:\n  /orders:\n    get:\n      operationId: listOrders\n"),
    });
    const p = await pipeline(root);
    const eps = p.apis.map((e) => `${e.method} ${e.path}`);
    expect(eps).toEqual(expect.arrayContaining(["GET /orders", "POST /login", "GET /items/{item_id}", "DELETE /items/{item_id}", "GET /posts", "GET /posts/{id}"]));
    expect(p.envVars.map((e) => e.name)).toEqual(expect.arrayContaining(["PORT", "API_KEY", "DATABASE_URL"]));
    expect(p.envVars.every((e) => !/\r/.test(e.name) && !/\r/.test(e.example ?? ""))).toBe(true);
    expect(p.scripts.map((s) => s.name)).toEqual(expect.arrayContaining(["dev", "test", "build", "lint"]));
    expect(p.scripts.every((s) => !/\r/.test(s.command))).toBe(true);
    expect(p.dependencies.map((d) => d.name)).toEqual(expect.arrayContaining(["flask", "requests"]));
  });

  it("never copies .env values or hardcoded secrets into the profile", async () => {
    const root = await project({
      ".env": "STRIPE_SECRET_KEY=sk_live_51HxAbCdEfGhIjKlMnOpQrStUv\nDATABASE_URL=postgres://admin:hunter2hunter2@db.internal/prod\n",
      ".env.example": "STRIPE_SECRET_KEY=sk_live_51RealLookingButInExampleFile99\nPORT=8080\n",
      "src/config.ts": "export const key = process.env.STRIPE_SECRET_KEY ?? 'sk_live_51HardcodedFallbackSecretValue';\nexport const aws = 'AKIAIOSFODNN7EXAMPLE';\n",
      "package.json": JSON.stringify({ name: "leaky", main: "src/config.ts" }),
    });
    const p = await scanProject(root);
    const json = JSON.stringify(p);
    for (const secret of ["sk_live_51HxAbCdEfGhIjKlMnOpQrStUv", "hunter2hunter2", "sk_live_51RealLookingButInExampleFile99", "sk_live_51HardcodedFallbackSecretValue"])
      expect(json).not.toContain(secret);
    expect(p.envVars.find((e) => e.name === "PORT")?.example).toBe("8080");
  });

  it("drops noise env var names", async () => {
    const root = await project({ "a.js": "const a = process.env.__; const b = process.env._X; const c = process.env.REAL_ONE;" });
    const p = await scanProject(root);
    expect(p.envVars.map((e) => e.name)).toEqual(["REAL_ONE"]);
  });

  it("bounds a huge flat directory", async () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "huge" }) };
    for (let i = 0; i < 3000; i++) files[`many/f${i}.txt`] = "x";
    const root = await project(files);
    const p = await scanProject(root, { maxFiles: 500 });
    expect(p.stats.truncated).toBe(true);
    expect(p.stats.files).toBe(500);
    expect(p.tree.split("\n").length).toBeLessThanOrEqual(150);
  });
});

describe("pathological detector input stays bounded", () => {
  it.each([
    ["nest unclosed decorators", "a.ts", "import {Controller} from '@nestjs/common';@Controller('x') class A {" + "@Get(".repeat(20000)],
    ["go unclosed funcs", "a.go", 'import "net/http"\n' + "func a(".repeat(20000)],
    ["rust unclosed nests", "a.rs", "use axum::Router;\n" + '.nest("/a", '.repeat(20000)],
    ["laravel unclosed groups", "routes/api.php", "<?php Route::get('/x');" + "->group(function() {".repeat(10000)],
    ["spring unclosed mappings", "A.java", "@RestController\n" + "class A {} @RequestMapping(".repeat(10000)],
    ["unclosed block comments", "b.ts", "import express from 'express';" + "x = 1; /*".repeat(100000)],
  ])("%s", (_name, file, text) => {
    const started = Date.now();
    detectRoutes(new Map([[file, text]]));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stripComments keeps offsets and only strips real comments", () => {
    const src = "const g = 'src/**/*.ts';\n/* block\ncomment */ app.get('/a')\n// line\nx /* unclosed";
    const out = stripComments("a.ts", src);
    expect(out.length).toBe(src.length);
    expect(out).toContain("'src/**/*.ts'");
    expect(out).not.toContain("block");
    expect(out).not.toContain("// line");
    expect(out).toContain("/* unclosed");
  });
});

// ---------------------------------------------------------------------------
// Detectors added / fixed from the real-repo sweep.
// ---------------------------------------------------------------------------

describe("NestJS", () => {
  it("applies setGlobalPrefix (with exclude) and URI versioning", () => {
    const eps = routes({
      "apps/api/src/main.ts":
        "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('api', { exclude: ['health'] });\napp.enableVersioning({ type: VersioningType.URI });\n",
      "apps/api/src/users.controller.ts":
        "import { Controller, Get, Post, Version } from '@nestjs/common';\n@Controller({ path: 'users', version: '1' })\nexport class UsersController {\n  @Get(':id')\n  find() {}\n  @Version('2')\n  @Post()\n  create() {}\n}\n",
      "apps/api/src/health.controller.ts": "import { Controller, Get } from '@nestjs/common';\n@Controller('health')\nexport class H {\n  @Get()\n  ok() {}\n}\n",
      "apps/other/src/x.controller.ts": "import { Controller, Get } from '@nestjs/common';\n@Controller('x')\nexport class X {\n  @Get()\n  x() {}\n}\n",
    });
    expect(eps).toEqual(expect.arrayContaining(["GET /api/v1/users/{id}", "POST /api/v2/users", "GET /health", "GET /x"]));
  });
});

describe("Fastify", () => {
  it("prefixes @fastify/autoload routes by directory and register({ prefix })", () => {
    const eps = routes({
      "src/app.ts":
        "import AutoLoad from '@fastify/autoload'\nimport path from 'node:path'\nexport default async function app(fastify) {\n  fastify.register(AutoLoad, { dir: path.join(import.meta.dirname, 'routes'), options: { prefix: '/v1' } })\n}\n",
      "src/routes/users/index.ts": "export default async function (fastify) {\n  fastify.get('/', async () => [])\n  fastify.get('/:id', async () => ({}))\n}\n",
      "src/routes/users/_userId/posts.ts": "export default async function (fastify) {\n  fastify.post('/posts', async () => ({}))\n}\n",
      "src/server.ts": "import Fastify from 'fastify'\nimport admin from './admin.js'\nconst f = Fastify()\nf.register(admin, { prefix: '/admin' })\n",
      "src/admin.ts": "import fastify from 'fastify'\nexport default async function admin(app) {\n  app.delete('/cache', async () => ({}))\n}\n",
    });
    expect(eps).toEqual(expect.arrayContaining(["GET /v1/users", "GET /v1/users/{id}", "POST /v1/users/{userId}/posts", "DELETE /admin/cache"]));
  });
});

describe("Hono", () => {
  it("handles basePath and regex params", () => {
    const eps = routes({
      "src/index.ts": "import { Hono } from 'hono'\nconst app = new Hono().basePath('/api')\napp.get('/post/:id{[0-9]+}', (c) => c.text('x'))\napp.get('/files/:name{.+\\\\.png}', (c) => c.text('x'))\n",
    });
    expect(eps).toEqual(["GET /api/post/{id}", "GET /api/files/{name}"]);
  });
});

describe("Laravel", () => {
  it("resolves prefix groups, match, and resource only/except", () => {
    const eps = routes({
      "routes/api.php": `<?php
Route::post('login', [AuthController::class, 'login']);
Route::prefix('v1')->middleware('auth:sanctum')->group(function () {
    Route::match(['put', 'patch'], 'user', 'UserController@update');
    Route::group(['prefix' => 'admin'], function () {
        Route::delete('cache', 'AdminController@flush');
    });
    Route::apiResource('posts', PostController::class)->only(['index', 'show']);
    Route::resource('photos.comments', CommentController::class, ['except' => ['create', 'edit', 'destroy']]);
});
Route::get('status', fn () => 'ok');
`,
    });
    expect(eps).toEqual(
      expect.arrayContaining([
        "POST /api/login",
        "PUT /api/v1/user",
        "PATCH /api/v1/user",
        "DELETE /api/v1/admin/cache",
        "GET /api/v1/posts",
        "GET /api/v1/posts/{post}",
        "GET /api/v1/photos/{photo}/comments",
        "POST /api/v1/photos/{photo}/comments",
        "PUT /api/v1/photos/{photo}/comments/{comment}",
        "GET /api/status",
      ]),
    );
    expect(eps).not.toContain("POST /api/v1/posts");
    expect(eps).not.toContain("DELETE /api/v1/photos/{photo}/comments/{comment}");
    expect(eps).not.toContain("GET /api/v1/photos/{photo}/comments/create");
  });
});

describe("Spring", () => {
  it("combines class and method mappings per class, incl. Kotlin arrays and multiple paths", () => {
    const eps = routes({
      "src/main/java/com/acme/samples/OrderController.java": `package com.acme.samples;
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/{id}")
  public Order get(@PathVariable Long id) { return null; }
  @RequestMapping(value = {"/search", "/find"}, method = RequestMethod.POST)
  public List<Order> search() { return null; }
  @DeleteMapping
  public void clear() {}
}
@RestController
@RequestMapping(path = "/api/health")
class HealthController {
  @GetMapping
  public String ok() { return "ok"; }
}
`,
      "src/main/kotlin/com/acme/UserController.kt": `@RestController
@RequestMapping(value = ["/api/users"])
class UserController {
    @PostMapping(["/", "/new"])
    fun create(): User = TODO()
}
`,
    });
    expect(eps).toEqual(
      expect.arrayContaining([
        "GET /api/orders/{id}",
        "POST /api/orders/search",
        "POST /api/orders/find",
        "DELETE /api/orders",
        "GET /api/health",
        "POST /api/users",
        "POST /api/users/new",
      ]),
    );
    expect(eps).not.toContain("GET /api/orders"); // the class-level @RequestMapping is a prefix, not a route
  });
});

describe("Rust axum / actix", () => {
  it("resolves Router::nest (inline and via functions) and ignores #[cfg(test)] modules", () => {
    const eps = routes({
      "src/main.rs": `use axum::{routing::{get, post}, Router};
mod api;
fn app() -> Router {
    Router::new()
        .route("/", get(root))
        .nest("/api", api::router())
        .nest("/admin", Router::new().route("/stats", get(stats)))
}
#[cfg(test)]
mod tests {
    fn lifetimes<'a>(x: &'a str) -> &'a str { x }
    #[test]
    fn t() { let app = Router::new().route("/only-in-tests", get(|| async {})); }
}
`,
      "src/api.rs": `use axum::{routing::{get, post}, Router};
pub fn router() -> Router {
    Router::new()
        .route("/users/{id}", get(get_user).delete(del_user))
        .route("/files/{*path}", get(file))
        .route("/upload", post_service(upload))
}
`,
    });
    expect(eps).toEqual(expect.arrayContaining(["GET /", "GET /api/users/{id}", "DELETE /api/users/{id}", "GET /api/files/{path}", "POST /api/upload", "GET /admin/stats"]));
    expect(eps.some((e) => e.includes("only-in-tests"))).toBe(false);
  });

  it("applies actix web::scope prefixes", () => {
    const eps = routes({
      "src/main.rs": `use actix_web::{web, App};
fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(web::scope("/api").route("/items", web::get().to(list)).route("/items", web::post().to(create)));
}
`,
    });
    expect(eps).toEqual(expect.arrayContaining(["GET /api/items", "POST /api/items"]));
  });
});

describe("Go", () => {
  it("carries router groups into registration functions across files (gin)", () => {
    const eps = routes({
      "main.go": `package main
import "github.com/gin-gonic/gin"
func main() {
	r := gin.Default()
	v1 := r.Group("/api")
	users.Register(v1.Group("/users"))
	articles.Routes(v1)
}
`,
      "users/routes.go": `package users
import "github.com/gin-gonic/gin"
func Register(router *gin.RouterGroup) {
	router.POST("", create)
	router.GET("/:id", get)
}
`,
      "articles/routes.go": `package articles
import "github.com/gin-gonic/gin"
func Routes(api, unused *gin.RouterGroup) {
	g := api.Group("/articles")
	g.GET("", list)
	g.DELETE("/:slug", del)
}
`,
    });
    expect(eps).toEqual(expect.arrayContaining(["POST /api/users", "GET /api/users/{id}", "GET /api/articles", "DELETE /api/articles/{slug}"]));
  });

  it("wires echo groups passed to methods from a main.go without router imports", () => {
    const eps = routes({
      "main.go": 'package main\nfunc main() {\n\tr := router.New()\n\tv1 := r.Group("/api")\n\th.Register(v1)\n}\n',
      "handler/routes.go": 'package handler\nimport "github.com/labstack/echo/v4"\nfunc (h *Handler) Register(v1 *echo.Group) {\n\tu := v1.Group("/user")\n\tu.GET("", h.Current)\n}\n',
    });
    expect(eps).toEqual(["GET /api/user"]);
  });

  it("resolves chi Mount of router-returning functions and Route closures", () => {
    const eps = routes({
      "main.go": `package main
import "github.com/go-chi/chi/v5"
func main() {
	r := chi.NewRouter()
	r.Mount("/admin", adminRouter())
	r.Route("/articles", func(r chi.Router) {
		r.Get("/", list)
		r.Route("/{id}", func(r chi.Router) {
			r.Put("/", update)
		})
	})
}
func adminRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/accounts", accounts)
	return r
}
`,
    });
    expect(eps).toEqual(expect.arrayContaining(["GET /admin/accounts", "GET /articles", "PUT /articles/{id}"]));
  });

  it("names a module after its last non-version segment", () => {
    expect(goModuleName("github.com/go-chi/chi/v5")).toBe("chi");
    expect(goModuleName("example.com/svc")).toBe("svc");
  });
});

describe("Rails", () => {
  it("handles scope :sym, param:, nested params and on: :collection / :member", () => {
    const eps = routes({
      "config/routes.rb": `Rails.application.routes.draw do
  scope :api, defaults: { format: :json } do
    resources :articles, param: :slug, except: [:edit, :new] do
      resource :favorite, only: [:create]
      get :feed, on: :collection
      post :publish, on: :member
    end
  end
end
`,
    });
    expect(eps).toEqual(
      expect.arrayContaining(["GET /api/articles", "GET /api/articles/{slug}", "POST /api/articles/{article_slug}/favorite", "GET /api/articles/feed", "POST /api/articles/{slug}/publish"]),
    );
  });
});

describe("Django / DRF", () => {
  it("normalizes regex url() includes and infers class-based view methods", () => {
    const eps = routes({
      "proj/urls.py": "from django.conf.urls import include, url\nurlpatterns = [\n    url(r'^api/', include('proj.app.urls')),\n]\n",
      "proj/app/urls.py": `"""Docs: url(r'^$', views.home, name='home')"""
from django.conf.urls import include, url
from rest_framework.routers import DefaultRouter
router = DefaultRouter(trailing_slash=False)
router.register(r'articles', views.ArticleViewSet)
urlpatterns = [
    url(r'^', include(router.urls)),
    url(r'^articles/(?P<slug>[-\\w]+)/comments/?$', views.CommentsView.as_view()),
    url(r'^tags/?$', views.tags),
]
`,
      "proj/app/views.py": `from rest_framework import generics, mixins, viewsets
from rest_framework.decorators import action, api_view
class ArticleViewSet(mixins.CreateModelMixin,
                     mixins.ListModelMixin,
                     viewsets.GenericViewSet):
    lookup_field = 'slug'
    def retrieve(self, request, slug):
        pass
    @action(detail=True, methods=['post'], url_path='publish')
    def publish_it(self, request, slug=None):
        pass
class CommentsView(generics.ListCreateAPIView):
    pass
@api_view(['GET', 'POST'])
def tags(request):
    pass
`,
    });
    expect(eps.sort()).toEqual(
      [
        "GET /api/articles",
        "POST /api/articles",
        "GET /api/articles/{slug}",
        "POST /api/articles/{slug}/publish",
        "GET /api/articles/{slug}/comments/",
        "POST /api/articles/{slug}/comments/",
        "GET /api/tags/",
        "POST /api/tags/",
      ].sort(),
    );
  });
});

describe("OpenAPI", () => {
  it("resolves $refs across JSON files (path items, parameters, schemas, nested relative refs)", async () => {
    const root = await project({
      "spec/openapi.json": JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Pets", version: "1" },
        servers: [{ url: "https://api.example.com/v2" }],
        paths: {
          "/pets": { $ref: "paths/pets.json" },
          "/pets/{petId}": { $ref: "./paths/pet.json#/item" },
        },
      }),
      "spec/paths/pets.json": JSON.stringify({
        get: { operationId: "listPets", parameters: [{ $ref: "../components/params.json#/Limit" }] },
        post: { operationId: "createPet", requestBody: { content: { "application/json": { schema: { $ref: "../components/schemas/Pet.json" } } } } },
      }),
      "spec/paths/pet.json": JSON.stringify({
        item: { parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }], delete: { operationId: "deletePet" } },
      }),
      "spec/components/params.json": JSON.stringify({ Limit: { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } } }),
      "spec/components/schemas/Pet.json": JSON.stringify({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, owner: { $ref: "Owner.json" }, parent: { $ref: "Pet.json" } },
      }),
      "spec/components/schemas/Owner.json": JSON.stringify({ type: "object", properties: { email: { type: "string", format: "email" } } }),
    });
    const p = await scanProject(root);
    expect(p.openapiSpecs).toEqual(["spec/openapi.json"]);
    const by = (k: string) => p.apis.find((e) => `${e.method} ${e.path}` === k)!;
    expect(p.apis.map((e) => `${e.method} ${e.path}`).sort()).toEqual(["DELETE /v2/pets/{petId}", "GET /v2/pets", "POST /v2/pets"]);
    expect(by("GET /v2/pets").params).toEqual([{ name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 100 } }]);
    const body = by("POST /v2/pets").requestBody!;
    expect(body.required).toEqual(["name"]);
    expect((body.properties!.owner as { properties: Record<string, unknown> }).properties.email).toEqual({ type: "string", format: "email" });
    expect((body.properties!.parent as { description: string }).description).toMatch(/Recursive reference/);
    expect(by("DELETE /v2/pets/{petId}").params[0]!.schema).toEqual({ type: "integer" });
  });

  it("never reads refs outside the project or over the network", () => {
    const eps = parseOpenApiDoc(
      JSON.stringify({ openapi: "3.0.0", paths: { "/a": { $ref: "../../etc/passwd" }, "/b": { $ref: "https://evil.example/p.json" }, "/c": { get: {} } } }),
      "openapi.json",
      () => {
        throw new Error("loader must not be called for escaping refs");
      },
    );
    expect(eps.map((e) => e.path)).toEqual(["/c"]);
  });
});

describe("spec vs code duplicates", () => {
  it("drops code routes that only lack the spec's mount prefix", () => {
    const ep = (method: ApiEndpoint["method"], p: string, source: string): ApiEndpoint => ({ method, path: p, params: [], source });
    const spec = [ep("GET", "/api/users/{id}", "openapi.yaml"), ep("POST", "/api/v1/users", "openapi.yaml")];
    const code = [ep("GET", "/users/{userId}", "a.go:1"), ep("POST", "/users", "a.go:2"), ep("GET", "/", "a.go:3"), ep("DELETE", "/users/{id}", "a.go:4")];
    expect(dropPrefixlessDuplicates(code, spec).map((e) => `${e.method} ${e.path}`)).toEqual(["GET /", "DELETE /users/{id}"]);
  });
});

describe("monorepo workspaces", () => {
  it("adds per-app workspace scripts and tags endpoints with their workspace", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "packages/*"], scripts: { build: "turbo run build" } }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "apps/api/package.json": JSON.stringify({ name: "@acme/api", scripts: { dev: "nest start --watch", test: "jest", migrate: "prisma migrate" }, dependencies: { "@nestjs/core": "^10" } }),
      "apps/api/src/main.ts": "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('api');\n",
      "apps/api/src/orders.controller.ts": "import { Controller, Get } from '@nestjs/common';\n@Controller('orders')\nexport class O {\n  @Get()\n  list() {}\n}\n",
      "apps/web/package.json": JSON.stringify({ name: "@acme/web", scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "^15" } }),
      "apps/web/app/api/health/route.ts": "export async function GET() { return Response.json({ ok: true }) }\n",
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", scripts: { build: "tsup", dev: "tsup --watch" } }),
      "examples/demo/package.json": JSON.stringify({ name: "demo", scripts: { dev: "vite" } }),
    });
    const p = await scanProject(root);
    const scripts = Object.fromEntries(p.scripts.map((s) => [s.name, s.command]));
    expect(scripts["api:dev"]).toBe("pnpm --filter @acme/api run dev");
    expect(scripts["api:test"]).toBe("pnpm --filter @acme/api run test");
    expect(scripts["web:build"]).toBe("pnpm --filter @acme/web run build");
    expect(scripts["ui:build"]).toBeUndefined(); // library package, not an app
    expect(scripts["api:migrate"]).toBeUndefined(); // only the common lifecycle scripts
    expect(Object.keys(scripts).some((k) => k.startsWith("demo:"))).toBe(false);
    const tagOf = (k: string) => p.apis.find((e) => `${e.method} ${e.path}` === k)?.tags;
    expect(tagOf("GET /api/orders")).toEqual(["api"]);
    expect(tagOf("GET /api/health")).toEqual(["web"]);
  });
});

describe("languages and fixture paths", () => {
  it("does not treat JVM packages named samples/test as fixtures, nor bundled assets as code", async () => {
    const root = await project({
      "pom.xml": "<project><artifactId>petclinic</artifactId><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>",
      "src/main/java/org/acme/samples/petclinic/OwnerController.java":
        '@Controller\nclass OwnerController {\n  @GetMapping("/owners")\n  public String list() { return "x"; }\n}\n' + "// padding\n".repeat(50),
      "src/main/resources/static/css/app.css": "a{}".repeat(40_000),
      "public/js/app.js": "var a=1;".repeat(20_000),
    });
    const p = await scanProject(root);
    expect(p.primaryLanguage).toBe("Java");
    expect(p.apis.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /owners"]);
  });

  it("ignores _examples, benches and code_samples for routes and languages", async () => {
    const root = await project({
      "go.mod": "module github.com/acme/router/v3\n\ngo 1.22\n",
      "router.go": 'package router\nimport "net/http"\nfunc New() *http.ServeMux { return http.NewServeMux() }\n',
      "_examples/rest/main.go": 'package main\nimport "github.com/go-chi/chi/v5"\nfunc main() { r := chi.NewRouter(); r.Get("/example", h) }\n',
      "benches/bench.go": 'package benches\nimport "net/http"\nfunc b() { m.HandleFunc("/bench", h) }\n',
      "docs/code_samples/C_sharp/get.cs": "class X {}",
    });
    const p = await scanProject(root);
    expect(p.name).toBe("router");
    expect(p.apis).toEqual([]);
    expect(p.primaryLanguage).toBe("Go");
  });
});

describe("env example hygiene", () => {
  it("drops token-shaped example values and masks remote URL passwords", async () => {
    const root = await project({
      ".env.example":
        "OPENAI_KEY_EXAMPLE=sk-proj-abcdefghijklmnopqrstuv\nGH=ghp_abcdefghijklmnopqrstuvwxyz0123\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/app\nREPLICA_URL=postgres://app:S3cr3tPass@db.prod.example.com:5432/app\nAPI_KEY=your-api-key\n",
    });
    const env = Object.fromEntries((await scanProject(root)).envVars.map((e) => [e.name, e.example]));
    expect(env.OPENAI_KEY_EXAMPLE).toBeUndefined();
    expect(env.GH).toBeUndefined();
    expect(env.DATABASE_URL).toBe("postgres://postgres:postgres@localhost:5432/app");
    expect(env.REPLICA_URL).toBe("postgres://app:[REDACTED]@db.prod.example.com:5432/app");
    expect(env.API_KEY).toBe("your-api-key");
  });
});
