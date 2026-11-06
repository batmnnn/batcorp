import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hex } from "viem";
import { deriveActor, funderActor } from "../env/actors.ts";
import { ethrexLogs, startEthrex, stopEthrex } from "../env/ethrex.ts";
import { ensureSidecarBuild, readObserve, startSidecar, stopSidecar, type SidecarHandle } from "../env/sidecar.ts";
import { EngineStepper } from "../env/stepper.ts";
import { waitUntil } from "../util/proc.ts";
import type { RpcRecord } from "../util/rpc.ts";
import { buildUnsignedFrameTx, signFrameTx, toWire } from "../vendor/sidecar/frameTx.ts";

const FRAMELAB_ROOT = path.resolve(import.meta.dir, "../..");
const runDir = path.join(FRAMELAB_ROOT, ".runs", `g2-${Date.now()}`);
// PUBLIC TEST-ONLY: ethrex fixtures/keys/private_keys_l1.txt, funded in l1-hegota.json.
const RELAYER_KEY: Hex = "0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d";

const evidence: RpcRecord[] = [];
const sink = (r: RpcRecord) => evidence.push(r);
const t = (label: string, started: number, timings: Record<string, number>) => (timings[label] = Date.now() - started);

const timings: Record<string, number> = {};
const ethrexName = "framelab-g2-ethrex";
let sidecar: SidecarHandle | undefined;
let result: Record<string, unknown> = {};
try {
  const node = await startEthrex({ name: ethrexName, httpPort: 18545, authPort: 18551, workDir: runDir, sink });
  timings.ethrexStartup = node.startupMs;
  const stepper = new EngineStepper(node, { sink });
  await stepper.init();
  await stepper.step();

  const build = await ensureSidecarBuild("observe", [path.join(FRAMELAB_ROOT, "patches/sidecar-observe.patch")]);
  sidecar = await startSidecar({
    build,
    ethrexRpcUrl: node.rpcUrl,
    apiPort: 15437,
    runDir,
    relayerPrivateKey: RELAYER_KEY,
    bundleIntervalMs: 250,
    ttlSeconds: 86_400,
    sink,
  });
  timings.sidecarStartup = sidecar.startupMs;
  const info = await sidecar.rpc.call<{ bootId: string; latestSeq: number; oldestSeq: number }>("skandha_explorer_info");

  const sender = funderActor();
  const recipient = deriveActor("g2", "recipient").address;
  const tx = await signFrameTx(
    buildUnsignedFrameTx(0n, { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, sender.privateKey, node.chainId, recipient),
    sender.privateKey
  );

  let started = Date.now();
  const hash = await sidecar.rpc.call<Hex>("eth_sendFrameTransaction", [toWire(tx)]);
  t("admission", started, timings);
  const statusAfterAdmit = await sidecar.rpc.call<{ status: string }>("skandha_frameTransactionStatus", [hash]);

  started = Date.now();
  const bundle = await sidecar.rpc.call("debug_bundler_sendBundleNow");
  t("sendBundleNow", started, timings);
  const statusAfterRelay = await sidecar.rpc.call<{ status: string }>("skandha_frameTransactionStatus", [hash]);

  started = Date.now();
  const block = await stepper.step({ expectTxs: [hash] });
  t("step", started, timings);

  started = Date.now();
  const done = await waitUntil(
    `reconcile.done for block ${block.number}`,
    async () => (await readObserve(sidecar!)).find((l) => l.event === "reconcile.done" && BigInt(l.block) === block.number),
    { timeoutMs: 30_000, intervalMs: 50 }
  );
  t("reconcileDone", started, timings);

  const statusAfterBlock = await sidecar.rpc.call<{ status: string }>("skandha_frameTransactionStatus", [hash]);
  const receipt = await sidecar.rpc.call<Record<string, unknown>>("eth_getFrameTransactionReceipt", [hash]);
  const explorerTx = await sidecar.rpc.call<Record<string, unknown>>("skandha_explorer_getTransaction", [hash]);
  const observe = await readObserve(sidecar);

  result = {
    gate: "G2+G4-smoke",
    pass: statusAfterBlock.status === "OnChain" && receipt !== null && done !== undefined,
    clientVersion: node.clientVersion,
    imageId: node.imageId,
    genesisHash: node.genesis.hash,
    sidecarBuild: build,
    sidecarConfigHash: sidecar.configHash,
    explorerInfo: info,
    hash,
    block,
    statuses: { afterAdmit: statusAfterAdmit, afterRelay: statusAfterRelay, afterBlock: statusAfterBlock },
    bundle,
    receipt,
    explorerTx,
    observe,
    timings,
  };
} catch (err) {
  result = { gate: "G2+G4-smoke", pass: false, error: (err as Error).message, timings, ethrexLog: await ethrexLogs(ethrexName, 40) };
} finally {
  if (sidecar) await stopSidecar(sidecar);
  await stopEthrex(ethrexName);
}

await mkdir(runDir, { recursive: true });
await writeFile(path.join(runDir, "result.json"), JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
await writeFile(path.join(runDir, "rpc.jsonl"), evidence.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(JSON.stringify({ runDir, pass: result.pass, error: result.error, timings }));
process.exit(result.pass ? 0 : 1);
