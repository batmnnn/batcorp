import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundleArchive, serveHosted } from "../src/ui/hosted.ts";

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

test("a downloaded bundle extracts with system tar, byte for byte, with sane modes", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "framelab-archive-src-"));
  const files: Record<string, string> = { "replay.sh": "#!/usr/bin/env bash\necho hi\n", "README.md": "x".repeat(1500), "evidence/run1.meta.json": "{}" };
  await mkdir(path.join(src, "evidence"));
  for (const [rel, text] of Object.entries(files)) {
    await writeFile(path.join(src, rel), text);
    await chmod(path.join(src, rel), 0o777);
  }
  const out = await mkdtemp(path.join(tmpdir(), "framelab-archive-out-"));
  const archive = path.join(out, "b.tar.gz");
  await writeFile(archive, await bundleArchive(src, "some-bundle"));
  const proc = Bun.spawn(["tar", "-xzf", archive, "-C", out], { stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(out, "some-bundle", rel);
    expect(await readFile(file, "utf8")).toBe(text);
    expect((await stat(file)).mode & 0o777).toBe(rel.endsWith(".sh") ? 0o755 : 0o644);
  }
});

test("only the configured host names are answered, except the health probe", async () => {
  expect((await get("/api/state", { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await get("/healthz", { headers: { host: "10.0.0.7:8080" } })).status).toBe(200);
});
