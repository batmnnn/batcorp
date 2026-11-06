import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { CONTRACT_FIXTURES } from "../fixtures/contracts.ts";
import type { ScenarioV1, Step } from "./types.ts";

export interface LoadedScenario {
  scenario: ScenarioV1;
  /** sha256 of the canonical JSON form, so YAML formatting does not change identity. */
  hash: string;
  text: string;
}

export function canonicalHash(scenario: ScenarioV1): string {
  return createHash("sha256").update(JSON.stringify(scenario)).digest("hex");
}

export function txRoles(steps: Step[]): string[] {
  return steps.flatMap((s) => (s.action === "submit" ? [s.tx_role] : []));
}

export function checkpointIds(steps: Step[]): string[] {
  return steps.flatMap((s) => (s.action === "advance-to-checkpoint" ? [s.checkpoint_id] : []));
}

/** Structural checks only; returns every problem rather than the first. */
export function validateScenario(s: ScenarioV1): string[] {
  const errors: string[] = [];
  if (s.schema !== "framelab.scenario/v1") errors.push(`unsupported schema ${s.schema}`);
  for (const field of ["id", "seed", "rule_pack"] as const) if (!s[field]) errors.push(`missing ${field}`);
  const actorRoles = new Set(s.actors.map((a) => a.role));
  if (actorRoles.size !== s.actors.length) errors.push("duplicate actor roles");

  const seen = new Set<string>();
  const roles = new Set<string>();
  const checkpoints = new Set<string>();
  const deployed = new Set<string>();
  const contractRoles = new Set(s.actors.filter((a) => a.contract).map((a) => a.role));
  for (const step of s.steps) {
    const usesContract = step.action === "submit" ? step.actor : step.action === "call" ? step.to : undefined;
    if (usesContract && contractRoles.has(usesContract) && !deployed.has(usesContract)) {
      errors.push(`step ${step.id}: contract ${usesContract} is used before its deploy step`);
    }
    if ((step.action === "transfer" || step.action === "call") && contractRoles.has(step.actor)) errors.push(`step ${step.id}: a contract actor cannot sign a normal tx`);
    if (seen.has(step.id)) errors.push(`duplicate step id ${step.id}`);
    for (const dep of step.depends_on ?? []) if (!seen.has(dep)) errors.push(`step ${step.id} depends on ${dep}, which is not an earlier step`);
    seen.add(step.id);
    const needActor = (role: string, what: string) => {
      if (!actorRoles.has(role)) errors.push(`step ${step.id}: unknown ${what} ${role}`);
    };
    switch (step.action) {
      case "fund":
        step.actors.forEach((a) => needActor(a, "actor"));
        for (const a of step.actors) if (contractRoles.has(a)) errors.push(`step ${step.id}: fund ${a} through its deploy step's value_wei`);
        break;
      case "submit":
        needActor(step.actor, "actor");
        if (step.to) needActor(step.to, "recipient");
        if (roles.has(step.tx_role)) errors.push(`tx role ${step.tx_role} submitted twice`);
        roles.add(step.tx_role);
        break;
      case "transfer":
        needActor(step.actor, "actor");
        needActor(step.to, "recipient");
        if ("of_tx_role" in step.amount && !roles.has(step.amount.of_tx_role)) {
          errors.push(`step ${step.id}: amount refers to ${step.amount.of_tx_role}, which is not submitted earlier`);
        }
        break;
      case "advance-to-checkpoint":
        if (checkpoints.has(step.checkpoint_id)) errors.push(`duplicate checkpoint ${step.checkpoint_id}`);
        checkpoints.add(step.checkpoint_id);
        break;
      case "deploy": {
        const spec = s.actors.find((a) => a.role === step.contract);
        if (!spec?.contract) errors.push(`step ${step.id}: ${step.contract} is not a contract actor`);
        else if (!CONTRACT_FIXTURES[spec.contract.fixture]) errors.push(`step ${step.id}: unknown contract fixture ${spec.contract.fixture}`);
        else needActor(spec.contract.owner, "owner");
        if (deployed.has(step.contract)) errors.push(`step ${step.id}: ${step.contract} deployed twice`);
        deployed.add(step.contract);
        break;
      }
      case "call":
        needActor(step.actor, "actor");
        needActor(step.to, "recipient");
        if (!/^0x([0-9a-fA-F]{2})*$/.test(step.data)) errors.push(`step ${step.id}: data must be 0x-prefixed hex bytes`);
        break;
      default:
        errors.push(`step ${(step as Step).id}: unknown action ${(step as { action: string }).action}`);
    }
  }

  for (const w of s.watch_storage ?? []) {
    if (!actorRoles.has(w.account)) errors.push(`watch_storage: unknown account ${w.account}`);
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(w.slot)) errors.push(`watch_storage: bad slot ${w.slot}`);
  }
  const ids = new Set<string>();
  for (const e of s.expectations) {
    for (const p of e.preconditions) {
      if (p.kind !== "storage-equals") continue;
      if (!(s.watch_storage ?? []).some((w) => w.account === p.account && BigInt(w.slot) === BigInt(p.slot))) {
        errors.push(`${e.assertion_id}: storage precondition on ${p.account}:${p.slot} is not in watch_storage`);
      }
      if (p.checkpoint_id && !checkpoints.has(p.checkpoint_id)) errors.push(`${e.assertion_id}: precondition checkpoint ${p.checkpoint_id} does not exist`);
    }
    if (ids.has(e.assertion_id)) errors.push(`duplicate assertion ${e.assertion_id}`);
    ids.add(e.assertion_id);
    if (!roles.has(e.tx_role)) errors.push(`${e.assertion_id}: tx role ${e.tx_role} is never submitted`);
    if (!checkpoints.has(e.checkpoint_id)) errors.push(`${e.assertion_id}: checkpoint ${e.checkpoint_id} does not exist`);
    if (!e.rule_ref) errors.push(`${e.assertion_id}: missing rule_ref`);
    if (e.deliberately_wrong !== undefined && e.deliberately_wrong !== true) errors.push(`${e.assertion_id}: deliberately_wrong must be true or absent`);
  }
  return errors;
}

export async function loadScenario(file: string): Promise<LoadedScenario> {
  const text = await readFile(file, "utf8");
  const scenario = YAML.parse(text) as ScenarioV1;
  const errors = validateScenario(scenario);
  if (errors.length > 0) throw new Error(`${file}:\n  ${errors.join("\n  ")}`);
  return { scenario, hash: canonicalHash(scenario), text };
}
