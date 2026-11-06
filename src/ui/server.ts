import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Subprocess } from "bun";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src/cli.ts");
const VIEWER = path.join(ROOT, "viewer/index.html");
const READABLE_ROOTS = [path.join(ROOT, "bundles"), path.join(ROOT, ".runs")];
const NOISE = / INFO | WARN |DEBUG|^\s*$/;
const NOT_RESULTS = new Set(["builds", "shrink-cache", "tamper", "secret-plant"]);

interface Job {
  kind: "env" | "run" | "shrink";
  label: string;
  dir: string;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  started: number;
  exitCode: number | null;
  log: string[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const rel = (abs: string) => path.relative(ROOT, abs);

function inside(abs: string, roots: string[]): boolean {
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

function resolveReadable(dir: unknown): string {
  if (typeof dir !== "string" || dir.length === 0) throw new HttpError(400, "dir is required");
  const abs = path.resolve(ROOT, dir);
  if (!inside(abs, READABLE_ROOTS)) throw new HttpError(403, "only bundles/ and .runs/ can be opened");
  return abs;
}

async function readText(file: string): Promise<string | null> {
  return readFile(file, "utf8").catch(() => null);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false
  );
}

async function pump(stream: ReadableStream<Uint8Array>, job: Job) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let rest = "";
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (!NOISE.test(line)) job.log.push(line.slice(0, 400));
    if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
  }
}

function spawnCli(kind: Job["kind"], label: string, dir: string, args: string[]): Job {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const job: Job = { kind, label, dir, proc, started: Date.now(), exitCode: null, log: [] };
  void pump(proc.stdout, job);
  void pump(proc.stderr, job);
  void proc.exited.then((code) => (job.exitCode = code));
  return job;
}

async function stopJob(job: Job | null) {
  if (!job || job.exitCode !== null) return;
  job.proc.kill("SIGINT");
  await job.proc.exited;
}

async function progressOf(dir: string, limit = 400): Promise<unknown[]> {
  const text = await readText(path.join(dir, "progress.jsonl"));
  if (!text) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

async function listScenarios(): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ["scenarios", "scenarios/negative"]) {
    const names = await readdir(path.join(ROOT, sub)).catch(() => []);
    for (const n of names.sort()) if (n.endsWith(".yaml")) out.push(`${sub}/${n}`);
  }
  return out;
}

async function listBuilds(): Promise<Array<{ id: string; label: string; patches: string[] }>> {
  const names = await readdir(path.join(ROOT, "patches")).catch(() => []);
  const injected = names.filter((n) => n.startsWith("inject-") && n.endsWith(".patch")).sort();
  return [
    { id: "observe", label: "observe", patches: [] },
    // Label = first two name parts ("inject-s1"), matching the CLI's build cache and bundle labels.
    ...injected.map((n) => ({ id: n.replace(/\.patch$/, ""), label: n.replace(/\.patch$/, "").split("-").slice(0, 2).join("-"), patches: [`patches/${n}`] })),
  ];
}

async function listResults() {
  const results: Array<{ dir: string; kind: string; scenario: string; overall: string; mtime: number; injected: boolean; negative: boolean }> = [];
  for (const root of READABLE_ROOTS) {
    const names = await readdir(root).catch(() => []);
    for (const name of names) {
      if (NOT_RESULTS.has(name) || name.startsWith("env-")) continue;
      const dir = path.join(root, name);
      const text = await readText(path.join(dir, "verdicts.json"));
      if (!text) continue;
      try {
        const v = JSON.parse(text);
        const kind = root.endsWith("bundles") ? "bundle" : (await exists(path.join(dir, "reduction.json"))) ? "shrink" : "run";
        const patches: Array<{ file: string }> = v.sidecar_build?.patches ?? [];
        results.push({
          dir: rel(dir),
          kind,
          scenario: v.scenario?.id ?? "?",
          overall: v.overall,
          mtime: (await stat(path.join(dir, "verdicts.json"))).mtimeMs,
          injected: patches.some((p) => path.basename(p.file).startsWith("inject-")),
          negative: Boolean(v.fault || v.run2_sidecar_build),
        });
      } catch {
        // not a FrameLab result
      }
    }
  }
  return results.sort((a, b) => b.mtime - a.mtime).slice(0, 40);
}

/** Every file the viewer renders, under one flat naming scheme for run, shrink and bundle layouts. */
async function viewFiles(dir: string) {
  const isBundle = await exists(path.join(dir, "manifest.json"));
  const files: Record<string, string> = {};
  const add = async (name: string, ...candidates: string[]) => {
    for (const c of candidates) {
      const text = await readText(path.join(dir, c));
      if (text !== null) {
        files[name] = text;
        return;
      }
    }
  };
  for (const f of ["verdicts.json", "manifest.json", "reduction.json", "node_pin.json", "compare.json", "scenario.original.yaml", "scenario.min.yaml", "README.md"]) await add(f, f);
  for (const k of [1, 2]) {
    await add(`events.run${k}.jsonl`, `events.run${k}.jsonl`, `run${k}/events.jsonl`);
    await add(`evidence.run${k}.json`, `evidence/run${k}.evidence.json`, `run${k}/evidence.json`);
    await add(`meta.run${k}.json`, `evidence/run${k}.meta.json`, `run${k}/meta.json`);
  }
  await add("rule_pack.json", "rule_pack.json");
  if (!files["rule_pack.json"] && files["verdicts.json"]) {
    const id = JSON.parse(files["verdicts.json"]).rule_pack?.id;
    const text = id ? await readText(path.join(ROOT, "rulepacks", `${id}.json`)) : null;
    if (text) files["rule_pack.json"] = text;
  }
  if (!files["verdicts.json"]) throw new HttpError(404, `${rel(dir)} has no verdicts.json`);
  return { dir: rel(dir), kind: isBundle ? "bundle" : files["reduction.json"] ? "shrink" : "run", files };
}

export async function serve(port: number): Promise<void> {
  let env: Job | null = null;
  let job: Job | null = null;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const busy = () => job !== null && job.exitCode === null;

  const startJob = async (kind: "run" | "shrink", label: string, dir: string, args: string[]) => {
    if (busy()) throw new HttpError(409, `a ${job!.kind} is already running`);
    // Runs use the same local ports as the probe stack.
    await stopJob(env);
    env = null;
    job = spawnCli(kind, label, dir, [...args, "--out", dir]);
    return { ok: true, dir: rel(dir) };
  };

  const api: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown>> = {
    "GET /api/state": async () => {
      const envInfo = env ? await readText(path.join(env.dir, "env.json")) : null;
      return {
        mode: "server",
        env: env && {
          status: env.exitCode !== null ? "stopped" : envInfo ? "ready" : "starting",
          dir: rel(env.dir),
          info: envInfo ? JSON.parse(envInfo) : null,
          exit_code: env.exitCode,
          log: env.log.slice(-20),
        },
        job: job && {
          kind: job.kind,
          label: job.label,
          dir: rel(job.dir),
          running: job.exitCode === null,
          exit_code: job.exitCode,
          started: job.started,
          progress: await progressOf(job.dir),
          log: job.log.slice(-30),
        },
        scenarios: await listScenarios(),
        builds: await listBuilds(),
        results: await listResults(),
      };
    },
    "GET /api/view": async (_b, url) => viewFiles(resolveReadable(url.searchParams.get("dir"))),
    "POST /api/env/start": async () => {
      if (busy()) throw new HttpError(409, `a ${job!.kind} is running; the probe stack shares its ports`);
      if (env && env.exitCode === null) return { ok: true, dir: rel(env.dir) };
      const dir = path.join(ROOT, ".runs", `env-${Date.now()}`);
      env = spawnCli("env", "probe", dir, ["env", "--out", dir]);
      return { ok: true, dir: rel(dir) };
    },
    "POST /api/env/stop": async () => {
      await stopJob(env);
      env = null;
      return { ok: true };
    },
    "POST /api/run": async (body) => {
      const scenario = path.resolve(ROOT, String(body.scenario ?? ""));
      if (!scenario.endsWith(".yaml") || !inside(scenario, [path.join(ROOT, "scenarios"), path.join(ROOT, "bundles")])) {
        throw new HttpError(400, "scenario must be a .yaml file under scenarios/ or bundles/");
      }
      const build = (await listBuilds()).find((b) => b.id === (body.build ?? "observe"));
      if (!build) throw new HttpError(400, `unknown node build ${String(body.build)}`);
      const id = path.basename(scenario, ".yaml");
      const dir = path.join(ROOT, ".runs", `ui-run-${id}-${build.label}-${Date.now()}`);
      return startJob("run", id, dir, ["run", scenario, "--label", build.label, ...build.patches.flatMap((p) => ["--patch", path.join(ROOT, p)])]);
    },
    "POST /api/shrink": async (body) => {
      const src = resolveReadable(body.dir);
      const verdicts = JSON.parse((await readText(path.join(src, "verdicts.json"))) ?? "null");
      if (!verdicts) throw new HttpError(400, "no verdicts.json");
      if (verdicts.overall !== "FAIL" || verdicts.disagreements?.length) throw new HttpError(400, "Shrink needs a FAIL that both runs agree on");
      if (verdicts.fault || verdicts.run2_sidecar_build) throw new HttpError(400, "negative-path test runs are not shrunk");
      const scenario = path.join(src, "scenario.original.yaml");
      if (!(await exists(scenario))) throw new HttpError(400, "no scenario.original.yaml");
      const patches = (verdicts.sidecar_build.patches as Array<{ file: string }>).map((p) => p.file).filter((f) => !f.endsWith("sidecar-observe.patch"));
      const label = String(verdicts.sidecar_build.label);
      const dir = path.join(ROOT, ".runs", `ui-shrink-${verdicts.scenario.id}-${label}-${Date.now()}`);
      return startJob("shrink", verdicts.scenario.id, dir, ["shrink", scenario, "--label", label, ...patches.flatMap((f) => ["--patch", path.resolve(ROOT, f)])]);
    },
    "POST /api/cancel": async () => {
      if (!busy()) throw new HttpError(409, "nothing is running");
      job!.proc.kill("SIGINT");
      return { ok: true };
    },
    "POST /api/export": async (body) => {
      const src = resolveReadable(body.dir);
      if (inside(src, [path.join(ROOT, "bundles")])) throw new HttpError(400, "already a bundle");
      const out = path.join(ROOT, "bundles", path.basename(src));
      const proc = Bun.spawn(["bun", CLI, "export", src, "--out", out], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const output = `${stdout}${stderr}`.split("\n").filter((l) => !NOISE.test(l));
      return { ok: code === 0, exit_code: code, bundle: code === 0 ? rel(out) : null, output };
    },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      // DNS-rebinding guard: only answer requests addressed to this local origin.
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("forbidden host", { status: 403 });
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(Bun.file(VIEWER), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return new Response("not found", { status: 404 });
      // A custom header forces a CORS preflight, which this server never grants, so other sites cannot POST here.
      if (req.method === "POST" && req.headers.get("x-framelab") !== "1") return new Response("missing x-framelab header", { status: 403 });
      try {
        const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
        return Response.json(await handler(body, url), { headers: { "cache-control": "no-store" } });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        return Response.json({ error: (err as Error).message }, { status });
      }
    },
  });
  console.log(`FrameLab UI: http://127.0.0.1:${server.port}/ (local only; Ctrl-C stops it and any stack it started)`);

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await Promise.all([stopJob(job), stopJob(env)]);
      server.stop(true);
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
