import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportBundle } from "../src/bundle/export.ts";
import { scanText, secretsFromEnv } from "../src/bundle/scan.ts";
import { FUNDER_PRIVATE_KEY } from "../src/env/actors.ts";
import { RELAYER_KEY } from "../src/runner/run.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function fakeRunDir(extra: { eventsLine?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "framelab-bundle-src-"));
  const scenarioText = await readFile(path.join(ROOT, "scenarios/s1-payer-drop.yaml"), "utf8");
  const rulePackText = await readFile(path.join(ROOT, "rulepacks/sidecar-policy@2e22ff0.json"), "utf8");
  const patchFile = path.join(ROOT, "patches/sidecar-observe.patch");
  const patchText = await readFile(patchFile, "utf8");
  const jwt = randomBytes(32).toString("hex");
  const verdict = { run: 1, assertions: [{ assertion_id: "S1-A1", tx_role: "tx1", checkpoint_id: "cp-trigger", rule_ref: "SP-BAL-ENFORCE", expected: "pending", observed: "pending", verdict: "PASS", reasons: [], preconditions: [] }], overall: "PASS", counts: { declared: 1, executed: 1, inconclusive: 0, mismatches: 0 } };
  await writeFile(
    path.join(dir, "verdicts.json"),
    JSON.stringify({
      scenario: { id: "s1-payer-drop", hash: "abc" },
      rule_pack: { id: "sidecar-policy@2e22ff0", hash: sha(rulePackText) },
      sidecar_build: { label: "observe", dir: path.join(ROOT, ".runs/builds/observe-x"), commit: "2e22ff0", buildHash: "b".repeat(64), patches: [{ file: patchFile, sha256: sha(patchText) }] },
      overall: "PASS",
      exit_code: 0,
      disagreements: [],
      runs: [verdict, { ...verdict, run: 2 }],
    })
  );
  await writeFile(path.join(dir, "scenario.original.yaml"), scenarioText);
  for (const run of [1, 2]) {
    const r = path.join(dir, `run${run}`);
    await mkdir(r, { recursive: true });
    await writeFile(path.join(r, "jwt.hex"), jwt);
    await writeFile(path.join(r, "sidecar-config.json"), JSON.stringify({ relayers: [RELAYER_KEY] }));
    await writeFile(path.join(r, "events.jsonl"), `${JSON.stringify({ run, kind: "admitted", raw: { from: FUNDER_PRIVATE_KEY.slice(0, 10) } })}\n${extra.eventsLine ?? ""}`);
    await writeFile(path.join(r, "evidence.json"), JSON.stringify({ run, checkpoints: {}, problems: [] }));
    await writeFile(path.join(r, "rpc.jsonl"), `${JSON.stringify({ url: "http://127.0.0.1:18545", method: "eth_sendRawTransaction", params: [`0x02${"ab".repeat(80)}`] })}\n`);
    await writeFile(
      path.join(r, "meta.json"),
      JSON.stringify({
        run,
        scenario_id: "s1-payer-drop",
        scenario_hash: "abc",
        ethrex: { image: "framelab/ethrex:test", image_id: "sha256:1", client_version: "ethrex/test", genesis_hash: "0xg", chain_id: 9, startup_ms: 1 },
        sidecar: { build_hash: "b".repeat(64), commit: "2e22ff0", patches: [], config_hash: "c", startup_ms: 1, boot_id: `boot-${run}` },
        driver: { kind: "engine-stepper", slot_seconds: 12 },
        reset: { method: "fresh", ms: 1000 },
        capabilities: { observe_pass_line: "ok" },
        wall_ms: 5000,
      })
    );
  }
  return { dir, jwt };
}

test("scan finds known secrets and credential shapes, not public test keys", () => {
  const known = [{ label: "jwt", value: "f".repeat(64) }];
  expect(scanText("a", `x ${"f".repeat(64)} y`, known)[0]?.kind).toContain("known secret");
  expect(scanText("a", "rpc https://user:pass@example.org/x", [])[0]?.kind).toBe("url-credentials");
  expect(scanText("a", "-----BEGIN EC PRIVATE KEY-----", [])[0]?.kind).toBe("pem-private-key");
  expect(scanText("a", `relayer ${RELAYER_KEY} funder ${FUNDER_PRIVATE_KEY}`, known)).toEqual([]);
  const env = secretsFromEnv({ FRAMELAB_QUALIFYING_KEY: "0x" + "9".repeat(64), RELAYER_KEY, PATH: "/usr/bin:/bin:/x/y/z" }, [RELAYER_KEY]);
  expect(env.map((e) => e.label)).toEqual(["env FRAMELAB_QUALIFYING_KEY"]);
});

test("export copies only allowlisted files, sanitizes paths and writes hashes", async () => {
  const { dir } = await fakeRunDir();
  const out = path.join(await mkdtemp(path.join(tmpdir(), "framelab-bundle-")), "b");
  const { manifest, findings } = await exportBundle({ srcDir: dir, bundleDir: out, framelabRoot: ROOT, env: {} });
  expect(findings).toEqual([]);
  expect(manifest?.shrink.ran).toBe(false);
  expect(manifest?.injected_regression).toBeNull();
  const top = (await readdir(out)).sort();
  expect(top).toEqual(["README.md", "SHA256SUMS", "events.run1.jsonl", "events.run2.jsonl", "evidence", "manifest.json", "node_pin.json", "patches", "reduction.json", "replay.sh", "rule_pack.json", "scenario.original.yaml", "verdicts.json"]);
  const all = JSON.stringify(await Promise.all(Object.keys(manifest!.files).map((f) => readFile(path.join(out, f), "utf8"))));
  expect(all).not.toContain("jwt.hex");
  expect(all).not.toContain(ROOT);
  expect(await readFile(path.join(out, "verdicts.json"), "utf8")).toContain("$FRAMELAB/.runs/builds/observe-x");
  expect(JSON.parse(await readFile(path.join(out, "reduction.json"), "utf8")).shrink_ran).toBe(false);
  for (const [rel, h] of Object.entries(manifest!.files)) expect(sha(await readFile(path.join(out, rel), "utf8"))).toBe(h);
});

test("export refuses and leaves no bundle when a run secret leaked into evidence", async () => {
  const leak = await fakeRunDir();
  await writeFile(path.join(leak.dir, "run1/events.jsonl"), `${JSON.stringify({ kind: "oops", raw: leak.jwt })}\n`);
  const out = path.join(await mkdtemp(path.join(tmpdir(), "framelab-bundle-")), "b");
  const res = await exportBundle({ srcDir: leak.dir, bundleDir: out, framelabRoot: ROOT, env: {} });
  expect(res.manifest).toBeNull();
  expect(res.findings[0]?.kind).toContain("engine JWT key");
  expect(await stat(out).then(() => true, () => false)).toBe(false);

  const cred = await fakeRunDir({ eventsLine: JSON.stringify({ rpc: "https://u:hunter2@rpc.example.org" }) });
  const res2 = await exportBundle({ srcDir: cred.dir, bundleDir: out, framelabRoot: ROOT, env: {} });
  expect(res2.findings.map((f) => f.kind)).toContain("url-credentials");
});
