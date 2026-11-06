import { expect, test } from "bun:test";
import { deployCode, slotGatedAccountRuntime } from "../src/fixtures/contracts.ts";

const OWNER = "0x00000000000000000000000000000000000000a1";

/** Walks the bytecode, skipping PUSH data, and returns opcode offsets. */
function opcodes(hex: string): Array<{ pc: number; op: number; arg?: string }> {
  const bytes = Buffer.from(hex.slice(2), "hex");
  const out: Array<{ pc: number; op: number; arg?: string }> = [];
  for (let pc = 0; pc < bytes.length; ) {
    const op = bytes[pc]!;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      out.push({ pc, op, arg: bytes.subarray(pc + 1, pc + 1 + n).toString("hex") });
      pc += 1 + n;
    } else {
      out.push({ pc, op });
      pc += 1;
    }
  }
  return out;
}

test("every JUMPI target in the slot-gated account is a JUMPDEST", () => {
  const code = slotGatedAccountRuntime(OWNER);
  const ops = opcodes(code);
  const dests = new Set(ops.filter((o) => o.op === 0x5b).map((o) => o.pc));
  const jumps = ops.flatMap((o, i) => (o.op === 0x57 ? [ops[i - 1]!] : []));
  expect(jumps).toHaveLength(3);
  for (const push of jumps) expect(dests.has(parseInt(push.arg!, 16))).toBe(true);
  expect(code).toContain(OWNER.slice(2));
  const approve = ops.findIndex((o) => o.op === 0xaa);
  expect(ops.slice(approve - 3, approve).map((o) => o.arg)).toEqual(["03", "00", "00"]);
});

test("initcode copies exactly the runtime after its 11-byte prefix", () => {
  const runtime = slotGatedAccountRuntime(OWNER);
  const init = deployCode(runtime);
  expect(init.slice(2, 24)).toBe(`60${((runtime.length - 2) / 2).toString(16)}80600b6000396000f3`);
  expect(`0x${init.slice(24)}`).toBe(runtime);
});
