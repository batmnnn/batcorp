import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hex } from "viem";
import { ETHREX_PIN } from "./pins.ts";
import { exec, waitUntil } from "../util/proc.ts";
import { RpcClient, type RpcSink } from "../util/rpc.ts";

export interface EthrexOptions {
  name: string;
  httpPort: number;
  authPort: number;
  workDir: string;
  image?: string;
  readyTimeoutMs?: number;
  sink?: RpcSink;
}

export interface GenesisInfo {
  hash: Hex;
  timestamp: bigint;
  gasLimit: bigint;
}

export interface EthrexHandle {
  container: string;
  image: string;
  imageId: string;
  rpc: RpcClient;
  rpcUrl: string;
  authUrl: string;
  jwtSecret: Buffer;
  startupMs: number;
  clientVersion: string;
  chainId: number;
  genesis: GenesisInfo;
}

export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function startEthrex(opts: EthrexOptions): Promise<EthrexHandle> {
  const image = opts.image ?? ETHREX_PIN.image;
  const genesisHash = await sha256File(ETHREX_PIN.genesisPath);
  if (genesisHash !== ETHREX_PIN.genesisSha256) {
    throw new Error(`genesis ${ETHREX_PIN.genesisPath} has sha256 ${genesisHash}, expected ${ETHREX_PIN.genesisSha256}`);
  }

  await mkdir(opts.workDir, { recursive: true });
  const jwtSecret = randomBytes(32);
  const jwtFile = path.join(opts.workDir, "jwt.hex");
  await writeFile(jwtFile, jwtSecret.toString("hex"), { mode: 0o600 });

  await exec(["docker", "rm", "-f", opts.name], { allowFail: true });
  const started = Date.now();
  // No --datadir volume: the chain lives in the container and `docker rm -f` is the reset.
  await exec([
    "docker", "run", "-d", "--name", opts.name,
    "-p", `127.0.0.1:${opts.httpPort}:8545`,
    "-p", `127.0.0.1:${opts.authPort}:8551`,
    "-v", `${ETHREX_PIN.genesisPath}:/genesis/l1-hegota.json:ro`,
    "-v", `${jwtFile}:/secrets/jwt.hex:ro`,
    image,
    "--network", "/genesis/l1-hegota.json",
    "--datadir", "/data",
    "--http.addr", "0.0.0.0", "--http.port", "8545",
    "--http.api", "eth,net,web3,ethrex,debug",
    "--authrpc.addr", "0.0.0.0", "--authrpc.port", "8551",
    "--authrpc.jwtsecret", "/secrets/jwt.hex",
    // The default snap mode answers every forkchoiceUpdated with SYNCING (fork_choice.rs).
    "--syncmode", "full",
  ]);

  const rpcUrl = `http://127.0.0.1:${opts.httpPort}`;
  const rpc = new RpcClient(rpcUrl, { sink: opts.sink, timeoutMs: 10_000 });
  const chainIdHex = await waitUntil("ethrex eth_chainId", () => rpc.call<Hex>("eth_chainId"), {
    timeoutMs: opts.readyTimeoutMs ?? 120_000,
    intervalMs: 250,
  });
  const startupMs = Date.now() - started;

  const imageId = (await exec(["docker", "image", "inspect", image, "--format", "{{.Id}}"])).stdout.trim();
  const clientVersion = await rpc.call<string>("web3_clientVersion");
  const block0 = await rpc.call<{ hash: Hex; timestamp: Hex; gasLimit: Hex }>("eth_getBlockByNumber", ["0x0", false]);

  return {
    container: opts.name,
    image,
    imageId,
    rpc,
    rpcUrl,
    authUrl: `http://127.0.0.1:${opts.authPort}`,
    jwtSecret,
    startupMs,
    clientVersion,
    chainId: Number(BigInt(chainIdHex)),
    genesis: { hash: block0.hash, timestamp: BigInt(block0.timestamp), gasLimit: BigInt(block0.gasLimit) },
  };
}

export async function stopEthrex(container: string): Promise<void> {
  await exec(["docker", "rm", "-f", container], { allowFail: true });
}

export async function ethrexLogs(container: string, tail = 200): Promise<string> {
  const { stdout, stderr } = await exec(["docker", "logs", "--tail", String(tail), container], { allowFail: true });
  return stdout + stderr;
}
