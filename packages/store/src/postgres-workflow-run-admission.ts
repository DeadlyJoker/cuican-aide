import { parseCompiledAgentVersion } from "@crewon/agent-version";
import {
  canonicalJson,
  RunStoreError,
  type AgentVersionAsset,
  type AgentVersionDeployment,
  type AgentVersionReleaseBundle,
  type CommitRunInput,
  type CommitRunResult,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type RunRoute,
  type WorkflowVersionAsset,
} from "@crewon/application";
import {
  MAX_WORKFLOW_VALUE_BYTES,
  parseCompiledWorkflowVersion,
  validateThreadState,
  type RunState,
  type ThreadState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { Pool, PoolClient } from "pg";

import {
  sameAgentVersionDeploymentCandidate,
  validateAgentVersionAsset,
  validateAgentVersionDeployment,
  validateAgentVersionReleaseBundle,
} from "./agent-version-store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import { stableJson } from "./store-invariants.ts";

type ReceiptRow = Readonly<{
  tenant_id: string;
  fingerprint: string;
  run_id: string;
  result_json: unknown;
}>;

export async function readPostgresWorkflowRunStartReplay(
  pool: Pool,
  schema: string,
  input: CommitWorkflowRunStartInput,
  digester: WorkflowContentDigester,
): Promise<CommitWorkflowRunStartResult | null> {
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const result = await loadReplay(client, schema, input, digester);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function commitPostgresWorkflowRunStart(
  client: PoolClient,
  schema: string,
  input: CommitWorkflowRunStartInput,
  candidateRoute: RunRoute,
  digester: WorkflowContentDigester,
  commitRun: (commit: CommitRunInput) => Promise<CommitRunResult>,
): Promise<CommitWorkflowRunStartResult> {
  await advisoryLock(
    client,
    `workflow-admission:${input.idempotency.scope}:${input.idempotency.key}`,
  );
  const replay = await loadReplay(client, schema, input, digester);
  if (replay !== null) return replay;
  await advisoryLock(client, `workflow-admission-tenant:${input.tenantId}`);

  const threadResult = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${schema}.thread_snapshots
     WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
    [input.tenantId, input.threadId],
  );
  const storedThread = threadResult.rows[0]?.state_json;
  if (storedThread === undefined) throw new RunStoreError("thread_not_active");
  const thread = storedThread as ThreadState;
  validateThreadState(thread);
  if (
    thread.tenantId !== input.tenantId ||
    thread.spaceId !== input.spaceId ||
    thread.status !== "active"
  )
    throw new RunStoreError("thread_not_active");

  const workflowVersion = await loadWorkflowVersion(
    client,
    schema,
    input,
    digester,
    true,
  );
  const releaseResult = await client.query<{ bundle_json: unknown }>(
    `SELECT bundles.bundle_json FROM ${schema}.active_agent_version_releases active
     JOIN ${schema}.agent_version_release_bundles bundles
       ON bundles.tenant_id=active.tenant_id AND bundles.release_id=active.release_id
     WHERE active.tenant_id=$1 FOR UPDATE OF active,bundles`,
    [input.tenantId],
  );
  const bundle = releaseResult.rows[0]?.bundle_json as
    | AgentVersionReleaseBundle
    | undefined;
  if (bundle === undefined)
    throw new RunStoreError("agent_version_release_not_active");
  validateAgentVersionReleaseBundle(bundle);
  const compiled = parseCompiledWorkflowVersion(
    workflowVersion.definitionJson,
    digester,
  );
  if (
    compiled.workflowId !== workflowVersion.workflowId ||
    compiled.workflowVersionId !== workflowVersion.workflowVersionId ||
    compiled.contentDigest !== workflowVersion.contentDigest
  )
    throw new RunStoreError("workflow_version_corrupt");
  const nodeIds = compiled.nodes.flatMap((node) =>
    node.kind === "humanGate"
      ? []
      : [
          node.kind === "verification"
            ? node.verifierAgentVersionId
            : node.agentVersionId,
        ],
  );
  const ids = [...new Set([...nodeIds, bundle.defaultAgentVersionId])].sort();
  const authorities = await Promise.all(
    ids.map((agentVersionId) =>
      loadAgentAuthority(
        client,
        schema,
        input.tenantId,
        agentVersionId,
        digester,
      ),
    ),
  );
  for (const authority of authorities) {
    const released = bundle.deployments.find(
      (candidate) =>
        candidate.agentVersionId === authority.deployment.agentVersionId,
    );
    if (
      released === undefined ||
      authority.deployment.contentDigest !== authority.asset.contentDigest ||
      !sameAgentVersionDeploymentCandidate(released, authority.deployment)
    )
      throw new RunStoreError("workflow_agent_deployment_mismatch");
  }
  const defaultAuthority = authorities.find(
    ({ deployment }) =>
      deployment.agentVersionId === bundle.defaultAgentVersionId,
  )!;
  const defaultCompiled = parseCompiledAgentVersion(
    defaultAuthority.asset.definitionJson,
    digester,
  );
  if (
    candidateRoute.agentVersionId !==
      defaultAuthority.deployment.agentVersionId ||
    candidateRoute.authorityId !== defaultAuthority.deployment.authorityId ||
    candidateRoute.workspaceBindingId !==
      defaultAuthority.deployment.workspaceBindingId ||
    candidateRoute.runtimeGeneration !== defaultCompiled.runtimeGeneration ||
    candidateRoute.policySnapshotId !== defaultCompiled.policySnapshotId
  )
    throw new RunStoreError("workflow_run_route_mismatch");

  const prepared = input.prepare({ workflowVersion, route: candidateRoute });
  validateRoot(input, prepared.workflowInputValue, digester);
  validatePrepared(
    input,
    prepared.commit,
    workflowVersion,
    candidateRoute,
    prepared.workflowInputValue,
  );
  const runId = prepared.commit.events[0]!.identity.runId;
  await advisoryLock(client, `run:${input.tenantId}:${runId}`);
  const run = await commitRun(prepared.commit);
  if (run.disposition !== "committed")
    throw new RunStoreError("workflow_run_prepare_invalid");
  const work = run.workItems[0]!;
  const root = prepared.workflowInputValue;
  const rootJson = canonicalJson(root.value);
  validateSchedulerWork(work.payload, root, compiled);
  await client.query(
    `INSERT INTO ${schema}.workflow_execution_values
       (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
     VALUES ($1,$2,$3,'rootInput',NULL,$4,$5,$6)`,
    [
      input.tenantId,
      runId,
      root.valueId,
      root.valueDigest,
      rootJson,
      run.state.createdAt,
    ],
  );
  const result = { authority: { workflowVersion, route: candidateRoute }, run };
  await client.query(
    `INSERT INTO ${schema}.workflow_run_admission_receipts
       (tenant_id,scope,idempotency_key,fingerprint,run_id,result_json)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.tenantId,
      input.idempotency.scope,
      input.idempotency.key,
      input.idempotency.requestFingerprint,
      runId,
      result,
    ],
  );
  return structuredClone(result);
}

async function loadReplay(
  client: PoolClient,
  schema: string,
  input: CommitWorkflowRunStartInput,
  digester: WorkflowContentDigester,
): Promise<CommitWorkflowRunStartResult | null> {
  const receipt = await client.query<ReceiptRow>(
    `SELECT tenant_id,fingerprint,run_id,result_json
     FROM ${schema}.workflow_run_admission_receipts WHERE scope=$1 AND idempotency_key=$2`,
    [input.idempotency.scope, input.idempotency.key],
  );
  const row = receipt.rows[0];
  if (row === undefined) return null;
  if (
    row.tenant_id !== input.tenantId ||
    row.fingerprint !== input.idempotency.requestFingerprint
  )
    throw new RunStoreError("idempotency_conflict");
  try {
    const result = row.result_json as CommitWorkflowRunStartResult;
    await validateReplay(client, schema, row, result, digester);
    return structuredClone({
      ...result,
      run: { ...result.run, disposition: "replayed" },
    });
  } catch (error) {
    if (
      error instanceof RunStoreError &&
      error.code === "workflow_run_admission_receipt_corrupt"
    )
      throw error;
    replayCorrupt();
  }
}

async function validateReplay(
  client: PoolClient,
  schema: string,
  receipt: ReceiptRow,
  result: CommitWorkflowRunStartResult,
  digester: WorkflowContentDigester,
): Promise<void> {
  const tenantId = result.run?.state?.tenantId;
  const runId = result.run?.state?.runId;
  if (tenantId !== receipt.tenant_id || runId !== receipt.run_id)
    replayCorrupt();
  const [snapshot, events, general, outbox, workItems, root] =
    await Promise.all([
      client.query<{ state_json: unknown }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE tenant_id=$1 AND run_id=$2`,
        [tenantId, runId],
      ),
      client.query<{ event_json: unknown }>(
        `SELECT event_json FROM ${schema}.run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence`,
        [tenantId, runId],
      ),
      client.query<{
        fingerprint: string;
        run_id: string;
        result_json: unknown;
      }>(
        `SELECT fingerprint,run_id,result_json FROM ${schema}.idempotency_receipts WHERE tenant_id=$1 AND run_id=$2`,
        [tenantId, runId],
      ),
      client.query<{ message_json: unknown }>(
        `SELECT message_json FROM ${schema}.outbox WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,message_id`,
        [tenantId, runId],
      ),
      client.query<{ work_item_json: unknown }>(
        `SELECT work_item_json FROM ${schema}.work_items WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,work_item_id`,
        [tenantId, runId],
      ),
      client.query<{
        value_id: string;
        value_digest: string;
        value_json: unknown;
      }>(
        `SELECT value_id,value_digest,value_json FROM ${schema}.workflow_execution_values WHERE tenant_id=$1 AND run_id=$2 AND role='rootInput' AND node_id IS NULL`,
        [tenantId, runId],
      ),
    ]);
  const storedState = snapshot.rows[0]?.state_json;
  if (storedState === undefined) replayCorrupt();
  const state = normalizeStoredRunState(
    storedState as RunState,
    "workflow_run_admission_receipt_corrupt",
  );
  const workflowVersion = await loadWorkflowVersion(
    client,
    schema,
    {
      tenantId,
      workflowVersionId: result.authority.workflowVersion.workflowVersionId,
    } as CommitWorkflowRunStartInput,
    digester,
    false,
  );
  const rootRow = root.rows[0];
  const work = result.run.workItems[0];
  const ref = work?.payload.workflowInput as
    | { valueId?: unknown; valueDigest?: unknown }
    | undefined;
  if (
    stableJson(state) !== stableJson(result.run.state) ||
    stableJson(events.rows.map(({ event_json }) => event_json)) !==
      stableJson(result.run.events) ||
    stableJson(outbox.rows.map(({ message_json }) => message_json)) !==
      stableJson(result.run.outbox) ||
    stableJson(workItems.rows.map(({ work_item_json }) => work_item_json)) !==
      stableJson(result.run.workItems) ||
    general.rows.length !== 1 ||
    general.rows[0]!.run_id !== runId ||
    general.rows[0]!.fingerprint !== receipt.fingerprint ||
    stableJson(general.rows[0]!.result_json) !== stableJson(result.run) ||
    stableJson(workflowVersion) !==
      stableJson(result.authority.workflowVersion) ||
    result.authority.route.agentVersionId !== state.agentVersionId ||
    result.authority.route.authorityId !== state.authorityId ||
    result.authority.route.workspaceBindingId !== state.workspaceBindingId ||
    result.authority.route.runtimeGeneration !== state.runtimeGeneration ||
    result.authority.route.policySnapshotId !== state.policySnapshotId ||
    root.rows.length !== 1 ||
    rootRow === undefined ||
    ref?.valueId !== rootRow.value_id ||
    ref.valueDigest !== rootRow.value_digest ||
    new TextEncoder().encode(canonicalJson(rootRow.value_json)).byteLength >
      MAX_WORKFLOW_VALUE_BYTES ||
    digester.sha256(canonicalJson(rootRow.value_json)) !== rootRow.value_digest
  )
    replayCorrupt();
}

async function loadWorkflowVersion(
  client: PoolClient,
  schema: string,
  input: Pick<CommitWorkflowRunStartInput, "tenantId" | "workflowVersionId">,
  digester: WorkflowContentDigester,
  lock: boolean,
): Promise<WorkflowVersionAsset> {
  const value = await client.query<{
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    content_digest: string;
    definition_json: string;
    created_at: Date | string;
  }>(
    `SELECT tenant_id,workflow_id,workflow_version_id,content_digest,definition_json,created_at FROM ${schema}.workflow_versions WHERE tenant_id=$1 AND workflow_version_id=$2${lock ? " FOR SHARE" : ""}`,
    [input.tenantId, input.workflowVersionId],
  );
  const row = value.rows[0];
  if (row === undefined) throw new RunStoreError("workflow_version_not_found");
  const asset = {
    schemaVersion: "crewon.workflow-version-asset.v0" as const,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    contentDigest: row.content_digest,
    definitionJson: row.definition_json,
    createdAt: new Date(row.created_at).toISOString(),
  };
  parseCompiledWorkflowVersion(asset.definitionJson, digester);
  return asset;
}

async function loadAgentAuthority(
  client: PoolClient,
  schema: string,
  tenantId: string,
  agentVersionId: string,
  digester: WorkflowContentDigester,
) {
  const result = await client.query<{
    asset_json: AgentVersionAsset;
    deployment_json: AgentVersionDeployment;
  }>(
    `SELECT versions.asset_json,deployments.deployment_json FROM ${schema}.agent_versions versions JOIN ${schema}.agent_version_deployments deployments USING (tenant_id,agent_version_id) WHERE versions.tenant_id=$1 AND versions.agent_version_id=$2 FOR SHARE OF versions,deployments`,
    [tenantId, agentVersionId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new RunStoreError("workflow_agent_deployment_mismatch");
  validateAgentVersionAsset(row.asset_json);
  validateAgentVersionDeployment(row.deployment_json);
  const compiled = parseCompiledAgentVersion(
    row.asset_json.definitionJson,
    digester,
  );
  if (
    compiled.agentVersionId !== row.asset_json.agentVersionId ||
    compiled.contentDigest !== row.asset_json.contentDigest
  )
    throw new RunStoreError("workflow_agent_deployment_mismatch");
  return { asset: row.asset_json, deployment: row.deployment_json };
}

function validateRoot(
  input: CommitWorkflowRunStartInput,
  root: ReturnType<
    CommitWorkflowRunStartInput["prepare"]
  >["workflowInputValue"],
  digester: WorkflowContentDigester,
) {
  const json = canonicalJson(root.value);
  if (
    root.schemaVersion !== "crewon.workflow-execution-value.v0" ||
    !/^[-A-Za-z0-9:._]{1,200}$/u.test(root.valueId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(root.valueDigest) ||
    json !== canonicalJson(input.workflowInput) ||
    new TextEncoder().encode(json).byteLength > MAX_WORKFLOW_VALUE_BYTES ||
    digester.sha256(json) !== root.valueDigest
  )
    throw new RunStoreError("workflow_execution_value_invalid");
}

function validatePrepared(
  input: CommitWorkflowRunStartInput,
  commit: CommitRunInput,
  version: WorkflowVersionAsset,
  route: RunRoute,
  root: ReturnType<
    CommitWorkflowRunStartInput["prepare"]
  >["workflowInputValue"],
) {
  const event = commit.events[0];
  const outbox = commit.outbox[0];
  const work = commit.workItems[0];
  if (
    commit.tenantId !== input.tenantId ||
    commit.expectedRevision !== 0 ||
    commit.events.length !== 1 ||
    event?.type !== "run.created" ||
    event.sequence !== 1 ||
    event.data.tenantId !== input.tenantId ||
    event.data.spaceId !== input.spaceId ||
    event.data.threadId !== input.threadId ||
    event.data.purpose !== "workflow" ||
    event.data.goalBinding !== null ||
    event.data.authorityId !== route.authorityId ||
    event.data.runtimeGeneration !== route.runtimeGeneration ||
    event.data.agentVersionId !== route.agentVersionId ||
    event.data.policySnapshotId !== route.policySnapshotId ||
    event.data.workspaceBindingId !== route.workspaceBindingId ||
    stableJson(event.data.workflowVersionBinding) !==
      stableJson({
        workflowId: version.workflowId,
        workflowVersionId: version.workflowVersionId,
        contentDigest: version.contentDigest,
      }) ||
    commit.outbox.length !== 1 ||
    outbox?.topic !== "run.updated" ||
    outbox.tenantId !== input.tenantId ||
    outbox.runId !== event.identity.runId ||
    stableJson(outbox.payload) !==
      stableJson({
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: 1,
      }) ||
    commit.workItems.length !== 1 ||
    work?.kind !== "run.execute" ||
    work.tenantId !== input.tenantId ||
    work.runId !== event.identity.runId ||
    stableJson(work.payload.workflowInput) !==
      stableJson({ valueId: root.valueId, valueDigest: root.valueDigest })
  )
    throw new RunStoreError("workflow_run_prepare_invalid");
}

function validateSchedulerWork(
  payload: unknown,
  root: { valueId: string; valueDigest: string },
  compiled: ReturnType<typeof parseCompiledWorkflowVersion>,
) {
  const value = payload as Record<string, unknown>;
  if (
    value.schemaVersion !== "crewon.workflow-scheduler-work-item.v1" ||
    value.trigger !== "workflowScheduler" ||
    stableJson(value.workflowInput) !== stableJson(root) ||
    stableJson(value.binding) !==
      stableJson({
        workflowId: compiled.workflowId,
        workflowVersionId: compiled.workflowVersionId,
        contentDigest: compiled.contentDigest,
      }) ||
    typeof value.schedulerOperationId !== "string"
  )
    throw new RunStoreError("workflow_scheduler_work_item_mismatch");
}

async function advisoryLock(client: PoolClient, key: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    key,
  ]);
}

function replayCorrupt(): never {
  throw new RunStoreError("workflow_run_admission_receipt_corrupt");
}
