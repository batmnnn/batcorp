import type { Expectation, Precondition } from "../scenario/types.ts";
import type { CheckpointObservation, RunEvidence, TxObservation } from "./evidence.ts";
import { ruleById, type RulePack } from "./rulepack.ts";

export type VerdictClass =
  | "PASS"
  | "EXPECTED_INVALIDATION"
  | "STALE_KEPT"
  | "WRONGLY_EVICTED"
  | "ASSERTION_MISMATCH"
  | "SPEC_DIVERGENCE"
  | "INCONCLUSIVE";

export interface AssertionVerdict {
  assertion_id: string;
  tx_role: string;
  checkpoint_id: string;
  rule_ref: string;
  expected: string;
  observed: string;
  verdict: VerdictClass;
  reasons: string[];
  preconditions: Array<{ precondition: Precondition; holds: boolean | null; detail: string }>;
}

export interface RunVerdict {
  run: number;
  assertions: AssertionVerdict[];
  overall: "PASS" | "FAIL" | "INCONCLUSIVE";
  counts: { declared: number; executed: number; inconclusive: number; mismatches: number };
}

const MISMATCH: VerdictClass[] = ["STALE_KEPT", "WRONGLY_EVICTED", "ASSERTION_MISMATCH"];

function obligationTo(tx: TxObservation, account: string): bigint | null {
  if (tx.max_cost === undefined || tx.sender_value === undefined || !tx.payer || !tx.sender) return null;
  let owed = 0n;
  if (tx.payer.toLowerCase() === account.toLowerCase()) owed += BigInt(tx.max_cost);
  if (tx.sender.toLowerCase() === account.toLowerCase()) owed += BigInt(tx.sender_value);
  return owed;
}

/**
 * SP-BAL-ENFORCE as written: over the tx roles pending right before the block, if the
 * account's obligations exceed its balance, cancel newest first until the rest fit.
 * Returns null when a needed fact is missing or admission times tie.
 */
export function newestCancellationSet(cp: CheckpointObservation, accountRole: string): { set: Set<string>; owed: bigint; balance: bigint } | { error: string } {
  const account = cp.addresses[accountRole];
  const balanceText = cp.balances[accountRole];
  if (!account || balanceText === undefined) return { error: `no address or balance for ${accountRole}` };
  const balance = BigInt(balanceText);
  const owing: Array<{ role: string; owed: bigint; at: number }> = [];
  for (const role of cp.pending_before) {
    const tx = cp.txs[role];
    if (!tx) return { error: `no observation for pending tx ${role}` };
    const owed = obligationTo(tx, account);
    if (owed === null) return { error: `missing obligation data for ${role}` };
    if (owed === 0n) continue;
    if (tx.admitted_at === undefined) return { error: `missing admission time for ${role}` };
    owing.push({ role, owed, at: tx.admitted_at });
  }
  const times = owing.map((o) => o.at);
  if (new Set(times).size !== times.length) return { error: `tied admission times among ${accountRole}'s pending txs` };
  owing.sort((a, b) => b.at - a.at);
  let owed = owing.reduce((sum, o) => sum + o.owed, 0n);
  const total = owed;
  const set = new Set<string>();
  for (const o of owing) {
    if (owed <= balance) break;
    owed -= o.owed;
    set.add(o.role);
  }
  return { set, owed: total, balance };
}

function evaluatePrecondition(p: Precondition, cp: CheckpointObservation): { holds: boolean | null; detail: string } {
  switch (p.kind) {
    case "admitted": {
      const tx = cp.txs[p.tx_role];
      if (!tx || tx.admitted_at === undefined) return { holds: false, detail: `${p.tx_role} has no recorded admission` };
      return { holds: true, detail: `${p.tx_role} admitted at ${tx.admitted_at}` };
    }
    case "obligations-exceed-balance": {
      const r = newestCancellationSet(cp, p.account);
      if ("error" in r) return { holds: null, detail: r.error };
      return { holds: r.owed > r.balance, detail: `${p.account} owes ${r.owed} wei, balance ${r.balance} wei` };
    }
    case "in-newest-cancellation-set":
    case "outside-newest-cancellation-set": {
      const r = newestCancellationSet(cp, p.account);
      if ("error" in r) return { holds: null, detail: r.error };
      const inSet = r.set.has(p.tx_role);
      const want = p.kind === "in-newest-cancellation-set";
      return { holds: inSet === want, detail: `cancellation set for ${p.account}: [${[...r.set].join(", ")}]` };
    }
    case "no-obligation-to": {
      const tx = cp.txs[p.tx_role];
      const account = cp.addresses[p.account];
      if (!tx || !account) return { holds: null, detail: `missing ${p.tx_role} or ${p.account}` };
      const owed = obligationTo(tx, account);
      if (owed === null) return { holds: null, detail: `missing obligation data for ${p.tx_role}` };
      return { holds: owed === 0n, detail: `${p.tx_role} owes ${p.account} ${owed} wei` };
    }
  }
}

function classify(expected: string, observed: string): VerdictClass {
  if (expected === observed) return expected === "evicted" ? "EXPECTED_INVALIDATION" : "PASS";
  if (expected === "evicted" && observed === "pending") return "STALE_KEPT";
  if (expected === "pending" && observed === "evicted") return "WRONGLY_EVICTED";
  return "ASSERTION_MISMATCH";
}

export function judgeAssertion(e: Expectation, run: RunEvidence, pack: RulePack): AssertionVerdict {
  const base = { assertion_id: e.assertion_id, tx_role: e.tx_role, checkpoint_id: e.checkpoint_id, rule_ref: e.rule_ref, expected: e.expected };
  const inconclusive = (observed: string, reasons: string[], preconditions: AssertionVerdict["preconditions"] = []): AssertionVerdict => ({
    ...base,
    observed,
    verdict: "INCONCLUSIVE",
    reasons,
    preconditions,
  });

  ruleById(pack, e.rule_ref);
  const problems = run.problems.filter((p) => !p.checkpoint_id || p.checkpoint_id === e.checkpoint_id);
  if (problems.length > 0) return inconclusive("unknown", problems.map((p) => `${p.kind}: ${p.detail}`));

  const cp = run.checkpoints[e.checkpoint_id];
  if (!cp) return inconclusive("unknown", [`checkpoint ${e.checkpoint_id} was not reached`]);
  if (!cp.block) return inconclusive("unknown", [`checkpoint ${e.checkpoint_id} has no block`]);
  if (!cp.pass?.completed) return inconclusive("unknown", [`no completed reconciliation pass for block ${cp.block.number}`]);

  const tx = cp.txs[e.tx_role];
  if (!tx) return inconclusive("unknown", [`no observation for ${e.tx_role}`]);
  const observed = tx.fate;
  if (observed === "unknown") return inconclusive("unknown", [`${e.tx_role} status is unknown (raw: ${tx.raw_status ?? "missing"}); a missing hash is not eviction`]);

  const preconditions = e.preconditions.map((p) => ({ precondition: p, ...evaluatePrecondition(p, cp) }));
  const unknown = preconditions.filter((p) => p.holds === null);
  if (unknown.length > 0) return inconclusive(observed, unknown.map((p) => `precondition ${p.precondition.kind} unknown: ${p.detail}`), preconditions);
  const failed = preconditions.filter((p) => p.holds === false);
  if (failed.length > 0) return inconclusive(observed, failed.map((p) => `precondition ${p.precondition.kind} does not hold: ${p.detail}`), preconditions);

  if (e.evidence_required.includes("in-pass-revalidated") && tx.hash && !cp.pass.revalidated.includes(tx.hash)) {
    if (observed === "pending") return inconclusive(observed, [`${e.tx_role} was not in the pass's revalidated set`], preconditions);
  }

  const verdict = classify(e.expected, observed);
  const reasons = [`expected ${e.expected}, observed ${observed}${tx.raw_status ? ` (raw ${tx.raw_status})` : ""}`];
  if (tx.revert_reason) reasons.push(`node reason: ${tx.revert_reason}`);
  return { ...base, observed, verdict, reasons, preconditions };
}

export function judgeRun(expectations: Expectation[], run: RunEvidence, pack: RulePack): RunVerdict {
  const assertions = expectations.map((e) => judgeAssertion(e, run, pack));
  const required = assertions.filter((_a, i) => expectations[i]!.required !== false);
  const executed = assertions.filter((a) => a.verdict !== "INCONCLUSIVE").length;
  const inconclusive = required.filter((a) => a.verdict === "INCONCLUSIVE").length;
  const mismatches = assertions.filter((a) => MISMATCH.includes(a.verdict)).length;
  let overall: RunVerdict["overall"];
  if (executed === 0 || inconclusive > 0) overall = "INCONCLUSIVE";
  else if (mismatches > 0) overall = "FAIL";
  else overall = "PASS";
  return { run: run.run, assertions, overall, counts: { declared: assertions.length, executed, inconclusive, mismatches } };
}

/** Both runs must reach the same verdict per assertion; otherwise the combined result is inconclusive. */
export function combineRuns(a: RunVerdict, b: RunVerdict): { overall: RunVerdict["overall"]; disagreements: string[] } {
  const disagreements: string[] = [];
  for (const x of a.assertions) {
    const y = b.assertions.find((z) => z.assertion_id === x.assertion_id);
    if (!y || y.verdict !== x.verdict || y.observed !== x.observed) {
      disagreements.push(`${x.assertion_id}: run ${a.run} ${x.verdict}/${x.observed} vs run ${b.run} ${y?.verdict ?? "missing"}/${y?.observed ?? "missing"}`);
    }
  }
  if (disagreements.length > 0) return { overall: "INCONCLUSIVE", disagreements };
  if (a.overall !== b.overall) return { overall: "INCONCLUSIVE", disagreements: [`overall ${a.overall} vs ${b.overall}`] };
  return { overall: a.overall, disagreements };
}

export function exitCode(overall: RunVerdict["overall"]): 0 | 1 | 2 {
  return overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 2;
}
