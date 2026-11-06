import { createHmac, timingSafeEqual } from "node:crypto";
import type { JudgeVm } from "./azure.ts";
import type { SessionRow } from "./sessions.ts";

export interface Limits {
  maxVms: number;
  perAccountPerDay: number;
  perDay: number;
  minAccountDays: number;
  lifetimeMinutes: number;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): Limits {
  const n = (k: string, d: number) => {
    const v = Number(env[k] ?? d);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    maxVms: n("LAB_MAX_VMS", 3),
    perAccountPerDay: n("LAB_PER_ACCOUNT_PER_DAY", 2),
    perDay: n("LAB_PER_DAY", 12),
    minAccountDays: n("LAB_MIN_ACCOUNT_DAYS", 30),
    lifetimeMinutes: n("LAB_LIFETIME_MINUTES", 180),
  };
}

export interface Refusal {
  code: "account-too-new" | "has-vm" | "full" | "account-daily" | "daily";
  message: string;
}

const hhmm = (iso: string) => iso.slice(11, 16);

/** Why this account cannot start a VM right now, or null when it can. */
export function refusal(o: { githubId: number; accountCreatedAt: string; now: Date; vms: JudgeVm[]; today: SessionRow[]; limits: Limits }): Refusal | null {
  const { limits: l } = o;
  const ageDays = (o.now.getTime() - Date.parse(o.accountCreatedAt)) / 86_400_000;
  if (!(ageDays >= l.minAccountDays)) {
    return { code: "account-too-new", message: `GitHub accounts must be at least ${l.minAccountDays} days old to get a VM.` };
  }
  const live = o.vms.filter((v) => v.state !== "Deleting");
  if (live.some((v) => v.githubId === String(o.githubId))) return { code: "has-vm", message: "You already have a VM." };
  if (live.length >= l.maxVms) {
    const next = live.map((v) => v.expiresAt).filter(Boolean).sort()[0];
    return { code: "full", message: `All ${l.maxVms} VMs are in use.${next ? ` The next one frees up by ${hhmm(next)} UTC.` : ""}` };
  }
  if (o.today.filter((s) => s.githubId === o.githubId).length >= l.perAccountPerDay) {
    return { code: "account-daily", message: `Each GitHub account can start ${l.perAccountPerDay} VMs a day. Try again after 00:00 UTC.` };
  }
  if (o.today.length >= l.perDay) return { code: "daily", message: `All ${l.perDay} of today's VMs have been handed out. Try again after 00:00 UTC.` };
  return null;
}

export interface Session {
  login: string;
  id: number;
  createdAt: string;
  exp: number;
}

const mac = (key: string, data: string) => createHmac("sha256", key).update(data).digest("base64url");

export function signSession(s: Session, key: string): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${body}.${mac(key, body)}`;
}

export function readSession(cookie: string | undefined, key: string, now = Date.now()): Session | null {
  const [body, sig] = (cookie ?? "").split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(key, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as Session;
    return typeof s.exp === "number" && s.exp > now && typeof s.id === "number" && typeof s.login === "string" ? s : null;
  } catch {
    return null;
  }
}
