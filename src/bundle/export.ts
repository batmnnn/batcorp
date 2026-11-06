import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { deriveActor, FUNDER_PRIVATE_KEY } from "../env/actors.ts";
import { ETHREX_PIN, SIDECAR_PIN, VENDOR_DIR } from "../env/pins.ts";
import { RELAYER_KEY, type RunMeta } from "../runner/run.ts";
import type { ScenarioV1 } from "../scenario/types.ts";
import { exec } from "../util/proc.ts";
import YAML from "yaml";
import { scanText, secretsFromEnv, type KnownSecret, type ScanFinding } from "./scan.ts";

export const BUNDLE_SCHEMA = "framelab.bundle/v1";

/** Source file (relative to the run or shrink directory) -> bundle path. Nothing else is copied. */
const ALLOWLIST: Array<[string, string]> = [
  ["verdicts.json", "verdicts.json"],
  ["scenario.original.yaml", "scenario.original.yaml"],
  ["scenario.min.yaml", "scenario.min.yaml"],
  ["reduction.json", "reduction.json"],
  ["run1/events.jsonl", "events.run1.jsonl"],
  ["run2/events.jsonl", "events.run2.jsonl"],
  ["run1/evidence.json", "evidence/run1.evidence.json"],
  ["run2/evidence.json", "evidence/run2.evidence.json"],
  ["run1/meta.json", "evidence/run1.meta.json"],
  ["run2/meta.json", "evidence/run2.meta.json"],
  ["run1/rpc.jsonl", "evidence/run1.rpc.jsonl"],
  ["run2/rpc.jsonl", "evidence/run2.rpc.jsonl"],
  ["run1/observe.jsonl", "evidence/run1.observe.jsonl"],
  ["run2/observe.jsonl", "evidence/run2.observe.jsonl"],
];
const REQUIRED = ["verdicts.json", "scenario.original.yaml", "run1/events.jsonl", "run2/events.jsonl", "run1/meta.json", "run1/evidence.json", "run2/evidence.json"];

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  tool: { name: string; version: string; commit: string; dirty: boolean; bun: string };
  source_mode: "real-node";
  scenario: { id: string; hash: string; replay_file: string };
  rule_pack: { id: string; hash: string; source_revision: string };
  genesis: { sha256: string; chain_id: number; genesis_hash: string; fork_schedule: string };
  node: RunMeta["ethrex"] & { pinned_commit: string; published_image_not_run: string };
  sidecar: { repo: string; commit: string; build_hash: string; patches: Array<{ file: string; sha256: string }>; config_hash: string };
  dependencies: Record<string, string>;
  driver: RunMeta["driver"];
  reset: { method: string; ms: number[] };
  capabilities: RunMeta["capabilities"];
  runs: Array<{ run: number; boot_id: string; wall_ms: number }>;
  coverage: Array<{ run: number; declared: number; executed: number; inconclusive: number; mismatches: number }>;
  overall: string;
  exit_code: number;
  shrink: { ran: boolean; claim?: string; stop_reason?: string };
  injected_regression: { label: string; patch: string; sha256: string } | null;
  public_test_keys: string;
  sanitized: string[];
  files: Record<string, string>;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false
  );
}

async function findFiles(dir: string, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findFiles(p, name)));
    else if (entry.name === name) out.push(p);
  }
  return out;
}

export function publicTestKeys(scenarios: ScenarioV1[]): string[] {
  const derived = scenarios.flatMap((s) => s.actors.map((a) => deriveActor(s.seed, a.role).privateKey));
  return [FUNDER_PRIVATE_KEY, RELAYER_KEY, ...derived];
}

export interface ExportOptions {
  srcDir: string;
  bundleDir: string;
  framelabRoot: string;
  env?: Record<string, string | undefined>;
}

export async function exportBundle(opts: ExportOptions): Promise<{ manifest: BundleManifest | null; findings: ScanFinding[] }> {
  for (const f of REQUIRED) if (!(await exists(path.join(opts.srcDir, f)))) throw new Error(`not a complete run directory: ${f} is missing in ${opts.srcDir}`);
  const verdicts = JSON.parse(await readFile(path.join(opts.srcDir, "verdicts.json"), "utf8"));
  const meta1: RunMeta = JSON.parse(await readFile(path.join(opts.srcDir, "run1/meta.json"), "utf8"));
  const meta2: RunMeta | null = (await exists(path.join(opts.srcDir, "run2/meta.json"))) ? JSON.parse(await readFile(path.join(opts.srcDir, "run2/meta.json"), "utf8")) : null;
  const original = YAML.parse(await readFile(path.join(opts.srcDir, "scenario.original.yaml"), "utf8")) as ScenarioV1;
  const hasMin = await exists(path.join(opts.srcDir, "scenario.min.yaml"));
  const reduction = (await exists(path.join(opts.srcDir, "reduction.json"))) ? JSON.parse(await readFile(path.join(opts.srcDir, "reduction.json"), "utf8")) : null;
  if (verdicts.fault || verdicts.run2_sidecar_build || meta1.fault || meta2?.fault) {
    throw new Error(`${opts.srcDir} is a negative-path test run (deliberate fault or mixed builds); it is not exportable as a regression`);
  }
  if (verdicts.cancelled) throw new Error(`${opts.srcDir} was cancelled; rerun it before exporting`);

  await rm(opts.bundleDir, { recursive: true, force: true });
  await mkdir(path.join(opts.bundleDir, "evidence"), { recursive: true });
  await mkdir(path.join(opts.bundleDir, "patches"), { recursive: true });

  const home = homedir();
  const sanitize = (text: string) => text.split(opts.framelabRoot).join("$FRAMELAB").split(path.resolve(VENDOR_DIR)).join("$VENDOR").split(home).join("~");
  const files: Record<string, string> = {};
  const put = async (rel: string, content: string) => {
    await writeFile(path.join(opts.bundleDir, rel), content, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
    files[rel] = sha256(content);
  };

  for (const [src, dest] of ALLOWLIST) {
    const from = path.join(opts.srcDir, src);
    if (await exists(from)) await put(dest, sanitize(await readFile(from, "utf8")));
  }
  if (!reduction) await put("reduction.json", JSON.stringify({ shrink_ran: false, note: "No shrink ran for this bundle; there is no scenario.min.yaml." }, null, 2));

  const patches = verdicts.sidecar_build.patches as Array<{ file: string; sha256: string }>;
  const bundledPatches: Array<{ file: string; sha256: string }> = [];
  for (const p of patches) {
    const content = await readFile(p.file, "utf8");
    if (sha256(content) !== p.sha256) throw new Error(`patch ${p.file} changed since the run (hash mismatch)`);
    const rel = `patches/${path.basename(p.file)}`;
    await put(rel, content);
    bundledPatches.push({ file: rel, sha256: p.sha256 });
  }
  const rulePackFile = path.join(opts.framelabRoot, "rulepacks", `${original.rule_pack}.json`);
  const rulePackText = await readFile(rulePackFile, "utf8");
  if (sha256(rulePackText) !== verdicts.rule_pack.hash) throw new Error(`rule pack ${rulePackFile} changed since the run (hash mismatch)`);
  await put("rule_pack.json", rulePackText);

  const injected = bundledPatches.find((p) => path.basename(p.file).startsWith("inject-"));
  const nodePin = {
    ethrex: { ...meta1.ethrex, pinned_commit: ETHREX_PIN.commit, genesis_sha256: ETHREX_PIN.genesisSha256, published_image_not_run: `${ETHREX_PIN.publishedImage} (does not start under Rosetta; V12)` },
    sidecar: { repo: SIDECAR_PIN.repo, commit: meta1.sidecar.commit, build_label: verdicts.sidecar_build.label, build_hash: meta1.sidecar.build_hash, patches: bundledPatches, config_hash: meta1.sidecar.config_hash },
    driver: meta1.driver,
    reset_method: meta1.reset.method,
  };
  await put("node_pin.json", JSON.stringify(nodePin, null, 2));

  const pkg = JSON.parse(await readFile(path.join(opts.framelabRoot, "package.json"), "utf8"));
  const commit = (await exec(["git", "rev-parse", "HEAD"], { cwd: opts.framelabRoot, allowFail: true })).stdout.trim() || "unknown";
  const dirty = (await exec(["git", "status", "--porcelain"], { cwd: opts.framelabRoot, allowFail: true })).stdout.trim().length > 0;
  const replayFile = hasMin ? "scenario.min.yaml" : "scenario.original.yaml";
  const expectedExit = hasMin ? 1 : verdicts.exit_code;

  await put("replay.sh", replayScript({ label: verdicts.sidecar_build.label, patches: bundledPatches.map((p) => p.file).filter((f) => !f.endsWith("sidecar-observe.patch")), replayFile, expectedExit, commit }));
  const runVerdicts = verdicts.runs as Array<{ run: number; counts: BundleManifest["coverage"][0] }>;
  await put(
    "README.md",
    readme({ original, replayFile, verdicts, reduction, injected, expectedExit, commit, nodePin })
  );

  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    tool: { name: pkg.name, version: pkg.version, commit, dirty, bun: Bun.version },
    source_mode: "real-node",
    scenario: { id: original.id, hash: verdicts.scenario.hash, replay_file: replayFile },
    rule_pack: { id: verdicts.rule_pack.id, hash: verdicts.rule_pack.hash, source_revision: `${SIDECAR_PIN.repo}@${SIDECAR_PIN.commit}` },
    genesis: { sha256: original.genesis.sha256, chain_id: original.genesis.chain_id, genesis_hash: meta1.ethrex.genesis_hash, fork_schedule: "l1-hegota.json: every fork through Hegota at time 0" },
    node: nodePin.ethrex,
    sidecar: { repo: SIDECAR_PIN.repo, commit: meta1.sidecar.commit, build_hash: meta1.sidecar.build_hash, patches: bundledPatches, config_hash: meta1.sidecar.config_hash },
    dependencies: { ...pkg.dependencies, ...Object.fromEntries(Object.entries(pkg.devDependencies ?? {}).map(([k, v]) => [`dev:${k}`, v as string])) },
    driver: meta1.driver,
    reset: { method: meta1.reset.method, ms: [meta1.reset.ms, ...(meta2 ? [meta2.reset.ms] : [])] },
    capabilities: meta1.capabilities,
    runs: [meta1, ...(meta2 ? [meta2] : [])].map((m) => ({ run: m.run, boot_id: m.sidecar.boot_id, wall_ms: m.wall_ms })),
    coverage: runVerdicts.map((v) => ({ ...v.counts, run: v.run })),
    overall: verdicts.overall,
    exit_code: verdicts.exit_code,
    shrink: reduction ? { ran: true, claim: reduction.claim, stop_reason: reduction.stop_reason } : { ran: false },
    injected_regression: injected ? { label: verdicts.sidecar_build.label, patch: injected.file, sha256: injected.sha256 } : null,
    public_test_keys: "Actor keys derive from the scenario seed (framelab-actor/v1); the funder and relayer keys are public ethrex dev keys. All are PUBLIC TEST-ONLY. Never fund or use them on any other network.",
    sanitized: ["absolute paths under the FrameLab checkout -> $FRAMELAB", "vendor checkout -> $VENDOR", "home directory -> ~"],
    files,
  };

  const known: KnownSecret[] = [
    ...(await Promise.all((await findFiles(opts.srcDir, "jwt.hex")).map(async (f) => ({ label: `engine JWT key ${path.relative(opts.srcDir, f)}`, value: (await readFile(f, "utf8")).trim() })))),
    ...secretsFromEnv(opts.env ?? process.env, publicTestKeys([original])),
  ];
  const manifestText = JSON.stringify(manifest, null, 2);
  const findings: ScanFinding[] = [];
  for (const rel of Object.keys(files)) findings.push(...scanText(rel, await readFile(path.join(opts.bundleDir, rel), "utf8"), known));
  findings.push(...scanText("manifest.json", manifestText, known));
  if (findings.length > 0) {
    await rm(opts.bundleDir, { recursive: true, force: true });
    return { manifest: null, findings };
  }
  await writeFile(path.join(opts.bundleDir, "manifest.json"), manifestText);
  const sums = Object.entries(files)
    .map(([rel, h]) => `${h}  ${rel}`)
    .join("\n");
  await writeFile(path.join(opts.bundleDir, "SHA256SUMS"), `${sums}\n`);
  return { manifest, findings };
}

function replayScript(o: { label: string; patches: string[]; replayFile: string; expectedExit: number; commit: string }): string {
  const patchArgs = o.patches.map((p) => `--patch "$HERE/${p}"`).join(" ");
  return `#!/usr/bin/env bash
# FrameLab replay: a fresh run of the frozen scenario on a clean local stack.
# It is a new execution, not playback of the saved events.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "\${FRAMELAB:?set FRAMELAB to a FrameLab checkout (bundle was made at ${o.commit})}"

cd "$HERE"
shasum -a 256 -c SHA256SUMS --quiet || { echo "replay: bundle files do not match SHA256SUMS; refusing to run" >&2; exit 2; }
bun "$FRAMELAB/src/cli.ts" check-pins "$HERE"

OUT="$HERE/replay-$(date +%Y%m%d-%H%M%S)"
set +e
bun "$FRAMELAB/src/cli.ts" run "$HERE/${o.replayFile}" --label "${o.label}" ${patchArgs} --out "$OUT"
code=$?
set -e
bun "$FRAMELAB/src/cli.ts" compare "$HERE" "$OUT" || true
echo "replay exit $code (bundle recorded ${o.expectedExit})"
exit $code
`;
}

interface ReductionSummary {
  claim: string;
  target: { assertion_id: string; verdict: string; tx_role: string; rule_ref: string };
  reduced: { hash: string } | null;
  final_confirmation: { outcome: string; reasons: string[] } | null;
  pruned_expectations?: string[];
}

function reductionSection(r: ReductionSummary): string {
  const lines = [`Shrink target: \`${r.target.assertion_id}\` ${r.target.verdict} on \`${r.target.tx_role}\` under \`${r.target.rule_ref}\`.`, "", r.claim];
  if (r.reduced && r.final_confirmation) {
    lines.push("", `Reduced case \`scenario.min.yaml\` (hash \`${r.reduced.hash.slice(0, 12)}…\`), final confirmation on two fresh runs: ${r.final_confirmation.outcome}.`);
    for (const reason of r.final_confirmation.reasons) lines.push(`- ${reason}`);
    if (r.pruned_expectations?.length) {
      lines.push("", `Removed from the reduced case because their preconditions no longer hold there: ${r.pruned_expectations.join(", ")}. No expected fate was edited.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function readme(o: {
  original: ScenarioV1;
  replayFile: string;
  verdicts: { overall: string; exit_code: number; runs: Array<{ assertions: Array<{ assertion_id: string; verdict: string; expected: string; observed: string; rule_ref: string }> }>; sidecar_build: { label: string } };
  reduction: ReductionSummary | null;
  injected: { file: string; sha256: string } | undefined;
  expectedExit: number;
  commit: string;
  nodePin: { ethrex: { image: string; image_id: string; pinned_commit: string }; sidecar: { commit: string; build_hash: string } };
}): string {
  const rows = o.verdicts.runs[0]!.assertions.map((a) => `| ${a.assertion_id} | ${a.rule_ref} | ${a.expected} | ${a.observed} | ${a.verdict} |`).join("\n");
  const injectedNote = o.injected
    ? `\n> **LOCAL INJECTED REGRESSION.** This bundle was produced on a sidecar build with \`${o.injected.file}\` (sha256 \`${o.injected.sha256.slice(0, 12)}…\`) applied on purpose. The mismatch below demonstrates FrameLab; it is not an upstream bug.\n`
    : "";
  return `# FrameLab bundle: ${o.original.id}
${injectedNote}
Original scenario \`${o.original.id}\`: **${o.verdicts.overall}** (exit ${o.verdicts.exit_code}) on sidecar build \`${o.verdicts.sidecar_build.label}\`, two fresh runs.

| Assertion | Rule | Expected | Observed | Verdict |
|---|---|---|---|---|
${rows}

${o.reduction ? reductionSection(o.reduction) : "No shrink ran for this bundle; there is no scenario.min.yaml.\n"}
## Replay

Prerequisites: macOS or Linux on arm64, Docker, Bun 1.3, a FrameLab checkout (bundle made at \`${o.commit}\`) with \`../vendor/sidecar\` at \`${o.nodePin.sidecar.commit}\`, and the local ethrex image \`${o.nodePin.ethrex.image}\` built from \`${o.nodePin.ethrex.pinned_commit}\` (recorded image ID \`${o.nodePin.ethrex.image_id}\`).

\`\`\`
FRAMELAB=/path/to/framelab ./replay.sh
\`\`\`

\`replay.sh\` checks \`SHA256SUMS\`, checks pins, runs \`${o.replayFile}\` twice on a fresh local chain and sidecar, then compares with this bundle. Expected exit: ${o.expectedExit}. Everything binds to 127.0.0.1; no public network is used.

## Known limits

- Results apply to this pinned local build and config only, not to the public network or other clients.
- The two runs are a consistency check, not proof of determinism. Replay is a new execution.
- A PASS covers the assertions run, not the whole client.
- A mismatch means the observed fate differs from this scenario's written expectation under the cited rule. On its own it does not show a node bug: the expectation can be wrong.
- The sidecar runs with \`patches/sidecar-observe.patch\`, which only logs reconcile pass completion.

## Keys

All keys in this bundle and its scenario are PUBLIC TEST-ONLY: actor keys derive from the scenario seed, and the funder and relayer keys are public ethrex dev keys. Never fund or use them on any other network. Engine JWT secrets are per-run and are not exported.

## Credits

FrameLab is MIT-licensed. It includes frame-transaction helpers extracted from Etherspot's MIT-licensed sidecar (see NOTICE in the FrameLab repo). It runs ethrex (MIT and Apache-2.0 license files in its repo) and the Etherspot sidecar (MIT) as local dependencies. The only changes to them are the labelled patches in \`patches/\`.
`;
}
