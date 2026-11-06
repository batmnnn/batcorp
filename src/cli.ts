import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { exportBundle } from "./bundle/export.ts";
import { sha256File, startEthrex, stopEthrex } from "./env/ethrex.ts";
import { ETHREX_PIN, SIDECAR_PIN } from "./env/pins.ts";
import { EngineStepper } from "./env/stepper.ts";
import { exec } from "./util/proc.ts";
import { ensureSidecarBuild, startSidecar, stopSidecar, type SidecarBuild, type SidecarHandle } from "./env/sidecar.ts";
import { loadRulePack, verifyRulePack, type LoadedRulePack } from "./oracle/rulepack.ts";
import { combineRuns, exitCode, judgeRun, type RunVerdict } from "./oracle/verdict.ts";
import type { ShrinkTarget } from "./reducer/candidate.ts";
import { shrink } from "./reducer/shrink.ts";
import { diffValues, EXCLUDED_FROM_COMPARISON, project } from "./runner/projection.ts";
import { FAULT_KINDS, RELAYER_KEY, runDirFor, runScenario, waitForPass, writeRunFiles, type Fault, type RunOutput } from "./runner/run.ts";
import { canonicalHash, loadScenario, type LoadedScenario } from "./scenario/load.ts";
import type { ScenarioV1 } from "./scenario/types.ts";

const FRAMELAB_ROOT = path.resolve(import.meta.dir, "..");
const OBSERVE_PATCH = path.join(FRAMELAB_ROOT, "patches/sidecar-observe.patch");
const PORTS = { http: 18545, auth: 18551, api: 15437 };
const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

interface Prepared {
  loaded: LoadedScenario;
  rulePack: LoadedRulePack;
  build: SidecarBuild;
  outDir: string;
  /** Negative-path testing only. */
  fault?: Fault;
  /** Negative-path testing only: run 2 on a different build, to show inconsistent double runs. */
  run2Build?: SidecarBuild;
  /** Appends one line to `<outDir>/progress.jsonl`; the UI's Running and Shrinking states read it. */
  progress: (event: Record<string, unknown>) => void;
  cancel: { requested: boolean };
}

async function prepare(file: string, label: string, patches: string[], out: string | undefined, kind: string): Promise<Prepared> {
  const loaded = await loadScenario(file);
  const rulePack = await loadRulePack(path.join(FRAMELAB_ROOT, "rulepacks", `${loaded.scenario.rule_pack}.json`));
  const badQuotes = (await verifyRulePack(rulePack.pack, SIDECAR_PIN.dir)).filter((c) => !c.hashOk || !c.quoteFound);
  if (badQuotes.length > 0) throw new Error(`rule pack ${rulePack.pack.id} does not match its pinned source: ${JSON.stringify(badQuotes)}`);
  const build = await ensureSidecarBuild(label, [OBSERVE_PATCH, ...patches.map((p) => path.resolve(p))]);
  const outDir = path.resolve(out ?? path.join(FRAMELAB_ROOT, ".runs", `${kind}-${loaded.scenario.id}-${label}-${Date.now()}`));
  await mkdir(outDir, { recursive: true });
  const progressFile = path.join(outDir, "progress.jsonl");
  const progress = (event: Record<string, unknown>) => appendFileSync(progressFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  progress({ kind: "start", command: kind, scenario: loaded.scenario.id, build: `${build.label}-${build.buildHash.slice(0, 12)}` });
  return { loaded, rulePack, build, outDir, progress, cancel: { requested: false } };
}

/** Shrink candidates pass `cancellable: false`: a stop request finishes the current candidate (§5.4). */
async function runOnce(p: Prepared, loaded: LoadedScenario, dir: string, run: number, cancellable = true): Promise<{ out: RunOutput; verdict: RunVerdict }> {
  const build = run === 2 && p.run2Build ? p.run2Build : p.build;
  const out = await runScenario({
    loaded,
    build,
    runDir: dir,
    run,
    ports: PORTS,
    fault: p.fault,
    cancelled: cancellable ? () => p.cancel.requested : undefined,
    onProgress: (e) => p.progress(e),
  });
  await writeRunFiles(dir, out);
  return { out, verdict: judgeRun(loaded.scenario.expectations, out.evidence, p.rulePack.pack) };
}

/** Two fresh runs of the same scenario, judged and compared on the semantic projection. */
async function runTwice(p: Prepared) {
  const results: Array<{ out: RunOutput; verdict: RunVerdict }> = [];
  for (const run of [1, 2]) {
    if (p.cancel.requested) break;
    const build = run === 2 && p.run2Build ? p.run2Build : p.build;
    const fault = p.fault ? `, FAULT ${p.fault.kind}@${p.fault.checkpoint_id}` : "";
    console.error(`run ${run}/2: ${p.loaded.scenario.id} on sidecar build ${build.label}-${build.buildHash.slice(0, 12)}${fault}`);
    p.progress({ kind: "run-start", run, of: 2, build: `${build.label}-${build.buildHash.slice(0, 12)}` });
    const r = await runOnce(p, p.loaded, runDirFor(p.outDir, run), run);
    console.error(`run ${run}: ${r.verdict.overall} (${r.verdict.counts.executed}/${r.verdict.counts.declared} executed, reset ${r.out.meta.reset.ms} ms, wall ${r.out.meta.wall_ms} ms)`);
    p.progress({ kind: "run-done", run, overall: r.verdict.overall, executed: r.verdict.counts.executed, declared: r.verdict.counts.declared });
    results.push(r);
  }
  let overall: RunVerdict["overall"];
  const disagreements: string[] = [];
  if (results.length < 2) {
    overall = "INCONCLUSIVE";
    disagreements.push(`cancelled after ${results.length} of 2 runs`);
  } else {
    const [a, b] = results as [(typeof results)[0], (typeof results)[0]];
    const combined = combineRuns(a.verdict, b.verdict);
    disagreements.push(...combined.disagreements);
    const projectionDiff = diffValues(project(a.out.evidence, a.verdict), project(b.out.evidence, b.verdict));
    disagreements.push(...projectionDiff.map((d) => `projection ${d}`));
    overall = disagreements.length > 0 ? "INCONCLUSIVE" : combined.overall;
  }
  const summary = {
    scenario: { id: p.loaded.scenario.id, hash: p.loaded.hash },
    rule_pack: { id: p.rulePack.pack.id, hash: p.rulePack.hash },
    sidecar_build: p.build,
    ...(p.run2Build ? { run2_sidecar_build: p.run2Build } : {}),
    ...(p.fault ? { fault: p.fault } : {}),
    ...(p.cancel.requested ? { cancelled: true } : {}),
    overall,
    exit_code: exitCode(overall),
    disagreements,
    excluded_from_comparison: EXCLUDED_FROM_COMPARISON,
    runs: results.map((r) => r.verdict),
  };
  await writeFile(path.join(p.outDir, "verdicts.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(p.outDir, "scenario.original.yaml"), p.loaded.text);
  return { overall, disagreements, results };
}

function printVerdicts(v: RunVerdict | undefined, disagreements: string[]) {
  for (const a of v?.assertions ?? []) console.log(`${a.assertion_id.padEnd(10)} ${a.verdict.padEnd(22)} expected ${a.expected}, observed ${a.observed}  ${a.reasons.join("; ")}`);
  for (const d of disagreements) console.log(`DISAGREE ${d}`);
}

const commonOptions = {
  patch: { type: "string" as const, multiple: true as const, default: [] as string[] },
  label: { type: "string" as const, default: "observe" },
  out: { type: "string" as const },
};

async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...commonOptions, fault: { type: "string" }, "run2-patch": { type: "string" }, "run2-label": { type: "string" } },
  });
  if (!positionals[0]) {
    throw new Error(
      "usage: framelab run <scenario.yaml> [--patch file]... [--label name] [--out dir]\n" +
        `  negative-path testing only: [--fault ${FAULT_KINDS.join("|")}@<checkpoint>] [--run2-patch file --run2-label name]`
    );
  }
  const negative = values.fault !== undefined || values["run2-patch"] !== undefined;
  const p = await prepare(positionals[0], values.label, values.patch, values.out, negative ? "negative" : "run");
  if (values.fault) {
    const [kind, checkpoint_id] = values.fault.split("@") as [Fault["kind"], string | undefined];
    const checkpoints = p.loaded.scenario.steps.flatMap((s) => (s.action === "advance-to-checkpoint" ? [s.checkpoint_id] : []));
    if (!FAULT_KINDS.includes(kind) || !checkpoint_id || !checkpoints.includes(checkpoint_id)) {
      throw new Error(`--fault must be ${FAULT_KINDS.join("|")}@<one of ${checkpoints.join(", ")}>`);
    }
    p.fault = { kind, checkpoint_id };
  }
  if (values["run2-patch"]) {
    p.run2Build = await ensureSidecarBuild(values["run2-label"] ?? "run2", [OBSERVE_PATCH, ...values.patch.map((f) => path.resolve(f)), path.resolve(values["run2-patch"])]);
  }
  process.once("SIGINT", () => {
    p.cancel.requested = true;
    console.error("cancel requested: stopping before the next step; the result will be INCONCLUSIVE");
  });
  const { overall, disagreements, results } = await runTwice(p);
  printVerdicts(results[0]?.verdict, disagreements);
  console.log(`${overall} (exit ${exitCode(overall)}) -> ${p.outDir}`);
  p.progress({ kind: "done", overall, exit_code: exitCode(overall), dir: p.outDir });
  return exitCode(overall);
}

async function cmdShrink(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...commonOptions, assertion: { type: "string" } } });
  if (!positionals[0]) throw new Error("usage: framelab shrink <scenario.yaml> [--assertion ID] [--patch file]... [--label name] [--out dir]");
  const p = await prepare(positionals[0], values.label, values.patch, values.out, "shrink");
  // One handler for the whole command: during the original runs it cancels them; later it stops the search.
  process.once("SIGINT", () => {
    p.cancel.requested = true;
    console.error("stop requested: finishing the current candidate, then exporting the best confirmed case");
  });
  const original = await runTwice(p);
  printVerdicts(original.results[0]?.verdict, original.disagreements);
  if (original.overall !== "FAIL") {
    console.log(`original is ${original.overall}; Shrink needs a FAIL that reproduces in two fresh runs -> ${p.outDir}`);
    p.progress({ kind: "done", overall: original.overall, exit_code: exitCode(original.overall), dir: p.outDir, shrink: "not started" });
    return exitCode(original.overall);
  }
  const first = original.results[0]!.verdict.assertions.find((a) => (values.assertion ? a.assertion_id === values.assertion : ["STALE_KEPT", "WRONGLY_EVICTED", "ASSERTION_MISMATCH"].includes(a.verdict)));
  if (!first || first.verdict === "PASS" || first.verdict === "INCONCLUSIVE" || first.verdict === "EXPECTED_INVALIDATION") {
    console.log(`no mismatching assertion ${values.assertion ?? ""} to target`);
    return 2;
  }
  const target: ShrinkTarget = { assertion_id: first.assertion_id, verdict: first.verdict, tx_role: first.tx_role, rule_ref: first.rule_ref, checkpoint_id: first.checkpoint_id };
  console.error(`target frozen: ${JSON.stringify(target)}`);
  const limits = p.loaded.scenario.limits;
  const shrinkStarted = Date.now();
  p.progress({ kind: "shrink-start", target, candidates_limit: limits.shrink_candidates, wall_limit_ms: limits.shrink_wall_ms });
  const tally = { node_tested: 0, kept: 0, unresolved: 0, invalid: 0, boring: 0, cached: 0 };

  let runNo = 2;
  const meta = original.results[0]!.out.meta;
  const { report, best } = await shrink({
    base: p.loaded.scenario,
    target,
    limits: p.loaded.scenario.limits,
    originalRunMs: Math.max(...original.results.map((r) => r.out.meta.wall_ms)),
    cacheSalt: JSON.stringify({ sidecar: p.build.buildHash, rules: p.rulePack.hash, ethrex: [ETHREX_PIN.image, meta.ethrex.image_id], genesis: ETHREX_PIN.genesisSha256, reset: meta.reset.method, driver: meta.driver }),
    cacheDir: path.join(FRAMELAB_ROOT, ".runs", "shrink-cache"),
    cancelled: () => p.cancel.requested,
    onRecord: (r) => {
      console.error(`candidate ${r.n} [${r.phase}] -${r.removed_units.length} units -${r.removed_actors.length} actors: ${r.outcome}${r.cached ? " (cached)" : ""} ${r.reasons.at(-1) ?? ""}`);
      if (r.phase !== "final-confirm") {
        if (r.cached) tally.cached++;
        else if (r.outcome !== "invalid") tally.node_tested++;
        if (r.outcome === "interesting") tally.kept++;
        else if (r.outcome === "unresolved" || r.outcome === "invalid" || r.outcome === "boring") tally[r.outcome]++;
      }
      p.progress({
        kind: "candidate",
        n: r.n,
        phase: r.phase,
        outcome: r.outcome,
        cached: r.cached,
        removed_units: r.removed_units.length,
        removed_actors: r.removed_actors.length,
        reason: r.reasons.at(-1) ?? "",
        totals: { ...tally },
        budget: { candidates_limit: limits.shrink_candidates, wall_limit_ms: limits.shrink_wall_ms, wall_used_ms: Date.now() - shrinkStarted },
      });
    },
    execute: async (scenario: ScenarioV1, label: string) => {
      const loaded: LoadedScenario = { scenario, hash: canonicalHash(scenario), text: YAML.stringify(scenario) };
      const dir = path.join(p.outDir, "candidates", label);
      const t0 = Date.now();
      const { out, verdict } = await runOnce(p, loaded, dir, ++runNo, false);
      await writeFile(path.join(dir, "scenario.yaml"), loaded.text);
      return { evidence: out.evidence, verdict, ms: Date.now() - t0 };
    },
  });
  await writeFile(path.join(p.outDir, "reduction.json"), JSON.stringify(report, null, 2));
  if (best) await writeFile(path.join(p.outDir, "scenario.min.yaml"), YAML.stringify(best));
  for (const run of [1, 2]) await copyFile(path.join(runDirFor(p.outDir, run), "events.jsonl"), path.join(p.outDir, `events.run${run}.jsonl`));
  console.log(report.claim);
  p.progress({ kind: "done", overall: original.overall, exit_code: exitCode(original.overall), dir: p.outDir, stop_reason: report.stop_reason, claim: report.claim });
  console.log(`stop: ${report.stop_reason}; node-tested ${report.totals.node_tested}, kept ${report.totals.kept}, unresolved ${report.totals.unresolved}, invalid ${report.totals.invalid}, cached ${report.totals.cached}; ${Math.round(report.budget.wall_used_ms / 1000)} s of ${report.budget.wall_limit_ms / 1000} s -> ${p.outDir}`);
  return exitCode(original.overall);
}

async function cmdExport(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" } } });
  if (!positionals[0]) throw new Error("usage: framelab export <run-or-shrink-dir> [--out bundle-dir]");
  const srcDir = path.resolve(positionals[0]);
  const bundleDir = path.resolve(values.out ?? path.join(FRAMELAB_ROOT, "bundles", path.basename(srcDir)));
  const { manifest, findings } = await exportBundle({ srcDir, bundleDir, framelabRoot: FRAMELAB_ROOT });
  if (!manifest) {
    for (const f of findings) console.error(`SECRET SCAN ${f.file}: ${f.kind}: ${f.excerpt}`);
    console.error(`export refused: ${findings.length} finding(s); no bundle was written`);
    return 2;
  }
  console.log(`bundle ${bundleDir}: ${Object.keys(manifest.files).length + 2} files, overall ${manifest.overall}, shrink ${manifest.shrink.ran ? "ran" : "did not run"}${manifest.injected_regression ? `, LOCAL INJECTED REGRESSION ${manifest.injected_regression.label}` : ""}`);
  return 0;
}

/** Every file under dir, as paths relative to it. */
async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, p)));
    else out.push(p);
  }
  return out;
}

async function cmdCheckPins(argv: string[]): Promise<number> {
  const dir = argv[0] && path.resolve(argv[0]);
  if (!dir) throw new Error("usage: framelab check-pins <bundle-dir>");
  const read = async (f: string) => JSON.parse(await readFile(path.join(dir, f), "utf8"));
  const manifest = await read("manifest.json");
  const pin = await read("node_pin.json");
  const errors: string[] = [];
  const warnings: string[] = [];
  const sidecarHead = (await exec(["git", "rev-parse", "HEAD"], { cwd: SIDECAR_PIN.dir, allowFail: true })).stdout.trim();
  if (pin.sidecar.commit !== SIDECAR_PIN.commit) errors.push(`bundle sidecar pin ${pin.sidecar.commit} != FrameLab pin ${SIDECAR_PIN.commit}`);
  if (sidecarHead !== SIDECAR_PIN.commit) errors.push(`vendor sidecar checkout is at ${sidecarHead || "nothing"}, pin is ${SIDECAR_PIN.commit}`);
  if (pin.ethrex.pinned_commit !== ETHREX_PIN.commit) errors.push(`bundle ethrex pin ${pin.ethrex.pinned_commit} != FrameLab pin ${ETHREX_PIN.commit}`);
  if (pin.ethrex.genesis_sha256 !== ETHREX_PIN.genesisSha256) errors.push("bundle genesis hash differs from the FrameLab pin");
  const localGenesis = await sha256File(ETHREX_PIN.genesisPath).catch(() => "missing");
  if (localGenesis !== ETHREX_PIN.genesisSha256) errors.push(`local genesis ${ETHREX_PIN.genesisPath} hash is ${localGenesis}`);
  const image = await exec(["docker", "image", "inspect", "--format", "{{.Id}}", pin.ethrex.image], { allowFail: true });
  if (image.code !== 0) errors.push(`ethrex image ${pin.ethrex.image} is not present locally`);
  else if (image.stdout.trim() !== pin.ethrex.image_id) warnings.push(`ethrex image ID ${image.stdout.trim()} differs from recorded ${pin.ethrex.image_id} (local rebuild of the same commit?)`);
  const rulePackText = await readFile(path.join(dir, "rule_pack.json"), "utf8");
  const localRulePack = await readFile(path.join(FRAMELAB_ROOT, "rulepacks", `${manifest.rule_pack.id}.json`), "utf8").catch(() => "");
  if (sha256Hex(rulePackText) !== manifest.rule_pack.hash) errors.push("bundle rule_pack.json does not match the manifest hash");
  if (sha256Hex(localRulePack) !== manifest.rule_pack.hash) errors.push(`local rule pack ${manifest.rule_pack.id} differs from the bundle's frozen oracle`);
  for (const p of pin.sidecar.patches as Array<{ file: string; sha256: string }>) {
    const text = await readFile(path.join(dir, p.file), "utf8").catch(() => null);
    if (text === null || sha256Hex(text) !== p.sha256) errors.push(`patch ${p.file} is missing or changed`);
  }
  if (manifest.tool.commit !== (await exec(["git", "rev-parse", "HEAD"], { cwd: FRAMELAB_ROOT, allowFail: true })).stdout.trim()) {
    warnings.push(`FrameLab checkout differs from the bundle's ${manifest.tool.commit}`);
  }
  const listed = new Set((await readFile(path.join(dir, "SHA256SUMS"), "utf8")).split("\n").filter(Boolean).map((l) => l.replace(/^[0-9a-f]{64} [ *]/, "")));
  listed.add("SHA256SUMS");
  const unlisted = (await listFiles(dir)).filter((f) => !listed.has(f));
  if (unlisted.length) {
    warnings.push(`${unlisted.length} file(s) in the bundle folder are not part of the bundle (not in SHA256SUMS); remove them before sharing: ${unlisted.slice(0, 5).join(", ")}${unlisted.length > 5 ? ", …" : ""}`);
  }
  for (const w of warnings) console.error(`check-pins warning: ${w}`);
  for (const e of errors) console.error(`check-pins error: ${e}`);
  if (errors.length > 0) return 2;
  console.error("check-pins: pins match");
  return 0;
}

async function cmdCompare(argv: string[]): Promise<number> {
  const [oldDir, newDir] = argv.map((a) => path.resolve(a));
  if (!oldDir || !newDir) throw new Error("usage: framelab compare <old-bundle-or-run-dir> <new-run-dir>");
  const readJson = async (d: string, f: string) => JSON.parse(await readFile(path.join(d, f), "utf8"));
  const before = await readJson(oldDir, "verdicts.json");
  const after = await readJson(newDir, "verdicts.json");
  const reduction = await readJson(oldDir, "reduction.json").catch(() => null);
  if (before.rule_pack.hash !== after.rule_pack.hash) {
    console.log(`not comparable: rule pack ${before.rule_pack.hash.slice(0, 12)} vs ${after.rule_pack.hash.slice(0, 12)}; the oracle must be frozen`);
    return 2;
  }
  let only: string | null = null;
  if (before.scenario.hash !== after.scenario.hash) {
    if (reduction?.reduced?.hash === after.scenario.hash) only = reduction.target.assertion_id;
    else {
      console.log("not comparable: different scenario (neither the same scenario nor the bundle's confirmed reduced case)");
      return 2;
    }
  }
  console.log(`old node build ${before.sidecar_build.label}-${before.sidecar_build.buildHash.slice(0, 12)}; new node build ${after.sidecar_build.label}-${after.sidecar_build.buildHash.slice(0, 12)}`);
  type A = { assertion_id: string; verdict: string; observed: string };
  const afterById = new Map<string, A>(after.runs[0].assertions.map((a: A) => [a.assertion_id, a]));
  const rows = (before.runs[0].assertions as A[])
    .filter((a) => !only || a.assertion_id === only)
    .map((a) => {
      const b = afterById.get(a.assertion_id);
      const change = !b ? "missing" : a.verdict === b.verdict ? "unchanged" : b.verdict === "PASS" || b.verdict === "EXPECTED_INVALIDATION" ? "now passes" : "changed";
      return { assertion_id: a.assertion_id, before: `${a.verdict}/${a.observed}`, after: b ? `${b.verdict}/${b.observed}` : "missing", change };
    });
  if (only && reduction) {
    const t = rows[0];
    console.log(`reduced case: only the shrink target ${only} is compared; the bundle recorded ${reduction.target.verdict}, the new run gives ${t?.after ?? "missing"}`);
  }
  for (const r of rows) console.log(`${r.assertion_id.padEnd(10)} ${r.before.padEnd(30)} -> ${r.after.padEnd(30)} ${r.change}`);
  await writeFile(path.join(newDir, "compare.json"), JSON.stringify({ old: oldDir, new: newDir, scope: only ? `target ${only} only` : "all assertions", old_build: before.sidecar_build, new_build: after.sidecar_build, rows, new_overall: after.overall }, null, 2));
  console.log(`new run overall ${after.overall} (exit ${exitCode(after.overall)}); expectations were not changed`);
  return exitCode(after.overall);
}

/**
 * Starts the pinned local stack, checks capabilities and the rule pack, writes `env.json`, then
 * holds the stack until SIGINT/SIGTERM. Runs never reuse it: each starts its own fresh stack.
 */
async function cmdEnv(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { out: { type: "string" }, "rule-pack": { type: "string", default: "sidecar-policy@2e22ff0" } } });
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());

  const outDir = path.resolve(values.out ?? path.join(FRAMELAB_ROOT, ".runs", `env-${Date.now()}`));
  await mkdir(outDir, { recursive: true });
  const rulePack = await loadRulePack(path.join(FRAMELAB_ROOT, "rulepacks", `${values["rule-pack"]}.json`));
  const checks = await verifyRulePack(rulePack.pack, SIDECAR_PIN.dir);
  const build = await ensureSidecarBuild("observe", [OBSERVE_PATCH]);
  const name = "framelab-env-ethrex";
  const sink = () => {};
  let sidecar: SidecarHandle | undefined;
  try {
    await stopEthrex(name);
    const node = await startEthrex({ name, httpPort: PORTS.http, authPort: PORTS.auth, workDir: outDir, sink });
    const head = await new EngineStepper(node, { sink }).init();
    sidecar = await startSidecar({ build, ethrexRpcUrl: node.rpcUrl, apiPort: PORTS.api, runDir: outDir, relayerPrivateKey: RELAYER_KEY, bundleIntervalMs: 250, ttlSeconds: 86_400, sink });
    await waitForPass(sidecar, head.number, 15_000);
    const info = await sidecar.rpc.call<{ bootId: string; oldestSeq: number }>("skandha_explorer_info");
    const blockHeight = BigInt(await node.rpc.call<string>("eth_blockNumber"));
    const env = {
      ready_at: Date.now(),
      note: "Probe stack. Each run starts its own fresh stack from these pins.",
      pins: {
        ethrex: { image: node.image, image_id: node.imageId, client_version: node.clientVersion, pinned_commit: ETHREX_PIN.commit, genesis_sha256: ETHREX_PIN.genesisSha256, genesis_hash: node.genesis.hash, chain_id: node.chainId },
        sidecar: { repo: SIDECAR_PIN.repo, commit: build.commit, build_label: build.label, build_hash: build.buildHash, patches: build.patches },
      },
      rule_pack: {
        id: rulePack.pack.id,
        hash: rulePack.hash,
        source_revision: `${SIDECAR_PIN.repo}@${SIDECAR_PIN.commit}`,
        quotes: checks.length,
        quotes_verified: checks.filter((c) => c.hashOk && c.quoteFound).length,
      },
      capabilities: {
        chain_id: `ok: ${node.chainId}`,
        engine_head: `ok: block ${head.number}`,
        observe_pass_line: `ok: pass reported for block ${head.number}`,
        explorer_info: `ok: bootId ${info.bootId}, oldestSeq ${info.oldestSeq}`,
      },
      block_height: blockHeight.toString(),
    };
    await writeFile(path.join(outDir, "env.json"), JSON.stringify(env, null, 2));
    console.log(`ready: ethrex ${node.clientVersion} at block ${blockHeight}, sidecar ${build.label}-${build.buildHash.slice(0, 12)}, rule pack ${env.rule_pack.quotes_verified}/${env.rule_pack.quotes} quotes verified -> ${outDir}`);
    await stopped;
    return 0;
  } finally {
    if (sidecar) await stopSidecar(sidecar);
    await stopEthrex(name);
  }
}

async function cmdServe(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: "4173" } } });
  const { serve } = await import("./ui/server.ts");
  await serve(Number(values.port));
  return 0;
}

const [command, ...rest] = Bun.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<number>> = {
  env: cmdEnv,
  run: cmdRun,
  shrink: cmdShrink,
  export: cmdExport,
  "check-pins": cmdCheckPins,
  compare: cmdCompare,
  serve: cmdServe,
};
const handler = command ? commands[command] : undefined;
if (!handler) {
  console.error(`usage: framelab <${Object.keys(commands).join("|")}> ...`);
  process.exit(2);
}
try {
  process.exit(await handler(rest));
} catch (err) {
  console.error(`framelab ${command}: ${process.env.FRAMELAB_DEBUG ? ((err as Error).stack ?? String(err)) : ((err as Error).message ?? String(err))}`);
  process.exit(2);
}
