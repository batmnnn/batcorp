import { ETHREX_PIN, SIDECAR_PIN } from "../env/pins.ts";
import type { ScenarioV1 } from "../scenario/types.ts";
import type { RulePack } from "./rulepack.ts";

/**
 * The only protocol profile this build can drive: the workshop ethrex EIP-8141 codec and the
 * sidecar policy, both at their pins. Current EIP-8141 text uses a different aggregate fee field
 * and signature hash, so scenarios or packs written for it are not applicable here.
 */
export const TARGET_PROFILE = {
  eip8141: `forshtat/ethrex@${ETHREX_PIN.commit}`,
  policy_source: `${SIDECAR_PIN.repo}@${SIDECAR_PIN.commit}`,
} as const;

export interface Compatibility {
  applicable: boolean;
  target: typeof TARGET_PROFILE;
  reasons: string[];
}

/** Checked before any node starts; an inapplicable scenario is INCONCLUSIVE, never a conformance failure. */
export function checkCompatibility(scenario: ScenarioV1, pack: RulePack | null, packError?: string): Compatibility {
  const reasons: string[] = [];
  const revisions = scenario.protocol_revisions ?? {};
  const codec = revisions.eip8141;
  if (codec !== TARGET_PROFILE.eip8141) {
    reasons.push(`scenario targets EIP-8141 codec ${codec ?? "(none declared)"}; this target implements ${TARGET_PROFILE.eip8141}, so its transactions would not encode as written`);
  }
  for (const [key, value] of Object.entries(revisions)) {
    if (key !== "eip8141" && key !== "policy") reasons.push(`scenario requires ${key} ${value}, which this target does not provide`);
  }
  if (revisions.policy !== undefined && revisions.policy !== scenario.rule_pack) {
    reasons.push(`scenario policy revision ${revisions.policy} differs from its rule pack ${scenario.rule_pack}`);
  }
  if (!pack) {
    reasons.push(`rule pack ${scenario.rule_pack} is not available${packError ? ` (${packError})` : ""}`);
  } else {
    if (pack.source.revision !== SIDECAR_PIN.commit) {
      reasons.push(`rule pack ${pack.id} quotes ${pack.source.repo}@${pack.source.revision.slice(0, 12)}; the target sidecar is ${SIDECAR_PIN.commit.slice(0, 12)}`);
    }
    const packCodec = pack.protocol?.eip8141 ?? "";
    if (!packCodec.includes(ETHREX_PIN.commit)) {
      reasons.push(`rule pack ${pack.id} is written for EIP-8141 ${packCodec || "(unspecified)"}, not ${TARGET_PROFILE.eip8141}`);
    }
  }
  return { applicable: reasons.length === 0, target: TARGET_PROFILE, reasons };
}
