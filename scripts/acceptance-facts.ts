/**
 * Content checks for scripts/acceptance.sh. Each check reads what a run, shrink or bundle wrote
 * and exits 0 only if the §11 property holds. Its last output line says what it saw.
 *
 *   bun scripts/acceptance-facts.ts <check> <args...>
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

type Assertion = { assertion_id: string; verdict: string; reasons: string[] };
type Run = { run: number; overall: string; counts: { declared: number; executed: number }; assertions: Assertion[] };
type Verdicts = {
  overall: string;
  exit_code: number;
  disagreements: string[];
  runs: Run[];
  fault?: { kind: string; checkpoint_id: string };
  compatibility?: { applicable: boolean; reasons: string[] };
};

const json = async <T>(...p: string[]): Promise<T> => JSON.parse(await readFile(path.join(...p), "utf8")) as T;
const exists = (p: string) => stat(p).then(() => true, () => false);
const GREEN = new Set(["PASS", "EXPECTED_INVALIDATION"]);

class Unmet extends Error {}
function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Unmet(msg);
}

async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    out.push(...(entry.isDirectory() ? await listFiles(dir, p) : [p]));
  }
  return out;
}

function firstCause(v: Verdicts): string {
  if (v.fault) return `fault ${v.fault.kind}@${v.fault.checkpoint_id}`;
  if (v.disagreements.length) return v.disagreements[0]!;
  const a = v.runs.flatMap((r) => r.assertions).find((x) => x.verdict === "INCONCLUSIVE");
  return a ? `${a.assertion_id}: ${a.reasons[0] ?? "inconclusive"}` : "no cause recorded";
}

const checks: Record<string, (args: string[]) => Promise<string>> = {
  /** Acceptance 1: PASS on two runs, each with at least one executed assertion, and projections agree. */
  async "fresh-pass"([dir]) {
    const v = await json<Verdicts>(dir!, "verdicts.json");
    need(v.overall === "PASS" && v.exit_code === 0, `overall ${v.overall}, exit ${v.exit_code}`);
    need(v.runs.length === 2, `${v.runs.length} run(s)`);
    for (const r of v.runs) need(r.counts.executed >= 1, `run ${r.run} executed ${r.counts.executed} assertions`);
    need(v.disagreements.length === 0, `projections disagree: ${v.disagreements[0]}`);
    const expected = v.runs[0]!.assertions.filter((a) => a.verdict === "EXPECTED_INVALIDATION").map((a) => a.assertion_id);
    return `PASS on both runs, ${v.runs.map((r) => `${r.counts.executed}/${r.counts.declared}`).join(" and ")} executed, projections agree; expected invalidations (green): ${expected.join(", ") || "none"}`;
  },

  /** Acceptance 2: only the flipped assertion fails, as an ASSERTION_MISMATCH labelled as a wrong expectation. */
  async "wrong-expectation"([dir, id]) {
    const v = await json<Verdicts>(dir!, "verdicts.json");
    need(v.overall === "FAIL" && v.exit_code === 1, `overall ${v.overall}, exit ${v.exit_code}`);
    for (const r of v.runs) {
      const red = r.assertions.filter((a) => !GREEN.has(a.verdict));
      need(red.length === 1 && red[0]!.assertion_id === id, `run ${r.run} red assertions: ${red.map((a) => a.assertion_id).join(", ")}`);
      need(red[0]!.verdict === "ASSERTION_MISMATCH", `run ${r.run} ${id} is ${red[0]!.verdict}`);
      need(red[0]!.reasons[0]?.startsWith("wrong test expectation"), `run ${r.run} ${id} is not labelled a wrong test expectation`);
    }
    return `FAIL on both runs at ${id} only, ASSERTION_MISMATCH, labelled "wrong test expectation"`;
  },

  /** Acceptance 3 and 9: never green. */
  async inconclusive([dir]) {
    const v = await json<Verdicts>(dir!, "verdicts.json");
    need(v.overall === "INCONCLUSIVE" && v.exit_code === 2, `overall ${v.overall}, exit ${v.exit_code}`);
    return `INCONCLUSIVE, exit 2: ${firstCause(v).slice(0, 200)}`;
  },

  /** Acceptance 4: the frozen target reproduces on the final two fresh runs and the case got smaller. */
  async shrunk([dir]) {
    const v = await json<Verdicts>(dir!, "verdicts.json");
    const r = await json<{
      target: { assertion_id: string; verdict: string };
      original: { total: number };
      reduced: { total: number } | null;
      totals: Record<string, number>;
      final_confirmation: { outcome: string } | null;
      stop_reason: string;
      claim: string;
    }>(dir!, "reduction.json");
    for (const run of v.runs) {
      const a = run.assertions.find((x) => x.assertion_id === r.target.assertion_id);
      need(a?.verdict === r.target.verdict, `original run ${run.run}: ${r.target.assertion_id} is ${a?.verdict}`);
    }
    need(r.target.verdict === "WRONGLY_EVICTED", `target is ${r.target.verdict}`);
    need(r.final_confirmation?.outcome === "interesting", `final confirmation: ${r.final_confirmation?.outcome ?? "not run"}`);
    need(r.reduced && r.reduced.total < r.original.total, `reduced ${r.reduced?.total} vs original ${r.original.total}`);
    need((r.totals.invalid ?? 0) + (r.totals.boring ?? 0) + (r.totals.unresolved ?? 0) > 0, "no candidate was rejected");
    const t = r.totals;
    return `${r.target.assertion_id} ${r.target.verdict} on both original runs; ${r.original.total} -> ${r.reduced!.total} steps, final two fresh runs reproduce; rejected: ${t.invalid} invalid, ${t.boring} other outcome, ${t.unresolved} unresolved; stop ${r.stop_reason}`;
  },

  /**
   * Acceptance 5 and 6: the folder holds exactly the files in SHA256SUMS, and no file contains an
   * engine JWT from any of the given run directories.
   */
  async "bundle-clean"([bundle, ...runDirs]) {
    const listed = (await readFile(path.join(bundle!, "SHA256SUMS"), "utf8")).split("\n").filter(Boolean).map((l) => l.replace(/^[0-9a-f]{64} [ *]/, ""));
    const files = await listFiles(bundle!);
    const extra = files.filter((f) => f !== "SHA256SUMS" && !listed.includes(f));
    need(extra.length === 0, `files not in SHA256SUMS: ${extra.slice(0, 5).join(", ")}`);
    need(listed.includes("manifest.json"), "manifest.json is not covered by SHA256SUMS");
    const jwts: string[] = [];
    for (const d of runDirs) {
      if (!(await exists(d))) continue;
      for (const f of (await listFiles(d)).filter((x) => path.basename(x) === "jwt.hex")) jwts.push((await readFile(path.join(d, f), "utf8")).trim().replace(/^0x/, ""));
    }
    need(jwts.length > 0, "no engine JWT found in the run directories to check against");
    for (const f of files) {
      const text = (await readFile(path.join(bundle!, f), "utf8")).toLowerCase();
      const hit = jwts.find((j) => text.includes(j.toLowerCase()));
      need(!hit, `${f} contains an engine JWT`);
    }
    return `${files.length} files, all in SHA256SUMS (manifest.json included); none contains any of ${jwts.length} engine JWTs from the runs`;
  },

  /** Acceptance 6: both planted secrets were found and no bundle was written. */
  async refused([bundle, log]) {
    const text = await readFile(log!, "utf8");
    need(!(await exists(bundle!)), `a bundle was written at ${bundle}`);
    need(/github-token/.test(text), "the planted GitHub-style token was not reported");
    need(/known secret/.test(text), "the planted secret environment value was not reported");
    need(/export refused/.test(text), "export did not say it refused");
    return "export refused; planted token and planted environment secret both reported; no bundle folder";
  },

  /** Acceptance 7: the reduced case's target now passes on a different build; expectations unchanged. */
  async "compare-fixed"([newDir]) {
    const c = await json<{ rows: Array<{ assertion_id: string; before: string; after: string; change: string }>; new_overall: string; old_build: { buildHash: string }; new_build: { buildHash: string } }>(newDir!, "compare.json");
    need(c.new_overall === "PASS", `new run overall ${c.new_overall}`);
    need(c.old_build.buildHash !== c.new_build.buildHash, "old and new node builds are the same");
    need(c.rows.length > 0 && c.rows.every((r) => r.change === "now passes"), `rows: ${c.rows.map((r) => `${r.assertion_id} ${r.change}`).join(", ")}`);
    return c.rows.map((r) => `${r.assertion_id} ${r.before} -> ${r.after}`).join("; ") + `; builds ${c.old_build.buildHash.slice(0, 12)} vs ${c.new_build.buildHash.slice(0, 12)}`;
  },

  /** Acceptance 9: rejected before any build or node start. */
  async "not-applicable"([dir]) {
    const v = await json<Verdicts>(dir!, "verdicts.json");
    need(v.compatibility?.applicable === false, "no compatibility refusal recorded");
    need(v.overall === "INCONCLUSIVE" && v.exit_code === 2, `overall ${v.overall}, exit ${v.exit_code}`);
    need(v.runs.length === 0 && !(await exists(path.join(dir!, "run1"))), "a run was started");
    return `not applicable, INCONCLUSIVE exit 2, no run started: ${v.compatibility.reasons[0]?.slice(0, 160)}`;
  },
};

const [name, ...args] = Bun.argv.slice(2);
const check = name ? checks[name] : undefined;
if (!check) {
  console.error(`usage: acceptance-facts.ts <${Object.keys(checks).join("|")}> <args...>`);
  process.exit(2);
}
try {
  console.log(await check(args));
} catch (err) {
  console.log(err instanceof Unmet ? `NOT MET: ${err.message}` : `ERROR: ${(err as Error).message}`);
  process.exit(1);
}
