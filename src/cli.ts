import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { SIDECAR_PIN } from "./env/pins.ts";
import { ensureSidecarBuild } from "./env/sidecar.ts";
import { loadRulePack, verifyRulePack } from "./oracle/rulepack.ts";
import { combineRuns, exitCode, judgeRun, type RunVerdict } from "./oracle/verdict.ts";
import { diffValues, EXCLUDED_FROM_COMPARISON, project } from "./runner/projection.ts";
import { runDirFor, runScenario, writeRunFiles } from "./runner/run.ts";
import { loadScenario } from "./scenario/load.ts";

const FRAMELAB_ROOT = path.resolve(import.meta.dir, "..");
const OBSERVE_PATCH = path.join(FRAMELAB_ROOT, "patches/sidecar-observe.patch");

async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      patch: { type: "string", multiple: true, default: [] },
      label: { type: "string", default: "observe" },
      out: { type: "string" },
      runs: { type: "string", default: "2" },
    },
  });
  const file = positionals[0];
  if (!file) throw new Error("usage: framelab run <scenario.yaml> [--patch file]... [--label name] [--out dir]");
  const loaded = await loadScenario(file);
  const rulePack = await loadRulePack(path.join(FRAMELAB_ROOT, "rulepacks", `${loaded.scenario.rule_pack}.json`));
  const quoteChecks = await verifyRulePack(rulePack.pack, SIDECAR_PIN.dir);
  const badQuotes = quoteChecks.filter((c) => !c.hashOk || !c.quoteFound);
  if (badQuotes.length > 0) {
    console.error(`rule pack ${rulePack.pack.id} does not match its pinned source: ${JSON.stringify(badQuotes)}`);
    return 2;
  }

  const build = await ensureSidecarBuild(values.label!, [OBSERVE_PATCH, ...values.patch!]);
  const outDir = path.resolve(values.out ?? path.join(FRAMELAB_ROOT, ".runs", `${loaded.scenario.id}-${values.label}-${Date.now()}`));
  await mkdir(outDir, { recursive: true });

  const runCount = Number(values.runs);
  const verdicts: RunVerdict[] = [];
  const projections: unknown[] = [];
  for (let run = 1; run <= runCount; run++) {
    const dir = runDirFor(outDir, run);
    console.error(`run ${run}/${runCount}: ${loaded.scenario.id} on sidecar build ${build.label}-${build.buildHash.slice(0, 12)}`);
    const out = await runScenario({ loaded, build, runDir: dir, run, ports: { http: 18545, auth: 18551, api: 15437 } });
    await writeRunFiles(dir, out);
    const verdict = judgeRun(loaded.scenario.expectations, out.evidence, rulePack.pack);
    verdicts.push(verdict);
    projections.push(project(out.evidence, verdict));
    console.error(`run ${run}: ${verdict.overall} (${verdict.counts.executed}/${verdict.counts.declared} executed, reset ${out.meta.reset.ms} ms, wall ${out.meta.wall_ms} ms)`);
  }

  let overall = verdicts[0]!.overall;
  const disagreements: string[] = [];
  if (verdicts.length >= 2) {
    const combined = combineRuns(verdicts[0]!, verdicts[1]!);
    overall = combined.overall;
    disagreements.push(...combined.disagreements);
    const projectionDiff = diffValues(projections[0], projections[1]);
    if (projectionDiff.length > 0) {
      overall = "INCONCLUSIVE";
      disagreements.push(...projectionDiff.map((d) => `projection ${d}`));
    }
  } else {
    overall = "INCONCLUSIVE";
    disagreements.push("only one run: the double-run consistency check did not happen");
  }

  const summary = {
    scenario: { id: loaded.scenario.id, hash: loaded.hash },
    rule_pack: { id: rulePack.pack.id, hash: rulePack.hash },
    sidecar_build: build,
    overall,
    exit_code: exitCode(overall),
    disagreements,
    excluded_from_comparison: EXCLUDED_FROM_COMPARISON,
    runs: verdicts,
  };
  await writeFile(path.join(outDir, "verdicts.json"), JSON.stringify(summary, null, 2));
  for (const a of verdicts[0]!.assertions) console.log(`${a.assertion_id.padEnd(10)} ${a.verdict.padEnd(22)} expected ${a.expected}, observed ${a.observed}  ${a.reasons.join("; ")}`);
  for (const d of disagreements) console.log(`DISAGREE ${d}`);
  console.log(`${overall} (exit ${exitCode(overall)}) -> ${outDir}`);
  return exitCode(overall);
}

const [command, ...rest] = Bun.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<number>> = { run: cmdRun };
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
