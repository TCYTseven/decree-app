import type { DependencyInfo } from "../core/types.js";
import type { ScanContext } from "./context.js";

/** Ordered: backend/meta frameworks first, UI libraries later. */
const DEP_RULES: [framework: string, test: (name: string, eco: DependencyInfo["ecosystem"]) => boolean][] = [
  ["nestjs", (n, e) => e === "npm" && n === "@nestjs/core"],
  ["nextjs", (n, e) => e === "npm" && n === "next"],
  ["remix", (n, e) => e === "npm" && (n === "@remix-run/node" || n === "@remix-run/react" || n === "@remix-run/serve")],
  ["sveltekit", (n, e) => e === "npm" && n === "@sveltejs/kit"],
  ["nuxt", (n, e) => e === "npm" && n === "nuxt"],
  ["astro", (n, e) => e === "npm" && n === "astro"],
  ["express", (n, e) => e === "npm" && n === "express"],
  ["fastify", (n, e) => e === "npm" && n === "fastify"],
  ["hono", (n, e) => e === "npm" && n === "hono"],
  ["koa", (n, e) => e === "npm" && (n === "koa" || n === "@koa/router" || n === "koa-router")],
  ["fastapi", (n, e) => e === "pypi" && n === "fastapi"],
  ["django", (n, e) => e === "pypi" && (n === "django" || n === "djangorestframework")],
  ["flask", (n, e) => e === "pypi" && n === "flask"],
  ["starlette", (n, e) => e === "pypi" && n === "starlette"],
  ["rails", (n, e) => e === "rubygems" && (n === "rails" || n === "railties")],
  ["sinatra", (n, e) => e === "rubygems" && n === "sinatra"],
  ["gin", (n, e) => e === "go" && n === "github.com/gin-gonic/gin"],
  ["echo", (n, e) => e === "go" && /^github\.com\/labstack\/echo(\/v\d+)?$/.test(n)],
  ["fiber", (n, e) => e === "go" && /^github\.com\/gofiber\/fiber(\/v\d+)?$/.test(n)],
  ["chi", (n, e) => e === "go" && /^github\.com\/go-chi\/chi(\/v\d+)?$/.test(n)],
  ["actix", (n, e) => e === "cargo" && n === "actix-web"],
  ["axum", (n, e) => e === "cargo" && n === "axum"],
  ["laravel", (n, e) => e === "composer" && n === "laravel/framework"],
  ["spring", (n, e) => e === "maven" && n.includes("spring-boot")],
  ["trpc", (n, e) => e === "npm" && n.startsWith("@trpc/")],
  [
    "graphql",
    (n, e) =>
      (e === "npm" && ["graphql", "@apollo/server", "apollo-server", "apollo-server-express", "graphql-yoga", "@nestjs/graphql", "type-graphql", "mercurius"].includes(n)) ||
      (e === "pypi" && ["graphene", "strawberry-graphql", "ariadne", "graphene-django"].includes(n)) ||
      (e === "go" && (n === "github.com/99designs/gqlgen" || n === "github.com/graphql-go/graphql")) ||
      (e === "rubygems" && n === "graphql") ||
      (e === "cargo" && (n === "async-graphql" || n === "juniper")),
  ],
  ["angular", (n, e) => e === "npm" && n === "@angular/core"],
  ["react", (n, e) => e === "npm" && n === "react"],
  ["vue", (n, e) => e === "npm" && n === "vue"],
  ["svelte", (n, e) => e === "npm" && n === "svelte"],
];

const FILE_RULES: [framework: string, files: string[]][] = [
  ["nextjs", ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]],
  ["nestjs", ["nest-cli.json"]],
  ["nuxt", ["nuxt.config.ts", "nuxt.config.js"]],
  ["sveltekit", ["svelte.config.js"]],
  ["remix", ["remix.config.js"]],
  ["astro", ["astro.config.mjs", "astro.config.ts"]],
  ["django", ["manage.py"]],
  ["rails", ["config/routes.rb", "bin/rails"]],
  ["laravel", ["artisan"]],
  ["angular", ["angular.json"]],
];

export function detectFrameworks(deps: DependencyInfo[], ctx: ScanContext, hints: Set<string>): string[] {
  const found = new Set<string>();
  for (const [fw, test] of DEP_RULES) if (deps.some((d) => test(d.name, d.ecosystem))) found.add(fw);
  for (const [fw, files] of FILE_RULES) if (files.some((f) => ctx.has(f))) found.add(fw);
  if (hints.has("spring")) found.add("spring");
  // sveltekit's svelte.config.js exists in plain svelte apps too; require the kit dep or routes dir.
  if (found.has("sveltekit") && !deps.some((d) => d.name === "@sveltejs/kit") && !ctx.files.some((f) => f.path.startsWith("src/routes/")))
    found.delete("sveltekit");
  const order = [...DEP_RULES.map(([f]) => f)];
  return [...found].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
