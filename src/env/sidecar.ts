import { createHash } from "node:crypto";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Subprocess } from "bun";
import type { Hex } from "viem";
import { SIDECAR_PIN } from "./pins.ts";
import { exec, waitUntil } from "../util/proc.ts";
import { RpcClient, type RpcSink } from "../util/rpc.ts";

const FRAMELAB_ROOT = path.resolve(import.meta.dir, "../..");
const BUILD_ROOT = path.join(FRAMELAB_ROOT, ".runs/builds");
const ENTRY_POINT = "0x00000000000000000000000000000000000000aa";
const MEMPOOL_ID = "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk";

export interface SidecarBuild {
  label: string;
  dir: string;
  commit: string;
  patches: Array<{ file: string; sha256: string }>;
  buildHash: string;
}

/** Worktree of the pinned sidecar with `patches` applied in order, built once per patch set. */
export async function ensureSidecarBuild(label: string, patchFiles: string[]): Promise<SidecarBuild> {
  const patches = await Promise.all(
    patchFiles.map(async (file) => ({
      file: path.relative(FRAMELAB_ROOT, path.resolve(file)),
      sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
    }))
  );
  const buildHash = createHash("sha256")
    .update(JSON.stringify({ commit: SIDECAR_PIN.commit, patches: patches.map((p) => p.sha256) }))
    .digest("hex");
  const dir = path.join(BUILD_ROOT, `${label}-${buildHash.slice(0, 12)}`);
  const build: SidecarBuild = { label, dir, commit: SIDECAR_PIN.commit, patches, buildHash };
  const marker = path.join(dir, ".framelab-build.json");
  if (existsSync(marker) && JSON.parse(await readFile(marker, "utf8")).buildHash === buildHash) return build;

  await exec(["git", "-C", SIDECAR_PIN.dir, "worktree", "remove", "--force", dir], { allowFail: true });
  await rm(dir, { recursive: true, force: true });
  await mkdir(BUILD_ROOT, { recursive: true });
  await exec(["git", "-C", SIDECAR_PIN.dir, "worktree", "add", "--detach", dir, SIDECAR_PIN.commit]);
  for (const file of patchFiles) await exec(["git", "-C", dir, "apply", "--whitespace=nowarn", path.resolve(file)]);
  await exec(["bun", "install", "--frozen-lockfile"], { cwd: dir });
  await exec(["bun", "run", "build"], { cwd: dir });
  await writeFile(marker, JSON.stringify(build, null, 2));
  return build;
}

export interface SidecarOptions {
  build: SidecarBuild;
  ethrexRpcUrl: string;
  apiPort: number;
  runDir: string;
  relayerPrivateKey: Hex;
  bundleIntervalMs: number;
  ttlSeconds: number;
  /** Runs relay on demand ("manual"); `auto` relays on its own, as the public devnet does. */
  bundlingMode?: "manual" | "auto";
  readyTimeoutMs?: number;
  sink?: RpcSink;
}

export interface SidecarHandle {
  proc: Subprocess;
  rpc: RpcClient;
  apiUrl: string;
  dataDir: string;
  observeFile: string;
  logFile: string;
  configHash: string;
  startupMs: number;
}

export function sidecarConfig(opts: Pick<SidecarOptions, "ethrexRpcUrl" | "relayerPrivateKey" | "bundleIntervalMs" | "ttlSeconds">) {
  return {
    entryPoints: [ENTRY_POINT],
    canonicalEntryPoint: ENTRY_POINT,
    standardMempoolId: MEMPOOL_ID,
    supportedMempools: [{ mempoolId: MEMPOOL_ID, entryPoint: ENTRY_POINT }],
    relayers: [opts.relayerPrivateKey],
    rpcEndpoint: opts.ethrexRpcUrl,
    rpcEndpointSubmit: opts.ethrexRpcUrl,
    bundleInterval: opts.bundleIntervalMs,
    useropsTTL: opts.ttlSeconds,
  };
}

export async function startSidecar(opts: SidecarOptions): Promise<SidecarHandle> {
  const dataDir = path.join(opts.runDir, "sidecar-data");
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  const config = sidecarConfig(opts);
  const configFile = path.join(opts.runDir, "sidecar-config.json");
  await writeFile(configFile, JSON.stringify(config, null, 2));
  const sanitized = { ...config, relayers: config.relayers.map(() => "<public-test-relayer>") };
  const configHash = createHash("sha256").update(JSON.stringify(sanitized)).digest("hex");

  const observeFile = path.join(opts.runDir, "observe.jsonl");
  const logFile = path.join(opts.runDir, "sidecar.log");
  await writeFile(observeFile, "");
  const out = openSync(logFile, "a");
  const started = Date.now();
  const proc = Bun.spawn(
    [
      "bun", "--bun", path.join(opts.build.dir, "packages/cli/bin/skandha.js"), "standalone",
      "--configFile", configFile,
      "--dataDir", dataDir,
      "--api.address", "127.0.0.1",
      "--api.port", String(opts.apiPort),
      "--api.wsPort", String(opts.apiPort),
      "--executor.bundlingMode", opts.bundlingMode ?? "manual",
      "--explorer.enable",
    ],
    {
      cwd: opts.build.dir,
      stdout: out,
      stderr: out,
      env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "debug", FRAMELAB_OBSERVE_FILE: observeFile },
    }
  );

  const apiUrl = `http://127.0.0.1:${opts.apiPort}/rpc/`;
  const rpc = new RpcClient(apiUrl, { sink: opts.sink, timeoutMs: 30_000 });
  try {
    await waitUntil(
      "sidecar explorer",
      async () => {
        if (proc.exitCode !== null) throw new Error(`sidecar exited with ${proc.exitCode}; see ${logFile}`);
        return rpc.call("skandha_explorer_info");
      },
      { timeoutMs: opts.readyTimeoutMs ?? 60_000, intervalMs: 250 }
    );
  } catch (err) {
    proc.kill();
    throw err;
  }
  return { proc, rpc, apiUrl, dataDir, observeFile, logFile, configHash, startupMs: Date.now() - started };
}

export async function stopSidecar(handle: SidecarHandle): Promise<void> {
  if (handle.proc.exitCode !== null) return;
  handle.proc.kill("SIGTERM");
  const exited = await Promise.race([handle.proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
  if (!exited) {
    handle.proc.kill("SIGKILL");
    await handle.proc.exited;
  }
}

export interface ObserveLine {
  event: "reconcile.start" | "reconcile.done" | "reconcile.error";
  block: string;
  at: number;
  pendingNew?: string[];
  pendingSubmitted?: string[];
  revalidated?: string[];
  balanceCancelled?: string[];
  message?: string;
}

export async function readObserve(handle: Pick<SidecarHandle, "observeFile">): Promise<ObserveLine[]> {
  const text = await readFile(handle.observeFile, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ObserveLine);
}
