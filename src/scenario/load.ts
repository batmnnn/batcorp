import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
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
  for (const step of s.steps) {
    if (seen.has(step.id)) errors.push(`duplicate step id ${step.id}`);
    for (const dep of step.depends_on ?? []) if (!seen.has(dep)) errors.push(`step ${step.id} depends on ${dep}, which is not an earlier step`);
    seen.add(step.id);
    const needActor = (role: string, what: string) => {
      if (!actorRoles.has(role)) errors.push(`step ${step.id}: unknown ${what} ${role}`);
    };
    switch (step.action) {
      case "fund":
        step.actors.forEach((a) => needActor(a, "actor"));
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
      default:
        errors.push(`step ${(step as Step).id}: unknown action ${(step as { action: string }).action}`);
    }
  }

  const ids = new Set<string>();
  for (const e of s.expectations) {
    if (ids.has(e.assertion_id)) errors.push(`duplicate assertion ${e.assertion_id}`);
    ids.add(e.assertion_id);
    if (!roles.has(e.tx_role)) errors.push(`${e.assertion_id}: tx role ${e.tx_role} is never submitted`);
    if (!checkpoints.has(e.checkpoint_id)) errors.push(`${e.assertion_id}: checkpoint ${e.checkpoint_id} does not exist`);
    if (!e.rule_ref) errors.push(`${e.assertion_id}: missing rule_ref`);
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
