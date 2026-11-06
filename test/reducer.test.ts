import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CheckpointObservation, RunEvidence } from "../src/oracle/evidence.ts";
import { loadRulePack } from "../src/oracle/rulepack.ts";
import { judgeRun } from "../src/oracle/verdict.ts";
import { buildCandidate, stepUnits, type ShrinkTarget } from "../src/reducer/candidate.ts";
import { ddmin, splitChunks } from "../src/reducer/ddmin.ts";
import { shrink, type Executor } from "../src/reducer/shrink.ts";
import { loadScenario } from "../src/scenario/load.ts";
import type { ScenarioV1 } from "../src/scenario/types.ts";

const { pack } = await loadRulePack(path.resolve(import.meta.dir, "../rulepacks/sidecar-policy@2e22ff0.json"));
const { scenario: NOISY } = await loadScenario(path.resolve(import.meta.dir, "../scenarios/s1-noisy.yaml"));
const TARGET: ShrinkTarget = { assertion_id: "S1-A1", verdict: "WRONGLY_EVICTED", tx_role: "tx1", rule_ref: "SP-BAL-ENFORCE", checkpoint_id: "cp-trigger" };
const MAX_COST = 100n;

/** Models the injected regression: the payer's entries are cancelled oldest first until the rest fit. */
function regressionModel(s: ScenarioV1, run: number): RunEvidence {
  const addresses = Object.fromEntries(s.actors.map((a, i) => [a.role, `0x${(i + 1).toString(16).padStart(40, "0")}`]));
  const drained = s.steps.some((st) => st.id === "drain");
  const payerBalance = drained ? (MAX_COST * 5n) / 2n : 10n ** 18n;
  const txs: CheckpointObservation["txs"] = {};
  let t = 1000;
  for (const st of s.steps) {
    if (st.action !== "submit") continue;
    txs[st.tx_role] = { hash: `0x${st.tx_role}`, raw_status: "New", fate: "pending", admitted_at: (t += 100), sender: addresses[st.actor], payer: addresses[st.actor], max_cost: MAX_COST.toString(), sender_value: "1" };
  }
  const payerTxs = Object.values(txs).filter((x) => x.payer === addresses.payer);
  let owed = payerTxs.reduce((sum) => sum + MAX_COST + 1n, 0n);
  for (const tx of payerTxs) {
    if (owed <= payerBalance) break;
    tx.raw_status = "Cancelled";
    tx.fate = "evicted";
    owed -= MAX_COST + 1n;
  }
  const balances = Object.fromEntries(s.actors.map((a) => [a.role, a.role === "payer" ? payerBalance.toString() : "1000000000000000000"]));
  const cp: CheckpointObservation = {
    checkpoint_id: "cp-trigger",
    block: { number: "2", hash: "0xb2", timestamp: "24" },
    pass: { completed: true, block: "2", revalidated: [], balance_cancelled: [] },
    pending_before: Object.keys(txs),
    txs,
    addresses,
    balances,
  };
  return { run, checkpoints: { "cp-trigger": cp }, problems: [] };
}

function modelExecutor(calls: string[], mutate?: (e: RunEvidence) => void): Executor {
  return async (s, label) => {
    calls.push(label);
    const evidence = regressionModel(s, calls.length);
    mutate?.(evidence);
    return { evidence, verdict: judgeRun(s.expectations, evidence, pack), ms: 1000 };
  };
}

const limits = (over: Partial<ScenarioV1["limits"]> = {}) => ({ ...NOISY.limits, ...over });
const tmp = () => mkdtemp(path.join(tmpdir(), "framelab-shrink-"));

test("splitChunks covers every item in order", () => {
  expect(splitChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4, 5]]);
  expect(splitChunks([1, 2, 3], 3)).toEqual([[1], [2], [3]]);
});

test("ddmin reaches the known minimal set and reports single deletions", async () => {
  const needed = new Set([2, 5, 7]);
  const result = await ddmin([1, 2, 3, 4, 5, 6, 7, 8], async (kept) => ([...needed].every((x) => kept.includes(x)) ? "interesting" : "boring"));
  expect(result.kept).toEqual([2, 5, 7]);
  expect(result.singleDeletions).toEqual({ permitted: 3, boring: 3, unresolved: 0 });
});

test("orphaned candidates are rejected before a node run", () => {
  const units = stepUnits(NOISY);
  const withoutFundNoise = units.filter((u) => u.id !== "fund-noise");
  const built = buildCandidate(NOISY, withoutFundNoise, new Set(), TARGET);
  expect(built.ok).toBe(false);
  if (!built.ok) expect(built.errors.some((e) => e.includes("depends on deleted step fund-noise"))).toBe(true);
  const withoutTx1 = buildCandidate(NOISY, units.filter((u) => u.id !== "submit-tx1"), new Set(), TARGET);
  expect(withoutTx1.ok).toBe(false);
});

test("the original noisy fixture shows the target under the regression model", () => {
  const evidence = regressionModel(NOISY, 1);
  const verdict = judgeRun(NOISY.expectations, evidence, pack);
  expect(verdict.assertions.map((a) => `${a.assertion_id}:${a.verdict}`)).toEqual([
    "S1-A1:WRONGLY_EVICTED",
    "S1-A2:WRONGLY_EVICTED",
    "S1-A3:STALE_KEPT",
    "S1-A4:STALE_KEPT",
    "S1-A5:PASS",
  ]);
});

test("shrink removes all noise and the control, keeps the target, and confirms twice", async () => {
  const calls: string[] = [];
  const { report, best } = await shrink({ base: NOISY, target: TARGET, limits: limits(), originalRunMs: 1000, execute: modelExecutor(calls), cacheSalt: "test", cacheDir: await tmp() });
  expect(report.stop_reason).toBe("complete");
  expect(best).not.toBeNull();
  const roles = best!.steps.flatMap((s) => (s.action === "submit" ? [s.tx_role] : []));
  expect(roles).toHaveLength(3);
  expect(roles[0]).toBe("tx1");
  expect(best!.actors.map((a) => a.role).sort()).toEqual(["payer", "sink"]);
  expect(report.reduced).toMatchObject({ setup: 2, action: 4, checkpoints: 1, total: 7 });
  expect(report.final_confirmation?.outcome).toBe("interesting");
  expect(calls.filter((c) => c.startsWith("final"))).toEqual(["final-run1", "final-run2"]);
  // Deleting any payer tx leaves no applicable assertion, which §5.4 counts as unresolved, so no 1-minimal claim.
  expect(report.single_deletions?.unresolved).toBeGreaterThan(0);
  expect(report.one_minimal).toBe(false);
  expect(report.claim).toContain("Not shown to be 1-minimal");
  expect(report.totals.invalid).toBeGreaterThan(0);
  expect(calls.length).toBe(report.candidates.reduce((n, c) => n + c.runs, 0));
});

test("unresolved runs are never accepted as a shrink", async () => {
  const calls: string[] = [];
  const { report, best } = await shrink({
    base: NOISY,
    target: TARGET,
    limits: limits(),
    originalRunMs: 1000,
    execute: modelExecutor(calls, (e) => e.problems.push({ kind: "pass-timeout", detail: "test" })),
    cacheSalt: "test",
    cacheDir: await tmp(),
  });
  expect(best).toBeNull();
  expect(report.reduced).toBeNull();
  expect(report.totals.kept).toBe(0);
  expect(report.totals.unresolved).toBeGreaterThan(0);
  expect(report.claim).toContain("No smaller confirmed case");
});

test("candidate budget stops the search, then the best case is confirmed fresh", async () => {
  const calls: string[] = [];
  const { report } = await shrink({ base: NOISY, target: TARGET, limits: limits({ shrink_candidates: 2 }), originalRunMs: 1000, execute: modelExecutor(calls), cacheSalt: "test", cacheDir: await tmp() });
  expect(report.stop_reason).toBe("candidate-budget");
  expect(report.totals.node_tested).toBe(2);
  expect(report.one_minimal).toBe(false);
});

test("cached successes still need a fresh final confirmation", async () => {
  const cacheDir = await tmp();
  const first = await shrink({ base: NOISY, target: TARGET, limits: limits(), originalRunMs: 1000, execute: modelExecutor([]), cacheSalt: "test", cacheDir });
  const freshUnresolved = first.report.candidates.filter((c) => c.phase !== "final-confirm" && c.outcome === "unresolved" && !c.cached).length;
  const calls: string[] = [];
  const { report } = await shrink({ base: NOISY, target: TARGET, limits: limits(), originalRunMs: 1000, execute: modelExecutor(calls), cacheSalt: "test", cacheDir });
  // Only resolved outcomes persist across sessions; unresolved ones are retried.
  expect(report.totals.node_tested).toBe(freshUnresolved);
  expect(calls.slice(-2)).toEqual(["final-run1", "final-run2"]);
  expect(report.reduced?.hash).toBe(first.report.reduced!.hash);
  const other = await shrink({ base: NOISY, target: TARGET, limits: limits(), originalRunMs: 1000, execute: modelExecutor([]), cacheSalt: "other-build", cacheDir });
  expect(other.report.totals.cached).toBe(first.report.totals.cached);
});

test("cancel exports the best confirmed case without a half-tested candidate", async () => {
  let n = 0;
  const { report } = await shrink({ base: NOISY, target: TARGET, limits: limits(), originalRunMs: 1000, execute: modelExecutor([]), cacheSalt: "test", cacheDir: await tmp(), cancelled: () => ++n > 3 });
  expect(report.stop_reason).toBe("cancelled");
  expect(report.final_confirmation).toBeNull();
  expect(report.candidates.every((c) => c.outcome !== "stopped")).toBe(true);
});
