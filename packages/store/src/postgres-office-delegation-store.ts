import {
  OfficeDelegationStoreError,
  canonicalJson,
  type CommitOfficeDelegationStartInput,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type OfficeDelegationListCursor,
  type OfficeDelegationPreparation,
  type OfficeDelegationStartResult,
  type RunRoute,
} from "@crewon/application";
import {
  OFFICE_DELEGATION_LIMITS,
  parseOfficeDefinition,
  parseOfficeDelegation,
  validateThreadState,
  type OfficeDefinition,
  type ThreadState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { Pool, PoolClient } from "pg";

import {
  decodePostgresRunState,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";
import { stableJson } from "./store-invariants.ts";
import { readPostgresWorkflowRunStartReplayWithinTransaction } from "./postgres-workflow-run-admission.ts";

type ReceiptRow = Readonly<{
  tenant_id: string;
  space_id: string;
  fingerprint: string;
  delegation_id: string;
  run_id: string;
}>;

export async function readPostgresOfficeDelegationReplay(
  pool: Pool,
  schema: string,
  input: CommitOfficeDelegationStartInput,
  digester: WorkflowContentDigester,
): Promise<OfficeDelegationStartResult | null> {
  validateStart(input);
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const replay = await loadReplay(client, schema, input, digester);
    await client.query("COMMIT");
    return replay;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function commitPostgresOfficeDelegationStart(
  client: PoolClient,
  schema: string,
  input: CommitOfficeDelegationStartInput,
  candidateRoute: RunRoute,
  digester: WorkflowContentDigester,
  loadThread: () => Promise<ThreadState | null>,
  commitWorkflow: (
    workflowInput: CommitWorkflowRunStartInput,
  ) => Promise<CommitWorkflowRunStartResult>,
): Promise<OfficeDelegationStartResult> {
  validateStart(input);
  await advisoryLock(
    client,
    `office-delegation:${input.idempotency.scope}:${input.idempotency.key}`,
  );
  const replay = await loadReplay(client, schema, input, digester);
  if (replay !== null) return replay;

  const office = await loadOffice(client, schema, input);
  const thread = await loadThread();
  if (
    thread === null ||
    thread.tenantId !== input.tenantId ||
    thread.spaceId !== input.spaceId ||
    thread.threadId !== input.threadId ||
    thread.status !== "active"
  ) {
    fail("office_delegation_thread_not_active");
  }
  validateThreadState(thread);

  let prepared: ReturnType<CommitOfficeDelegationStartInput["prepare"]> | null =
    null;
  const workflowInput: CommitWorkflowRunStartInput = {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    threadId: input.threadId,
    workflowVersionId: input.workflowVersionId,
    workflowInput: input.workflowInput,
    idempotency: input.idempotency,
    resolveCandidateRoute: async () => candidateRoute,
    prepare: ({ workflowVersion, route }) => {
      if (prepared !== null) fail("office_delegation_prepare_repeated");
      try {
        prepared = input.prepare({
          office,
          workflowVersion,
          thread,
          route,
        });
      } catch (error) {
        fail("office_delegation_prepare_rejected", error);
      }
      return {
        commit: prepared.runCommit,
        workflowInputValue: prepared.workflowInputValue,
      };
    },
  };
  const workflow = await commitWorkflow(workflowInput);
  if (prepared === null || workflow.run.disposition !== "committed") {
    fail("office_delegation_prepare_invalid");
  }
  const preparation = prepared as OfficeDelegationPreparation;
  const delegation = parseOfficeDelegation(preparation.delegation);
  validatePreparation(input, office, workflow, preparation, delegation);

  await client.query(
    `INSERT INTO ${schema}.office_delegations
       (tenant_id,space_id,delegation_id,office_id,office_version_id,
        workflow_version_id,thread_id,run_id,created_at,delegation_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.tenantId,
      input.spaceId,
      delegation.delegationId,
      delegation.officeId,
      input.officeVersionId,
      delegation.workflowVersionBinding.workflowVersionId,
      delegation.threadId,
      delegation.runId,
      delegation.createdAt,
      delegation,
    ],
  );
  const result: OfficeDelegationStartResult = {
    disposition: "committed",
    delegation,
    run: workflow.run,
  };
  await client.query(
    `INSERT INTO ${schema}.office_delegation_receipts
       (tenant_id,space_id,scope,idempotency_key,fingerprint,delegation_id,run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.tenantId,
      input.spaceId,
      input.idempotency.scope,
      input.idempotency.key,
      input.idempotency.requestFingerprint,
      delegation.delegationId,
      delegation.runId,
    ],
  );
  return structuredClone(result);
}

export async function listPostgresOfficeDelegations(
  pool: Pool,
  schema: string,
  input: {
    tenantId: string;
    spaceId: string;
    officeVersionId: string;
    before: OfficeDelegationListCursor | null;
    limit: number;
  },
) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > OFFICE_DELEGATION_LIMITS.list ||
    [input.tenantId, input.spaceId, input.officeVersionId].some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    (input.before !== null &&
      (!Number.isFinite(Date.parse(input.before.createdAt)) ||
        input.before.delegationId.length === 0))
  ) {
    fail("office_delegation_list_limit_invalid");
  }
  const values: unknown[] = [
    input.tenantId,
    input.spaceId,
    input.officeVersionId,
  ];
  let cursor = "";
  if (input.before !== null) {
    cursor =
      ' AND (delegations.created_at < $4 OR (delegations.created_at = $4 AND delegations.delegation_id COLLATE "C" < $5::text COLLATE "C"))';
    values.push(input.before.createdAt, input.before.delegationId);
  }
  values.push(input.limit + 1);
  const limit = `$${values.length}`;
  const rows = await pool.query<PostgresRunRow & { delegation_json: unknown }>(
    `SELECT delegations.delegation_json,
            snapshots.tenant_id,snapshots.space_id,snapshots.run_id,
            snapshots.revision,snapshots.last_sequence,snapshots.state_json,
            snapshots.updated_at,bindings.thread_id
     FROM ${schema}.office_delegations AS delegations
     JOIN ${schema}.run_snapshots AS snapshots
       ON snapshots.tenant_id=delegations.tenant_id
      AND snapshots.run_id=delegations.run_id
     JOIN ${schema}.run_thread_bindings AS bindings
       ON bindings.tenant_id=snapshots.tenant_id
      AND bindings.run_id=snapshots.run_id
     WHERE delegations.tenant_id=$1 AND delegations.space_id=$2
       AND delegations.office_version_id=$3${cursor}
     ORDER BY delegations.created_at DESC,
              delegations.delegation_id COLLATE "C" DESC
     LIMIT ${limit}`,
    values,
  );
  const items = rows.rows.slice(0, input.limit).map((row) => {
    const delegation = parseOfficeDelegation(row.delegation_json);
    const run = decodePostgresRunState(row, {
      tenantId: input.tenantId,
      runId: delegation.runId,
    });
    if (
      run.tenantId !== input.tenantId ||
      run.spaceId !== input.spaceId ||
      run.runId !== delegation.runId ||
      run.threadId !== delegation.threadId ||
      delegation.tenantId !== input.tenantId ||
      delegation.spaceId !== input.spaceId ||
      delegation.officeVersionId !== input.officeVersionId ||
      stableJson(run.workflowVersionBinding) !==
        stableJson(delegation.workflowVersionBinding)
    ) {
      fail("office_delegation_run_corrupt");
    }
    return { delegation, run };
  });
  const last = items.at(-1)?.delegation;
  return {
    items,
    next:
      rows.rows.length <= input.limit || last === undefined
        ? null
        : { createdAt: last.createdAt, delegationId: last.delegationId },
  };
}

async function loadReplay(
  client: PoolClient,
  schema: string,
  input: CommitOfficeDelegationStartInput,
  digester: WorkflowContentDigester,
): Promise<OfficeDelegationStartResult | null> {
  const receipt = await client.query<ReceiptRow>(
    `SELECT tenant_id,space_id,fingerprint,delegation_id,run_id
     FROM ${schema}.office_delegation_receipts
     WHERE scope=$1 AND idempotency_key=$2`,
    [input.idempotency.scope, input.idempotency.key],
  );
  const row = receipt.rows[0];
  if (row === undefined) return null;
  if (
    row.tenant_id !== input.tenantId ||
    row.space_id !== input.spaceId ||
    row.fingerprint !== input.idempotency.requestFingerprint
  ) {
    fail("office_delegation_idempotency_conflict");
  }
  try {
    const persistedDelegation = await client.query<{
      delegation_json: unknown;
    }>(
      `SELECT delegation_json FROM ${schema}.office_delegations
       WHERE tenant_id=$1 AND delegation_id=$2 AND run_id=$3`,
      [input.tenantId, row.delegation_id, row.run_id],
    );
    const delegation = parseOfficeDelegation(
      persistedDelegation.rows[0]?.delegation_json,
    );
    const workflow = await readPostgresWorkflowRunStartReplayWithinTransaction(
      client,
      schema,
      workflowAdmissionInput(input),
      digester,
    );
    if (
      workflow === null ||
      delegation.tenantId !== input.tenantId ||
      delegation.spaceId !== input.spaceId ||
      delegation.officeVersionId !== input.officeVersionId ||
      delegation.workflowVersionBinding.workflowVersionId !==
        input.workflowVersionId ||
      delegation.threadId !== input.threadId ||
      delegation.delegationId !== row.delegation_id ||
      delegation.runId !== row.run_id ||
      workflow.run.state.runId !== row.run_id ||
      workflow.run.state.threadId !== delegation.threadId ||
      stableJson(workflow.run.state.workflowVersionBinding) !==
        stableJson(delegation.workflowVersionBinding)
    ) {
      fail("office_delegation_receipt_corrupt");
    }
    return { disposition: "replayed", delegation, run: workflow.run };
  } catch (error) {
    if (error instanceof OfficeDelegationStoreError) throw error;
    fail("office_delegation_receipt_corrupt", error);
  }
}

function workflowAdmissionInput(
  input: CommitOfficeDelegationStartInput,
): CommitWorkflowRunStartInput {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    threadId: input.threadId,
    workflowVersionId: input.workflowVersionId,
    workflowInput: input.workflowInput,
    idempotency: input.idempotency,
    resolveCandidateRoute: async () => {
      fail("office_delegation_replay_route_called");
    },
    prepare: () => fail("office_delegation_replay_prepare_called"),
  };
}

async function loadOffice(
  client: PoolClient,
  schema: string,
  input: CommitOfficeDelegationStartInput,
): Promise<OfficeDefinition> {
  const result = await client.query<{ definition_json: unknown }>(
    `SELECT definition_json FROM ${schema}.office_definitions
     WHERE tenant_id=$1 AND space_id=$2 AND office_version_id=$3
     FOR SHARE`,
    [input.tenantId, input.spaceId, input.officeVersionId],
  );
  if (result.rows[0] === undefined) fail("office_delegation_office_not_found");
  const office = parseOfficeDefinition(result.rows[0].definition_json);
  if (
    office.tenantId !== input.tenantId ||
    office.spaceId !== input.spaceId ||
    office.officeVersionId !== input.officeVersionId
  ) {
    fail("office_delegation_office_corrupt");
  }
  return office;
}

function validatePreparation(
  input: CommitOfficeDelegationStartInput,
  office: OfficeDefinition,
  workflow: CommitWorkflowRunStartResult,
  preparation: ReturnType<CommitOfficeDelegationStartInput["prepare"]>,
  delegation: ReturnType<typeof parseOfficeDelegation>,
) {
  const run = workflow.run.state;
  if (
    delegation.tenantId !== input.tenantId ||
    delegation.spaceId !== input.spaceId ||
    delegation.officeId !== office.officeId ||
    delegation.officeVersionId !== office.officeVersionId ||
    delegation.workflowVersionBinding.workflowVersionId !==
      input.workflowVersionId ||
    stableJson(delegation.workflowVersionBinding) !==
      stableJson(run.workflowVersionBinding) ||
    delegation.threadId !== input.threadId ||
    delegation.runId !== run.runId ||
    delegation.createdAt !== run.createdAt ||
    run.tenantId !== input.tenantId ||
    run.spaceId !== input.spaceId ||
    run.threadId !== input.threadId ||
    preparation.runCommit.events[0]?.identity.runId !== delegation.runId ||
    canonicalJson(preparation.workflowInputValue.value) !==
      canonicalJson(input.workflowInput) ||
    workflow.authority.workflowVersion.workflowVersionId !==
      input.workflowVersionId
  ) {
    fail("office_delegation_prepare_invalid");
  }
}

function validateStart(input: CommitOfficeDelegationStartInput) {
  for (const value of [
    input.tenantId,
    input.spaceId,
    input.officeVersionId,
    input.workflowVersionId,
    input.threadId,
    input.idempotency.scope,
    input.idempotency.key,
    input.idempotency.requestFingerprint,
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      fail("office_delegation_input_invalid");
    }
  }
}

async function advisoryLock(client: PoolClient, value: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    value,
  ]);
}

function fail(code: string, cause?: unknown): never {
  throw new OfficeDelegationStoreError(code, {
    cause: cause instanceof Error ? cause : undefined,
  });
}
