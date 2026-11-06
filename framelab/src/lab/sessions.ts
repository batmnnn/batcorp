import { token } from "./azure.ts";

/**
 * One row per VM handed out, partitioned by UTC day, so the daily limits survive restarts and
 * scale-to-zero. Stored in an Azure Table, reached with the lab's managed identity.
 */
export interface SessionRow {
  vm: string;
  login: string;
  githubId: number;
  createdAt: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

function tableUrl(path = ""): string {
  const account = process.env.LAB_TABLE_ACCOUNT;
  const table = process.env.LAB_TABLE_NAME ?? "labsessions";
  if (!account) throw new Error("LAB_TABLE_ACCOUNT is not set");
  return `https://${account}.table.core.windows.net/${table}${path}`;
}

async function headers(): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await token("https://storage.azure.com/")}`,
    "x-ms-version": "2020-12-06",
    "x-ms-date": new Date().toUTCString(),
    accept: "application/json;odata=nometadata",
    "content-type": "application/json",
  };
}

export async function recordSession(row: SessionRow): Promise<void> {
  const res = await fetch(tableUrl(), {
    method: "POST",
    headers: { ...(await headers()), prefer: "return-no-content" },
    body: JSON.stringify({ PartitionKey: day(new Date(row.createdAt)), RowKey: row.vm, login: row.login, githubId: String(row.githubId), createdAt: row.createdAt }),
  });
  if (!res.ok) throw new Error(`session table insert: HTTP ${res.status}`);
}

export async function sessionsOn(date: Date): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  let next = `?$filter=${encodeURIComponent(`PartitionKey eq '${day(date)}'`)}`;
  for (;;) {
    const res = await fetch(tableUrl(`()${next}`), { headers: await headers() });
    if (!res.ok) throw new Error(`session table query: HTTP ${res.status}`);
    const body = (await res.json()) as { value: Array<{ RowKey: string; login: string; githubId: string; createdAt: string }> };
    for (const v of body.value) rows.push({ vm: v.RowKey, login: v.login, githubId: Number(v.githubId), createdAt: v.createdAt });
    const pk = res.headers.get("x-ms-continuation-nextpartitionkey");
    const rk = res.headers.get("x-ms-continuation-nextrowkey");
    if (!pk && !rk) return rows;
    next = `?$filter=${encodeURIComponent(`PartitionKey eq '${day(date)}'`)}${pk ? `&NextPartitionKey=${encodeURIComponent(pk)}` : ""}${rk ? `&NextRowKey=${encodeURIComponent(rk)}` : ""}`;
  }
}
