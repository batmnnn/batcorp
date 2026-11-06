import { generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * Azure Resource Manager calls for judge VMs. Everything lives in one resource group that holds
 * nothing else; the lab's identity has VM and network rights on that group only. Every resource
 * carries the `framelab-lab` tag, its owner and its expiry, so the reaper can find and delete it.
 */
const ARM = "https://management.azure.com";
const COMPUTE = "2024-07-01";
const DISKS = "2024-03-02";
const NETWORK = "2024-05-01";
export const LAB_TAG = "framelab-lab";

export interface LabConfig {
  subscription: string;
  group: string;
  location: string;
  subnetId: string;
  vmSize: string;
}

export function labConfig(env: Record<string, string | undefined> = process.env): LabConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    subscription: need("AZURE_SUBSCRIPTION_ID"),
    group: need("LAB_RESOURCE_GROUP"),
    location: need("LAB_LOCATION"),
    subnetId: need("LAB_SUBNET_ID"),
    vmSize: env.LAB_VM_SIZE ?? "Standard_D4s_v5",
  };
}

const tokens = new Map<string, { token: string; until: number }>();

/** Container Apps managed identity, or AZURE_ACCESS_TOKEN / AZURE_STORAGE_TOKEN when run by hand. */
export async function token(resource = `${ARM}/`): Promise<string> {
  const manual = resource.includes("storage") ? process.env.AZURE_STORAGE_TOKEN : process.env.AZURE_ACCESS_TOKEN;
  if (manual) return manual;
  const hit = tokens.get(resource);
  if (hit && Date.now() < hit.until) return hit.token;
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new Error("no managed identity (IDENTITY_ENDPOINT) and no manual token");
  const url = new URL(endpoint);
  url.searchParams.set("api-version", "2019-08-01");
  url.searchParams.set("resource", resource);
  if (process.env.AZURE_CLIENT_ID) url.searchParams.set("client_id", process.env.AZURE_CLIENT_ID);
  const res = await fetch(url, { headers: { "X-IDENTITY-HEADER": header } });
  if (!res.ok) throw new Error(`managed identity token: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_on: string | number };
  tokens.set(resource, { token: body.access_token, until: Number(body.expires_on) * 1000 - 5 * 60_000 });
  return body.access_token;
}

export class ArmError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function arm<T>(method: string, path: string, apiVersion: string, body?: unknown): Promise<T> {
  const url = path.startsWith(`${ARM}/`) ? path : `${ARM}${path}${path.includes("?") ? "&" : "?"}api-version=${apiVersion}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = `HTTP ${res.status}`;
    let message = text.slice(0, 300);
    try {
      const e = JSON.parse(text).error;
      if (e?.code) code = e.code;
      if (e?.message) message = e.message;
    } catch {}
    throw new ArmError(res.status, code, `${method} ${path.split("/").slice(-2).join("/")}: ${code}: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const groupPath = (c: LabConfig) => `/subscriptions/${c.subscription}/resourceGroups/${c.group}`;
const vmPath = (c: LabConfig, name: string) => `${groupPath(c)}/providers/Microsoft.Compute/virtualMachines/${name}`;
const ipPath = (c: LabConfig, name: string) => `${groupPath(c)}/providers/Microsoft.Network/publicIPAddresses/${name}-ip`;
const nicPath = (c: LabConfig, name: string) => `${groupPath(c)}/providers/Microsoft.Network/networkInterfaces/${name}-nic`;

async function waitProvisioned(path: string, apiVersion: string, timeoutMs = 120_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await arm<{ properties: Record<string, any> }>("GET", path, apiVersion);
    const state = r.properties?.provisioningState;
    if (state === "Succeeded") return r.properties;
    if (state === "Failed" || state === "Canceled") throw new Error(`${path.split("/").pop()} provisioning ${state}`);
    if (Date.now() > deadline) throw new Error(`${path.split("/").pop()} still ${state} after ${timeoutMs / 1000} s`);
    await Bun.sleep(2000);
  }
}

/**
 * Azure insists on one RSA key in the VM profile. This one is generated per VM and its private
 * half is never exported, so nobody can use it; the judge's own GitHub keys go in via cloud-init.
 */
export function unusableRsaKey(): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const mpint = (b64: string) => {
    const b = Buffer.from(b64, "base64url");
    return (b[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
  };
  const field = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  return `ssh-rsa ${Buffer.concat([field(Buffer.from("ssh-rsa")), field(mpint(jwk.e)), field(mpint(jwk.n))]).toString("base64")} framelab-unusable`;
}

export function vmName(login: string): string {
  const slug = login.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "judge";
  return `judge-${slug}-${randomBytes(3).toString("hex")}`;
}

export interface JudgeVm {
  name: string;
  login: string;
  githubId: string;
  expiresAt: string;
  createdAt: string;
  state: string;
}

/** Creates the public IP, NIC and VM. Returns once the VM is accepted; it boots and sets itself up after. */
export async function createJudgeVm(
  c: LabConfig,
  o: { name: string; login: string; githubId: number; customData: string; expiresAt: Date }
): Promise<{ ip: string }> {
  const tags = { [LAB_TAG]: "judge", login: o.login, "github-id": String(o.githubId), "created-at": new Date().toISOString(), "expires-at": o.expiresAt.toISOString() };
  try {
    await arm("PUT", ipPath(c, o.name), NETWORK, {
      location: c.location,
      tags,
      sku: { name: "Standard" },
      properties: { publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4" },
    });
    const ip = await waitProvisioned(ipPath(c, o.name), NETWORK);
    await arm("PUT", nicPath(c, o.name), NETWORK, {
      location: c.location,
      tags,
      properties: {
        ipConfigurations: [
          {
            name: "ipconfig1",
            properties: {
              subnet: { id: c.subnetId },
              privateIPAllocationMethod: "Dynamic",
              publicIPAddress: { id: ipPath(c, o.name), properties: { deleteOption: "Delete" } },
            },
          },
        ],
      },
    });
    await waitProvisioned(nicPath(c, o.name), NETWORK);
    await arm("PUT", vmPath(c, o.name), COMPUTE, {
      location: c.location,
      tags,
      properties: {
        hardwareProfile: { vmSize: c.vmSize },
        storageProfile: {
          imageReference: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" },
          osDisk: { createOption: "FromImage", deleteOption: "Delete", diskSizeGB: 64, managedDisk: { storageAccountType: "StandardSSD_LRS" } },
        },
        osProfile: {
          computerName: o.name,
          adminUsername: "judge",
          customData: Buffer.from(o.customData).toString("base64"),
          linuxConfiguration: {
            disablePasswordAuthentication: true,
            ssh: { publicKeys: [{ path: "/home/judge/.ssh/authorized_keys", keyData: unusableRsaKey() }] },
          },
        },
        networkProfile: { networkInterfaces: [{ id: nicPath(c, o.name), properties: { primary: true, deleteOption: "Delete" } }] },
        diagnosticsProfile: { bootDiagnostics: { enabled: true } },
      },
    });
    return { ip: String(ip.ipAddress) };
  } catch (err) {
    await deleteJudgeResources(c, o.name).catch(() => {});
    throw err;
  }
}

export async function listJudgeVms(c: LabConfig): Promise<JudgeVm[]> {
  const out: JudgeVm[] = [];
  let next: string | null = `${groupPath(c)}/providers/Microsoft.Compute/virtualMachines`;
  while (next) {
    const page: { value: Array<{ name: string; tags?: Record<string, string>; properties: { provisioningState: string; timeCreated?: string } }>; nextLink?: string } =
      await arm("GET", next, COMPUTE);
    for (const vm of page.value) {
      if (vm.tags?.[LAB_TAG] !== "judge") continue;
      out.push({
        name: vm.name,
        login: vm.tags.login ?? "",
        githubId: vm.tags["github-id"] ?? "",
        expiresAt: vm.tags["expires-at"] ?? "",
        createdAt: vm.tags["created-at"] ?? vm.properties.timeCreated ?? "",
        state: vm.properties.provisioningState,
      });
    }
    next = page.nextLink ?? null;
  }
  return out;
}

export async function publicIp(c: LabConfig, name: string): Promise<string | null> {
  const r = await arm<{ properties: { ipAddress?: string } }>("GET", ipPath(c, name), NETWORK).catch(() => null);
  return r?.properties.ipAddress ?? null;
}

/** Deleting the VM also deletes its disk, NIC and public IP (deleteOption); the NIC and IP are retried in case the VM never existed. */
const del = (path: string, v: string) => arm("DELETE", path, v).catch((e) => (e instanceof ArmError && e.status === 404 ? null : Promise.reject(e)));

/**
 * Starts deleting the VM and returns once Azure accepts it. Its NIC, public IP and OS disk carry
 * deleteOption Delete, so they go with it; the reaper sweeps up anything left over.
 */
export async function deleteJudgeVm(c: LabConfig, name: string): Promise<void> {
  await del(vmPath(c, name), COMPUTE);
}

/** Deletes the VM, waits until it is gone, then deletes its NIC and IP if they are still there. */
export async function deleteJudgeResources(c: LabConfig, name: string, timeoutMs = 600_000): Promise<void> {
  await deleteJudgeVm(c, name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const gone = await arm("GET", vmPath(c, name), COMPUTE).then(
      () => false,
      (e) => (e instanceof ArmError && e.status === 404 ? true : Promise.reject(e))
    );
    if (gone) break;
    if (Date.now() > deadline) throw new Error(`${name} was still deleting after ${timeoutMs / 1000} s`);
    await Bun.sleep(5_000);
  }
  await del(nicPath(c, name), NETWORK);
  await del(ipPath(c, name), NETWORK);
}

/** Tagged lab resources of any type, for the reaper's orphan sweep. */
export async function listTaggedResources(c: LabConfig): Promise<Array<{ id: string; type: string; name: string; createdAt: string; expiresAt: string }>> {
  const r = await arm<{ value: Array<{ id: string; type: string; name: string; tags?: Record<string, string> }> }>(
    "GET",
    `${groupPath(c)}/resources?$filter=${encodeURIComponent(`tagName eq '${LAB_TAG}'`)}`,
    "2021-04-01"
  );
  return r.value.map((x) => ({ id: x.id, type: x.type, name: x.name, createdAt: x.tags?.["created-at"] ?? "", expiresAt: x.tags?.["expires-at"] ?? "" }));
}

export async function deleteById(id: string, type: string): Promise<void> {
  const v = type === "Microsoft.Compute/disks" ? DISKS : type.startsWith("Microsoft.Compute") ? COMPUTE : NETWORK;
  await arm("DELETE", id, v).catch((e) => (e instanceof ArmError && e.status === 404 ? null : Promise.reject(e)));
}

/**
 * The end of the VM's serial console log. Cloud-init prints FRAMELAB_SETUP_READY or
 * FRAMELAB_SETUP_FAILED there, which is how the lab page knows setup finished without the VM
 * holding any credential or opening another port.
 */
export async function serialTail(c: LabConfig, name: string, bytes = 32_768): Promise<string> {
  const r = await arm<{ serialConsoleLogBlobUri?: string }>("POST", `${vmPath(c, name)}/retrieveBootDiagnosticsData?sasUriExpirationTimeInMinutes=5`, COMPUTE).catch(() => null);
  if (!r?.serialConsoleLogBlobUri) return "";
  const head = await fetch(r.serialConsoleLogBlobUri, { method: "HEAD" });
  const size = Number(head.headers.get("content-length") ?? 0);
  if (!size) return "";
  const res = await fetch(r.serialConsoleLogBlobUri, { headers: { "x-ms-range": `bytes=${Math.max(0, size - bytes)}-${size - 1}`, "x-ms-version": "2021-08-06" } });
  return res.ok ? await res.text() : "";
}
