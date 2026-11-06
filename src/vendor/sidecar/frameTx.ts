// Extracted from the ERC-8421 Mempool Sidecar at 2e22ff0a2898e69ea4bf5275bce1be8581a8582a:
//   packages/types/src/contracts/FrameTx.ts (types and constants used below)
//   packages/executor/src/services/FrameTxService/codec.ts (encodeFrameTx, computeSigHash, encodeRawFrameTx)
//   test/e2e/helpers.ts (buildUnsignedFrameTx, signFrameTx, toWire)
// Copyright (c) 2023 Etherspot. MIT License; full text in NOTICE.
// Only imports and default arguments were changed.
import { RLP, type Input } from "@ethereumjs/rlp";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

export const FRAME_MODE = {
  DEFAULT: 0,
  VERIFY: 1,
  SENDER: 2,
} as const;
export type FrameMode = (typeof FRAME_MODE)[keyof typeof FRAME_MODE];

export const APPROVE_SCOPE = {
  NONE: 0x0,
  PAYMENT: 0x1,
  EXECUTION: 0x2,
  EXECUTION_AND_PAYMENT: 0x3,
} as const;
export type ApproveScope = (typeof APPROVE_SCOPE)[keyof typeof APPROVE_SCOPE];

export const ATOMIC_BATCH_FLAG = 0x4;

export interface FrameLimits {
  execution: bigint;
  state: bigint;
}

export interface Frame {
  mode: FrameMode;
  /** bits 0-1: approval scope (see APPROVE_SCOPE); bit 2: ATOMIC_BATCH_FLAG */
  flags: number;
  target: `0x${string}` | null;
  limits: FrameLimits;
  value: bigint;
  data: `0x${string}`;
}

export const SIG_SCHEME = {
  ARBITRARY: 0x0,
  SECP256K1: 0x1,
  P256: 0x2,
} as const;
export type SigScheme = (typeof SIG_SCHEME)[keyof typeof SIG_SCHEME];

export interface SignatureEntry {
  scheme: SigScheme;
  /** empty for ARBITRARY; 20-byte address for SECP256K1/P256 */
  signer: `0x${string}` | "0x";
  /** empty (canonical sig hash) or an explicit 32-byte digest */
  msg: `0x${string}` | "0x";
  signature: `0x${string}`;
}

export interface FeeParams {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  maxFeePerBlobGas: bigint;
}

export interface RecentRootReference {
  sourceId: `0x${string}`;
  slot: bigint;
  root: `0x${string}`;
}

export interface FrameTransaction {
  chainId: bigint;
  nonceKeys: bigint[];
  nonceSeq: bigint;
  sender: `0x${string}`;
  frames: Frame[];
  signatures: SignatureEntry[];
  fees: FeeParams;
  blobVersionedHashes: `0x${string}`[];
  recentRootReferences: RecentRootReference[];
}

export const FRAME_TX_TYPE = 0x06;
export const ENTRY_POINT = "0x00000000000000000000000000000000000000aa" as const;

function encodeBigint(n: bigint): Uint8Array {
  if (n === BigInt(0)) return new Uint8Array();
  return toBytes(toHex(n));
}

function encodeFrame(f: Frame): Input[] {
  return [
    encodeBigint(BigInt(f.mode)),
    encodeBigint(BigInt(f.flags)),
    f.target ? toBytes(f.target) : new Uint8Array(),
    [encodeBigint(f.limits.execution), encodeBigint(f.limits.state)],
    encodeBigint(f.value),
    toBytes(f.data),
  ];
}

function encodeSignature(s: SignatureEntry): Input[] {
  return [encodeBigint(BigInt(s.scheme)), toBytes(s.signer), toBytes(s.msg), toBytes(s.signature)];
}

function encodeFees(fees: FeeParams): Input[] {
  return [
    encodeBigint(fees.maxPriorityFeePerGas),
    encodeBigint(fees.maxFeePerGas),
    encodeBigint(fees.maxFeePerBlobGas),
  ];
}

function encodeRecentRootReference(ref: RecentRootReference): Input[] {
  return [toBytes(ref.sourceId), encodeBigint(ref.slot), toBytes(ref.root)];
}

export function encodeFrameTx(tx: FrameTransaction): Uint8Array {
  const structure: Input[] = [
    encodeBigint(tx.chainId),
    tx.nonceKeys.map(encodeBigint),
    encodeBigint(tx.nonceSeq),
    toBytes(tx.sender),
    tx.frames.map(encodeFrame),
    tx.signatures.map(encodeSignature),
    encodeFees(tx.fees),
    tx.blobVersionedHashes.map((h) => toBytes(h)),
    tx.recentRootReferences.map(encodeRecentRootReference),
  ];
  return RLP.encode(structure);
}

/** Per EIP-8141 §Signature Hash: elide raw signature bytes for any
 * signature entry whose msg is empty before hashing. */
export function computeSigHash(tx: FrameTransaction): Hex {
  const elided: FrameTransaction = {
    ...tx,
    signatures: tx.signatures.map((s) => (s.msg === "0x" ? { ...s, signature: "0x" as const } : s)),
  };
  const payload = new Uint8Array([FRAME_TX_TYPE, ...encodeFrameTx(elided)]);
  return keccak256(payload);
}

export function encodeRawFrameTx(tx: FrameTransaction): Hex {
  return toHex(new Uint8Array([FRAME_TX_TYPE, ...encodeFrameTx(tx)]));
}

export function buildUnsignedFrameTx(
  nonce: bigint,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  privateKey: Hex,
  chainId: number,
  recipient: `0x${string}`
): FrameTransaction {
  const sender = privateKeyToAccount(privateKey).address;
  return {
    chainId: BigInt(chainId),
    nonceKeys: [0n],
    nonceSeq: nonce,
    sender,
    frames: [
      {
        mode: FRAME_MODE.VERIFY,
        flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
        target: null,
        limits: { execution: BigInt(30000), state: BigInt(0) },
        value: BigInt(0),
        data: "0x",
      },
      {
        mode: FRAME_MODE.SENDER,
        flags: APPROVE_SCOPE.NONE,
        target: recipient,
        limits: { execution: BigInt(50000), state: BigInt(0) },
        value: BigInt(1),
        data: "0x",
      },
    ],
    signatures: [
      {
        scheme: SIG_SCHEME.SECP256K1,
        signer: "0x",
        msg: "0x",
        signature: "0x",
      },
    ],
    fees: {
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxFeePerBlobGas: BigInt(0),
    },
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
}

/**
 * Signs over `computeSigHash` (which elides signature bytes for entries whose
 * `msg` is empty) and packs the result the way `validateSignature` reads it
 * back: `v || r || s`, with `v` the 0/1 recovery id, not 27/28.
 */
export async function signFrameTx(tx: FrameTransaction, privateKey: Hex): Promise<FrameTransaction> {
  const sigHash = computeSigHash(tx);
  const signature = await sign({ hash: sigHash, privateKey });
  const v = Number(signature.v) - 27;
  const packed = ("0x" + v.toString(16).padStart(2, "0") + signature.r.slice(2) + signature.s.slice(2)) as Hex;
  return {
    ...tx,
    signatures: [{ ...tx.signatures[0]!, signature: packed }],
  };
}

export function toWire(tx: FrameTransaction): unknown {
  const hex = (n: bigint): string => `0x${n.toString(16)}`;
  return {
    chainId: hex(tx.chainId),
    nonceKeys: tx.nonceKeys.map(hex),
    nonceSeq: hex(tx.nonceSeq),
    sender: tx.sender,
    frames: tx.frames.map((f) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: { execution: hex(f.limits.execution), state: hex(f.limits.state) },
      value: hex(f.value),
      data: f.data,
    })),
    signatures: tx.signatures.map((s) => ({
      scheme: s.scheme,
      signer: s.signer,
      msg: s.msg,
      signature: s.signature,
    })),
    fees: {
      maxPriorityFeePerGas: hex(tx.fees.maxPriorityFeePerGas),
      maxFeePerGas: hex(tx.fees.maxFeePerGas),
      maxFeePerBlobGas: hex(tx.fees.maxFeePerBlobGas),
    },
    blobVersionedHashes: tx.blobVersionedHashes,
    recentRootReferences: tx.recentRootReferences.map((r) => ({
      sourceId: r.sourceId,
      slot: hex(r.slot),
      root: r.root,
    })),
  };
}
