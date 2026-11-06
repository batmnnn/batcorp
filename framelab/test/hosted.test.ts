import { afterAll, expect, test } from "bun:test";
import { serveHosted } from "../src/ui/hosted.ts";

const port = 18000 + Math.floor(Math.random() * 2000);
const host = `127.0.0.1:${port}`;
const server = serveHosted(port, [host]);
afterAll(() => server.stop(true));

const get = (p: string, init: RequestInit = {}) => fetch(`http://${host}${p}`, init);

test("the hosted copy reports read-only mode with no runner state", async () => {
  const res = await get("/api/state");
  expect(res.status).toBe(200);
  const s = await res.json();
  expect(s).toMatchObject({ mode: "hosted", env: null, job: null, scenarios: [], builds: [] });
  expect(s.results.every((r: { dir: string; kind: string }) => r.dir.startsWith("bundles/") && r.kind === "bundle")).toBe(true);
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("raw runs and anything outside bundles/ cannot be opened or downloaded", async () => {
  for (const dir of [".runs/x", "bundles/../.runs/x", "bundles/a/b", "bundles/..", "/etc", "scenarios", "bundles/"]) {
    for (const route of ["/api/view", "/api/download"]) {
      expect((await get(`${route}?dir=${encodeURIComponent(dir)}`)).status).toBe(403);
    }
  }
  expect((await get("/api/view?dir=bundles/no-such-bundle")).status).toBe(404);
});

test("nothing can be started: every write is refused", async () => {
  for (const p of ["/api/run", "/api/shrink", "/api/export", "/api/env/start", "/api/env/stop", "/api/cancel"]) {
    const res = await get(p, { method: "POST", headers: { "x-framelab": "1", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(405);
  }
});

test("only the configured host names are answered, except the health probe", async () => {
  expect((await get("/api/state", { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await get("/healthz", { headers: { host: "10.0.0.7:8080" } })).status).toBe(200);
});
