import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportBundle } from "../src/bundle/export.ts";
import { checkCompatibility } from "../src/oracle/compat.ts";
import { loadRulePack } from "../src/oracle/rulepack.ts";
import { loadScenario } from "../src/scenario/load.ts";
import type { ScenarioV1 } from "../src/scenario/types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const { pack } = await loadRulePack(path.join(ROOT, "rulepacks/sidecar-policy@2e22ff0.json"));
const { scenario: S1 } = await loadScenario(path.join(ROOT, "scenarios/s1-payer-drop.yaml"));
const withRevisions = (protocol_revisions: Record<string, string>): ScenarioV1 => ({ ...S1, protocol_revisions });

test("the shipped scenarios and pack fit the pinned target", async () => {
  for (const f of ["s1-payer-drop.yaml", "s1-noisy.yaml", "s2-storage-dep.yaml"]) {
    const { scenario } = await loadScenario(path.join(ROOT, "scenarios", f));
    expect(checkCompatibility(scenario, pack)).toMatchObject({ applicable: true, reasons: [] });
  }
});

test("a current-draft codec scenario is not applicable, with the reason", async () => {
  const { scenario } = await loadScenario(path.join(ROOT, "scenarios/negative/s1-current-codec.yaml"));
  const c = checkCompatibility(scenario, pack);
  expect(c.applicable).toBe(false);
  expect(c.reasons).toHaveLength(1);
  expect(c.reasons[0]).toContain("would not encode as written");
});

test("extra protocol requirements, a policy mismatch and a missing codec are each reported", () => {
  const base = S1.protocol_revisions;
  expect(checkCompatibility(withRevisions({ ...base, eels: "bogota-fixtures@main" }), pack).reasons).toEqual([
    "scenario requires eels bogota-fixtures@main, which this target does not provide",
  ]);
  expect(checkCompatibility(withRevisions({ ...base, policy: "sidecar-policy@ffffff0" }), pack).reasons[0]).toContain("differs from its rule pack");
  expect(checkCompatibility(withRevisions({ policy: base.policy! }), pack).reasons[0]).toContain("(none declared)");
});

test("a pack from another sidecar revision or another codec is not applicable", () => {
  const otherSource = { ...pack, source: { ...pack.source, revision: "0".repeat(40) } };
  expect(checkCompatibility(S1, otherSource).reasons[0]).toContain("the target sidecar is 2e22ff0a2898");
  const otherCodec = { ...pack, protocol: { eip8141: "ethereum/EIPs@master" } };
  expect(checkCompatibility(S1, otherCodec).reasons[0]).toContain("is written for EIP-8141 ethereum/EIPs@master");
});

test("a missing pack is not applicable rather than a crash", () => {
  const c = checkCompatibility({ ...S1, rule_pack: "sidecar-policy@ffffff0" }, null, "ENOENT");
  expect(c.applicable).toBe(false);
  expect(c.reasons.some((r) => r.includes("sidecar-policy@ffffff0 is not available (ENOENT)"))).toBe(true);
});

test("export refuses a not-applicable result", async () => {
  const dir = path.join(tmpdir(), `framelab-compat-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "verdicts.json"), JSON.stringify({ overall: "INCONCLUSIVE", compatibility: checkCompatibility(withRevisions({}), pack), runs: [] }));
  await expect(exportBundle({ srcDir: dir, bundleDir: path.join(dir, "bundle"), framelabRoot: ROOT })).rejects.toThrow("not applicable to this target");
});
