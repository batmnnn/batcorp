import { createHash, createHmac } from "node:crypto";
import type { Address, Hex } from "viem";
import { sleep } from "../util/proc.ts";
import { RpcClient, type RpcSink } from "../util/rpc.ts";
import type { EthrexHandle } from "./ethrex.ts";

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

export interface StepperOptions {
  slotSeconds?: number;
  feeRecipient?: Address;
  buildWaitMs?: number;
  sink?: RpcSink;
}

export interface BlockRef {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface StepResult extends BlockRef {
  txHashes: Hex[];
  ms: number;
}

interface PayloadStatus {
  status: string;
  latestValidHash: Hex | null;
  validationError: string | null;
}

interface ExecutionPayloadResponse {
  executionPayload: Record<string, unknown> & { blockHash: Hex; blockNumber: Hex; transactions: Hex[] };
  blobsBundle?: { commitments: Hex[] } | null;
  executionRequests?: Hex[] | null;
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

export function engineJwt(secret: Buffer, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSec }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function kzgToVersionedHash(commitment: Hex): Hex {
  const digest = createHash("sha256").update(Buffer.from(commitment.slice(2), "hex")).digest();
  digest[0] = 0x01;
  return `0x${digest.toString("hex")}`;
}

/**
 * Single-node payload stepper over ethrex's Hegota engine API
 * (forkchoiceUpdatedV5 -> getPayloadV6 -> newPayloadV6 -> forkchoiceUpdatedV5).
 * Block n gets timestamp genesis + slotSeconds * n and slot n, so the same step
 * list yields the same block numbers and timestamps on every fresh chain.
 */
export class EngineStepper {
  private engine: RpcClient;
  private head!: BlockRef;
  private readonly slotSeconds: number;
  private readonly feeRecipient: Address;
  private readonly buildWaitMs: number;

  constructor(
    private node: EthrexHandle,
    opts: StepperOptions = {}
  ) {
    this.slotSeconds = opts.slotSeconds ?? 12;
    this.feeRecipient = opts.feeRecipient ?? "0x000000000000000000000000000000000000fee1";
    this.buildWaitMs = opts.buildWaitMs ?? 300;
    this.engine = new RpcClient(node.authUrl, {
      headers: () => ({ authorization: `Bearer ${engineJwt(node.jwtSecret)}` }),
      sink: opts.sink,
      timeoutMs: 60_000,
    });
  }

  async init(): Promise<BlockRef> {
    const latest = await this.node.rpc.call<{ number: Hex; hash: Hex; timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    this.head = { number: BigInt(latest.number), hash: latest.hash, timestamp: BigInt(latest.timestamp) };
    return this.head;
  }

  get current(): BlockRef {
    return this.head;
  }

  async step({ expectTxs = [] }: { expectTxs?: Hex[] } = {}): Promise<StepResult> {
    const started = Date.now();
    const number = this.head.number + 1n;
    const timestamp = this.node.genesis.timestamp + BigInt(this.slotSeconds) * number;
    const state = { headBlockHash: this.head.hash, safeBlockHash: this.head.hash, finalizedBlockHash: this.head.hash };

    const fcu = await this.engine.call<{ payloadStatus: PayloadStatus; payloadId: Hex | null }>("engine_forkchoiceUpdatedV5", [
      state,
      {
        timestamp: `0x${timestamp.toString(16)}`,
        prevRandao: ZERO_HASH,
        suggestedFeeRecipient: this.feeRecipient,
        withdrawals: [],
        parentBeaconBlockRoot: ZERO_HASH,
        slotNumber: `0x${number.toString(16)}`,
        inclusionListTransactions: [],
        targetGasLimit: `0x${this.node.genesis.gasLimit.toString(16)}`,
      },
    ]);
    if (fcu.payloadStatus.status !== "VALID" || !fcu.payloadId) {
      throw new Error(`forkchoiceUpdatedV5 for block ${number}: ${JSON.stringify(fcu)}`);
    }

    await sleep(this.buildWaitMs);
    const built = await this.engine.call<ExecutionPayloadResponse>("engine_getPayloadV6", [fcu.payloadId]);
    const payload = built.executionPayload;
    const versionedHashes = (built.blobsBundle?.commitments ?? []).map(kzgToVersionedHash);

    const status = await this.engine.call<PayloadStatus>("engine_newPayloadV6", [
      payload,
      versionedHashes,
      ZERO_HASH,
      built.executionRequests ?? [],
      [],
    ]);
    if (status.status !== "VALID") {
      throw new Error(`newPayloadV6 for block ${number}: ${status.status} ${status.validationError ?? ""}`);
    }

    const setHead = await this.engine.call<{ payloadStatus: PayloadStatus }>("engine_forkchoiceUpdatedV5", [
      { headBlockHash: payload.blockHash, safeBlockHash: payload.blockHash, finalizedBlockHash: payload.blockHash },
    ]);
    if (setHead.payloadStatus.status !== "VALID") {
      throw new Error(`forkchoiceUpdatedV5 head update to ${payload.blockHash}: ${JSON.stringify(setHead)}`);
    }

    const block = await this.node.rpc.call<{ number: Hex; hash: Hex; timestamp: Hex; transactions: Hex[] }>("eth_getBlockByNumber", ["latest", false]);
    if (block.hash !== payload.blockHash || BigInt(block.number) !== number) {
      throw new Error(`head after step is ${block.number}/${block.hash}, expected ${number}/${payload.blockHash}`);
    }
    const missing = expectTxs.filter((tx) => !block.transactions.includes(tx));
    if (missing.length > 0) {
      throw new Error(`block ${number} is missing expected transactions: ${missing.join(", ")}`);
    }

    this.head = { number, hash: block.hash, timestamp: BigInt(block.timestamp) };
    return { ...this.head, txHashes: block.transactions, ms: Date.now() - started };
  }
}
