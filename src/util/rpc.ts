export interface RpcRecord {
  at: number;
  ms: number;
  url: string;
  method: string;
  params: unknown[];
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export type RpcSink = (record: RpcRecord) => void;

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown
  ) {
    super(`${method}: ${message}`);
  }
}

export class RpcTransportError extends Error {}

export interface RpcClientOptions {
  headers?: () => Record<string, string>;
  timeoutMs?: number;
  sink?: RpcSink;
}

export class RpcClient {
  private id = 0;

  constructor(
    readonly url: string,
    private opts: RpcClientOptions = {}
  ) {}

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const started = Date.now();
    const record: RpcRecord = { at: started, ms: 0, url: this.url, method, params };
    let body: { result?: T; error?: { code?: number; message: string; data?: unknown } };
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.headers?.() ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        throw new RpcTransportError(`${method}: HTTP ${res.status} non-JSON body: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      record.ms = Date.now() - started;
      record.error = { message: (err as Error).message };
      this.opts.sink?.(record);
      if (err instanceof RpcTransportError) throw err;
      throw new RpcTransportError(`${method}: ${(err as Error).message}`);
    }
    record.ms = Date.now() - started;
    if (body.error) {
      record.error = body.error;
      this.opts.sink?.(record);
      throw new RpcError(method, body.error.code, body.error.message, body.error.data);
    }
    record.result = body.result;
    this.opts.sink?.(record);
    return body.result as T;
  }
}
