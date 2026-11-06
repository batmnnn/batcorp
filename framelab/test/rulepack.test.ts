import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { SIDECAR_PIN } from "../src/env/pins.ts";
import { loadRulePack, normalizeProse, verifyRulePack } from "../src/oracle/rulepack.ts";

const PACK = path.resolve(import.meta.dir, "../rulepacks/sidecar-policy@2e22ff0.json");

test("normalizeProse joins doc-comment lines", () => {
  expect(normalizeProse("  /**\n   * a `b`\n   * c\n   */")).toBe("a `b` c");
});

test.skipIf(!existsSync(SIDECAR_PIN.dir))("every rule quote is verbatim in the pinned sidecar source", async () => {
  const { pack } = await loadRulePack(PACK);
  expect(pack.source.revision).toBe(SIDECAR_PIN.commit);
  const checks = await verifyRulePack(pack, SIDECAR_PIN.dir);
  expect(checks.length).toBeGreaterThan(0);
  for (const check of checks) expect(check).toEqual({ ...check, hashOk: true, quoteFound: true });
});
