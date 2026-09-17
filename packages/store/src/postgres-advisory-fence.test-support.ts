import { setTimeout } from "node:timers/promises";
import type { Pool } from "pg";

export async function holdAdvisoryFence(pool: Pool, key: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const pid = (
      await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    let releasePromise: Promise<void> | undefined;
    return {
      pid,
      release(): Promise<void> {
        return (releasePromise ??= (async () => {
          try {
            await client.query("ROLLBACK");
          } finally {
            client.release();
          }
        })());
      },
      async waitForWaiters(expected: number): Promise<void> {
        const deadline = performance.now() + 4_000;
        do {
          const result = await pool.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM pg_locks waiter
             JOIN pg_locks holder ON holder.pid=$1 AND holder.granted
               AND holder.locktype=waiter.locktype
               AND holder.database=waiter.database
               AND holder.classid=waiter.classid
               AND holder.objid=waiter.objid
               AND holder.objsubid=waiter.objsubid
             WHERE waiter.locktype='advisory' AND NOT waiter.granted`,
            [pid],
          );
          if (Number(result.rows[0]?.count) >= expected) return;
          await setTimeout(2);
        } while (performance.now() < deadline);
        throw new Error("provider_advisory_waiter_timeout");
      },
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    throw error;
  }
}
