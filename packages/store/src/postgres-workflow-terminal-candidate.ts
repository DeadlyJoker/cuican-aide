import {
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type WorkflowNodeContinuationStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import { settlePostgresWorkflowNodeModelTerminal } from "./postgres-workflow-model-settlement.ts";

type Input = Parameters<
  WorkflowNodeContinuationStore["settlePreparedWorkflowNodeTerminal"]
>[0];

export async function settlePreparedPostgresWorkflowNodeTerminal(
  client: PoolClient,
  schema: string,
  input: Input,
  digester: WorkflowContentDigester,
) {
  const stored = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${schema}.workflow_node_continuations
     WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3 FOR UPDATE`,
    [input.authority.tenantId, input.authority.runId, input.authority.nodeId],
  );
  const checkpoint =
    stored.rows[0] === undefined
      ? null
      : validateWorkflowNodeContinuationCheckpoint(stored.rows[0].state_json);
  const candidate = checkpoint?.terminalCandidate;
  if (
    candidate === null ||
    candidate === undefined ||
    candidate.candidateId !== input.candidateId ||
    checkpoint?.activeDispatch === null ||
    checkpoint?.activeDispatch === undefined
  )
    throw new RunStoreError("workflow_terminal_candidate_corrupt");
  return settlePostgresWorkflowNodeModelTerminal(
    client,
    schema,
    {
      binding: input.binding,
      nodeId: input.authority.nodeId,
      operationId: input.operationId,
      evidence: candidate.evidence,
      lease: input.lease,
      authority: input.authority,
      dispatch: checkpoint.activeDispatch,
      dispatchTerminalOutcome: candidate.dispatchTerminalOutcome,
    },
    digester,
  );
}
