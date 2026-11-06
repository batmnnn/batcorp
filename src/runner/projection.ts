import type { RunEvidence } from "../oracle/evidence.ts";
import type { RunVerdict } from "../oracle/verdict.ts";

/** Fields left out of the run-to-run comparison. Fates, dependency values and verdicts are never excluded. */
export const EXCLUDED_FROM_COMPARISON = [
  "absolute admission times (relative admission order is compared)",
  "problem detail text (problem kinds are compared)",
  "RPC timings, wall-clock times, explorer bootId",
  "ports, run directories, container names",
];

export function project(evidence: RunEvidence, verdict: RunVerdict) {
  return {
    problems: evidence.problems.map((p) => ({ kind: p.kind, checkpoint_id: p.checkpoint_id ?? null })),
    checkpoints: Object.values(evidence.checkpoints).map((cp) => ({
      checkpoint_id: cp.checkpoint_id,
      block: cp.block,
      pass: cp.pass && {
        completed: cp.pass.completed,
        block: cp.pass.block,
        revalidated: [...cp.pass.revalidated].sort(),
        balance_cancelled: [...cp.pass.balance_cancelled].sort(),
      },
      pending_before: cp.pending_before,
      admission_order: Object.entries(cp.txs)
        .filter(([, t]) => t.admitted_at !== undefined)
        .sort(([, a], [, b]) => a.admitted_at! - b.admitted_at!)
        .map(([role]) => role),
      txs: Object.fromEntries(
        Object.entries(cp.txs).map(([role, t]) => [
          role,
          { hash: t.hash ?? null, raw_status: t.raw_status ?? null, fate: t.fate, payer: t.payer ?? null, max_cost: t.max_cost ?? null, sender_value: t.sender_value ?? null, revert_reason: t.revert_reason ?? null },
        ])
      ),
      balances: cp.balances,
    })),
    verdicts: verdict.assertions.map((a) => ({ assertion_id: a.assertion_id, verdict: a.verdict, observed: a.observed })),
  };
}

export function diffValues(a: unknown, b: unknown, at = "$"): string[] {
  if (a === b) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return [`${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [`${at}: array vs object`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`));
}
