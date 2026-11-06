import { concatHex, type Hex } from "viem";

/** Minimal assembler: opcodes as hex bytes, PUSH1 of a label resolves to that label's offset. */
type Item = { op: string } | { label: string } | { push1Label: string } | { push20: Hex };

function assemble(items: Item[]): Hex {
  const offsets = new Map<string, number>();
  let pc = 0;
  for (const it of items) {
    if ("label" in it) offsets.set(it.label, pc);
    else if ("op" in it) pc += it.op.length / 2;
    else if ("push1Label" in it) pc += 2;
    else pc += 21;
  }
  let out = "";
  for (const it of items) {
    if ("op" in it) out += it.op;
    else if ("push1Label" in it) {
      const at = offsets.get(it.push1Label);
      if (at === undefined || at > 0xff) throw new Error(`bad label ${it.push1Label}`);
      out += `60${at.toString(16).padStart(2, "0")}`;
    } else if ("push20" in it) out += `73${it.push20.slice(2).toLowerCase().padStart(40, "0")}`;
  }
  return `0x${out}`;
}

const ENTRY_POINT_BYTE = "aa";
const APPROVE_EXECUTION_AND_PAYMENT = "03";

/**
 * S2 fixture account. In a VERIFY frame (caller is ENTRY_POINT) it reads its own slot 0 and calls
 * APPROVE(scope 3) only if the slot is non-zero; otherwise it reverts. A normal call from `owner`
 * stores calldata word 0 into slot 0. Any other call stops, so it can receive ETH.
 */
export function slotGatedAccountRuntime(owner: Hex): Hex {
  return assemble([
    { op: "33" }, // CALLER
    { op: `60${ENTRY_POINT_BYTE}` }, // PUSH1 0xaa
    { op: "14" }, // EQ
    { push1Label: "verify" },
    { op: "57" }, // JUMPI
    { op: "33" }, // CALLER
    { push20: owner },
    { op: "14" }, // EQ
    { push1Label: "set" },
    { op: "57" }, // JUMPI
    { op: "00" }, // STOP
    { label: "set" },
    { op: "5b" }, // JUMPDEST
    { op: "6000" }, // PUSH1 0
    { op: "35" }, // CALLDATALOAD
    { op: "6000" }, // PUSH1 0
    { op: "55" }, // SSTORE
    { op: "00" }, // STOP
    { label: "verify" },
    { op: "5b" }, // JUMPDEST
    { op: "6000" }, // PUSH1 0
    { op: "54" }, // SLOAD
    { op: "15" }, // ISZERO
    { push1Label: "deny" },
    { op: "57" }, // JUMPI
    { op: `60${APPROVE_EXECUTION_AND_PAYMENT}` }, // PUSH1 scope
    { op: "6000" }, // PUSH1 length
    { op: "6000" }, // PUSH1 offset (top of stack)
    { op: "aa" }, // APPROVE
    { label: "deny" },
    { op: "5b" }, // JUMPDEST
    { op: "6000" }, // PUSH1 0
    { op: "80" }, // DUP1
    { op: "fd" }, // REVERT
  ]);
}

/** Initcode that returns `runtime` unchanged. */
export function deployCode(runtime: Hex): Hex {
  const size = (runtime.length - 2) / 2;
  if (size > 0xff) throw new Error("runtime too large for this initcode");
  const s = size.toString(16).padStart(2, "0");
  // PUSH1 size, DUP1, PUSH1 11, PUSH1 0, CODECOPY, PUSH1 0, RETURN
  const init: Hex = `0x60${s}80600b6000396000f3`;
  return concatHex([init, runtime]);
}

export const CONTRACT_FIXTURES: Record<string, (owner: Hex) => Hex> = {
  "slot-gated-account": slotGatedAccountRuntime,
};
