import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { HttpError, listResults, viewFiles } from "./server.ts";

/**
 * The public, read-only copy of the viewer. It serves published bundles and nothing else: no
 * endpoint starts a node, a run, a shrink or an export, and raw run folders (which can hold an
 * engine JWT) are never readable. Replays happen on the reader's own machine.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const VIEWER = path.join(ROOT, "viewer/index.html");
const BUNDLES = path.join(ROOT, "bundles");
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
};
const RESULTS_TTL_MS = 30_000;

const exists = (file: string) => stat(file).then(() => true, () => false);

/** `bundles/<name>` only, with a plain folder name: no other root, no path separators, no dot-dot. */
function bundleDir(dir: string | null): string {
  const name = dir?.startsWith("bundles/") ? dir.slice("bundles/".length) : "";
  if (!NAME.test(name) || name.includes("..")) throw new HttpError(403, "only published bundles can be opened");
  return path.join(BUNDLES, name);
}

async function requireBundle(dir: string): Promise<void> {
  for (const f of ["manifest.json", "SHA256SUMS", "verdicts.json"]) {
    if (!(await exists(path.join(dir, f)))) throw new HttpError(404, "no published bundle with that name");
  }
}

const json = (data: unknown, cache: string) => Response.json(data, { headers: { "cache-control": cache, ...SECURITY } });

export function serveHosted(port: number, hosts: string[]) {
  const allowed = new Set(hosts);
  let cached: { at: number; results: Awaited<ReturnType<typeof listResults>> } | null = null;
  const results = async () => {
    if (!cached || Date.now() - cached.at > RESULTS_TTL_MS) cached = { at: Date.now(), results: await listResults([BUNDLES]) };
    return cached.results;
  };

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (!allowed.has(req.headers.get("host") ?? "")) return new Response("forbidden host", { status: 403 });
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only copy", { status: 405, headers: { allow: "GET, HEAD", ...SECURITY } });
      try {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(Bun.file(VIEWER), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SECURITY } });
        }
        if (url.pathname === "/api/state") return json({ mode: "hosted", env: null, job: null, scenarios: [], builds: [], results: await results() }, "no-store");
        if (url.pathname === "/api/view") {
          const dir = bundleDir(url.searchParams.get("dir"));
          await requireBundle(dir);
          return json(await viewFiles(dir), "public, max-age=60");
        }
        if (url.pathname === "/api/download") {
          const dir = bundleDir(url.searchParams.get("dir"));
          await requireBundle(dir);
          const name = path.basename(dir);
          const tar = Bun.spawn(["tar", "-czf", "-", "-C", BUNDLES, "--", name], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
          return new Response(tar.stdout, {
            headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}.tar.gz"`, "cache-control": "public, max-age=60", ...SECURITY },
          });
        }
        return new Response("not found", { status: 404, headers: SECURITY });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        return Response.json({ error: status === 500 ? "internal error" : (err as Error).message }, { status, headers: SECURITY });
      }
    },
  });
  console.log(`FrameLab hosted copy (read only) on port ${server.port}, answering ${[...allowed].join(", ")}`);
  return server;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: "string", default: "8080" } } });
  const hosts = (process.env.FRAMELAB_PUBLIC_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  if (!hosts.length) {
    console.error("FRAMELAB_PUBLIC_HOSTS is required: the comma-separated host names this copy answers to");
    process.exit(2);
  }
  serveHosted(Number(values.port), hosts);
}
