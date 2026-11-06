import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type Strength = "MUST" | "SHOULD" | "MAY" | "implementation policy";

export interface RuleRef {
  path: string;
  sha256: string;
  section: string;
  quote: string;
}

export interface Rule {
  id: string;
  strength: Strength;
  summary: string;
  refs: RuleRef[];
}

export interface RulePack {
  schema: "framelab.rulepack/v1";
  id: string;
  authority: string;
  source: { repo: string; revision: string };
  protocol: Record<string, string>;
  rules: Rule[];
}

export interface LoadedRulePack {
  pack: RulePack;
  /** sha256 of the rule-pack file as stored, used to freeze the oracle. */
  hash: string;
  file: string;
}

export async function loadRulePack(file: string): Promise<LoadedRulePack> {
  const text = await readFile(file, "utf8");
  const pack = JSON.parse(text) as RulePack;
  if (pack.schema !== "framelab.rulepack/v1") throw new Error(`${file}: unsupported schema ${pack.schema}`);
  return { pack, hash: createHash("sha256").update(text).digest("hex"), file };
}

export function ruleById(pack: RulePack, id: string): Rule {
  const rule = pack.rules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} is not in pack ${pack.id}`);
  return rule;
}

/** Collapses comment markers and whitespace so multi-line doc comments compare as prose. */
export function normalizeProse(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*|\/\/)\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface QuoteCheck {
  rule: string;
  path: string;
  hashOk: boolean;
  quoteFound: boolean;
}

/** Checks every ref against a checkout of the pack's source revision: file hash and verbatim quote. */
export async function verifyRulePack(pack: RulePack, sourceDir: string): Promise<QuoteCheck[]> {
  const checks: QuoteCheck[] = [];
  for (const rule of pack.rules) {
    for (const ref of rule.refs) {
      const content = await readFile(path.join(sourceDir, ref.path), "utf8");
      checks.push({
        rule: rule.id,
        path: ref.path,
        hashOk: createHash("sha256").update(content).digest("hex") === ref.sha256,
        quoteFound: normalizeProse(content).includes(normalizeProse(ref.quote)),
      });
    }
  }
  return checks;
}
