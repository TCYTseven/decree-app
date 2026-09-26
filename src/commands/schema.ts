import { specJsonSchema } from "../core/spec.js";

export async function schemaCommand(): Promise<void> {
  process.stdout.write(`${JSON.stringify(specJsonSchema(), null, 2)}\n`);
}
