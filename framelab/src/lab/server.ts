import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { createJudgeVm, deleteJudgeVm, labConfig, listJudgeVms, publicIp, serialTail, vmName, type JudgeVm, type LabConfig } from "./azure.ts";
import { FAILED_MARK, READY_MARK, judgeCloudInit, sshKeys } from "./cloud-init.ts";
import { limitsFromEnv, readSession, refusal, signSession, type Limits, type Session } from "./policy.ts";
import { recordSession, sessionsOn, type SessionRow } from "./sessions.ts";
import { Tunnel, TunnelError, type AgentData } from "./tunnel.ts";

/**
 * The judge VM lab. A judge connects GitHub, then gets one fresh VM that trusts only the SSH keys
 * on their GitHub account and is deleted after its lifetime. The GitHub token is used once, to read
 * the account, and revoked; it is never stored. Writes need a signed session, a same-origin Origin
 * header and `x-framelab: 1`. /ui/ relays to the FrameLab UI on the signed-in judge's own VM, through
 * the agent that VM connects to /agent with a token only it holds.
 */
const PAGE = path.join(import.meta.dir, "page.html");
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "strict-transport-security": "max-age=31536000" };
const SESSION_COOKIE = "__Host-fl_lab";
const STATE_COOKIE = "__Host-fl_state";
const SESSION_HOURS = 8;
/** What deploy-lab.sh puts in place of the GitHub OAuth app until lab-github.sh sets it. */
export const NOT_CONFIGURED = "not-configured";

export interface LabServerConfig {
  hosts: string[];
  clientId: string;
  clientSecret: string;
  sessionKey: string;
  repo: string;
  ref: string;
  viewerUrl: string;
  limits: Limits;
  azure: LabConfig;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...SECURITY, ...extra } });

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_UI_BODY = 1024 * 1024;

/** A sliding one-minute window per client address. */
function rateLimiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    return recent.length <= perMinute;
  };
}

/** One create or delete at a time, so two clicks cannot both pass the limits. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function cached<T>(ms: number, load: () => Promise<T>) {
  let at = 0;
  let value: Promise<T> | null = null;
  return {
    get: (fresh = false) => {
      if (fresh || !value || Date.now() - at > ms) {
        at = Date.now();
        value = load().catch((e) => {
          at = 0;
          throw e;
        });
      }
      return value;
    },
  };
}

async function githubUser(cfg: LabServerConfig, code: string, redirectUri: string): Promise<{ login: string; id: number; created_at: string }> {
  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri }),
  });
  const t = (await tok.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!t.access_token) throw new HttpError(400, "github", `GitHub sign-in did not complete (${t.error ?? `HTTP ${tok.status}`})`);
  try {
    const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "framelab-lab" } });
    if (!res.ok) throw new HttpError(502, "github", `GitHub did not return the account (HTTP ${res.status})`);
    const u = (await res.json()) as { login: string; id: number; created_at: string };
    return { login: u.login, id: u.id, created_at: u.created_at };
  } finally {
    await fetch(`https://api.github.com/applications/${cfg.clientId}/token`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`, accept: "application/vnd.github+json", "user-agent": "framelab-lab" },
      body: JSON.stringify({ access_token: t.access_token }),
    }).catch(() => {});
  }
}

async function githubKeys(login: string): Promise<string[]> {
  const res = await fetch(`https://github.com/${encodeURIComponent(login)}.keys`, { headers: { "user-agent": "framelab-lab" } });
  if (!res.ok) throw new HttpError(502, "github", `could not read the SSH keys on GitHub (HTTP ${res.status})`);
  return sshKeys(await res.text());
}

export function serveLab(port: number, cfg: LabServerConfig) {
  const allowed = new Set(cfg.hosts);
  const canonical = cfg.hosts[0];
  const redirectUri = `https://${canonical}/auth/callback`;
  const signInReady = cfg.clientId !== NOT_CONFIGURED && cfg.clientSecret !== NOT_CONFIGURED;
  const general = rateLimiter(120);
  const creates = rateLimiter(4);
  // The FrameLab UI polls every second while a run is going.
  const uiCalls = rateLimiter(600);
  const tunnel = new Tunnel();
  const exclusive = serial();
  const vms = cached(10_000, () => listJudgeVms(cfg.azure));
  const today = cached(30_000, () => sessionsOn(new Date()));
  const setup = new Map<string, { at: number; state: string }>();

  async function setupState(vm: JudgeVm): Promise<string> {
    if (vm.state === "Creating") return "creating";
    if (vm.state === "Failed") return "failed";
    if (vm.state === "Deleting") return "deleting";
    const hit = setup.get(vm.name);
    if (hit && (hit.state !== "setting-up" || Date.now() - hit.at < 15_000)) return hit.state;
    const lines = (await serialTail(cfg.azure, vm.name).catch(() => "")).split(/\r?\n/).map((l) => l.trim());
    const state = lines.includes(READY_MARK) ? "ready" : lines.includes(FAILED_MARK) ? "failed" : "setting-up";
    setup.set(vm.name, { at: Date.now(), state });
    return state;
  }

  async function me(s: Session | null) {
    const list = await vms.get();
    const live = list.filter((v) => v.state !== "Deleting");
    const base = {
      viewer: cfg.viewerUrl,
      signInReady,
      limits: { maxVms: cfg.limits.maxVms, lifetimeMinutes: cfg.limits.lifetimeMinutes, perAccountPerDay: cfg.limits.perAccountPerDay, minAccountDays: cfg.limits.minAccountDays },
      capacity: { running: live.length, max: cfg.limits.maxVms },
    };
    if (!s) return { ...base, signedIn: false };
    const mine = list.find((v) => v.githubId === String(s.id));
    const vm = mine
      ? { name: mine.name, state: await setupState(mine), ip: await publicIp(cfg.azure, mine.name), expiresAt: mine.expiresAt, createdAt: mine.createdAt, ui: tunnel.connected(mine.name) }
      : null;
    const why = mine ? null : refusal({ githubId: s.id, accountCreatedAt: s.createdAt, now: new Date(), vms: list, today: await today.get(), limits: cfg.limits });
    return { ...base, signedIn: true, login: s.login, vm, refusal: why };
  }

  async function startVm(s: Session) {
    return exclusive(async () => {
      const list = await vms.get(true);
      const rows: SessionRow[] = await today.get(true);
      const why = refusal({ githubId: s.id, accountCreatedAt: s.createdAt, now: new Date(), vms: list, today: rows, limits: cfg.limits });
      if (why) throw new HttpError(409, why.code, why.message);
      const keys = await githubKeys(s.login);
      if (!keys.length) throw new HttpError(422, "no-keys", "Your GitHub account has no SSH keys. Add one at github.com/settings/keys, then try again.");
      const name = vmName(s.login);
      const expiresAt = new Date(Date.now() + cfg.limits.lifetimeMinutes * 60_000);
      const token = randomBytes(32).toString("base64url");
      const agent = { url: `wss://${canonical}/agent`, token, vm: name };
      const customData = judgeCloudInit({ keys, expiresAt, repo: cfg.repo, ref: cfg.ref, agent });
      const { ip } = await createJudgeVm(cfg.azure, { name, login: s.login, githubId: s.id, customData, expiresAt, agentHash: sha256(token) });
      console.log(`lab: started ${name} for ${s.login} (${keys.length} key(s)), expires ${expiresAt.toISOString()}`);
      await recordSession({ vm: name, login: s.login, githubId: s.id, createdAt: new Date().toISOString() }).catch((e) => console.error(`lab: session not recorded: ${e.message}`));
      await vms.get(true);
      await today.get(true);
      return { name, ip, expiresAt: expiresAt.toISOString() };
    });
  }

  async function endVm(s: Session) {
    return exclusive(async () => {
      const mine = (await vms.get(true)).find((v) => v.githubId === String(s.id));
      if (!mine) throw new HttpError(404, "no-vm", "You have no VM.");
      await deleteJudgeVm(cfg.azure, mine.name);
      tunnel.drop(mine.name);
      console.log(`lab: ${s.login} deleted ${mine.name}`);
      await vms.get(true);
    });
  }

  const toLab = () => new Response(null, { status: 302, headers: { location: "/", ...SECURITY } });

  /** /ui/<path> on the lab is <path> on the FrameLab UI of the signed-in judge's own VM. */
  async function relay(req: Request, url: URL, s: Session | null): Promise<Response> {
    if (!s) return req.method === "GET" ? toLab() : json({ error: "Connect GitHub first." }, 401);
    const write = req.method !== "GET" && req.method !== "HEAD";
    if (write && (req.headers.get("origin") !== `https://${req.headers.get("host")}` || req.headers.get("x-framelab") !== "1")) {
      return json({ error: "cross-site request refused" }, 403);
    }
    if (!uiCalls(String(s.id))) return json({ error: "too many requests" }, 429, { "retry-after": "10" });
    const mine = (await vms.get()).find((v) => v.githubId === String(s.id));
    if (!mine || !tunnel.connected(mine.name)) {
      return url.pathname === "/ui/" && req.method === "GET" ? toLab() : json({ error: "Your VM's FrameLab UI is not connected yet." }, 503);
    }
    const body = write ? new Uint8Array(await req.arrayBuffer()) : undefined;
    if (body && body.length > MAX_UI_BODY) return json({ error: "request too large" }, 413);
    try {
      const res = await tunnel.request(mine.name, { method: req.method, path: url.pathname.slice(3) + url.search, headers: req.headers, body });
      for (const [k, v] of Object.entries(SECURITY)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (e instanceof TunnelError) return json({ error: e.message }, e.status);
      throw e;
    }
  }

  const server = Bun.serve<AgentData>({
    hostname: "0.0.0.0",
    port,
    websocket: {
      idleTimeout: 60,
      sendPings: true,
      maxPayloadLength: 1024 * 1024,
      open: (ws) => tunnel.open(ws),
      message: (ws, m) => tunnel.message(ws, m),
      close: (ws, code) => {
        tunnel.close(ws);
        console.log(`lab: relay down for ${ws.data.vm} (${code})`);
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok");
      const host = req.headers.get("host") ?? "";
      if (!allowed.has(host)) return new Response("forbidden host", { status: 403 });
      if (host !== canonical && req.method === "GET" && (url.pathname === "/" || url.pathname === "/auth/login")) {
        return new Response(null, { status: 302, headers: { location: `https://${canonical}${url.pathname}`, ...SECURITY } });
      }
      const session = readSession(readCookie(req, SESSION_COOKIE), cfg.sessionKey);
      if (url.pathname === "/ui") return new Response(null, { status: 302, headers: { location: "/ui/", ...SECURITY } });
      if (url.pathname.startsWith("/ui/")) {
        return relay(req, url, session).catch((err) => {
          console.error(`lab: relay ${req.method} ${url.pathname}: ${(err as Error).message}`);
          return json({ error: "Something went wrong on our side. Try again in a minute.", code: "internal" }, 500);
        });
      }
      // The ingress appends the real client address; anything before it came from the client.
      const client = (req.headers.get("x-forwarded-for") ?? srv.requestIP(req)?.address ?? "?").split(",").at(-1)!.trim();
      if (!general(client)) return json({ error: "too many requests" }, 429, { "retry-after": "60" });
      try {
        if (url.pathname === "/agent") {
          const name = req.headers.get("x-framelab-vm") ?? "";
          const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
          if (!/^judge-[a-z0-9-]{1,60}$/.test(name) || !/^[A-Za-z0-9_-]{43}$/.test(presented)) return new Response("unauthorized", { status: 401 });
          const vm = (await vms.get()).find((v) => v.name === name);
          if (!vm || !vm.agentHash || vm.state === "Deleting" || !same(sha256(presented), vm.agentHash)) return new Response("unauthorized", { status: 401 });
          if (srv.upgrade(req, { data: { vm: name } })) {
            console.log(`lab: relay up for ${name}`);
            return undefined;
          }
          return new Response("expected a WebSocket upgrade", { status: 426 });
        }
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          return new Response(Bun.file(PAGE), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SECURITY } });
        }
        if (req.method === "GET" && url.pathname === "/auth/login") {
          if (!signInReady) return new Response(null, { status: 302, headers: { location: "/?error=unconfigured", ...SECURITY } });
          const state = randomBytes(18).toString("base64url");
          const to = new URL("https://github.com/login/oauth/authorize");
          to.searchParams.set("client_id", cfg.clientId);
          to.searchParams.set("redirect_uri", redirectUri);
          to.searchParams.set("state", state);
          to.searchParams.set("scope", "");
          return new Response(null, { status: 302, headers: { location: to.toString(), "set-cookie": cookie(STATE_COOKIE, state, 600), ...SECURITY } });
        }
        if (req.method === "GET" && url.pathname === "/auth/callback") {
          const want = readCookie(req, STATE_COOKIE) ?? "";
          const got = url.searchParams.get("state") ?? "";
          const code = url.searchParams.get("code") ?? "";
          const back = (why: string) => new Response(null, { status: 302, headers: { location: `/?error=${why}`, "set-cookie": cookie(STATE_COOKIE, "", 0), ...SECURITY } });
          if (!want || !same(want, got) || !code) return back("state");
          const u = await githubUser(cfg, code, redirectUri).catch((e) => {
            console.error(`lab: sign-in failed: ${(e as Error).message}`);
            return null;
          });
          if (!u) return back("github");
          const s: Session = { login: u.login, id: u.id, createdAt: u.created_at, exp: Date.now() + SESSION_HOURS * 3_600_000 };
          console.log(`lab: ${u.login} signed in`);
          const headers = new Headers({ location: "/", ...SECURITY });
          headers.append("set-cookie", cookie(SESSION_COOKIE, signSession(s, cfg.sessionKey), SESSION_HOURS * 3600));
          headers.append("set-cookie", cookie(STATE_COOKIE, "", 0));
          return new Response(null, { status: 302, headers });
        }
        if (req.method === "GET" && url.pathname === "/api/me") return json(await me(session));

        if (req.method !== "POST") return new Response("not found", { status: 404, headers: SECURITY });
        if (req.headers.get("origin") !== `https://${req.headers.get("host")}` || req.headers.get("x-framelab") !== "1") {
          throw new HttpError(403, "origin", "cross-site request refused");
        }
        if (url.pathname === "/auth/logout") return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
        if (!session) throw new HttpError(401, "signed-out", "Connect GitHub first.");
        if (url.pathname === "/api/vm") {
          if (!creates(client)) throw new HttpError(429, "slow-down", "Too many attempts; wait a minute.");
          return json(await startVm(session), 201);
        }
        if (url.pathname === "/api/vm/delete") {
          await endVm(session);
          return json({ ok: true });
        }
        return new Response("not found", { status: 404, headers: SECURITY });
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
        console.error(`lab: ${req.method} ${url.pathname}: ${(err as Error).message}`);
        return json({ error: "Something went wrong on our side. Try again in a minute.", code: "internal" }, 500);
      }
    },
  });
  console.log(`FrameLab lab on port ${server.port}, answering ${[...allowed].join(", ")}`);
  return server;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: "string", default: "8080" } } });
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) {
      console.error(`${k} is required`);
      process.exit(2);
    }
    return v;
  };
  const sessionKey = need("SESSION_KEY");
  if (sessionKey.length < 32) {
    console.error("SESSION_KEY must be at least 32 characters");
    process.exit(2);
  }
  serveLab(Number(values.port), {
    hosts: need("LAB_PUBLIC_HOSTS").split(",").map((h) => h.trim()).filter(Boolean),
    clientId: need("GITHUB_CLIENT_ID"),
    clientSecret: need("GITHUB_CLIENT_SECRET"),
    sessionKey,
    repo: process.env.LAB_REPO ?? "https://github.com/batmnnn/batcorp.git",
    ref: process.env.LAB_REF ?? "main",
    viewerUrl: process.env.VIEWER_URL ?? "https://batcorps.batmnnn.live/",
    limits: limitsFromEnv(),
    azure: labConfig(),
  });
}
