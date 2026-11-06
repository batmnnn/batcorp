/**
 * Runs `framelab devnet`'s submit path end to end against the pinned local stack instead of the
 * public network: same encoder, same RPC allowlist, same funding and inclusion checks. A
 * background stepper mines a block every second, standing in for the public chain's slots.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Hex } from "viem";
import { funderActor } from "../env/actors.ts";
import { startEthrex, stopEthrex } from "../env/ethrex.ts";
import { ensureSidecarBuild, startSidecar, stopSidecar, type SidecarHandle } from "../env/sidecar.ts";
import { EngineStepper } from "../env/stepper.ts";
import { submitQualifyingTx } from "../devnet/submit.ts";
import { RELAYER_KEY } from "../runner/run.ts";

const FRAMELAB_ROOT = path.resolve(import.meta.dir, "../..");
const outDir = path.join(FRAMELAB_ROOT, ".runs", `devnet-local-${Date.now()}`);
const name = "framelab-devnet-local-ethrex";
const keyDir = await mkdtemp(path.join(os.tmpdir(), "framelab-devnet-local-"));
let sidecar: SidecarHandle | undefined;
let mining = true;
let exit = 2;
try {
  await stopEthrex(name);
  const node = await startEthrex({ name, httpPort: 18545, authPort: 18551, workDir: outDir, sink: () => {} });
  const stepper = new EngineStepper(node, { sink: () => {} });
  await stepper.init();
  await stepper.step();
  const build = await ensureSidecarBuild("observe", [path.join(FRAMELAB_ROOT, "patches/sidecar-observe.patch")]);
  sidecar = await startSidecar({ build, ethrexRpcUrl: node.rpcUrl, apiPort: 15437, runDir: outDir, relayerPrivateKey: RELAYER_KEY, bundleIntervalMs: 250, ttlSeconds: 86_400, bundlingMode: "auto", sink: () => {} });
  const miner = (async () => {
    while (mining) {
      await new Promise((r) => setTimeout(r, 1_000));
      if (mining) await stepper.step();
    }
  })();
  const funder = funderActor();
  for (const dryRun of [true, false]) {
    const r = await submitQualifyingTx({
      target: {
        name: "pinned local stack",
        executionRpc: node.rpcUrl,
        sidecarRpc: sidecar.rpc.url,
        chainId: node.chainId,
        funder: { address: funder.address as Hex, key: async () => funder.privateKey },
      },
      outDir: path.join(outDir, dryRun ? "dry-run" : "submit"),
      framelabRoot: FRAMELAB_ROOT,
      keyFile: path.join(keyDir, "throwaway.key"),
      dryRun,
      // The stepper's block timestamps follow the genesis clock, not the wall clock.
      maxHeadAgeMs: Number.POSITIVE_INFINITY,
      inclusionTimeoutMs: 60_000,
      log: (line) => console.error(`  ${line}`),
    });
    console.log(`${dryRun ? "dry run" : "submit"}: exit ${r.exit}: ${r.summary}`);
    exit = r.exit;
    if (r.exit !== 0) break;
  }
  mining = false;
  await miner;
} finally {
  mining = false;
  if (sidecar) await stopSidecar(sidecar);
  await stopEthrex(name);
  await rm(keyDir, { recursive: true, force: true });
}
console.log(`-> ${outDir}`);
process.exit(exit);
