#!/usr/bin/env bun
/**
 * Publishes an exported bundle to the hosted, read-only viewer that deploy/azure/deploy.sh sets up.
 * Publishing makes the bundle public: only publish bundles you would commit to a public repository.
 *
 * The folder is copied first and the copy is what gets checked and uploaded. It is refused unless
 * every file is listed in SHA256SUMS with a matching hash, nothing is unlisted or a symlink, the
 * manifest agrees with SHA256SUMS, and the export's secret scan comes back clean again (engine JWTs
 * from every local run, the devnet throwaway key, secret-like environment values).
 *
 *   bun scripts/publish-bundle.ts <bundle-dir> [--name NAME] [--replace] [--dry-run]
 *   bun scripts/publish-bundle.ts --remove NAME
 *   bun scripts/publish-bundle.ts --list
 */
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { BUNDLE_SCHEMA, publicTestKeys } from "../src/bundle/export.ts";
import { scanText, secretsFromEnv, type KnownSecret } from "../src/bundle/scan.ts";
import { DEFAULT_KEY_FILE } from "../src/devnet/submit.ts";
import type { ScenarioV1 } from "../src/scenario/types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const RG = process.env.FRAMELAB_AZ_RG ?? "rg-framelab";
const APP = process.env.FRAMELAB_AZ_APP ?? "framelab";
const SHARE = "bundles";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUIRED = ["manifest.json", "SHA256SUMS", "verdicts.json", "replay.sh"];
const SUM_LINE = /^([0-9a-f]{64}) {2}(\S.*)$/;

const exists = (file: string) => stat(file).then(() => true, () => false);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(dir, name)));
    else if (entry.isFile()) out.push(name);
    else throw new Error(`${name} is not a regular file (symlinks and devices are refused)`);
  }
  return out;
}

async function knownSecrets(scenarios: ScenarioV1[]): Promise<KnownSecret[]> {
  const runs = path.join(ROOT, ".runs");
  const jwts: KnownSecret[] = [];
  if (await exists(runs)) {
    for await (const rel of new Bun.Glob("**/jwt.hex").scan({ cwd: runs, onlyFiles: true })) {
      jwts.push({ label: `engine JWT key .runs/${rel}`, value: (await readFile(path.join(runs, rel), "utf8")).trim() });
    }
  }
  return [
    ...jwts,
    ...secretsFromEnv(process.env, publicTestKeys(scenarios)),
    ...(await readFile(DEFAULT_KEY_FILE, "utf8").then((k) => [{ label: "devnet throwaway key", value: k.trim() }], () => [])),
  ];
}

/** Everything that makes the folder unpublishable; empty when it is an intact, clean bundle. */
async function checkBundle(dir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const f of REQUIRED) if (!(await exists(path.join(dir, f)))) problems.push(`${f} is missing: not an exported bundle`);
  if (problems.length) return problems;

  const files = await walk(dir);
  const sums = new Map<string, string>();
  for (const line of (await readFile(path.join(dir, "SHA256SUMS"), "utf8")).split("\n").filter(Boolean)) {
    const m = SUM_LINE.exec(line);
    if (!m || m[2].startsWith("/") || m[2].split("/").includes("..")) problems.push(`SHA256SUMS has a malformed line: ${line.slice(0, 80)}`);
    else sums.set(m[2], m[1]);
  }
  for (const rel of files) if (rel !== "SHA256SUMS" && !sums.has(rel)) problems.push(`${rel} is not listed in SHA256SUMS`);
  for (const [rel, hash] of sums) {
    if (!files.includes(rel)) problems.push(`${rel} is listed in SHA256SUMS but missing`);
    else if (sha256(await readFile(path.join(dir, rel))) !== hash) problems.push(`${rel} does not match SHA256SUMS`);
  }

  let manifest: { schema?: string; files?: Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return [...problems, "manifest.json is not valid JSON"];
  }
  if (manifest.schema !== BUNDLE_SCHEMA) problems.push(`manifest.json schema is ${manifest.schema}, expected ${BUNDLE_SCHEMA}`);
  for (const [rel, hash] of Object.entries(manifest.files ?? {})) {
    if (sums.get(rel) !== hash) problems.push(`manifest.json and SHA256SUMS disagree on ${rel}`);
  }

  const scenarios: ScenarioV1[] = [];
  for (const f of ["scenario.original.yaml", "scenario.min.yaml"]) {
    if (files.includes(f)) scenarios.push(YAML.parse(await readFile(path.join(dir, f), "utf8")));
  }
  const known = await knownSecrets(scenarios);
  for (const rel of files) {
    for (const f of scanText(rel, await readFile(path.join(dir, rel), "utf8"), known)) problems.push(`${f.file}: ${f.kind}: ${f.excerpt}`);
  }
  return problems;
}

/** Runs az with storage credentials in its environment only, never on the command line or in output. */
async function az(args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["az", ...args, "--only-show-errors"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`az ${args.slice(0, 3).join(" ")} failed: ${err.trim() || `exit ${code}`}`);
  return out.trim();
}

async function target() {
  const account = await az(["storage", "account", "list", "-g", RG, "--query", "[0].name", "-o", "tsv"]);
  if (!account) throw new Error(`no storage account in ${RG}; run deploy/azure/deploy.sh first`);
  const key = await az(["storage", "account", "keys", "list", "-g", RG, "-n", account, "--query", "[0].value", "-o", "tsv"]);
  const fqdn = await az(["containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.configuration.ingress.[customDomains[0].name, fqdn] | [?@] | [0]", "-o", "tsv"]);
  return { env: { AZURE_STORAGE_ACCOUNT: account, AZURE_STORAGE_KEY: key }, fqdn };
}

type Entry = { name: string; type?: string };
const list = async (env: Record<string, string>, dir?: string): Promise<Entry[]> =>
  JSON.parse(await az(["storage", "file", "list", "--share-name", SHARE, ...(dir ? ["--path", dir] : []), "-o", "json"], env));
const published = async (env: Record<string, string>, name: string) =>
  (await az(["storage", "directory", "exists", "--share-name", SHARE, "--name", name, "--query", "exists", "-o", "tsv"], env)) === "true";

async function removeDirs(env: Record<string, string>, dir: string): Promise<void> {
  for (const e of await list(env, dir)) if (e.type === "dir") await removeDirs(env, `${dir}/${e.name}`);
  await az(["storage", "directory", "delete", "--share-name", SHARE, "--name", dir, "--fail-not-exist"], env);
}

/** verdicts.json goes first, so the viewer stops listing the bundle before its files disappear. */
async function unpublish(env: Record<string, string>, name: string): Promise<void> {
  await az(["storage", "file", "delete", "--share-name", SHARE, "--path", `${name}/verdicts.json`], env).catch(() => "");
  await az(["storage", "file", "delete-batch", "--source", SHARE, "--pattern", `${name}/*`], env);
  await removeDirs(env, name);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: { name: { type: "string" }, replace: { type: "boolean" }, "dry-run": { type: "boolean" }, remove: { type: "string" }, list: { type: "boolean" } },
  });

  if (values.list) {
    const { env, fqdn } = await target();
    const names = (await list(env)).filter((e) => e.type === "dir").map((e) => e.name).sort();
    if (!names.length) console.log("nothing published");
    for (const n of names) console.log(`${n}\thttps://${fqdn}/?b=bundles/${n}`);
    return 0;
  }

  if (values.remove !== undefined) {
    if (!NAME.test(values.remove)) return usage(`not a bundle name: ${values.remove}`);
    const { env } = await target();
    if (!(await published(env, values.remove))) return usage(`${values.remove} is not published`);
    await unpublish(env, values.remove);
    console.log(`removed ${values.remove}; the hosted list drops it within 30 s`);
    return 0;
  }

  if (positionals.length !== 1) return usage("give exactly one bundle folder");
  const src = path.resolve(positionals[0]);
  const name = values.name ?? path.basename(src);
  if (!NAME.test(name) || name.includes("..")) return usage(`not a usable bundle name: ${name} (letters, digits, . _ - only)`);

  const stage = await mkdtemp(path.join(tmpdir(), "framelab-publish-"));
  try {
    const copy = path.join(stage, name);
    await cp(src, copy, { recursive: true, verbatimSymlinks: true });
    const problems = await checkBundle(copy);
    if (problems.length) {
      console.error(`refusing to publish ${positionals[0]}:`);
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }
    console.log(`${positionals[0]}: every file matches SHA256SUMS and the secret scan is clean`);
    if (values["dry-run"]) {
      console.log(`dry run: would publish as ${name}`);
      return 0;
    }

    const { env, fqdn } = await target();
    if (await published(env, name)) {
      if (!values.replace) return usage(`${name} is already published; pass --replace to overwrite it`);
      await unpublish(env, name);
    }
    const verdicts = path.join(stage, "verdicts.json");
    await cp(path.join(copy, "verdicts.json"), verdicts);
    await rm(path.join(copy, "verdicts.json"));
    await az(["storage", "directory", "create", "--share-name", SHARE, "--name", name, "--fail-on-exist"], env);
    await az(["storage", "file", "upload-batch", "--destination", SHARE, "--destination-path", name, "--source", copy], env);
    await az(["storage", "file", "upload", "--share-name", SHARE, "--source", verdicts, "--path", `${name}/verdicts.json`], env);
    console.log(`published ${name}; it shows in the hosted list within 30 s`);
    console.log(`https://${fqdn}/?b=bundles/${name}`);
    return 0;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function usage(message: string): number {
  console.error(`publish-bundle: ${message}`);
  console.error("usage: bun scripts/publish-bundle.ts <bundle-dir> [--name NAME] [--replace] [--dry-run] | --remove NAME | --list");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`publish-bundle: ${(err as Error).message}`);
    process.exit(2);
  }
);
