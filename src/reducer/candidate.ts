import type { RunEvidence } from "../oracle/evidence.ts";
import type { AssertionVerdict, RunVerdict, VerdictClass } from "../oracle/verdict.ts";
import { validateScenario } from "../scenario/load.ts";
import type { Expectation, ScenarioV1, Step } from "../scenario/types.ts";
import type { Outcome } from "./ddmin.ts";

/** A deletable unit: one step, or every step sharing a `group`. */
export interface Unit {
  id: string;
  stepIds: string[];
}

export interface ShrinkTarget {
  assertion_id: string;
  verdict: VerdictClass;
  tx_role: string;
  rule_ref: string;
  checkpoint_id: string;
}

export function stepUnits(s: ScenarioV1): Unit[] {
  const units: Unit[] = [];
  const byGroup = new Map<string, Unit>();
  for (const step of s.steps) {
    if (!step.group) {
      units.push({ id: step.id, stepIds: [step.id] });
      continue;
    }
    let unit = byGroup.get(step.group);
    if (!unit) {
      unit = { id: `group:${step.group}`, stepIds: [] };
      byGroup.set(step.group, unit);
      units.push(unit);
    }
    unit.stepIds.push(step.id);
  }
  return units;
}

function expectationRoles(e: Expectation): string[] {
  return [e.tx_role, ...e.preconditions.flatMap((p) => ("tx_role" in p ? [p.tx_role] : []))];
}

function expectationAccounts(e: Expectation): string[] {
  return e.preconditions.flatMap((p) => ("account" in p ? [p.account] : []));
}

function stepActors(step: Step): string[] {
  switch (step.action) {
    case "fund":
      return [];
    case "submit":
      return [step.actor, ...(step.to ? [step.to] : [])];
    case "transfer":
      return [step.actor, step.to];
    case "advance-to-checkpoint":
      return [];
  }
}

export type CandidateBuild =
  | { ok: true; scenario: ScenarioV1; droppedExpectations: string[] }
  | { ok: false; errors: string[] };

/**
 * Deletes units and actors from `base`. Expectations about deleted txs or checkpoints are dropped
 * and listed; the target expectation is never dropped or edited, so losing its subject is invalid.
 */
export function buildCandidate(base: ScenarioV1, keptUnits: Unit[], removedActors: Set<string>, target: ShrinkTarget): CandidateBuild {
  const keptSteps = new Set(keptUnits.flatMap((u) => u.stepIds));
  const steps: Step[] = [];
  for (const step of base.steps) {
    if (!keptSteps.has(step.id)) continue;
    if (step.action === "fund") {
      const actors = step.actors.filter((a) => !removedActors.has(a));
      if (actors.length > 0) steps.push({ ...step, actors });
      else keptSteps.delete(step.id);
      continue;
    }
    steps.push(step);
  }
  const errors: string[] = [];
  for (const step of steps) {
    for (const dep of step.depends_on ?? []) if (!keptSteps.has(dep)) errors.push(`step ${step.id} depends on deleted step ${dep}`);
    for (const actor of stepActors(step)) if (removedActors.has(actor)) errors.push(`step ${step.id} uses removed actor ${actor}`);
  }

  const submitted = new Set(steps.flatMap((s) => (s.action === "submit" ? [s.tx_role] : [])));
  const checkpoints = new Set(steps.flatMap((s) => (s.action === "advance-to-checkpoint" ? [s.checkpoint_id] : [])));
  const expectations: Expectation[] = [];
  const droppedExpectations: string[] = [];
  for (const e of base.expectations) {
    const subjectPresent = expectationRoles(e).every((r) => submitted.has(r)) && checkpoints.has(e.checkpoint_id) && expectationAccounts(e).every((a) => !removedActors.has(a));
    if (subjectPresent) expectations.push(e);
    else if (e.assertion_id === target.assertion_id) errors.push(`target ${e.assertion_id} lost its tx, checkpoint or account`);
    else droppedExpectations.push(e.assertion_id);
  }

  const scenario: ScenarioV1 = { ...base, actors: base.actors.filter((a) => !removedActors.has(a.role)), steps, expectations };
  errors.push(...validateScenario(scenario));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, scenario, droppedExpectations };
}

/** Actors no remaining non-fund step or kept expectation refers to. */
export function unusedActors(s: ScenarioV1): string[] {
  const used = new Set([...s.steps.flatMap(stepActors), ...s.expectations.flatMap(expectationAccounts)]);
  return s.actors.map((a) => a.role).filter((r) => !used.has(r));
}

export function stepCounts(s: ScenarioV1) {
  const setup = s.steps.filter((st) => st.group === "setup").length;
  const checkpoints = s.steps.filter((st) => st.group !== "setup" && st.action === "advance-to-checkpoint").length;
  return { total: s.steps.length, setup, action: s.steps.length - setup - checkpoints, checkpoints, actors: s.actors.length, expectations: s.expectations.length };
}

/** Reached with full evidence, but a declared precondition is measured false: the assertion does not apply. */
function onlyPreconditionsFailed(a: AssertionVerdict): boolean {
  return a.preconditions.length > 0 && a.preconditions.every((p) => p.holds !== null) && a.preconditions.some((p) => p.holds === false);
}

/** The frozen §5.4 predicate for one fresh run. */
export function judgePredicate(target: ShrinkTarget, scenario: ScenarioV1, evidence: RunEvidence, verdict: RunVerdict): { outcome: Outcome; reason: string } {
  if (evidence.problems.length > 0) return { outcome: "unresolved", reason: `evidence problems: ${evidence.problems.map((p) => p.kind).join(", ")}` };
  const expectRejected = new Set(scenario.expectations.filter((e) => e.expected === "rejected").map((e) => e.tx_role));
  for (const cp of Object.values(evidence.checkpoints)) {
    for (const [role, tx] of Object.entries(cp.txs)) {
      if (tx.fate === "rejected" && !expectRejected.has(role)) return { outcome: "unresolved", reason: `unrelated admission rejection of ${role}: ${tx.revert_reason ?? "no reason"}` };
    }
  }
  if (verdict.counts.executed === 0) return { outcome: "unresolved", reason: "zero assertions executed" };
  const a = verdict.assertions.find((x) => x.assertion_id === target.assertion_id);
  if (!a) return { outcome: "unresolved", reason: "target assertion not judged" };
  if (a.tx_role !== target.tx_role || a.rule_ref !== target.rule_ref || a.checkpoint_id !== target.checkpoint_id) {
    return { outcome: "unresolved", reason: "target assertion identity changed" };
  }
  const unreached = verdict.assertions.filter((x) => x.verdict === "INCONCLUSIVE" && !onlyPreconditionsFailed(x));
  if (unreached.length > 0) return { outcome: "unresolved", reason: `not reached or missing evidence: ${unreached.map((x) => `${x.assertion_id} (${x.reasons.join("; ")})`).join(", ")}` };
  if (a.verdict === "INCONCLUSIVE") return { outcome: "boring", reason: `target preconditions no longer hold: ${a.reasons.join("; ")}` };
  if (a.verdict === target.verdict) return { outcome: "interesting", reason: `${a.assertion_id} ${a.verdict}` };
  if (a.verdict === "PASS" || a.verdict === "EXPECTED_INVALIDATION") return { outcome: "boring", reason: `${a.assertion_id} ${a.verdict}` };
  return { outcome: "unresolved", reason: `different mismatch: ${a.assertion_id} ${a.verdict}` };
}
