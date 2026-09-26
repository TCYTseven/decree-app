import type { LLM } from "../core/types.js";

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set. Export it, add it to .env, or pass --offline.");
    this.name = "MissingApiKeyError";
  }
}

/** Resolve the Anthropic API key from explicit option, env, or a .env file in cwd. */
export function resolveApiKey(explicit?: string): string | undefined {
  throw new Error("resolveApiKey: not implemented");
}

export function createLLM(opts: { apiKey?: string; model?: string } = {}): LLM {
  throw new Error("createLLM: not implemented");
}
