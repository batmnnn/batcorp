export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function exec(cmd: string[], opts: { cwd?: string; allowFail?: boolean } = {}): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }
  return { code, stdout, stderr };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { timeoutMs, intervalMs = 250 }: { timeoutMs: number; intervalMs?: number }
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? ` (last error: ${(lastError as Error).message})` : "";
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${suffix}`);
}
