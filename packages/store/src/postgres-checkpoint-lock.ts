import type { PoolClient } from "pg";
import { RunStoreBusyError } from "@crewon/application";

/** Keep the existing writer lock protocol and the caller's bounded lock timeout. */
export async function lockPostgresCheckpointRun(
  client: PoolClient,
  scope: { tenantId: string; runId: string },
  mode: "read" | "write",
): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `run:${scope.tenantId}:${scope.runId}`,
    ]);
  } catch (error) {
    // Only a recovery read may yield without failing an Attempt. A write failure
    // may leave a freshly generated model result without its durable checkpoint.
    // The transaction owner must confirm rollback before propagating this error.
    if (
      mode === "read" &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "55P03"
    )
      throw new RunStoreBusyError({ cause: error });
    throw error;
  }
}
