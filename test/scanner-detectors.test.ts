import { describe, expect, it } from "vitest";
import { isSecretName, parseEnvFile } from "../src/scanner/env.js";
import { parseJustfile, parseMakefile, parsePep508, parseRequirements } from "../src/scanner/manifests.js";
import { looksLikeOpenApi, parseOpenApiDoc } from "../src/scanner/openapi.js";
import { detectRoutes, normalizePath } from "../src/scanner/routes/index.js";
import { parseToml } from "../src/scanner/toml.js";
import { renderTree } from "../src/scanner/tree.js";
import { sanitizeRemote } from "../src/scanner/git.js";
import { readmeSummary } from "../src/scanner/docs.js";
import { projectName } from "../src/scanner/index.js";

const routes = (files: Record<string, string>) =>
  detectRoutes(new Map(Object.entries(files))).map((e) => `${e.method} ${e.path}`);

describe("normalizePath", () => {
  it.each([
    ["/users/:id", "/users/{id}"],
    ["/users/:id?", "/users/{id}"],
    ["/files/:id(\\d+)", "/files/{id}"],
    ["/items/<int:item_id>", "/items/{item_id}"],
    ["/docs/<path:p>/", "/docs/{p}"],
    ["/blog/[slug]", "/blog/{slug}"],
    ["/shop/[...all]", "/shop/{all}"],
    ["/x/{id:[0-9]+}", "/x/{id}"],
    ["/files/{p:path}", "/files/{p}"],
    ["/static/*filepath", "/static/{filepath}"],
    ["users/", "/users"],
  ])("%s -> %s", (input, out) => {
    expect(normalizePath(input).path).toBe(out);
  });
  it("records integer converters", () => {
    expect(normalizePath("/items/<int:id>").types).toEqual({ id: { type: "integer" } });
  });
});

describe("parseToml", () => {
  it("handles tables, arrays, inline tables and multiline strings", () => {
    const t = parseToml(`
# comment
[project]
name = "demo" # trailing
description = """Multi
line"""
dependencies = [
  "fastapi>=0.1",  # web
  'uvicorn[standard]',
]
[project.scripts]
demo = "demo.cli:main"

[tool.poetry.dependencies]
python = "^3.11"
requests = { version = "^2.31", extras = ["socks"] }

[[bin]]
name = "a"
[[bin]]
name = "b"
`);
    expect(t.project).toMatchObject({ name: "demo", description: "Multi\nline", dependencies: ["fastapi>=0.1", "uvicorn[standard]"] });
    expect((t.project as Record<string, unknown>).scripts).toEqual({ demo: "demo.cli:main" });
    expect(((t.tool as any).poetry.dependencies.requests as any).version).toBe("^2.31");
    expect((t.bin as any[]).map((b) => b.name)).toEqual(["a", "b"]);
  });
  it("never throws on garbage", () => {
    expect(() => parseToml("[[[ nope\n= = =\nkey = \"unterminated\nok = 1")).not.toThrow();
    expect(parseToml("[[[ nope\nok = 1").ok).toBe(1);
  });
});

describe("manifest helpers", () => {
  it("parses PEP 508 and requirements", () => {
    expect(parsePep508("Django[argon2]>=4.2 ; python_version > '3.8'")).toEqual({ name: "django", version: ">=4.2" });
    expect(parseRequirements("-r base.txt\n# c\nflask==3.0.0  # web\n-e git+https://x/y.git#egg=mylib\nrequests\n")).toEqual([
      { name: "flask", version: "==3.0.0" },
      { name: "mylib" },
      { name: "requests" },
    ]);
  });
  it("parses Makefile targets with recipes", () => {
    const s = parseMakefile("VAR := 1\n.PHONY: a\n\na b: deps\n\t@echo hi\n\t-rm -f x\n\nc:\n\t$(MAKE) a\nd: ; echo inline\n%.o: %.c\n\tcc\n", "Makefile");
    expect(s).toEqual([
      { name: "a", command: "echo hi && rm -f x", source: "Makefile" },
      { name: "b", command: "echo hi && rm -f x", source: "Makefile" },
      { name: "c", command: "make c", source: "Makefile" },
      { name: "d", command: "echo inline", source: "Makefile" },
    ]);
  });
  it("parses justfile recipes", () => {
    const s = parseJustfile('set shell := ["bash", "-c"]\nversion := "1"\n\ntest:\n    cargo test\n\ndeploy env:\n    ./deploy.sh {{env}}\n', "justfile");
    expect(s).toEqual([
      { name: "test", command: "cargo test", source: "justfile" },
      { name: "deploy", command: "just deploy", source: "justfile" },
    ]);
  });
});

describe("env helpers", () => {
  it("classifies secrets", () => {
    for (const n of ["API_KEY", "STRIPE_SECRET_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "OPENAI_API_KEY", "SENTRY_DSN"]) expect(isSecretName(n)).toBe(true);
    for (const n of ["DATABASE_URL", "PORT", "NEXT_PUBLIC_STRIPE_KEY", "STRIPE_PUBLISHABLE_KEY", "AWS_ACCESS_KEY_ID", "LOG_LEVEL"]) expect(isSecretName(n)).toBe(false);
  });
  it("parses env files", () => {
    expect(parseEnvFile('export A=1\nB="two words" # c\n# C=3\nD=\n')).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "two words" },
      { name: "D", value: "" },
    ]);
  });
  it("strips credentials from git remotes", () => {
    expect(sanitizeRemote("https://x:tok@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(sanitizeRemote("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
  });
});

describe("OpenAPI", () => {
  it("sniffs spec files", () => {
    expect(looksLikeOpenApi("openapi: 3.1.0\ninfo: {}", ".yaml")).toBe(true);
    expect(looksLikeOpenApi('{\n  "swagger": "2.0",', ".json")).toBe(true);
    expect(looksLikeOpenApi("name: ci\non: push", ".yml")).toBe(false);
  });
  it("parses Swagger 2.0 with basePath, body and formData params", () => {
    const doc = JSON.stringify({
      swagger: "2.0",
      basePath: "/v2",
      paths: {
        "/pet/{petId}": {
          parameters: [{ name: "petId", in: "path", required: true, type: "integer" }],
          get: { operationId: "getPet", summary: "Find pet", tags: ["pet"] },
          delete: { operationId: "deletePet", parameters: [{ name: "api_key", in: "header", type: "string" }] },
          post: {
            operationId: "updatePetWithForm",
            consumes: ["application/x-www-form-urlencoded"],
            parameters: [
              { name: "name", in: "formData", type: "string", required: true },
              { name: "status", in: "formData", type: "string" },
            ],
          },
        },
        "/pet": {
          post: { operationId: "addPet", parameters: [{ in: "body", name: "body", required: true, schema: { $ref: "#/definitions/Pet" } }] },
        },
      },
      definitions: {
        Pet: { type: "object", required: ["name"], properties: { name: { type: "string" }, tags: { type: "array", items: { $ref: "#/definitions/Tag" } } } },
        Tag: { type: "object", properties: { id: { type: "integer" } } },
      },
    });
    const eps = parseOpenApiDoc(doc, "swagger.json");
    expect(eps.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /v2/pet/{petId}", "POST /v2/pet/{petId}", "DELETE /v2/pet/{petId}", "POST /v2/pet"]);
    expect(eps[0]!.params).toEqual([{ name: "petId", in: "path", required: true, schema: { type: "integer" } }]);
    expect(eps[1]!.requestBody).toEqual({ type: "object", properties: { name: { type: "string" }, status: { type: "string" } }, required: ["name"] });
    expect(eps[2]!.params.map((p) => p.in)).toEqual(["path", "header"]);
    expect(eps[3]!.requestBody).toEqual({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, tags: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } } },
    });
  });
  it("handles recursive schemas and server path prefixes", () => {
    const yaml = `openapi: 3.1.0
servers:
  - url: https://api.example.com/v1
paths:
  /nodes:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Node' }
components:
  schemas:
    Node:
      type: object
      properties:
        children: { type: array, items: { $ref: '#/components/schemas/Node' } }
`;
    const [e] = parseOpenApiDoc(yaml, "openapi.yaml");
    expect(e!.path).toBe("/v1/nodes");
    expect((e!.requestBody!.properties!.children as any).items.description).toMatch(/Recursive/);
  });
  it("returns [] for invalid documents", () => {
    expect(parseOpenApiDoc("openapi: [", "x.yaml")).toEqual([]);
  });
});

describe("route detection", () => {
  it("express with nested mounts across files and route() chains", () => {
    const r = routes({
      "src/app.js": `const express = require('express');
const api = require('./api');
const app = express();
app.use('/api', api);
app.get('/', (req, res) => res.send('ok'));`,
      "src/api/index.js": `const { Router } = require('express');
const users = require('./users');
const router = Router();
router.use('/users', users);
module.exports = router;`,
      "src/api/users.js": `const express = require('express');
const router = express.Router();
router.route('/:id')
  .get(show)
  .put(update);
router.delete('/:id', destroy);
// router.post('/commented-out', nope);
axios.get('/not-a-route');
module.exports = router;`,
    });
    expect(r.sort()).toEqual(["DELETE /api/users/{id}", "GET /", "GET /api/users/{id}", "PUT /api/users/{id}"].sort());
  });

  it("fastify, hono and koa", () => {
    expect(
      routes({
        "a.ts": `import Fastify from 'fastify';
const app = Fastify();
app.route({ method: ['GET', 'HEAD'], url: '/things/:id', handler });
app.post<{ Body: X }>('/things', h);
app.register(admin, { prefix: '/admin' });`,
        "b.ts": `import { Hono } from 'hono';
const api = new Hono();
api.get('/ping', (c) => c.text('pong'));
api.patch('/items/:id', h);`,
        "c.ts": `import Router from '@koa/router';
const router = new Router();
router.del('/sessions/:sid', h);`,
      }).sort(),
    ).toEqual(["DELETE /sessions/{sid}", "GET /ping", "GET /things/{id}", "HEAD /things/{id}", "PATCH /items/{id}", "POST /things"].sort());
  });

  it("NestJS controllers with DTO bodies and typed params", () => {
    const eps = detectRoutes(
      new Map([
        [
          "src/users/users.controller.ts",
          `import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CreateUserDto } from './dto';
@Controller('users')
export class UsersController {
  @Get()
  findAll(@Query('role') role?: string) {}

  @Get(':id')
  findOne(@Param('id') id: number) {}

  @Post()
  create(@Body() dto: CreateUserDto) {}

  @Delete(':id')
  async remove(@Param('id') id: string) {}
}`,
        ],
        [
          "src/users/dto.ts",
          `export class CreateUserDto {
  @IsEmail()
  email: string;
  @IsOptional()
  name?: string;
  roles: ('admin' | 'user')[];
}`,
        ],
      ]),
    );
    expect(eps.map((e) => `${e.method} ${e.path} ${e.operationId}`)).toEqual([
      "GET /users findAll",
      "GET /users/{id} findOne",
      "POST /users create",
      "DELETE /users/{id} remove",
    ]);
    expect(eps[0]!.params).toEqual([{ name: "role", in: "query", required: false, schema: { type: "string" } }]);
    expect(eps[1]!.params[0]!.schema).toEqual({ type: "number" });
    expect(eps[2]!.requestBody).toEqual({
      type: "object",
      properties: { email: { type: "string" }, name: { type: "string" }, roles: { type: "array", items: { type: "string", enum: ["admin", "user"] } } },
      required: ["email", "roles"],
    });
  });

  it("Flask blueprints and Django urls + DRF routers", () => {
    expect(
      routes({
        "app/views.py": `from flask import Blueprint
bp = Blueprint("items", __name__, url_prefix="/items")

@bp.route("/", methods=["GET", "POST"])
def items():
    pass

@bp.route("/<int:item_id>", methods=["DELETE"])
def delete_item(item_id):
    pass
`,
      }),
    ).toEqual(["GET /items/", "POST /items/", "DELETE /items/{item_id}"]);

    const dj = detectRoutes(
      new Map([
        ["mysite/urls.py", `from django.urls import include, path\nurlpatterns = [\n    path("api/", include("polls.urls")),\n    path("admin/", admin.site.urls),\n]\n`],
        [
          "polls/urls.py",
          `from rest_framework.routers import DefaultRouter
from . import views
router = DefaultRouter()
router.register(r"questions", views.QuestionViewSet)
urlpatterns = [
    path("", views.index, name="index"),
    path("<int:question_id>/vote/", views.vote, name="vote"),
    path("", include(router.urls)),
]
`,
        ],
      ]),
    );
    const keys = dj.map((e) => `${e.method} ${e.path}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "GET /api/",
        "GET /api/{question_id}/vote/",
        "GET /api/questions/",
        "POST /api/questions/",
        "DELETE /api/questions/{id}/",
      ]),
    );
    expect(dj.find((e) => e.path === "/api/{question_id}/vote/")?.params[0]).toEqual({ name: "question_id", in: "path", required: true, schema: { type: "integer" } });
  });

  it("Rails routes.rb expands resources, namespaces, nesting and members", () => {
    const r = routes({
      "config/routes.rb": `Rails.application.routes.draw do
  root "home#index"
  get "/status", to: "status#show"
  namespace :api do
    resources :users, only: [:index, :show, :destroy] do
      resources :posts, only: %i[index create]
      member do
        post :activate
      end
    end
    resource :profile, only: [:show, :update]
  end
end`,
    });
    expect(r).toEqual([
      "GET /",
      "GET /status",
      "GET /api/users",
      "GET /api/users/{id}",
      "DELETE /api/users/{id}",
      "GET /api/users/{user_id}/posts",
      "POST /api/users/{user_id}/posts",
      "POST /api/users/{id}/activate",
      "GET /api/profile",
      "PATCH /api/profile",
      "PUT /api/profile",
    ]);
  });

  it("Go chi / net/http 1.22 / gorilla mux / echo", () => {
    expect(
      routes({
        "main.go": `package main
import (
  "net/http"
  "github.com/go-chi/chi/v5"
)
func main() {
  r := chi.NewRouter()
  r.Get("/health", health)
  r.Route("/articles", func(r chi.Router) {
    r.Post("/", create)
    r.Delete("/{articleID}", remove)
  })
  mux := http.NewServeMux()
  mux.HandleFunc("GET /users/{id}", getUser)
  mux.HandleFunc("/legacy", legacy)
  resp, _ := http.Get("/not/a/route")
}`,
        "mux.go": `package main
import "github.com/gorilla/mux"
func routes() {
  m := mux.NewRouter()
  m.HandleFunc("/books/{id:[0-9]+}", h).Methods("PUT", "PATCH")
}`,
      }).sort(),
    ).toEqual(["DELETE /articles/{articleID}", "GET /health", "GET /legacy", "GET /users/{id}", "PATCH /books/{id}", "POST /articles", "PUT /books/{id}"].sort());
  });

  it("Laravel, Spring, actix/axum, Sinatra", () => {
    expect(
      routes({
        "routes/api.php": `<?php\nRoute::get('/users/{user}', [UserController::class, 'show']);\nRoute::apiResource('photos', PhotoController::class);\n`,
      }),
    ).toEqual(expect.arrayContaining(["GET /api/users/{user}", "GET /api/photos", "DELETE /api/photos/{photo}"]));
    expect(
      routes({
        "src/main/java/demo/OrderController.java": `@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/{id}")
  public Order get(@PathVariable Long id) { return null; }
  @PostMapping
  public Order create(@RequestBody Order o) { return o; }
}`,
      }),
    ).toEqual(["GET /api/orders/{id}", "POST /api/orders"]);
    expect(
      routes({
        "src/main.rs": `use axum::{routing::{get, post}, Router};
let app = Router::new().route("/users/:id", get(show).delete(remove)).route("/users", post(create));`,
        "src/actix.rs": `use actix_web::{get, web};\n#[get("/hello/{name}")]\nasync fn greet(name: web::Path<String>) -> String { name.to_string() }`,
      }).sort(),
    ).toEqual(["DELETE /users/{id}", "GET /hello/{name}", "GET /users/{id}", "POST /users"].sort());
    expect(routes({ "app.rb": `require 'sinatra'\nget '/hi' do\n  'hi'\nend\ndelete '/items/:id' do\nend\n` })).toEqual(["GET /hi", "DELETE /items/{id}"]);
  });
});

describe("renderTree", () => {
  it("caps entries per directory and total lines", () => {
    const files = Array.from({ length: 500 }, (_, i) => ({ path: `src/m${i}/f.ts`, name: "f.ts", ext: ".ts", size: 1, depth: 2 }));
    const dirs = ["src", ...files.map((f) => f.path.slice(0, f.path.lastIndexOf("/")))];
    const t = renderTree("proj", { files, dirs, truncated: false });
    const lines = t.split("\n");
    expect(lines[0]).toBe("proj/");
    expect(lines.length).toBeLessThanOrEqual(150);
    expect(t).toMatch(/… \d+ more/);
  });
});

describe("project identity (QA regressions)", () => {
  it("replaces generic monorepo root package names with the directory name", () => {
    expect(projectName("@api/source", "/work/conduit")).toBe("conduit");
    expect(projectName("@acme/workspace", "/work/src")).toBe("acme");
    expect(projectName("acme-orders", "/work/x")).toBe("acme-orders");
    expect(projectName(undefined, "/work/tasks-api")).toBe("tasks-api");
  });

  it("summarizes the README intro, skipping feature bullets, blockquote headings and later sections", () => {
    expect(readmeSummary("# App\n\n- ⚡ FastAPI\n- 🧰 SQLModel\n\n## How to use\n\nClick the button.\n")).toBeUndefined();
    expect(readmeSummary("# App\n\n> ### Example Node codebase for [RealWorld](https://x.y).\n")).toBe("Example Node codebase for RealWorld.");
    expect(readmeSummary("# App\n\nInventory service.\n\n- one\n")).toBe("Inventory service.");
  });
});
