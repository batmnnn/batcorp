import type { Fate } from "../scenario/types.ts";

/** One tx role as observed at a checkpoint. Raw fields are kept beside the normalized fate. */
export interface TxObservation {
  hash?: string;
  raw_status?: string;
  revert_reason?: string;
  fate: Fate | "unknown";
  admitted_at?: number;
  sender?: string;
  payer?: string;
  /** From ethrex_simulateFrameTransaction (the EL), not from the sidecar under test. */
  max_cost?: string;
  sender_value?: string;
}

export interface PassObservation {
  completed: boolean;
  block: string;
  revalidated: string[];
  balance_cancelled: string[];
}

export interface CheckpointObservation {
  checkpoint_id: string;
  block: { number: string; hash: string; timestamp: string } | null;
  pass: PassObservation | null;
  /** Pending-before-checkpoint view: tx roles the run held as pending right before this checkpoint's block. */
  pending_before: string[];
  txs: Record<string, TxObservation>;
  /** Actor role -> address. */
  addresses: Record<string, string>;
  /** Actor role -> balance (decimal wei) at the checkpoint block. */
  balances: Record<string, string>;
  /** `role:0xslot` -> 32-byte value at the checkpoint block, for the scenario's watch_storage. */
  storage?: Record<string, string>;
}

export interface RunEvidence {
  run: number;
  checkpoints: Record<string, CheckpointObservation>;
  /** Restart, history gap, transport failure, timeout: each one makes affected assertions inconclusive. */
  problems: Array<{ checkpoint_id?: string; kind: string; detail: string }>;
}

export function normalizeStatus(raw: string | undefined): Fate | "unknown" {
  switch (raw) {
    case "New":
    case "Pending":
    case "Submitted":
      return "pending";
    case "OnChain":
    case "Finalized":
      return "included-success";
    case "Reverted":
      return "included-revert";
    case "Cancelled":
      return "evicted";
    default:
      return "unknown";
  }
}
