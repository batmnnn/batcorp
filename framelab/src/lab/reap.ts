import { deleteById, deleteJudgeVm, labConfig, listJudgeVms, listTaggedResources, type JudgeVm } from "./azure.ts";

/**
 * Runs every few minutes as a Container Apps job. Deletes judge VMs past their expiry (or with no
 * readable expiry once they are older than the longest lifetime), then any tagged NIC, IP or disk
 * that no VM owns and that is older than ORPHAN_MINUTES (left behind by a failed create).
 */
const MAX_LIFETIME_MS = 4 * 3_600_000;
const ORPHAN_MS = 30 * 60_000;

export function expired(vm: JudgeVm, now: number): boolean {
  const until = Date.parse(vm.expiresAt);
  if (Number.isFinite(until)) return now >= until;
  const created = Date.parse(vm.createdAt);
  return !Number.isFinite(created) || now - created >= MAX_LIFETIME_MS;
}

export function owner(resourceName: string, vmNames: string[]): string | undefined {
  return vmNames.find((vm) => resourceName === `${vm}-nic` || resourceName === `${vm}-ip` || resourceName.startsWith(`${vm}_OsDisk_`));
}

async function main(): Promise<number> {
  const c = labConfig();
  const now = Date.now();
  const vms = await listJudgeVms(c);
  let failures = 0;
  for (const vm of vms.filter((v) => v.state !== "Deleting" && expired(v, now))) {
    try {
      await deleteJudgeVm(c, vm.name);
      console.log(`reap: deleting ${vm.name} (${vm.login}, expired ${vm.expiresAt || "unknown"})`);
    } catch (e) {
      failures++;
      console.error(`reap: ${vm.name}: ${(e as Error).message}`);
    }
  }
  const names = vms.map((v) => v.name);
  for (const r of await listTaggedResources(c)) {
    if (r.type === "Microsoft.Compute/virtualMachines" || owner(r.name, names)) continue;
    const created = Date.parse(r.createdAt);
    if (Number.isFinite(created) && now - created < ORPHAN_MS) continue;
    try {
      await deleteById(r.id, r.type);
      console.log(`reap: deleted orphan ${r.type.split("/").pop()} ${r.name}`);
    } catch (e) {
      failures++;
      console.error(`reap: orphan ${r.name}: ${(e as Error).message}`);
    }
  }
  console.log(`reap: ${vms.length} VM(s) seen, done`);
  return failures ? 1 : 0;
}

if (import.meta.main) main().then((code) => process.exit(code), (e) => (console.error(`reap: ${(e as Error).message}`), process.exit(1)));
