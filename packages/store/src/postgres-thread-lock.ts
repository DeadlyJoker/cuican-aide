import type { PoolClient } from "pg";

export async function advisoryLock(
  client: PoolClient,
  key: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}

export function threadLockKey(tenantId: string, threadId: string): string {
  return `thread:${tenantId}:${threadId}`;
}
