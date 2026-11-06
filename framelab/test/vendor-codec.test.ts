import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildUnsignedFrameTx, computeSigHash, encodeRawFrameTx, signFrameTx } from "../src/vendor/sidecar/frameTx.ts";
import { deriveActor, funderActor } from "../src/env/actors.ts";

const BUILD_ROOT = path.resolve(import.meta.dir, "../.runs/builds");
// A fresh checkout has no sidecar build until the first run makes one.
const build = existsSync(BUILD_ROOT)
  ? readdirSync(BUILD_ROOT, { withFileTypes: true }).find((d) => d.isDirectory() && d.name.startsWith("observe-"))
  : undefined;

test.skipIf(!build)("extracted codec matches the pinned sidecar build", async () => {
  const codec = await import(path.join(BUILD_ROOT, build!.name, "packages/executor/lib/services/FrameTxService/codec.js"));
  const unsigned = buildUnsignedFrameTx(
    3n,
    { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    funderActor().privateKey,
    9,
    deriveActor("codec-test", "recipient").address
  );
  const signed = await signFrameTx(unsigned, funderActor().privateKey);
  expect(computeSigHash(unsigned)).toBe(codec.computeSigHash(unsigned));
  expect(computeSigHash(signed)).toBe(codec.computeSigHash(signed));
  expect(encodeRawFrameTx(signed)).toBe(codec.encodeRawFrameTx(signed));
});
