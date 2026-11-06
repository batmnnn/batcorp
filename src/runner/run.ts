import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveActor, funderActor, type Actor } from "../env/actors.ts";
import { startEthrex, stopEthrex, ethrexLogs, type EthrexHandle } from "../env/ethrex.ts";
import { readObserve, startSidecar, stopSidecar, type ObserveLine, type SidecarBuild, type SidecarHandle } from "../env/sidecar.ts";
import { EngineStepper, type StepResult } from "../env/stepper.ts";
import type { CheckpointObservation, RunEvidence, TxObservation } from "../oracle/evidence.ts";
import { normalizeStatus } from "../oracle/evidence.ts";
import type { LoadedScenario } from "../scenario/load.ts";
import type { CheckpointStep, FundStep, Step, SubmitStep, TransferStep } from "../scenario/types.ts";
import { sleep, waitUntil } from "../util/proc.ts";
import { RpcError, type RpcRecord } from "../util/rpc.ts";
import { APPROVE_SCOPE, FRAME_MODE, SIG_SCHEME, encodeRawFrameTx, signFrameTx, toWire, type FrameTransaction } from "../vendor/sidecar/frameTx.ts";

// PUBLIC TEST-ONLY: ethrex fixtures/keys/private_keys_l1.txt, funded in l1-hegota.json.
export const RELAYER_KEY: Hex = "0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d";
const MAX_FEE = 10_000_000_000n;
const TIP = 1_000_000_000n;
/**
 * Frame-tx fee cap. A normal transfer's unused fee (max fee minus effective price, times gas used)
 * stays with the sender, so a drain leaves slightly more than asked. A high frame cap keeps that
 * slack well under 1% of one frame tx's max cost.
 */
const FRAME_MAX_FEE = 500_000_000_000n;
/** enforceBalances orders by millisecond admission time; keep admissions apart so order is unambiguous. */
const ADMISSION_GAP_MS = 60;

export interface RunConfig {
  loaded: LoadedScenario;
  build: SidecarBuild;
  runDir: string;
  run: number;
  ports: { http: number; auth: number; api: number };
  bundleIntervalMs?: number;
}

export interface NormalizedEvent {
  run: number;
  at: number;
  step_id?: string;
  checkpoint_id?: string;
  block_number?: string;
  block_hash?: string;
  tx_role?: string;
  tx_hash?: string;
  raw_status?: string;
  fate?: string;
  source: "runner" | "sidecar-rpc" | "explorer" | "observe" | "ethrex";
  kind: string;
  raw?: unknown;
}

export interface RunMeta {
  run: number;
  scenario_id: string;
  scenario_hash: string;
  ethrex: { image: string; image_id: string; client_version: string; genesis_hash: string; chain_id: number; startup_ms: number };
  sidecar: { build_hash: string; commit: string; patches: SidecarBuild["patches"]; config_hash: string; startup_ms: number; boot_id: string };
  driver: { kind: "engine-stepper"; slot_seconds: number };
  reset: { method: string; ms: number };
  /** Checked before any scenario step; a failed check aborts the run as a runner-error. */
  capabilities: Record<string, string>;
  wall_ms: number;
}

export interface RunOutput {
  evidence: RunEvidence;
  events: NormalizedEvent[];
  observe: ObserveLine[];
  rpc: RpcRecord[];
  meta: RunMeta;
}

interface TxState extends TxObservation {
  role: string;
  step_id: string;
}

export function runDirFor(root: string, run: number): string {
  return path.join(root, `run${run}`);
}

export async function runScenario(cfg: RunConfig): Promise<RunOutput> {
  const { scenario } = cfg.loaded;
  const started = Date.now();
  const rpc: RpcRecord[] = [];
  const events: NormalizedEvent[] = [];
  const problems: RunEvidence["problems"] = [];
  const checkpoints: Record<string, CheckpointObservation> = {};
  const sink = (r: RpcRecord) => rpc.push(r);
  const emit = (e: Omit<NormalizedEvent, "run" | "at">) => events.push({ run: cfg.run, at: Date.now(), ...e });

  await mkdir(cfg.runDir, { recursive: true });
  const ethrexName = `framelab-run${cfg.run}-ethrex`;
  let node: EthrexHandle | undefined;
  let sidecar: SidecarHandle | undefined;
  let meta: RunMeta | undefined;

  try {
    const resetStarted = Date.now();
    await stopEthrex(ethrexName);
    node = await startEthrex({ name: ethrexName, httpPort: cfg.ports.http, authPort: cfg.ports.auth, workDir: cfg.runDir, sink });
    if (node.chainId !== scenario.genesis.chain_id) throw new Error(`chain id ${node.chainId}, scenario expects ${scenario.genesis.chain_id}`);
    const stepper = new EngineStepper(node, { sink });
    const head = await stepper.init();
    sidecar = await startSidecar({
      build: cfg.build,
      ethrexRpcUrl: node.rpcUrl,
      apiPort: cfg.ports.api,
      runDir: cfg.runDir,
      relayerPrivateKey: RELAYER_KEY,
      bundleIntervalMs: cfg.bundleIntervalMs ?? 250,
      ttlSeconds: 86_400,
      sink,
    });
    const sc = sidecar;
    // Capability check: the observation hook must report a pass for the starting head.
    await waitForPass(sc, head.number, 15_000);
    const resetMs = Date.now() - resetStarted;
    const info = await sc.rpc.call<{ bootId: string; oldestSeq: number; latestSeq: number }>("skandha_explorer_info");
    meta = {
      run: cfg.run,
      scenario_id: scenario.id,
      scenario_hash: cfg.loaded.hash,
      ethrex: { image: node.image, image_id: node.imageId, client_version: node.clientVersion, genesis_hash: node.genesis.hash, chain_id: node.chainId, startup_ms: node.startupMs },
      sidecar: { build_hash: cfg.build.buildHash, commit: cfg.build.commit, patches: cfg.build.patches, config_hash: sc.configHash, startup_ms: sc.startupMs, boot_id: info.bootId },
      driver: { kind: "engine-stepper", slot_seconds: 12 },
      reset: { method: "fresh ethrex container + fresh sidecar process and dataDir", ms: resetMs },
      capabilities: {
        chain_id: `ok: ${node.chainId}`,
        engine_head: `ok: block ${head.number}`,
        observe_pass_line: `ok: pass reported for block ${head.number}`,
        explorer_info: `ok: bootId ${info.bootId}, oldestSeq ${info.oldestSeq}`,
      },
      wall_ms: 0,
    };

    const actors = new Map<string, Actor>(scenario.actors.map((a) => [a.role, deriveActor(scenario.seed, a.role)]));
    const addresses = Object.fromEntries([...actors].map(([role, a]) => [role, a.address]));
    const funder = funderActor();
    const nextNonce = new Map<string, bigint>();
    const queuedNormal: Array<{ step_id: string; hash: Hex }> = [];
    const txs = new Map<string, TxState>();
    const eth = node.rpc;

    const takeNonce = async (address: string): Promise<bigint> => {
      let n = nextNonce.get(address);
      if (n === undefined) n = BigInt(await eth.call<Hex>("eth_getTransactionCount", [address, "latest"]));
      nextNonce.set(address, n + 1n);
      return n;
    };
    // New-account creation costs state gas on this fork (about 207k for a fresh address, about 12k otherwise).
    const transferGas = async (from: string, to: string) =>
      BigInt(await eth.call<Hex>("eth_estimateGas", [{ from, to, value: "0x1" }, "latest"]));
    const sendTransfer = async (step: Step, from: Actor, to: string, value: bigint, gas?: bigint) => {
      const account = privateKeyToAccount(from.privateKey);
      const raw = await account.signTransaction({
        type: "eip1559",
        chainId: node!.chainId,
        nonce: Number(await takeNonce(from.address)),
        to: to as Hex,
        value,
        gas: gas ?? (await transferGas(from.address, to)),
        maxFeePerGas: MAX_FEE,
        maxPriorityFeePerGas: TIP,
      });
      const hash = await eth.call<Hex>("eth_sendRawTransaction", [raw]);
      queuedNormal.push({ step_id: step.id, hash });
      emit({ source: "ethrex", kind: "normal-tx-sent", step_id: step.id, tx_hash: hash, raw: { from: from.role, to, value: value.toString() } });
    };

    const refreshTx = async (tx: TxState, checkpoint_id?: string, block?: StepResult) => {
      if (!tx.hash) return;
      let raw: { status: string; reason?: string; payer?: string } | undefined;
      try {
        raw = await sc.rpc.call<{ status: string; reason?: string; payer?: string }>("skandha_frameTransactionStatus", [tx.hash]);
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
      }
      let detail: { entry: { status?: string; revertReason?: string; submittedTime?: number } | null; events: Array<{ kind: string; status?: string; reason?: string; seq: number }> } | undefined;
      try {
        detail = await sc.rpc.call("skandha_explorer_getTransaction", [tx.hash]);
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
      }
      tx.raw_status = raw?.status ?? detail?.entry?.status;
      tx.revert_reason = raw?.reason ?? detail?.entry?.revertReason ?? detail?.events.findLast((e) => e.reason)?.reason;
      tx.fate = normalizeStatus(tx.raw_status);
      emit({
        source: "sidecar-rpc",
        kind: "status",
        checkpoint_id,
        block_number: block?.number.toString(),
        block_hash: block?.hash,
        tx_role: tx.role,
        tx_hash: tx.hash,
        raw_status: tx.raw_status,
        fate: tx.fate,
        raw: { status: raw ?? null, explorer: detail ?? null },
      });
    };

    for (const step of scenario.steps) {
      if (Date.now() - started > scenario.limits.scenario_ms) {
        problems.push({ kind: "scenario-timeout", detail: `exceeded ${scenario.limits.scenario_ms} ms before step ${step.id}` });
        break;
      }
      emit({ source: "runner", kind: "step-start", step_id: step.id, raw: step });
      switch (step.action) {
        case "fund": {
          for (const role of (step as FundStep).actors) {
            const spec = scenario.actors.find((a) => a.role === role)!;
            if (spec.fund_wei) await sendTransfer(step, funder, actors.get(role)!.address, BigInt(spec.fund_wei));
          }
          break;
        }
        case "transfer": {
          const s = step as TransferStep;
          const from = actors.get(s.actor)!;
          let value: bigint;
          const to = actors.get(s.to)!.address;
          const gas = await transferGas(from.address, to);
          if ("wei" in s.amount) {
            value = BigInt(s.amount.wei);
          } else {
            const ref = txs.get(s.amount.of_tx_role);
            if (!ref?.max_cost) {
              problems.push({ kind: "missing-data", detail: `${s.id}: no max cost for ${s.amount.of_tx_role}` });
              break;
            }
            const balance = BigInt(await eth.call<Hex>("eth_getBalance", [from.address, "latest"]));
            const leave = (BigInt(ref.max_cost) * BigInt(Math.round(s.amount.leave_max_cost_multiple * 1000))) / 1000n;
            value = balance - leave - gas * MAX_FEE;
            if (value <= 0n) {
              problems.push({ kind: "fixture", detail: `${s.id}: ${s.actor} balance ${balance} cannot leave ${leave}` });
              break;
            }
          }
          await sendTransfer(step, from, to, value, gas);
          break;
        }
        case "submit": {
          const s = step as SubmitStep;
          const actor = actors.get(s.actor)!;
          const key = BigInt(s.nonce_key);
          const nonceSeq = key === 0n ? BigInt(await eth.call<Hex>("eth_getTransactionCount", [actor.address, "latest"])) : 0n;
          const unsigned: FrameTransaction = {
            chainId: BigInt(node.chainId),
            nonceKeys: [key],
            nonceSeq,
            sender: actor.address,
            frames: [
              { mode: FRAME_MODE.VERIFY, flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT, target: null, limits: { execution: 30_000n, state: 0n }, value: 0n, data: "0x" },
              { mode: FRAME_MODE.SENDER, flags: APPROVE_SCOPE.NONE, target: s.to ? (actors.get(s.to)!.address as Hex) : actor.address, limits: { execution: 50_000n, state: 0n }, value: BigInt(s.value_wei ?? "0"), data: "0x" },
            ],
            signatures: [{ scheme: SIG_SCHEME.SECP256K1, signer: "0x", msg: "0x", signature: "0x" }],
            fees: { maxPriorityFeePerGas: TIP, maxFeePerGas: FRAME_MAX_FEE, maxFeePerBlobGas: 0n },
            blobVersionedHashes: [],
            recentRootReferences: [],
          };
          const signed = await signFrameTx(unsigned, actor.privateKey);
          const tx: TxState = { role: s.tx_role, step_id: s.id, fate: "unknown", sender: actor.address, sender_value: (s.value_wei ?? "0").toString() };
          txs.set(s.tx_role, tx);
          const sim = await eth.call<{ canonicalMempoolValid: boolean; payer: string | null; maxCost: string | null; canonicalMempoolViolation: string | null }>(
            "ethrex_simulateFrameTransaction",
            [encodeRawFrameTx(signed), "latest"]
          );
          emit({ source: "ethrex", kind: "simulate", step_id: s.id, tx_role: s.tx_role, raw: sim });
          if (sim.payer) tx.payer = sim.payer;
          if (sim.maxCost !== null && sim.maxCost !== undefined) tx.max_cost = BigInt(sim.maxCost).toString();
          try {
            tx.hash = await sc.rpc.call<Hex>("eth_sendFrameTransaction", [toWire(signed)]);
            tx.admitted_at = Date.now();
            emit({ source: "sidecar-rpc", kind: "admitted", step_id: s.id, tx_role: s.tx_role, tx_hash: tx.hash });
            await refreshTx(tx);
          } catch (err) {
            if (!(err instanceof RpcError)) throw err;
            tx.fate = "rejected";
            tx.revert_reason = err.message;
            emit({ source: "sidecar-rpc", kind: "rejected", step_id: s.id, tx_role: s.tx_role, raw: { code: err.code, message: err.message, data: err.data } });
          }
          await sleep(ADMISSION_GAP_MS);
          break;
        }
        case "advance-to-checkpoint": {
          const s = step as CheckpointStep;
          for (const tx of txs.values()) await refreshTx(tx, s.checkpoint_id);
          const pendingBefore = [...txs.values()].filter((t) => t.fate === "pending").map((t) => t.role);
          const expect = queuedNormal.splice(0).map((q) => q.hash);
          let block: StepResult;
          try {
            block = await stepper.step({ expectTxs: expect });
          } catch (err) {
            problems.push({ checkpoint_id: s.checkpoint_id, kind: "block-driver", detail: (err as Error).message });
            break;
          }
          emit({ source: "ethrex", kind: "block", checkpoint_id: s.checkpoint_id, block_number: block.number.toString(), block_hash: block.hash, raw: block });
          for (const hash of expect) {
            const receipt = await eth.call<{ status: Hex }>("eth_getTransactionReceipt", [hash]);
            if (receipt.status !== "0x1") problems.push({ checkpoint_id: s.checkpoint_id, kind: "fixture", detail: `normal tx ${hash} status ${receipt.status}` });
          }

          let pass: CheckpointObservation["pass"] = null;
          try {
            const line = await waitForPass(sc, block.number, scenario.limits.checkpoint_wait_ms);
            emit({ source: "observe", kind: line.event, checkpoint_id: s.checkpoint_id, block_number: line.block, raw: line });
            if (line.event === "reconcile.done") {
              pass = { completed: true, block: line.block, revalidated: line.revalidated ?? [], balance_cancelled: line.balanceCancelled ?? [] };
            } else {
              problems.push({ checkpoint_id: s.checkpoint_id, kind: "pass-error", detail: line.message ?? "reconcile threw" });
            }
          } catch (err) {
            problems.push({ checkpoint_id: s.checkpoint_id, kind: "pass-timeout", detail: (err as Error).message });
          }

          const now = await sc.rpc.call<{ bootId: string; oldestSeq: number }>("skandha_explorer_info");
          if (now.bootId !== meta.sidecar.boot_id) problems.push({ checkpoint_id: s.checkpoint_id, kind: "restart", detail: `bootId ${meta.sidecar.boot_id} -> ${now.bootId}` });
          if (now.oldestSeq > 1) problems.push({ checkpoint_id: s.checkpoint_id, kind: "history-gap", detail: `oldestSeq is ${now.oldestSeq}` });
          if (sc.proc.exitCode !== null) problems.push({ checkpoint_id: s.checkpoint_id, kind: "restart", detail: `sidecar exited ${sc.proc.exitCode}` });

          for (const tx of txs.values()) await refreshTx(tx, s.checkpoint_id, block);
          const balances: Record<string, string> = {};
          for (const [role, a] of actors) balances[role] = BigInt(await eth.call<Hex>("eth_getBalance", [a.address, `0x${block.number.toString(16)}`])).toString();

          checkpoints[s.checkpoint_id] = {
            checkpoint_id: s.checkpoint_id,
            block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
            pass,
            pending_before: pendingBefore,
            txs: Object.fromEntries([...txs].map(([role, t]) => [role, observationOf(t)])),
            addresses,
            balances,
          };
          break;
        }
      }
    }
  } catch (err) {
    problems.push({ kind: "runner-error", detail: (err as Error).message });
    if (node) emit({ source: "ethrex", kind: "log-tail", raw: await ethrexLogs(ethrexName, 40) });
  } finally {
    if (sidecar) await stopSidecar(sidecar);
    await stopEthrex(ethrexName);
  }

  const observe = sidecar ? await readObserve(sidecar).catch(() => []) : [];
  if (!meta) throw new Error(`run ${cfg.run} failed before setup completed: ${problems.map((p) => p.detail).join("; ")}`);
  meta.wall_ms = Date.now() - started;
  return { evidence: { run: cfg.run, checkpoints, problems }, events, observe, rpc, meta };
}

function observationOf(t: TxState): TxObservation {
  const { role: _role, step_id: _step, ...obs } = t;
  return { ...obs };
}

async function waitForPass(sc: SidecarHandle, block: bigint, timeoutMs: number): Promise<ObserveLine> {
  return waitUntil(
    `reconcile pass for block ${block}`,
    async () =>
      (await readObserve(sc)).find((l) => (l.event === "reconcile.done" || l.event === "reconcile.error") && BigInt(l.block) === block),
    { timeoutMs, intervalMs: 50 }
  );
}

export async function writeRunFiles(dir: string, out: RunOutput): Promise<void> {
  const big = (_k: string, x: unknown) => (typeof x === "bigint" ? x.toString() : x);
  const json = (v: unknown) => JSON.stringify(v, big, 2);
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r, big)).join("\n") + "\n";
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "evidence.json"), json(out.evidence));
  await writeFile(path.join(dir, "events.jsonl"), jsonl(out.events));
  await writeFile(path.join(dir, "rpc.jsonl"), jsonl(out.rpc));
  await writeFile(path.join(dir, "meta.json"), json(out.meta));
}
