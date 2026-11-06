import path from "node:path";

export const VENDOR_DIR = path.resolve(import.meta.dir, "../../../vendor");

export const SIDECAR_PIN = {
  repo: "https://github.com/forshtat/mempool-workshop-sidecar",
  commit: "2e22ff0a2898e69ea4bf5275bce1be8581a8582a",
  dir: path.join(VENDOR_DIR, "sidecar"),
} as const;

export const ETHREX_PIN = {
  repo: "https://github.com/forshtat/ethrex",
  commit: "9aa3645d795945c64400f41a70aace0edfa7f383",
  // The published image is linux/amd64 only and does not start under Rosetta
  // on Apple Silicon, so the default is a local native build of the same commit.
  image: process.env.FRAMELAB_ETHREX_IMAGE ?? "framelab/ethrex:9aa3645d-arm64-release-fast",
  publishedImage:
    "ghcr.io/forshtat/eip8141-devnet@sha256:c9a7770f892e02255999e1c0ffd596ecee704d9175c2480811ccdcfa1c2224c6",
  genesisPath: path.join(VENDOR_DIR, "ethrex/fixtures/genesis/l1-hegota.json"),
  genesisSha256: "5fe93acb7674db5d809aae4d66bff742121ed718bcddd327efcb8c1a9e631fb4",
} as const;

export const CHAIN_ID = 9;
