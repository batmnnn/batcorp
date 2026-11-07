import type { FromAgent, ToAgent } from "./tunnel.ts";

/**
 * Runs on a judge VM as the framelab-agent service, copied there by cloud-init. It dials out to
 * the lab and relays the requests the lab sends, which come only from the VM's owner, to the
 * FrameLab UI on this VM. It reaches that one local address and nothing else.
 */
const CHUNK = 256 * 1024;
// Bun's client accepts request headers; the DOM typing of WebSocket does not know that.
const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

export function runAgent(o: { url: string; token: string; vm: string; ui: string; log?: (line: string) => void }): { stop(): void } {
  const ui = new URL(o.ui);
  const inflight = new Map<number, AbortController>();
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;

  const send = (m: FromAgent) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  async function relay(r: Extract<ToAgent, { t: "req" }>) {
    const ac = new AbortController();
    inflight.set(r.id, ac);
    try {
      const target = new URL(r.path, ui);
      if (target.origin !== ui.origin || !r.path.startsWith("/")) throw new Error("refused path");
      const res = await fetch(target, {
        method: r.method,
        headers: r.headers,
        body: r.body ? Buffer.from(r.body, "base64") : undefined,
        redirect: "manual",
        signal: ac.signal,
      });
      send({ t: "res", id: r.id, status: res.status, headers: Object.fromEntries(res.headers) });
      const reader = res.body?.getReader();
      for (;;) {
        const part = await reader?.read();
        if (!part || part.done) break;
        for (let i = 0; i < part.value.length; i += CHUNK) send({ t: "chunk", id: r.id, data: Buffer.from(part.value.subarray(i, i + CHUNK)).toString("base64") });
      }
      send({ t: "end", id: r.id });
    } catch (e) {
      if (!ac.signal.aborted) send({ t: "error", id: r.id, message: (e as Error).message });
    } finally {
      inflight.delete(r.id);
    }
  }

  function connect() {
    if (stopped) return;
    const sock = new BunWebSocket(o.url, { headers: { authorization: `Bearer ${o.token}`, "x-framelab-vm": o.vm } });
    ws = sock;
    sock.onopen = () => {
      delay = 1000;
      o.log?.(`agent: connected to ${o.url}`);
    };
    sock.onmessage = (ev) => {
      let m: ToAgent;
      try {
        m = JSON.parse(String(ev.data)) as ToAgent;
      } catch {
        return;
      }
      if (m.t === "req") void relay(m);
      else if (m.t === "cancel") inflight.get(m.id)?.abort();
    };
    sock.onclose = (ev) => {
      for (const ac of inflight.values()) ac.abort();
      inflight.clear();
      if (stopped) return;
      o.log?.(`agent: disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); retrying in ${delay / 1000} s`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  }

  connect();
  return {
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}

if (import.meta.main) {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) {
      console.error(`${k} is required`);
      process.exit(2);
    }
    return v;
  };
  runAgent({ url: need("LAB_AGENT_URL"), token: need("LAB_AGENT_TOKEN"), vm: need("LAB_VM_NAME"), ui: process.env.LAB_UI_URL ?? "http://127.0.0.1:4173", log: console.log });
}
