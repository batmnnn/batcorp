import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunEvidence } from "../oracle/evidence.ts";
import type { RunVerdict } from "../oracle/verdict.ts";
import { canonicalHash } from "../scenario/load.ts";
import type { Limits, ScenarioV1 } from "../scenario/types.ts";
import { buildCandidate, judgePredicate, stepCounts, stepUnits, unusedActors, type ShrinkTarget, type Unit } from "./candidate.ts";
import { ddmin, type Outcome, type SingleDeletionReport } from "./ddmin.ts";

export type Executor = (scenario: ScenarioV1, label: string) => Promise<{ evidence: RunEvidence; verdict: RunVerdict; ms: number }>;

export type StopReason = "complete" | "candidate-budget" | "wall-budget" | "cancelled";

export interface CandidateRecord {
  n: number;
  phase: "steps" | "actors" | "final-confirm";
  key: string | null;
  removed_units: string[];
  removed_actors: string[];
  outcome: Outcome;
  reasons: string[];
  cached: boolean;
  runs: number;
  ms: number;
  dropped_expectations: string[];
}

export interface ShrinkReport {
  target: ShrinkTarget;
  original: ReturnType<typeof stepCounts> & { hash: string };
  reduced: (ReturnType<typeof stepCounts> & { hash: string; removed_units: string[]; removed_actors: string[] }) | null;
  candidates: CandidateRecord[];
  totals: { node_tested: number; kept: number; boring: number; unresolved: number; invalid: number; cached: number };
  budget: { candidates_limit: number; wall_limit_ms: number; wall_used_ms: number; confirm_reserve_ms: number };
  stop_reason: StopReason;
  final_confirmation: { outcome: Outcome; reasons: string[] } | null;
  single_deletions: SingleDeletionReport | null;
  one_minimal: boolean;
  claim: string;
}

export interface ShrinkOptions {
  base: ScenarioV1;
  target: ShrinkTarget;
  limits: Limits;
  /** Wall time of one fresh run of the original; sizes the confirmation reserve. */
  originalRunMs: number;
  execute: Executor;
  /** Pins, rule pack hash, reset method and driver config; part of every cache key. */
  cacheSalt: string;
  cacheDir: string;
  now?: () => number;
  cancelled?: () => boolean;
  onRecord?: (record: CandidateRecord) => void;
}

class Stop extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

export async function shrink(opts: ShrinkOptions): Promise<{ report: ShrinkReport; best: ScenarioV1 | null }> {
  const now = opts.now ?? Date.now;
  const started = now();
  const allUnits = stepUnits(opts.base);
  const records: CandidateRecord[] = [];
  const memory = new Map<string, { outcome: Outcome; reasons: string[] }>();
  let maxRunMs = opts.originalRunMs;
  let nodeTested = 0;
  let stopReason: StopReason = "complete";

  let best = { scenario: opts.base, units: allUnits, actors: new Set<string>(), fresh: true };

  const reserveMs = () => 2 * maxRunMs;
  const checkBudget = () => {
    if (opts.cancelled?.()) throw new Stop("cancelled");
    if (nodeTested >= opts.limits.shrink_candidates) throw new Stop("candidate-budget");
    if (now() - started + 2 * maxRunMs + reserveMs() > opts.limits.shrink_wall_ms) throw new Stop("wall-budget");
  };

  await mkdir(opts.cacheDir, { recursive: true });
  const cacheFile = (key: string) => path.join(opts.cacheDir, `${key}.json`);
  const readCache = async (key: string) => {
    const hit = memory.get(key);
    if (hit) return hit;
    try {
      return JSON.parse(await readFile(cacheFile(key), "utf8")) as { outcome: Outcome; reasons: string[] };
    } catch {
      return null;
    }
  };

  /** Two fresh runs; the second only when the first is interesting. */
  const freshTwice = async (scenario: ScenarioV1, label: string) => {
    const reasons: string[] = [];
    let runs = 0;
    for (const k of [1, 2]) {
      const res = await opts.execute(scenario, `${label}-run${k}`);
      runs++;
      maxRunMs = Math.max(maxRunMs, res.ms);
      const p = judgePredicate(opts.target, scenario, res.evidence, res.verdict);
      reasons.push(`run ${k}: ${p.outcome} (${p.reason})`);
      if (p.outcome !== "interesting") {
        const outcome: Outcome = k === 2 && p.outcome === "boring" ? "unresolved" : p.outcome;
        if (k === 2 && p.outcome === "boring") reasons.push("fresh runs disagree");
        return { outcome, reasons, runs };
      }
    }
    return { outcome: "interesting" as Outcome, reasons, runs };
  };

  const test = async (phase: CandidateRecord["phase"], kept: Unit[], actors: Set<string>): Promise<Outcome> => {
    const t0 = now();
    const keptIds = new Set(kept.map((u) => u.id));
    const record: CandidateRecord = {
      n: records.length + 1,
      phase,
      key: null,
      removed_units: allUnits.filter((u) => !keptIds.has(u.id)).map((u) => u.id),
      removed_actors: [...actors],
      outcome: "invalid",
      reasons: [],
      cached: false,
      runs: 0,
      ms: 0,
      dropped_expectations: [],
    };
    const push = () => {
      record.ms = now() - t0;
      records.push(record);
      opts.onRecord?.(record);
    };
    const built = buildCandidate(opts.base, kept, actors, opts.target);
    if (!built.ok) {
      record.reasons = built.errors;
      push();
      return "invalid";
    }
    record.dropped_expectations = built.droppedExpectations;
    const key = createHash("sha256").update(`${canonicalHash(built.scenario)}\n${opts.cacheSalt}`).digest("hex").slice(0, 24);
    record.key = key;
    const cached = await readCache(key);
    let fresh = false;
    if (cached) {
      Object.assign(record, { outcome: cached.outcome, reasons: cached.reasons, cached: true });
    } else {
      checkBudget();
      nodeTested++;
      const res = await freshTwice(built.scenario, `c${String(record.n).padStart(3, "0")}`);
      Object.assign(record, { outcome: res.outcome, reasons: res.reasons, runs: res.runs });
      fresh = true;
      memory.set(key, { outcome: res.outcome, reasons: res.reasons });
      if (res.outcome === "interesting" || res.outcome === "boring") {
        await writeFile(cacheFile(key), JSON.stringify({ outcome: res.outcome, reasons: res.reasons }));
      }
    }
    if (record.outcome === "interesting") best = { scenario: built.scenario, units: kept, actors, fresh };
    push();
    return record.outcome;
  };

  let singleDeletions: SingleDeletionReport | null = null;
  try {
    const result = await ddmin(allUnits, async (kept) => {
      try {
        return await test("steps", kept, best.actors);
      } catch (err) {
        if (err instanceof Stop) {
          stopReason = err.reason;
          return "stopped";
        }
        throw err;
      }
    });
    singleDeletions = result.singleDeletions;
    if (!result.stopped) {
      const unused = unusedActors(best.scenario);
      const allAtOnce = unused.length > 0 ? await test("actors", best.units, new Set([...best.actors, ...unused])) : "interesting";
      if (allAtOnce !== "interesting" && unused.length > 1) {
        for (const actor of unused) await test("actors", best.units, new Set([...best.actors, actor]));
      }
    }
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    stopReason = err.reason;
  }

  let finalConfirmation: ShrinkReport["final_confirmation"] = null;
  let confirmed = best.scenario !== opts.base && best.fresh;
  if (best.scenario !== opts.base && stopReason !== "cancelled") {
    const t0 = now();
    const res = await freshTwice(best.scenario, "final");
    finalConfirmation = { outcome: res.outcome, reasons: res.reasons };
    confirmed = res.outcome === "interesting";
    const record: CandidateRecord = {
      n: records.length + 1,
      phase: "final-confirm",
      key: null,
      removed_units: allUnits.filter((u) => !best.units.includes(u)).map((u) => u.id),
      removed_actors: [...best.actors],
      outcome: res.outcome,
      reasons: res.reasons,
      cached: false,
      runs: res.runs,
      ms: now() - t0,
      dropped_expectations: [],
    };
    records.push(record);
    opts.onRecord?.(record);
  }

  const searchRecords = records.filter((r) => r.phase !== "final-confirm");
  const totals = {
    node_tested: searchRecords.filter((r) => !r.cached && r.outcome !== "invalid").length,
    kept: searchRecords.filter((r) => r.outcome === "interesting").length,
    boring: searchRecords.filter((r) => r.outcome === "boring").length,
    unresolved: searchRecords.filter((r) => r.outcome === "unresolved").length,
    invalid: searchRecords.filter((r) => r.outcome === "invalid").length,
    cached: searchRecords.filter((r) => r.cached).length,
  };
  const oneMinimal = stopReason === "complete" && singleDeletions !== null && singleDeletions.unresolved === 0;
  const reduced =
    confirmed && best.scenario !== opts.base
      ? { ...stepCounts(best.scenario), hash: canonicalHash(best.scenario), removed_units: allUnits.filter((u) => !best.units.includes(u)).map((u) => u.id), removed_actors: [...best.actors] }
      : null;
  const singles = singleDeletions
    ? `${singleDeletions.permitted} permitted single deletions of the final step set were tested: ${singleDeletions.boring} did not reproduce, ${singleDeletions.unresolved} unresolved.`
    : "Single deletions of the final step set were not all tested.";
  const claim = reduced
    ? `Smallest found: ${reduced.total} steps (${reduced.setup} setup, ${reduced.action} action, ${reduced.checkpoints} checkpoint) from ${opts.base.steps.length}. ${singles} ` +
      (oneMinimal ? "1-minimal with respect to step deletion." : "Not shown to be 1-minimal.") +
      " Not a global minimum."
    : "No smaller confirmed case; the original scenario is the best case.";

  return {
    best: reduced ? best.scenario : null,
    report: {
      target: opts.target,
      original: { ...stepCounts(opts.base), hash: canonicalHash(opts.base) },
      reduced,
      candidates: records,
      totals,
      budget: { candidates_limit: opts.limits.shrink_candidates, wall_limit_ms: opts.limits.shrink_wall_ms, wall_used_ms: now() - started, confirm_reserve_ms: reserveMs() },
      stop_reason: stopReason,
      final_confirmation: finalConfirmation,
      single_deletions: singleDeletions,
      one_minimal: oneMinimal,
      claim,
    },
  };
}
