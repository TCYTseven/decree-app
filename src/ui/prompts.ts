import * as p from "@clack/prompts";

/** Thrown when the user cancels a prompt (Ctrl+C / Esc). */
export class CancelledError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

function unwrap<T>(v: T | symbol): T {
  if (p.isCancel(v) || typeof v === "symbol") throw new CancelledError();
  return v as T;
}

export async function askText(opts: p.TextOptions): Promise<string> {
  return unwrap<string>(await p.text(opts));
}

export async function askConfirm(opts: p.ConfirmOptions): Promise<boolean> {
  return unwrap<boolean>(await p.confirm(opts));
}

export async function askSelect<T>(opts: p.SelectOptions<T>): Promise<T> {
  return unwrap<T>((await p.select<T>(opts)) as T | symbol);
}

export async function askMultiselect<T>(opts: p.MultiSelectOptions<T>): Promise<T[]> {
  return unwrap<T[]>(await p.multiselect<T>(opts));
}
