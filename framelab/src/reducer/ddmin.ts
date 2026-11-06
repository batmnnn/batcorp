/**
 * Complement-deletion ddmin after Zeller ("Reducing Failure-Inducing Inputs", debuggingbook.org).
 * Only deletions are tried: subsets are never run on their own. "unresolved" and "invalid" outcomes
 * never count as a successful deletion.
 */
export type Outcome = "interesting" | "boring" | "unresolved" | "invalid" | "stopped";

export interface SingleDeletionReport {
  /** Single-unit deletions that passed structural validation. */
  permitted: number;
  boring: number;
  unresolved: number;
}

export interface DdminResult<U> {
  kept: U[];
  stopped: boolean;
  /** Present only when the last round tried every single-unit deletion of the final set. */
  singleDeletions: SingleDeletionReport | null;
}

export function splitChunks<U>(items: U[], n: number): U[][] {
  const chunks: U[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = start + Math.floor((items.length - start) / (n - i));
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks.filter((c) => c.length > 0);
}

export async function ddmin<U>(units: U[], test: (kept: U[]) => Promise<Outcome>): Promise<DdminResult<U>> {
  let current = units;
  let n = 2;
  let singleDeletions: SingleDeletionReport | null = null;
  while (current.length > 0) {
    const chunks = splitChunks(current, Math.min(n, current.length));
    const singles = chunks.length === current.length ? { permitted: 0, boring: 0, unresolved: 0 } : null;
    let reduced = false;
    for (const chunk of chunks) {
      const complement = current.filter((u) => !chunk.includes(u));
      const outcome = await test(complement);
      if (outcome === "stopped") return { kept: current, stopped: true, singleDeletions: null };
      if (singles && outcome !== "invalid") {
        singles.permitted++;
        if (outcome === "boring") singles.boring++;
        if (outcome === "unresolved") singles.unresolved++;
      }
      if (outcome === "interesting") {
        current = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (singles) {
      singleDeletions = singles;
      break;
    }
    n = Math.min(n * 2, current.length);
  }
  return { kept: current, stopped: false, singleDeletions };
}
