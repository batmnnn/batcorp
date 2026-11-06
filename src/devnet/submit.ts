/**
 * One qualifying frame transaction on a live alt-mempool network. This is the only FrameLab code
 * that talks to a public network. It sends at most two transactions per call: a plain transfer
 * that funds a throwaway key once from the network's published genesis account, and one frame
 * transaction from that key back to itself. Every RPC method it may call is listed below.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { scanText } from "../bundle/scan.ts";
import { ETHREX_PIN, SIDECAR_PIN } from "../env/pins.ts";
import { RpcClient, RpcError, type RpcRecord } from "../util/rpc.ts";
import { buildUnsignedFrameTx, encodeRawFrameTx, signFrameTx, toWire } from "../vendor/sidecar/frameTx.ts";

export interface DevnetTarget {
  name: string;
  executionRpc: string;
  sidecarRpc: string;
  chainId: number;
  explorerTxUrl?: (hash: Hex) => string;
  /** Account funded at genesis whose key the network's operators publish on purpose. */
  funder: { address: Hex; key: () => Promise<Hex> };
}

const PUBLIC_SIDECAR_RPC = "https://altmempool.forshtat.com/rpc";

/** The workshop devnet (docs.altmempool.wtf/guides/devnet): throwaway, no value, may be reset. */
export const PUBLIC_DEVNET: DevnetTarget = {
  name: "public alt-mempool devnet",
  executionRpc: "https://altmempool.forshtat.com",
  sidecarRpc: PUBLIC_SIDECAR_RPC,
  chainId: 1337,
  explorerTxUrl: (hash) => `https://explorer.altmempool.wtf/tx/${hash}?node=${encodeURIComponent(PUBLIC_SIDECAR_RPC)}`,
  funder: { address: "0x5544596212F91984C986A919C8026DF0576816f9", key: () => publishedGenesisKey() },
};

/** The devnet's genesis key as committed in the pinned sidecar checkout (deploy/devnet/genesis.values.env). */
async function publishedGenesisKey(): Promise<Hex> {
  const file = path.join(SIDECAR_PIN.dir, "deploy/devnet/genesis.values.env");
  const m = /private key:\s*(0x[0-9a-fA-F]{64})/.exec(await readFile(file, "utf8"));
  if (!m) throw new Error(`no published genesis key in ${file}`);
  return m[1] as Hex;
}

const EXECUTION_METHODS = new Set([
  "eth_chainId",
  "web3_clientVersion",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
  "ethrex_simulateFrameTransaction",
]);
const SIDECAR_METHODS = new Set([
  "eth_chainId",
  "skandha_explorer_info",
  "eth_sendFrameTransaction",
  "skandha_frameTransactionStatus",
  "eth_getFrameTransactionReceipt",
  "skandha_explorer_getTransaction",
]);

class AllowlistedRpc {
  constructor(
    private rpc: RpcClient,
    private allowed: Set<string>
  ) {}
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.allowed.has(method)) throw new Error(`${method} is not on FrameLab's devnet method allowlist`);
    return this.rpc.call<T>(method, params);
  }
}

export const DEFAULT_KEY_FILE = process.env.FRAMELAB_DEVNET_KEY_FILE ?? path.join(os.homedir(), ".framelab", "devnet-throwaway.key");

/** Reads the throwaway key, creating it if asked. It must live outside the FrameLab checkout. */
export async function throwawayKey(file: string, framelabRoot: string, create: boolean): Promise<Hex | null> {
  const abs = path.resolve(file);
  if (abs === framelabRoot || abs.startsWith(framelabRoot + path.sep)) throw new Error(`the throwaway key file must be outside the FrameLab checkout: ${abs}`);
  const existing = await readFile(abs, "utf8").then((t) => t.trim(), () => null);
  if (existing !== null) {
    if (!/^0x[0-9a-f]{64}$/i.test(existing)) throw new Error(`${abs} does not hold a 32-byte hex key`);
    return existing as Hex;
  }
  if (!create) return null;
  await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  const key = generatePrivateKey();
  await writeFile(abs, key + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

export interface SubmitOptions {
  target: DevnetTarget;
  outDir: string;
  framelabRoot: string;
  keyFile: string;
  dryRun: boolean;
  /** Refuse to run while the head block is older than this. */
  maxHeadAgeMs: number;
  inclusionTimeoutMs: number;
  log: (line: string) => void;
}

export interface SubmitResult {
  exit: 0 | 1 | 2;
  summary: string;
  record: Record<string, unknown>;
}

const FUND_WEI = 10_000_000_000_000_000n; // 0.01 ETH: thousands of frame txs at devnet fees
const MIN_BALANCE_WEI = FUND_WEI / 2n;
const TIP = 1_000_000_000n;
const POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (h: string) => BigInt(h);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export async function submitQualifyingTx(opts: SubmitOptions): Promise<SubmitResult> {
  const { target, log } = opts;
  const evidence: RpcRecord[] = [];
  const sink = (r: RpcRecord) => evidence.push(r);
  const eth = new AllowlistedRpc(new RpcClient(target.executionRpc, { sink, timeoutMs: 20_000 }), EXECUTION_METHODS);
  const sc = new AllowlistedRpc(new RpcClient(target.sidecarRpc, { sink, timeoutMs: 20_000 }), SIDECAR_METHODS);
  const record: Record<string, unknown> = { target: { name: target.name, execution_rpc: target.executionRpc, sidecar_rpc: target.sidecarRpc, chain_id: target.chainId }, started_at: new Date().toISOString(), dry_run: opts.dryRun };
  const secrets: string[] = [];

  const finish = async (exit: 0 | 1 | 2, summary: string): Promise<SubmitResult> => {
    record.result = { exit, summary };
    record.finished_at = new Date().toISOString();
    const text = json(record);
    const rpcText = evidence.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const known = secrets.map((value, i) => ({ label: `signing key ${i + 1}`, value }));
    const leaks = [...scanText("devnet.json", text, known), ...scanText("rpc.jsonl", rpcText, known)].filter((f) => f.kind.startsWith("known secret"));
    if (leaks.length) throw new Error(`refusing to write the record: a signing key would be in ${leaks.map((l) => l.file).join(", ")}`);
    await mkdir(opts.outDir, { recursive: true });
    await writeFile(path.join(opts.outDir, "devnet.json"), text);
    await writeFile(path.join(opts.outDir, "rpc.jsonl"), rpcText);
    return { exit, summary, record };
  };

  // 1. Read-only preflight: the right network, the codec FrameLab encodes, and a live chain.
  const [chainHex, scChainHex, clientVersion] = await Promise.all([eth.call<Hex>("eth_chainId"), sc.call<Hex>("eth_chainId"), eth.call<string>("web3_clientVersion")]);
  const sidecarInfo = await sc.call<Record<string, unknown>>("skandha_explorer_info").catch((e) => ({ unavailable: (e as Error).message }));
  const head = await eth.call<{ number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas: Hex }>("eth_getBlockByNumber", ["latest", false]);
  const headAgeMs = Date.now() - Number(big(head.timestamp)) * 1000;
  record.preflight = { chain_id: Number(big(chainHex)), sidecar_chain_id: Number(big(scChainHex)), client_version: clientVersion, sidecar: sidecarInfo, head: { number: big(head.number), hash: head.hash, age_s: Math.round(headAgeMs / 1000), base_fee: big(head.baseFeePerGas) } };
  if (Number(big(chainHex)) !== target.chainId || Number(big(scChainHex)) !== target.chainId) {
    return finish(2, `wrong network: execution chain ${big(chainHex)}, sidecar chain ${big(scChainHex)}, expected ${target.chainId}`);
  }
  if (!clientVersion.includes(ETHREX_PIN.commit)) {
    return finish(2, `not applicable: the network runs ${clientVersion}; FrameLab's frame-tx encoder is pinned to forshtat/ethrex@${ETHREX_PIN.commit}`);
  }
  if (headAgeMs > opts.maxHeadAgeMs) {
    return finish(2, `the network is not producing blocks: head ${big(head.number)} is ${Math.round(headAgeMs / 60_000)} min old, so nothing sent now would be included; nothing was sent`);
  }
  log(`preflight: chain ${target.chainId}, ${clientVersion}, head ${big(head.number)} (${Math.round(headAgeMs / 1000)} s old), base fee ${big(head.baseFeePerGas)} wei`);

  // 2. Keys. The funder key must be the one the operators publish for the documented address.
  const funderKey = await target.funder.key();
  secrets.push(funderKey);
  if (privateKeyToAccount(funderKey).address.toLowerCase() !== target.funder.address.toLowerCase()) {
    return finish(2, `the funder key does not belong to the documented genesis account ${target.funder.address}`);
  }
  const key = await throwawayKey(opts.keyFile, opts.framelabRoot, !opts.dryRun);
  if (key) secrets.push(key);
  const sender = key ? privateKeyToAccount(key).address : null;
  record.sender = sender ?? "(not created: dry run)";
  const balance = sender ? big(await eth.call<Hex>("eth_getBalance", [sender, "latest"])) : 0n;
  log(`throwaway sender ${sender ?? "(would be created)"}: balance ${balance} wei`);

  const baseFee = big(head.baseFeePerGas);
  const fees = { maxFeePerGas: baseFee * 2n + TIP, maxPriorityFeePerGas: TIP };

  // 3. Fund once, from the published genesis account, only when needed.
  if (balance < MIN_BALANCE_WEI) {
    if (opts.dryRun || !sender) {
      record.funding = { would_send_wei: FUND_WEI, from: target.funder.address };
      return finish(0, `dry run: would fund the throwaway key with ${FUND_WEI} wei from ${target.funder.address}, then send one frame tx; nothing was sent`);
    }
    const funder = privateKeyToAccount(funderKey);
    const gasEstimate = big(await eth.call<Hex>("eth_estimateGas", [{ from: funder.address, to: sender, value: `0x${FUND_WEI.toString(16)}` }, "latest"]));
    const gas = (gasEstimate * 6n) / 5n;
    let fundHash: Hex | null = null;
    // The genesis account is shared, so another user can take the nonce between read and send.
    for (let attempt = 1; attempt <= 3 && !fundHash; attempt++) {
      const nonce = big(await eth.call<Hex>("eth_getTransactionCount", [funder.address, "pending"]));
      const raw = await funder.signTransaction({ type: "eip1559", chainId: target.chainId, nonce: Number(nonce), to: sender, value: FUND_WEI, gas, ...fees });
      try {
        fundHash = await eth.call<Hex>("eth_sendRawTransaction", [raw]);
      } catch (err) {
        if (!(err instanceof RpcError) || !/nonce|already known|underpriced/i.test(err.message) || attempt === 3) throw err;
        log(`funding attempt ${attempt}: ${err.message}; retrying with a fresh nonce`);
        await sleep(1_000);
      }
    }
    log(`funding transfer sent: ${fundHash}`);
    const receipt = await waitFor(opts.inclusionTimeoutMs, () => eth.call<{ status: Hex; blockNumber: Hex } | null>("eth_getTransactionReceipt", [fundHash]));
    record.funding = { tx_hash: fundHash, from: funder.address, value_wei: FUND_WEI, gas, receipt };
    if (!receipt) return finish(2, `the funding transfer ${fundHash} was not included within ${opts.inclusionTimeoutMs / 1000} s; no frame tx was sent`);
    if (receipt.status !== "0x1") return finish(2, `the funding transfer ${fundHash} reverted; no frame tx was sent`);
    log(`funding included in block ${big(receipt.blockNumber)}`);
  }

  // 4. One frame tx: VERIFY approves execution and payment, SENDER moves 1 wei to itself.
  const nonce = big(await eth.call<Hex>("eth_getTransactionCount", [sender!, "latest"]));
  const tx = await signFrameTx(buildUnsignedFrameTx(nonce, fees, key!, target.chainId, sender!), key!);
  const raw = encodeRawFrameTx(tx);
  const simulation = await eth.call<Record<string, unknown>>("ethrex_simulateFrameTransaction", [raw, "latest"]);
  record.frame_tx = { nonce_key: 0, nonce_seq: nonce, fees, raw, simulation };
  if (opts.dryRun) return finish(0, `dry run: the frame tx simulates (${JSON.stringify(simulation).slice(0, 160)}); nothing was sent`);

  let hash: Hex;
  try {
    hash = await sc.call<Hex>("eth_sendFrameTransaction", [toWire(tx)]);
  } catch (err) {
    if (!(err instanceof RpcError)) throw err;
    record.frame_tx = { ...(record.frame_tx as object), rejected: { code: err.code, message: err.message, data: err.data } };
    return finish(1, `the sidecar rejected the frame tx: ${err.message}`);
  }
  log(`admitted by the sidecar: ${hash}`);
  const statuses: Array<{ at: string; status: string; reason?: string }> = [];
  const final = await waitFor(opts.inclusionTimeoutMs, async () => {
    const s = await sc.call<{ status: string; reason?: string }>("skandha_frameTransactionStatus", [hash]).catch(() => null);
    if (s && statuses.at(-1)?.status !== s.status) {
      statuses.push({ at: new Date().toISOString(), status: s.status, ...(s.reason ? { reason: s.reason } : {}) });
      log(`status ${s.status}${s.reason ? ` (${s.reason})` : ""}`);
    }
    return s && ["OnChain", "Finalized", "Reverted", "Cancelled"].includes(s.status) ? s : null;
  });
  const receipt = await sc.call<{ blockNumber?: Hex; blockHash?: Hex; status?: Hex } | null>("eth_getFrameTransactionReceipt", [hash]).catch(() => null);
  const explorer = await sc.call<unknown>("skandha_explorer_getTransaction", [hash]).catch((e) => ({ unavailable: (e as Error).message }));
  const link = target.explorerTxUrl?.(hash) ?? null;
  record.frame_tx = { ...(record.frame_tx as object), hash, statuses, receipt, explorer, explorer_url: link };
  if (!final) return finish(2, `admitted as ${hash} but not included within ${opts.inclusionTimeoutMs / 1000} s (last status ${statuses.at(-1)?.status ?? "unknown"})${link ? `: ${link}` : ""}`);
  if (final.status === "Reverted" || final.status === "Cancelled") return finish(1, `${hash} ended ${final.status}${final.reason ? `: ${final.reason}` : ""}`);
  return finish(0, `${hash} included in block ${receipt?.blockNumber ? big(receipt.blockNumber) : "?"} (${final.status})${link ? `: ${link}` : ""}`);
}

async function waitFor<T>(timeoutMs: number, poll: () => Promise<T | null>): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await poll();
    if (v) return v;
    await sleep(POLL_MS);
  }
  return null;
}

/** Earlier non-dry runs against the same network that ended with the tx on chain. */
export async function earlierInclusions(runsDir: string, target: DevnetTarget): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(runsDir).catch(() => [] as string[])) {
    if (!d.startsWith("devnet-")) continue;
    const r = await readFile(path.join(runsDir, d, "devnet.json"), "utf8").then(JSON.parse, () => null);
    if (r && !r.dry_run && r.target?.chain_id === target.chainId && r.target?.sidecar_rpc === target.sidecarRpc && r.result?.exit === 0) out.push(path.join(runsDir, d));
  }
  return out;
}
