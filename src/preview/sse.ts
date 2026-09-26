import type { ServerResponse } from "node:http";

/** Format one Server-Sent Event. Multi-line data is split into several `data:` lines per the spec. */
export function formatSSE(event: string, data: unknown, id?: string | number): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  let out = "";
  if (id !== undefined) out += `id: ${String(id).replace(/[\r\n]/g, "")}\n`;
  out += `event: ${event.replace(/[\r\n]/g, "")}\n`;
  for (const line of (payload ?? "null").split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** Parse an SSE byte stream back into events (used by tests and mirrors the browser client). */
export function parseSSE(text: string): { event: string; data: string; id?: string }[] {
  const events: { event: string; data: string; id?: string }[] = [];
  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length || event !== "message") events.push({ event, data: data.join("\n"), id });
  }
  return events;
}

/** A single SSE response with heartbeats; `closed` flips when the client goes away. */
export class SSEStream {
  closed = false;
  private seq = 0;
  private heartbeat?: NodeJS.Timeout;
  private closeHandlers: (() => void)[] = [];

  constructor(
    private res: ServerResponse,
    opts: { heartbeatMs?: number } = {},
  ) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    res.write(": decree preview stream\n\n");
    const hb = opts.heartbeatMs ?? 15000;
    if (hb > 0) {
      this.heartbeat = setInterval(() => this.comment("ping"), hb);
      this.heartbeat.unref?.();
    }
    res.on("close", () => this.markClosed());
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const fn of this.closeHandlers.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.res.write(formatSSE(event, data, ++this.seq));
  }

  comment(text: string): void {
    if (!this.closed) this.res.write(`: ${text.replace(/[\r\n]/g, " ")}\n\n`);
  }

  end(): void {
    if (!this.closed) this.res.end();
    this.markClosed();
  }
}
