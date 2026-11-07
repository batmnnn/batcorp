import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runAgent } from "../src/lab/agent.ts";
import type { JudgeVm, LabConfig } from "../src/lab/azure.ts";
import { unusableRsaKey, vmName } from "../src/lab/azure.ts";
import { FAILED_MARK, READY_MARK, judgeCloudInit, sshKeys } from "../src/lab/cloud-init.ts";
import { limitsFromEnv, readSession, refusal, signSession, type Session } from "../src/lab/policy.ts";
import { expired, owner } from "../src/lab/reap.ts";
import { NOT_CONFIGURED, serveLab } from "../src/lab/server.ts";
import type { SessionRow } from "../src/lab/sessions.ts";
import { Tunnel, type AgentData } from "../src/lab/tunnel.ts";

const ED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0yW3Qkq4oF0xRr2Wl1t5eJpL6iN0d3o2u7x1n7Zk";
const limits = limitsFromEnv({});
const now = new Date("2026-11-06T12:00:00Z");
const old = "2020-01-01T00:00:00Z";
const vm = (githubId: string, over: Partial<JudgeVm> = {}): JudgeVm => ({
  name: `judge-x-${githubId}`,
  login: `u${githubId}`,
  githubId,
  createdAt: "2026-11-06T11:00:00Z",
  expiresAt: "2026-11-06T14:00:00Z",
  state: "Succeeded",
  agentHash: "",
  ...over,
});
const relay = { url: "wss://lab.example.test/agent", token: "t".repeat(43), vm: "judge-x-1" };
const row = (githubId: number): SessionRow => ({ vm: "judge-x", login: `u${githubId}`, githubId, createdAt: "2026-11-06T09:00:00Z" });
const ask = (o: Partial<Parameters<typeof refusal>[0]> = {}) =>
  refusal({ githubId: 7, accountCreatedAt: old, now, vms: [], today: [], limits, ...o });

test("defaults: 3 VMs, 2 per account and 12 in all per day, 30-day accounts, 3 hours", () => {
  expect(limits).toEqual({ maxVms: 3, perAccountPerDay: 2, perDay: 12, minAccountDays: 30, lifetimeMinutes: 180 });
  expect(limitsFromEnv({ LAB_MAX_VMS: "nope", LAB_PER_DAY: "-1" })).toMatchObject({ maxVms: 3, perDay: 12 });
});

test("an old enough account with no VM, room and quota left gets one", () => {
  expect(ask()).toBeNull();
  expect(ask({ vms: [vm("1"), vm("2")], today: [row(1), row(2), row(7)] })).toBeNull();
});

test("each limit refuses with its own reason", () => {
  expect(ask({ accountCreatedAt: "2026-10-20T00:00:00Z" })?.code).toBe("account-too-new");
  expect(ask({ accountCreatedAt: "not a date" })?.code).toBe("account-too-new");
  expect(ask({ vms: [vm("7")] })?.code).toBe("has-vm");
  const full = ask({ vms: [vm("1"), vm("2", { expiresAt: "2026-11-06T13:05:00Z" }), vm("3")] });
  expect(full?.code).toBe("full");
  expect(full?.message).toContain("13:05 UTC");
  expect(ask({ today: [row(7), row(7)] })?.code).toBe("account-daily");
  expect(ask({ today: Array.from({ length: 12 }, (_, i) => row(100 + i)) })?.code).toBe("daily");
});

test("VMs being deleted free their slot and do not count as the account's VM", () => {
  const deleting = { state: "Deleting" };
  expect(ask({ vms: [vm("7", deleting)] })).toBeNull();
  expect(ask({ vms: [vm("1"), vm("2"), vm("3", deleting)] })).toBeNull();
});

test("sessions round-trip and refuse tampering, another key and expiry", () => {
  const key = "k".repeat(40);
  const s: Session = { login: "judge", id: 42, createdAt: old, exp: Date.now() + 60_000 };
  const cookie = signSession(s, key);
  expect(readSession(cookie, key)).toEqual(s);
  expect(readSession(cookie, "j".repeat(40))).toBeNull();
  const [body, sig] = cookie.split(".");
  const forged = Buffer.from(JSON.stringify({ ...s, id: 1 })).toString("base64url");
  expect(readSession(`${forged}.${sig}`, key)).toBeNull();
  expect(readSession(`${body}.${sig}x`, key)).toBeNull();
  expect(readSession(cookie, key, s.exp + 1)).toBeNull();
  expect(readSession(undefined, key)).toBeNull();
  expect(readSession("garbage", key)).toBeNull();
});

test("only bare SSH public keys from <login>.keys are used, at most 10", () => {
  const text = [ED, `${ED} laptop`, "", "not a key", "ssh-ed25519 AAAA$(reboot)", "ssh-dss AAAAB3NzaC1kc3M=", ...Array(12).fill(ED)].join("\n");
  const keys = sshKeys(text);
  expect(keys.length).toBe(10);
  expect(keys.every((k) => k === ED)).toBe(true);
  expect(sshKeys("")).toEqual([]);
});

test("cloud-init is valid YAML that installs the judge's keys, the UI and its relay, and reports on the serial console", async () => {
  const expiresAt = new Date(Date.now() + 180 * 60_000);
  const text = judgeCloudInit({ keys: [ED], expiresAt, repo: "https://github.com/batmnnn/batcorp.git", ref: "main", agent: relay });
  expect(text.startsWith("#cloud-config\n")).toBe(true);
  const doc = Bun.YAML.parse(text) as { write_files: Array<{ path: string; content: string; permissions: string; append?: boolean; defer?: boolean }>; runcmd: unknown[][] };
  const files = Object.fromEntries(doc.write_files.map((f) => [f.path, f]));
  expect(files["/home/judge/.ssh/authorized_keys"]).toMatchObject({ content: `${ED}\n`, append: true, defer: true });
  expect(files["/usr/local/bin/framelab-setup"]!.content).toContain('git clone --depth 1 --branch "main" "https://github.com/batmnnn/batcorp.git"');
  expect(files["/etc/motd"]!.content).toContain(expiresAt.toISOString().slice(0, 16));
  expect(files["/etc/framelab/agent.env"]).toMatchObject({ permissions: "0600", content: `LAB_AGENT_URL=${relay.url}\nLAB_AGENT_TOKEN=${relay.token}\nLAB_VM_NAME=${relay.vm}\n` });
  expect(files["/opt/framelab/agent.ts"]!.content).toBe(await readFile(new URL("../src/lab/agent.ts", import.meta.url), "utf8"));
  expect(files["/etc/systemd/system/framelab-ui.service"]!.content).toContain("ExecStart=/home/judge/.bun/bin/bun src/cli.ts serve --port 4173");
  expect(files["/etc/systemd/system/framelab-agent.service"]!.content).toContain("EnvironmentFile=/etc/framelab/agent.env");
  expect(doc.runcmd[0]).toEqual(["shutdown", "-h", "+190", "FrameLab judge VM: time is up"]);
  const last = JSON.stringify(doc.runcmd.at(-1));
  expect(last).toContain("systemctl enable --now framelab-ui.service framelab-agent.service");
  expect(last).toContain(READY_MARK);
  expect(last).toContain(FAILED_MARK);
});

test("cloud-init refuses keys, repositories, refs and relay settings that could inject into it", () => {
  const ok = { keys: [ED], expiresAt: new Date(), repo: "https://github.com/batmnnn/batcorp.git", ref: "main", agent: relay };
  expect(() => judgeCloudInit(ok)).not.toThrow();
  expect(() => judgeCloudInit({ ...ok, agent: { ...relay, url: "ws://lab.example.test/agent" } })).toThrow();
  expect(() => judgeCloudInit({ ...ok, agent: { ...relay, token: "short" } })).toThrow();
  expect(() => judgeCloudInit({ ...ok, agent: { ...relay, token: `${"t".repeat(40)}\nX=1` } })).toThrow();
  expect(() => judgeCloudInit({ ...ok, agent: { ...relay, vm: "Judge X" } })).toThrow();
  expect(() => judgeCloudInit({ ...ok, keys: [] })).toThrow();
  expect(() => judgeCloudInit({ ...ok, keys: [`${ED}\nruncmd: [reboot]`] })).toThrow();
  expect(() => judgeCloudInit({ ...ok, repo: "https://evil.example/x.git" })).toThrow();
  expect(() => judgeCloudInit({ ...ok, ref: 'main"; reboot; "' })).toThrow();
  expect(() => judgeCloudInit({ ...ok, ref: "-o" })).toThrow();
});

test("VM names are Azure-safe and the placeholder RSA key is well formed", () => {
  expect(vmName("Some_User--")).toMatch(/^judge-some-user-[0-9a-f]{6}$/);
  expect(vmName("---")).toMatch(/^judge-judge-[0-9a-f]{6}$/);
  expect(vmName("a".repeat(39)).length).toBeLessThanOrEqual(64);
  const key = unusableRsaKey();
  expect(key).toMatch(/^ssh-rsa [A-Za-z0-9+/]+={0,3} framelab-unusable$/);
  expect(Buffer.from(key.split(" ")[1]!, "base64").subarray(4, 11).toString()).toBe("ssh-rsa");
});

test("the reaper deletes past expiry, falls back to age, and knows which NIC, IP and disk a VM owns", () => {
  const t = Date.parse("2026-11-06T14:00:00Z");
  expect(expired(vm("1"), t - 1)).toBe(false);
  expect(expired(vm("1"), t)).toBe(true);
  expect(expired(vm("1", { expiresAt: "" }), Date.parse("2026-11-06T14:59:00Z"))).toBe(false);
  expect(expired(vm("1", { expiresAt: "" }), Date.parse("2026-11-06T15:00:00Z"))).toBe(true);
  expect(expired(vm("1", { expiresAt: "", createdAt: "" }), t)).toBe(true);
  const names = ["judge-a-111111"];
  expect(owner("judge-a-111111-nic", names)).toBe("judge-a-111111");
  expect(owner("judge-a-111111-ip", names)).toBe("judge-a-111111");
  expect(owner("judge-a-111111_OsDisk_1_abc", names)).toBe("judge-a-111111");
  expect(owner("judge-a-222222-nic", names)).toBeUndefined();
});

test("the relay carries requests to the VM's UI and back, without cookies, and only to that UI", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/") return new Response("<p>ui</p>", { headers: { "content-type": "text/html", "set-cookie": "x=1" } });
      if (u.pathname === "/api/state") return Response.json({ host: req.headers.get("host"), cookie: req.headers.get("cookie"), xf: req.headers.get("x-framelab"), q: u.search });
      if (u.pathname === "/api/echo" && req.method === "POST") return new Response(req.body, { headers: { "content-type": "application/json" } });
      if (u.pathname === "/api/download") return new Response(new Uint8Array(1_500_000).fill(7), { headers: { "content-type": "application/gzip" } });
      return new Response("not found", { status: 404 });
    },
  });
  const tunnel = new Tunnel();
  const hub = Bun.serve<AgentData>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: { open: (ws) => tunnel.open(ws), message: (ws, m) => tunnel.message(ws, m), close: (ws) => tunnel.close(ws) },
    fetch(req, srv) {
      if (req.headers.get("authorization") !== "Bearer tok") return new Response("unauthorized", { status: 401 });
      return srv.upgrade(req, { data: { vm: req.headers.get("x-framelab-vm")! } }) ? undefined : new Response("upgrade", { status: 426 });
    },
  });
  const agent = runAgent({ url: `ws://127.0.0.1:${hub.port}/agent`, token: "tok", vm: "judge-a", ui: `http://127.0.0.1:${upstream.port}` });
  for (let i = 0; i < 100 && !tunnel.connected("judge-a"); i++) await Bun.sleep(20);
  expect(tunnel.connected("judge-a")).toBe(true);
  const ask = (method: string, p: string, headers: Record<string, string> = {}, body?: Uint8Array) => tunnel.request("judge-a", { method, path: p, headers: new Headers(headers), body });

  const page = await ask("GET", "/");
  expect(page.status).toBe(200);
  expect(await page.text()).toBe("<p>ui</p>");
  expect(page.headers.get("set-cookie")).toBeNull();
  expect(await (await ask("GET", "/api/state?b=x", { cookie: "__Host-fl_lab=secret", "x-framelab": "1" })).json()).toEqual({ host: `127.0.0.1:${upstream.port}`, cookie: null, xf: "1", q: "?b=x" });
  expect(await (await ask("POST", "/api/echo", { "content-type": "application/json" }, new TextEncoder().encode('{"a":1}'))).text()).toBe('{"a":1}');
  const download = new Uint8Array(await (await ask("GET", "/api/download")).arrayBuffer());
  expect(download.length).toBe(1_500_000);
  expect(download.every((b) => b === 7)).toBe(true);
  expect((await ask("GET", "/missing")).status).toBe(404);
  for (const p of ["//evil.example/x", "http://evil.example/", "relative"]) await expect(ask("GET", p)).rejects.toMatchObject({ status: 502 });
  await expect(tunnel.request("judge-b", { method: "GET", path: "/", headers: new Headers() })).rejects.toMatchObject({ status: 503 });

  agent.stop();
  for (let i = 0; i < 100 && tunnel.connected("judge-a"); i++) await Bun.sleep(20);
  expect(tunnel.connected("judge-a")).toBe(false);
  hub.stop(true);
  upstream.stop(true);
});

const port = 20000 + Math.floor(Math.random() * 2000);
const canonical = "lab.example.test";
const local = `127.0.0.1:${port}`;
const azure: LabConfig = { subscription: "s", group: "g", location: "l", subnetId: "x", vmSize: "v" };
const cfg = {
  hosts: [canonical, local],
  clientId: "Iv1.testclient",
  clientSecret: "s".repeat(40),
  sessionKey: "k".repeat(40),
  repo: "https://github.com/batmnnn/batcorp.git",
  ref: "main",
  viewerUrl: "https://viewer.example.test/",
  limits,
  azure,
};
const lab = serveLab(port, cfg);
const off = serveLab(port + 1, { ...cfg, hosts: [`127.0.0.1:${port + 1}`], clientId: NOT_CONFIGURED, clientSecret: NOT_CONFIGURED });
afterAll(() => {
  lab.stop(true);
  off.stop(true);
});
const hit = (p: string, init: RequestInit & { host?: string } = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { redirect: "manual", ...init, headers: { host: init.host ?? canonical, ...(init.headers as Record<string, string>) } });

test("the lab answers only its own hosts and sends other hosts to the canonical one", async () => {
  expect((await hit("/healthz", { host: "evil.test" })).status).toBe(200);
  expect((await hit("/", { host: "evil.test" })).status).toBe(403);
  const moved = await hit("/auth/login", { host: local });
  expect(moved.status).toBe(302);
  expect(moved.headers.get("location")).toBe(`https://${canonical}/auth/login`);
  const page = await hit("/");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await page.text()).toContain("Connect GitHub");
});

test("sign-in asks GitHub for no scopes and binds the attempt to a state cookie", async () => {
  const res = await hit("/auth/login");
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(to.searchParams.get("client_id")).toBe("Iv1.testclient");
  expect(to.searchParams.get("scope")).toBe("");
  expect(to.searchParams.get("redirect_uri")).toBe(`https://${canonical}/auth/callback`);
  const cookie = res.headers.get("set-cookie")!;
  expect(cookie).toStartWith(`__Host-fl_state=${to.searchParams.get("state")};`);
  expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
  for (const q of ["", "?code=c", `?code=c&state=${to.searchParams.get("state")}`]) {
    const back = await hit(`/auth/callback${q}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/?error=state");
  }
});

test("writes need the same origin, the header and a session", async () => {
  const post = (p: string, headers: Record<string, string>) => hit(p, { method: "POST", headers });
  expect((await post("/api/vm", { "x-framelab": "1" })).status).toBe(403);
  expect((await post("/api/vm", { origin: "https://evil.test", "x-framelab": "1" })).status).toBe(403);
  expect((await post("/api/vm", { origin: `https://${canonical}` })).status).toBe(403);
  expect((await post("/api/vm", { origin: `https://${canonical}`, "x-framelab": "1" })).status).toBe(401);
  expect((await post("/api/vm/delete", { origin: `https://${canonical}`, "x-framelab": "1" })).status).toBe(401);
  const forged = `${Buffer.from(JSON.stringify({ login: "x", id: 1, createdAt: old, exp: Date.now() + 60_000 })).toString("base64url")}.AAAA`;
  expect((await post("/api/vm", { origin: `https://${canonical}`, "x-framelab": "1", cookie: `__Host-fl_lab=${forged}` })).status).toBe(401);
});

test("/ui/ needs a session, and writes through it need the same origin and the header", async () => {
  const s = signSession({ login: "judge", id: 42, createdAt: old, exp: Date.now() + 60_000 }, cfg.sessionKey);
  expect((await hit("/ui")).headers.get("location")).toBe("/ui/");
  const out = await hit("/ui/");
  expect(out.status).toBe(302);
  expect(out.headers.get("location")).toBe("/");
  expect((await hit("/ui/api/run", { method: "POST", headers: { origin: `https://${canonical}`, "x-framelab": "1" } })).status).toBe(401);
  for (const headers of [{ origin: "https://evil.test", "x-framelab": "1" }, { origin: `https://${canonical}` }] as Record<string, string>[]) {
    expect((await hit("/ui/api/run", { method: "POST", headers: { ...headers, cookie: `__Host-fl_lab=${s}` } })).status).toBe(403);
  }
});

test("a relay agent without a well-formed VM name and token is refused before any lookup", async () => {
  for (const headers of [{}, { "x-framelab-vm": "judge-a-1", authorization: "Bearer short" }, { "x-framelab-vm": "../x", authorization: `Bearer ${"a".repeat(43)}` }] as Record<string, string>[]) {
    expect((await hit("/agent", { headers })).status).toBe(401);
  }
});

test("until the OAuth app is connected, sign-in says so instead of failing at GitHub", async () => {
  const res = await fetch(`http://127.0.0.1:${port + 1}/auth/login`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/?error=unconfigured");
});
