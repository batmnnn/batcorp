import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveActor, funderActor } from "../env/actors.ts";
import { ethrexLogs, startEthrex, stopEthrex } from "../env/ethrex.ts";
import { ETHREX_PIN } from "../env/pins.ts";
import { EngineStepper, type StepResult } from "../env/stepper.ts";

const RUN_ROOT = path.resolve(import.meta.dir, "../../.runs");

interface ChainRun {
  run: number;
  startupMs: number;
  resetMs: number;
  clientVersion: string;
  imageId: string;
  genesisHash: Hex;
  blocks: Array<Pick<StepResult, "number" | "hash" | "timestamp" | "txHashes" | "ms">>;
  triggerTx: Hex;
  triggerStatus: string;
  recipientBalance: string;
}

async function oneRun(run: number): Promise<ChainRun> {
  const name = "framelab-g3-ethrex";
  const resetStarted = Date.now();
  await stopEthrex(name);
  const node = await startEthrex({ name, httpPort: 18545, authPort: 18551, workDir: path.join(RUN_ROOT, `g3-env-${run}`) });
  const resetMs = Date.now() - resetStarted;
  try {
    const stepper = new EngineStepper(node);
    await stepper.init();
    const blocks: StepResult[] = [await stepper.step()];

    const funder = privateKeyToAccount(funderActor().privateKey);
    const recipient = deriveActor("g3", "recipient").address;
    const raw = await funder.signTransaction({
      type: "eip1559",
      chainId: node.chainId,
      nonce: 0,
      to: recipient,
      value: 10n ** 18n,
      gas: 21_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const triggerTx = await node.rpc.call<Hex>("eth_sendRawTransaction", [raw]);
    blocks.push(await stepper.step({ expectTxs: [triggerTx] }));
    blocks.push(await stepper.step());

    const receipt = await node.rpc.call<{ status: Hex; blockNumber: Hex }>("eth_getTransactionReceipt", [triggerTx]);
    const balance = await node.rpc.call<Hex>("eth_getBalance", [recipient, "latest"]);
    return {
      run,
      startupMs: node.startupMs,
      resetMs,
      clientVersion: node.clientVersion,
      imageId: node.imageId,
      genesisHash: node.genesis.hash,
      blocks: blocks.map(({ number, hash, timestamp, txHashes, ms }) => ({ number, hash, timestamp, txHashes, ms })),
      triggerTx,
      triggerStatus: receipt.status,
      recipientBalance: BigInt(balance).toString(),
    };
  } catch (err) {
    console.error(await ethrexLogs(name, 60));
    throw err;
  } finally {
    await stopEthrex(name);
  }
}

const runs = [await oneRun(1), await oneRun(2)];
const [a, b] = runs as [ChainRun, ChainRun];
const sameBlocks =
  a.blocks.length === b.blocks.length &&
  a.blocks.every((block, i) => {
    const other = b.blocks[i]!;
    return block.number === other.number && block.timestamp === other.timestamp && block.hash === other.hash;
  });
const result = {
  gate: "G3-chain",
  image: ETHREX_PIN.image,
  runs,
  sameNumbersTimestampsAndHashes: sameBlocks,
  pass: sameBlocks && runs.every((r) => r.triggerStatus === "0x1"),
};
await mkdir(RUN_ROOT, { recursive: true });
const out = path.join(RUN_ROOT, `g3-chain-${Date.now()}.json`);
await writeFile(out, JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(JSON.stringify({ out, pass: result.pass, sameBlocks, startupMs: runs.map((r) => r.startupMs), resetMs: runs.map((r) => r.resetMs), stepMs: runs.map((r) => r.blocks.map((x) => x.ms)) }));
process.exit(result.pass ? 0 : 1);
