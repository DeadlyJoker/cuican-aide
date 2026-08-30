import { RunStoreError, type ThreadModelState } from "@crewon/application";
import type { Pool, PoolClient } from "pg";

import { validateThreadModelState } from "./store-invariants.ts";

type ThreadModelStateRow = Readonly<{ state_json: unknown }>;

export async function loadPostgresThreadModelState(
  connection: Pool | PoolClient,
  schema: string,
  locator: Readonly<{ tenantId: string; threadId: string }>,
): Promise<ThreadModelState | null> {
  const result = await connection.query<ThreadModelStateRow>(
    `SELECT state_json
     FROM ${schema}.thread_model_states
     WHERE tenant_id=$1 AND thread_id=$2`,
    [locator.tenantId, locator.threadId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const state = structuredClone(row.state_json) as ThreadModelState;
  validateThreadModelState(state);
  if (
    state.tenantId !== locator.tenantId ||
    state.threadId !== locator.threadId
  ) {
    throw new RunStoreError("stored_thread_model_state_invalid");
  }
  return state;
}

export async function writePostgresThreadModelState(
  client: PoolClient,
  schema: string,
  state: ThreadModelState,
): Promise<void> {
  validateThreadModelState(state);
  await client.query(
    `INSERT INTO ${schema}.thread_model_states
       (tenant_id, thread_id, state_json, updated_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, thread_id) DO UPDATE SET
       state_json=EXCLUDED.state_json,
       updated_at=EXCLUDED.updated_at`,
    [state.tenantId, state.threadId, state, state.updatedAt],
  );
}
