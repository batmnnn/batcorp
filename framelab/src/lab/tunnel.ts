import type { ServerWebSocket } from "bun";

/**
 * The lab's end of the relay to each judge VM's FrameLab UI. The VM accepts nothing but SSH, so
 * its agent dials out to the lab over a WebSocket and the lab hands it the owner's /ui/ requests.
 * Only a few headers cross in either direction; cookies never do. Bodies travel as base64 chunks.
 */
export type ToAgent =
  | { t: "req"; id: number; method: string; path: string; headers: Record<string, string>; body?: string }
  | { t: "cancel"; id: number };
export type FromAgent =
  | { t: "res"; id: number; status: number; headers: Record<string, string> }
  | { t: "chunk"; id: number; data: string }
  | { t: "end"; id: number }
  | { t: "error"; id: number; message: string };

export interface AgentData {
  vm: string;
}

export const REQUEST_HEADERS = ["accept", "content-type", "x-framelab"];
export const RESPONSE_HEADERS = ["content-type", "content-disposition", "cache-control"];
const MAX_PENDING = 32;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const QUIET_MS = 120_000;

export class TunnelError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Pending {
  ws: ServerWebSocket<AgentData>;
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  ctrl?: ReadableStreamDefaultController<Uint8Array>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

const NO_BODY = new Set([204, 205, 304]);

export class Tunnel {
  private agents = new Map<string, ServerWebSocket<AgentData>>();
  private pending = new Map<number, Pending>();
  private nextId = 1;

  connected(vm: string): boolean {
    return this.agents.has(vm);
  }

  open(ws: ServerWebSocket<AgentData>): void {
    const old = this.agents.get(ws.data.vm);
    this.agents.set(ws.data.vm, ws);
    if (old && old !== ws) old.close(4000, "replaced by a newer connection");
  }

  close(ws: ServerWebSocket<AgentData>): void {
    if (this.agents.get(ws.data.vm) === ws) this.agents.delete(ws.data.vm);
    for (const [id, p] of this.pending) if (p.ws === ws) this.fail(id, new TunnelError(502, "the VM's relay disconnected"));
  }

  /** Disconnects a VM's agent, for a VM that is being deleted. */
  drop(vm: string): void {
    this.agents.get(vm)?.close(4001, "VM deleted");
  }

  message(ws: ServerWebSocket<AgentData>, raw: string | Buffer): void {
    let f: FromAgent;
    try {
      f = JSON.parse(String(raw)) as FromAgent;
    } catch {
      return;
    }
    const p = this.pending.get(f.id);
    if (!p || p.ws !== ws) return;
    this.quiet(f.id, p);
    if (f.t === "res" && !p.ctrl) {
      const headers = new Headers();
      for (const k of RESPONSE_HEADERS) if (typeof f.headers?.[k] === "string") headers.set(k, f.headers[k]!);
      const status = Number.isInteger(f.status) && f.status >= 200 && f.status <= 599 ? f.status : 502;
      if (NO_BODY.has(status)) {
        this.forget(f.id);
        p.resolve(new Response(null, { status, headers }));
        return;
      }
      const id = f.id;
      const body = new ReadableStream<Uint8Array>({
        start: (ctrl) => {
          p.ctrl = ctrl;
        },
        cancel: () => {
          this.forget(id);
          this.send(ws, { t: "cancel", id });
        },
      });
      p.resolve(new Response(body, { status, headers }));
    } else if (f.t === "chunk" && p.ctrl && typeof f.data === "string") {
      const bytes = Buffer.from(f.data, "base64");
      p.bytes += bytes.length;
      if (p.bytes > MAX_RESPONSE_BYTES) return this.fail(f.id, new TunnelError(502, "response too large"));
      p.ctrl.enqueue(bytes);
    } else if (f.t === "end" && p.ctrl) {
      this.forget(f.id);
      p.ctrl.close();
    } else if (f.t === "error") {
      this.fail(f.id, new TunnelError(502, `the VM could not answer: ${String(f.message).slice(0, 200)}`));
    }
  }

  request(vm: string, r: { method: string; path: string; headers: Headers; body?: Uint8Array }): Promise<Response> {
    const ws = this.agents.get(vm);
    if (!ws) return Promise.reject(new TunnelError(503, "Your VM's FrameLab UI is not connected yet."));
    let mine = 0;
    for (const p of this.pending.values()) if (p.ws === ws) mine++;
    if (mine >= MAX_PENDING) return Promise.reject(new TunnelError(503, "Too many requests to your VM at once."));
    const id = this.nextId++;
    const headers: Record<string, string> = {};
    for (const k of REQUEST_HEADERS) {
      const v = r.headers.get(k);
      if (v !== null) headers[k] = v;
    }
    return new Promise<Response>((resolve, reject) => {
      const p: Pending = { ws, resolve, reject, bytes: 0 };
      this.pending.set(id, p);
      this.quiet(id, p);
      this.send(ws, { t: "req", id, method: r.method, path: r.path, headers, body: r.body?.length ? Buffer.from(r.body).toString("base64") : undefined });
    });
  }

  private send(ws: ServerWebSocket<AgentData>, m: ToAgent): void {
    ws.send(JSON.stringify(m));
  }

  private quiet(id: number, p: Pending): void {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      this.fail(id, new TunnelError(504, "your VM stopped answering"));
      this.send(p.ws, { t: "cancel", id });
    }, QUIET_MS);
  }

  private forget(id: number): void {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private fail(id: number, err: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.forget(id);
    if (!p.ctrl) return p.reject(err);
    try {
      p.ctrl.error(err);
    } catch {}
  }
}
