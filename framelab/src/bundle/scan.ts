/**
 * Content scan for bundle export. It complements the allowlist; a clean scan is not proof that no
 * secret is present. Exact known secrets (per-run engine JWT keys, secret-like environment values)
 * are checked verbatim; patterns catch common credential shapes.
 */
export interface ScanFinding {
  file: string;
  kind: string;
  excerpt: string;
}

export interface KnownSecret {
  label: string;
  value: string;
}

const PATTERNS: Array<[string, RegExp]> = [
  ["pem-private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["api-key-param", /[?&](?:api[_-]?key|apikey|access_token|token)=[^&\s"']{8,}/i],
  ["secret-assignment", /\b[A-Za-z0-9_]*(?:PRIVATE_KEY|SECRET|PASSWORD|API_KEY|ACCESS_TOKEN)[A-Za-z0-9_]*["']?\s*[=:]\s*["']?[^\s"',}]{8,}/i],
];

const SECRET_ENV_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|RPC_URL|AUTH/i;

/** Environment values that look like secrets, minus values declared public. */
export function secretsFromEnv(env: Record<string, string | undefined>, publicValues: string[]): KnownSecret[] {
  const allowed = new Set(publicValues.map((v) => v.toLowerCase().replace(/^0x/, "")));
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && value && value.length >= 12 && !allowed.has(value.toLowerCase().replace(/^0x/, "")))
    .map(([name, value]) => ({ label: `env ${name}`, value: value! }));
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  return `${text.slice(start, index)}[${length} chars redacted]${text.slice(index + length, index + length + 20)}`.replace(/\s+/g, " ");
}

export function scanText(file: string, text: string, known: KnownSecret[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lower = text.toLowerCase();
  for (const secret of known) {
    const bare = secret.value.toLowerCase().replace(/^0x/, "");
    if (bare.length < 12) continue;
    const at = lower.indexOf(bare);
    if (at >= 0) findings.push({ file, kind: `known secret (${secret.label})`, excerpt: excerpt(text, at, bare.length) });
  }
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) findings.push({ file, kind, excerpt: excerpt(text, m.index, m[0].length) });
  }
  return findings;
}
