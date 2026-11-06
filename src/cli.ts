import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { ETHREX_PIN, SIDECAR_PIN } from "./env/pins.ts";
import { ensureSidecarBuild, type SidecarBuild } from "./env/sidecar.ts";
import { loadRulePack, verifyRulePack, type LoadedRulePack } from "./oracle/rulepack.ts";
import { combineRuns, exitCode, judgeRun, type RunVerdict } from "./oracle/verdict.ts";
import type { ShrinkTarget } from "./reducer/candidate.ts";
import { shrink } from "./reducer/shrink.ts";
import { diffValues, EXCLUDED_FROM_COMPARISON, project } from "./runner/projection.ts";
import { runDirFor, runScenario, writeRunFiles, type RunOutput } from "./runner/run.ts";
import { canonicalHash, loadScenario, type LoadedScenario } from "./scenario/load.ts";
import type { ScenarioV1 } from "./scenario/types.ts";

const FRAMELAB_ROOT = path.resolve(import.meta.dir, "..");
const OBSERVE_PATCH = path.join(FRAMELAB_ROOT, "patches/sidecar-observe.patch");
const PORTS = { http: 18545, auth: 18551, api: 15437 };

interface Prepared {
  loaded: LoadedScenario;
  rulePack: LoadedRulePack;
  build: SidecarBuild;
  outDir: string;
}

async function prepare(file: string, label: string, patches: string[], out: string | undefined, kind: string): Promise<Prepared> {
  const loaded = await loadScenario(file);
  const rulePack = await loadRulePack(path.join(FRAMELAB_ROOT, "rulepacks", `${loaded.scenario.rule_pack}.json`));
  const badQuotes = (await verifyRulePack(rulePack.pack, SIDECAR_PIN.dir)).filter((c) => !c.hashOk || !c.quoteFound);
  if (badQuotes.length > 0) throw new Error(`rule pack ${rulePack.pack.id} does not match its pinned source: ${JSON.stringify(badQuotes)}`);
  const build = await ensureSidecarBuild(label, [OBSERVE_PATCH, ...patches.map((p) => path.resolve(p))]);
  const outDir = path.resolve(out ?? path.join(FRAMELAB_ROOT, ".runs", `${kind}-${loaded.scenario.id}-${label}-${Date.now()}`));
  await mkdir(outDir, { recursive: true });
  return { loaded, rulePack, build, outDir };
}

async function runOnce(p: Prepared, loaded: LoadedScenario, dir: string, run: number): Promise<{ out: RunOutput; verdict: RunVerdict }> {
  const out = await runScenario({ loaded, build: p.build, runDir: dir, run, ports: PORTS });
  await writeRunFiles(dir, out);
  return { out, verdict: judgeRun(loaded.scenario.expectations, out.evidence, p.rulePack.pack) };
}

/** Two fresh runs of the same scenario, judged and compared on the semantic projection. */
async function runTwice(p: Prepared) {
  const results: Array<{ out: RunOutput; verdict: RunVerdict }> = [];
  for (const run of [1, 2]) {
    console.error(`run ${run}/2: ${p.loaded.scenario.id} on sidecar build ${p.build.label}-${p.build.buildHash.slice(0, 12)}`);
    const r = await runOnce(p, p.loaded, runDirFor(p.outDir, run), run);
    console.error(`run ${run}: ${r.verdict.overall} (${r.verdict.counts.executed}/${r.verdict.counts.declared} executed, reset ${r.out.meta.reset.ms} ms, wall ${r.out.meta.wall_ms} ms)`);
    results.push(r);
  }
  const [a, b] = results as [(typeof results)[0], (typeof results)[0]];
  const combined = combineRuns(a.verdict, b.verdict);
  const disagreements = [...combined.disagreements];
  const projectionDiff = diffValues(project(a.out.evidence, a.verdict), project(b.out.evidence, b.verdict));
  disagreements.push(...projectionDiff.map((d) => `projection ${d}`));
  const overall = disagreements.length > 0 ? "INCONCLUSIVE" : combined.overall;
  const summary = {
    scenario: { id: p.loaded.scenario.id, hash: p.loaded.hash },
    rule_pack: { id: p.rulePack.pack.id, hash: p.rulePack.hash },
    sidecar_build: p.build,
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

function printVerdicts(v: RunVerdict, disagreements: string[]) {
  for (const a of v.assertions) console.log(`${a.assertion_id.padEnd(10)} ${a.verdict.padEnd(22)} expected ${a.expected}, observed ${a.observed}  ${a.reasons.join("; ")}`);
  for (const d of disagreements) console.log(`DISAGREE ${d}`);
}

const commonOptions = {
  patch: { type: "string" as const, multiple: true as const, default: [] as string[] },
  label: { type: "string" as const, default: "observe" },
  out: { type: "string" as const },
};

async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: commonOptions });
  if (!positionals[0]) throw new Error("usage: framelab run <scenario.yaml> [--patch file]... [--label name] [--out dir]");
  const p = await prepare(positionals[0], values.label, values.patch, values.out, "run");
  const { overall, disagreements, results } = await runTwice(p);
  printVerdicts(results[0]!.verdict, disagreements);
  console.log(`${overall} (exit ${exitCode(overall)}) -> ${p.outDir}`);
  return exitCode(overall);
}

async function cmdShrink(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...commonOptions, assertion: { type: "string" } } });
  if (!positionals[0]) throw new Error("usage: framelab shrink <scenario.yaml> [--assertion ID] [--patch file]... [--label name] [--out dir]");
  const p = await prepare(positionals[0], values.label, values.patch, values.out, "shrink");
  const original = await runTwice(p);
  printVerdicts(original.results[0]!.verdict, original.disagreements);
  if (original.overall !== "FAIL") {
    console.log(`original is ${original.overall}; Shrink needs a FAIL that reproduces in two fresh runs -> ${p.outDir}`);
    return exitCode(original.overall);
  }
  const first = original.results[0]!.verdict.assertions.find((a) => (values.assertion ? a.assertion_id === values.assertion : ["STALE_KEPT", "WRONGLY_EVICTED", "ASSERTION_MISMATCH"].includes(a.verdict)));
  if (!first || first.verdict === "PASS" || first.verdict === "INCONCLUSIVE" || first.verdict === "EXPECTED_INVALIDATION") {
    console.log(`no mismatching assertion ${values.assertion ?? ""} to target`);
    return 2;
  }
  const target: ShrinkTarget = { assertion_id: first.assertion_id, verdict: first.verdict, tx_role: first.tx_role, rule_ref: first.rule_ref, checkpoint_id: first.checkpoint_id };
  console.error(`target frozen: ${JSON.stringify(target)}`);

  let cancelled = false;
  process.once("SIGINT", () => {
    cancelled = true;
    console.error("stop requested: finishing the current candidate, then exporting the best confirmed case");
  });
  let runNo = 2;
  const meta = original.results[0]!.out.meta;
  const { report, best } = await shrink({
    base: p.loaded.scenario,
    target,
    limits: p.loaded.scenario.limits,
    originalRunMs: Math.max(...original.results.map((r) => r.out.meta.wall_ms)),
    cacheSalt: JSON.stringify({ sidecar: p.build.buildHash, rules: p.rulePack.hash, ethrex: [ETHREX_PIN.image, meta.ethrex.image_id], genesis: ETHREX_PIN.genesisSha256, reset: meta.reset.method, driver: meta.driver }),
    cacheDir: path.join(FRAMELAB_ROOT, ".runs", "shrink-cache"),
    cancelled: () => cancelled,
    onRecord: (r) => console.error(`candidate ${r.n} [${r.phase}] -${r.removed_units.length} units -${r.removed_actors.length} actors: ${r.outcome}${r.cached ? " (cached)" : ""} ${r.reasons.at(-1) ?? ""}`),
    execute: async (scenario: ScenarioV1, label: string) => {
      const loaded: LoadedScenario = { scenario, hash: canonicalHash(scenario), text: YAML.stringify(scenario) };
      const dir = path.join(p.outDir, "candidates", label);
      const t0 = Date.now();
      const { out, verdict } = await runOnce(p, loaded, dir, ++runNo);
      await writeFile(path.join(dir, "scenario.yaml"), loaded.text);
      return { evidence: out.evidence, verdict, ms: Date.now() - t0 };
    },
  });
  await writeFile(path.join(p.outDir, "reduction.json"), JSON.stringify(report, null, 2));
  if (best) await writeFile(path.join(p.outDir, "scenario.min.yaml"), YAML.stringify(best));
  for (const run of [1, 2]) await copyFile(path.join(runDirFor(p.outDir, run), "events.jsonl"), path.join(p.outDir, `events.run${run}.jsonl`));
  console.log(report.claim);
  console.log(`stop: ${report.stop_reason}; node-tested ${report.totals.node_tested}, kept ${report.totals.kept}, unresolved ${report.totals.unresolved}, invalid ${report.totals.invalid}, cached ${report.totals.cached}; ${Math.round(report.budget.wall_used_ms / 1000)} s of ${report.budget.wall_limit_ms / 1000} s -> ${p.outDir}`);
  return exitCode(original.overall);
}

const [command, ...rest] = Bun.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<number>> = { run: cmdRun, shrink: cmdShrink };
const handler = command ? commands[command] : undefined;
if (!handler) {
  console.error(`usage: framelab <${Object.keys(commands).join("|")}> ...`);
  process.exit(2);
}
try {
  process.exit(await handler(rest));
} catch (err) {
  console.error((err as Error).stack ?? String(err));
  process.exit(2);
}
