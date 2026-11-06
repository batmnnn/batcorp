import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Version tag mixed into every derived key; bump it if the derivation changes. */
export const ACTOR_DERIVATION = "framelab-actor/v1";

// PUBLIC TEST-ONLY: first rich account of ethrex fixtures/keys/private_keys_l1.txt,
// funded in l1-hegota.json. Anyone can recover it; never use it on another network.
export const FUNDER_PRIVATE_KEY: Hex = "0x941e103320615d394a55708be13e45994c7d93b932b064dbcb2b511fe3254e2e";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface Actor {
  role: string;
  privateKey: Hex;
  address: Address;
}

/** PUBLIC TEST-ONLY keys: derived from the scenario seed, so they are recoverable by design. */
export function deriveActor(seed: string, role: string): Actor {
  const privateKey = keccak256(toHex(`${ACTOR_DERIVATION}:${seed}:${role}`));
  const scalar = BigInt(privateKey);
  if (scalar === 0n || scalar >= SECP256K1_N) {
    throw new Error(`derived key for role ${role} is outside the secp256k1 range; change the seed`);
  }
  return { role, privateKey, address: privateKeyToAccount(privateKey).address };
}

export function funderActor(): Actor {
  return { role: "funder", privateKey: FUNDER_PRIVATE_KEY, address: privateKeyToAccount(FUNDER_PRIVATE_KEY).address };
}
