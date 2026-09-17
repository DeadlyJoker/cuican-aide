import type { Pool, QueryResult } from "pg";
import {
  RunStoreError,
  type ArtifactRetentionReadOptions,
} from "@crewon/application";

/** A dedicated read transaction keeps its server timeout local to this maintenance read. */
export async function readPostgresArtifactEvidence(input: {
  pool: Pool;
  text: string;
  values: string[];
  options: ArtifactRetentionReadOptions;
}): Promise<QueryResult> {
  const { options } = input;
  if (
    !Number.isFinite(options.maxDurationMs) ||
    options.maxDurationMs <= 0 ||
    options.maxDurationMs > 5000
  )
    throw new RunStoreError("artifact_retention_read_options_invalid");
  const deadline = performance.now() + options.maxDurationMs;
  const remaining = () => {
    options.signal.throwIfAborted();
    const value = deadline - performance.now();
    if (value <= 0) throw new RunStoreError("artifact_retention_guard_timeout");
    return Math.max(1, Math.ceil(value));
  };
  remaining();
  // A late checkout is still physically pending; the observer retains admission until release.
  const client = await input.pool.connect();
  let transaction = false,
    destroy = false,
    failed = false;
  let failure: unknown;
  let result: QueryResult | undefined;
  try {
    const budgetMs = remaining();
    transaction = true;
    // Respect a shorter existing server timeout. Zero means no limit, not a zero-ms budget.
    // One setup round trip. The interpolated value is only a validated, rounded duration.
    await client.query(
      `BEGIN READ ONLY;
       SELECT set_config('statement_timeout',
        LEAST(${budgetMs}::bigint, COALESCE(NULLIF(setting::bigint, 0), ${budgetMs}::bigint))::text, true)
       FROM pg_settings WHERE name='statement_timeout'`,
    );
    remaining();
    result = await client.query(input.text, input.values);
    remaining();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (transaction) {
      try {
        // Cancellation detaches the observer; it does not release/reuse a still-running client.
        // Await the server response and rollback even on abort, then return physical admission.
        await client.query("ROLLBACK");
      } catch (error) {
        destroy = true;
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    client.release(destroy);
  }
  if (failed) throw failure;
  remaining();
  return result!;
}
