import { expect, test } from "bun:test";
import path from "node:path";
import type { CheckpointObservation, RunEvidence } from "../src/oracle/evidence.ts";
import { loadRulePack } from "../src/oracle/rulepack.ts";
import { combineRuns, exitCode, judgeRun, newestCancellationSet } from "../src/oracle/verdict.ts";
import type { Expectation } from "../src/scenario/types.ts";

const { pack } = await loadRulePack(path.resolve(import.meta.dir, "../rulepacks/sidecar-policy@2e22ff0.json"));
const PAYER = "0x00000000000000000000000000000000000000a1";
const CONTROL = "0x00000000000000000000000000000000000000c1";
const ROLES = ["tx1", "tx2", "tx3", "tx4"];

function checkpoint(fates: Record<string, string>, overrides: Partial<CheckpointObservation> = {}): CheckpointObservation {
  const txs: CheckpointObservation["txs"] = {};
  ROLES.forEach((role, i) => {
    txs[role] = {
      hash: `0x${i}`,
      raw_status: fates[role] === "evicted" ? "Cancelled" : "New",
      fate: fates[role] as never,
      admitted_at: 1000 + i * 100,
      sender: PAYER,
      payer: PAYER,
      max_cost: "100",
      sender_value: "1",
    };
  });
  txs.control = { hash: "0xc", raw_status: "New", fate: "pending", admitted_at: 2000, sender: CONTROL, payer: CONTROL, max_cost: "100", sender_value: "1" };
  return {
    checkpoint_id: "cp-trigger",
    block: { number: "2", hash: "0xb2", timestamp: "24" },
    pass: { completed: true, block: "2", revalidated: [], balance_cancelled: [] },
    pending_before: [...ROLES, "control"],
    txs,
    addresses: { payer: PAYER, control: CONTROL },
    balances: { payer: "250", control: "1000" },
    ...overrides,
  };
}

function expectation(role: string, expected: "pending" | "evicted", preconditionKind: "in-newest-cancellation-set" | "outside-newest-cancellation-set"): Expectation {
  return {
    assertion_id: `S1-${role}`,
    tx_role: role,
    checkpoint_id: "cp-trigger",
    expected,
    rule_ref: "SP-BAL-ENFORCE",
    derivation: "test",
    preconditions: [
      { kind: "admitted", tx_role: role },
      { kind: "obligations-exceed-balance", account: "payer" },
      { kind: preconditionKind, tx_role: role, account: "payer" },
    ],
    evidence_required: [],
  };
}

const S1: Expectation[] = [
  expectation("tx1", "pending", "outside-newest-cancellation-set"),
  expectation("tx2", "pending", "outside-newest-cancellation-set"),
  expectation("tx3", "evicted", "in-newest-cancellation-set"),
  expectation("tx4", "evicted", "in-newest-cancellation-set"),
  {
    assertion_id: "S1-control",
    tx_role: "control",
    checkpoint_id: "cp-trigger",
    expected: "pending",
    rule_ref: "SP-BAL-ENFORCE",
    derivation: "test",
    preconditions: [{ kind: "no-obligation-to", tx_role: "control", account: "payer" }],
    evidence_required: [],
  },
];

const run = (n: number, cp: CheckpointObservation, problems: RunEvidence["problems"] = []): RunEvidence => ({ run: n, checkpoints: { "cp-trigger": cp }, problems });
const correct = () => checkpoint({ tx1: "pending", tx2: "pending", tx3: "evicted", tx4: "evicted" });

test("newest-first cancellation set follows SP-BAL-ENFORCE", () => {
  const r = newestCancellationSet(correct(), "payer");
  expect("error" in r).toBe(false);
  if (!("error" in r)) {
    expect([...r.set].sort()).toEqual(["tx3", "tx4"]);
    expect(r.owed).toBe(404n);
  }
});

test("correct policy: pass, with expected invalidations not red", () => {
  const v = judgeRun(S1, run(1, correct()), pack);
  expect(v.overall).toBe("PASS");
  expect(v.assertions.map((a) => a.verdict)).toEqual(["PASS", "PASS", "EXPECTED_INVALIDATION", "EXPECTED_INVALIDATION", "PASS"]);
  expect(exitCode(v.overall)).toBe(0);
});

test("oldest-first regression: stale-kept newest and wrongly-evicted oldest", () => {
  const v = judgeRun(S1, run(1, checkpoint({ tx1: "evicted", tx2: "evicted", tx3: "pending", tx4: "pending" })), pack);
  expect(v.overall).toBe("FAIL");
  expect(v.assertions.map((a) => a.verdict)).toEqual(["WRONGLY_EVICTED", "WRONGLY_EVICTED", "STALE_KEPT", "STALE_KEPT", "PASS"]);
  expect(exitCode(v.overall)).toBe(1);
});

test("flipped expectation fails at that assertion only", () => {
  const flipped = S1.map((e) => (e.assertion_id === "S1-tx4" ? { ...e, expected: "pending" as const } : e));
  const v = judgeRun(flipped, run(1, correct()), pack);
  expect(v.overall).toBe("FAIL");
  expect(v.assertions.filter((a) => a.verdict !== "PASS" && a.verdict !== "EXPECTED_INVALIDATION").map((a) => a.assertion_id)).toEqual(["S1-tx4"]);
});

test("missing pass evidence, missing checkpoint, zero assertions and transport problems never go green", () => {
  expect(judgeRun(S1, run(1, checkpoint({ tx1: "pending", tx2: "pending", tx3: "pending", tx4: "pending" }, { pass: null })), pack).overall).toBe("INCONCLUSIVE");
  expect(judgeRun(S1, { run: 1, checkpoints: {}, problems: [] }, pack).overall).toBe("INCONCLUSIVE");
  expect(judgeRun([], run(1, correct()), pack).overall).toBe("INCONCLUSIVE");
  expect(judgeRun(S1, run(1, correct(), [{ kind: "restart", detail: "bootId changed" }]), pack).overall).toBe("INCONCLUSIVE");
});

test("unknown status and tied admission times are inconclusive, not eviction", () => {
  const unknown = correct();
  unknown.txs.tx4 = { ...unknown.txs.tx4!, fate: "unknown", raw_status: undefined };
  expect(judgeRun(S1, run(1, unknown), pack).assertions[3]!.verdict).toBe("INCONCLUSIVE");
  const tied = correct();
  tied.txs.tx4 = { ...tied.txs.tx4!, admitted_at: tied.txs.tx3!.admitted_at };
  expect(judgeRun(S1, run(1, tied), pack).overall).toBe("INCONCLUSIVE");
});

test("precondition that no longer holds makes the assertion inconclusive", () => {
  const rich = correct();
  rich.balances.payer = "10000";
  const v = judgeRun(S1, run(1, rich), pack);
  expect(v.assertions[3]!.verdict).toBe("INCONCLUSIVE");
  expect(v.overall).toBe("INCONCLUSIVE");
});

test("double-run disagreement is inconclusive", () => {
  const a = judgeRun(S1, run(1, correct()), pack);
  const b = judgeRun(S1, run(2, checkpoint({ tx1: "pending", tx2: "pending", tx3: "evicted", tx4: "pending" })), pack);
  expect(combineRuns(a, b).overall).toBe("INCONCLUSIVE");
  expect(combineRuns(a, judgeRun(S1, run(2, correct()), pack)).overall).toBe("PASS");
});
