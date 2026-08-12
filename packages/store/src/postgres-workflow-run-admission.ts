import { parseCompiledAgentVersion } from "@crewon/agent-version";
import type { JsonValue } from "@crewon/contracts";
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
  type IdempotencyDescriptor,
  type RunRoute,
  type WorkflowVersionAsset,
} from "@crewon/application";
import {
  MAX_WORKFLOW_VALUE_BYTES,
  parseCompiledWorkflowVersion,
  validateWorkflowSchemaValue,
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

type StoredAdmissionReceipt = Readonly<{
  schemaVersion: "crewon.postgres-workflow-run-admission-receipt.v1";
  generalIdempotency: IdempotencyDescriptor;
  result: CommitWorkflowRunStartResult;
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
  commitRun: (
    commit: CommitRunInput,
    beforeWrite: (
      authority: Readonly<{
        current: RunState | null;
        next: RunState;
        thread: ThreadState;
      }>,
    ) => Promise<void>,
  ) => Promise<CommitRunResult>,
): Promise<CommitWorkflowRunStartResult> {
  await advisoryLock(
    client,
    `workflow-admission:${input.idempotency.scope}:${input.idempotency.key}`,
  );
  const replay = await loadReplay(client, schema, input, digester);
  if (replay !== null) return replay;
  await advisoryLock(client, `workflow-admission-tenant:${input.tenantId}`);

  const initialAuthority = await loadFreshAuthority(
    client,
    schema,
    input,
    candidateRoute,
    digester,
    false,
  );
  const prepared = input.prepare(initialAuthority.authority);
  validateRoot(input, prepared.workflowInputValue, digester);
  validatePrepared(
    input,
    prepared.commit,
    initialAuthority.authority.workflowVersion,
    candidateRoute,
    prepared.workflowInputValue,
  );
  const run = await commitRun(prepared.commit, async ({ thread }) => {
    if (
      thread.tenantId !== input.tenantId ||
      thread.threadId !== input.threadId ||
      thread.spaceId !== input.spaceId ||
      thread.status !== "active"
    )
      throw new RunStoreError("thread_not_active");
    const finalAuthority = await loadFreshAuthority(
      client,
      schema,
      input,
      candidateRoute,
      digester,
      true,
    );
    if (stableJson(finalAuthority) !== stableJson(initialAuthority))
      throw new RunStoreError("workflow_run_route_mismatch");
  });
  if (run.disposition !== "committed")
    throw new RunStoreError("workflow_run_prepare_invalid");
  const work = run.workItems[0]!;
  const root = prepared.workflowInputValue;
  const rootJson = canonicalJson(root.value);
  const compiled = parseCompiledWorkflowVersion(
    initialAuthority.authority.workflowVersion.definitionJson,
    digester,
  );
  validateSchedulerWork(work.payload, root, compiled);
  const runId = run.state.runId;
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
  const result = { authority: initialAuthority.authority, run };
  const stored: StoredAdmissionReceipt = {
    schemaVersion: "crewon.postgres-workflow-run-admission-receipt.v1",
    generalIdempotency: prepared.commit.idempotency,
    result,
  };
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
      stored,
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
    const stored = row.result_json as StoredAdmissionReceipt;
    if (
      stored.schemaVersion !==
      "crewon.postgres-workflow-run-admission-receipt.v1"
    )
      replayCorrupt();
    const result = stored.result;
    await validateReplay(client, schema, input, row, stored, digester);
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
  input: CommitWorkflowRunStartInput,
  receipt: ReceiptRow,
  stored: StoredAdmissionReceipt,
  digester: WorkflowContentDigester,
): Promise<void> {
  const result = stored.result;
  const tenantId = result.run?.state?.tenantId;
  const runId = result.run?.state?.runId;
  if (
    tenantId !== receipt.tenant_id ||
    tenantId !== input.tenantId ||
    result.run.state.spaceId !== input.spaceId ||
    result.run.state.threadId !== input.threadId ||
    result.authority.workflowVersion.tenantId !== input.tenantId ||
    result.authority.workflowVersion.workflowVersionId !==
      input.workflowVersionId ||
    runId !== receipt.run_id ||
    result.run.disposition !== "committed"
  )
    replayCorrupt();
  const [snapshot, events, general, outbox, workItems, root] =
    await Promise.all([
      client.query<{ state_json: unknown }>(
        `SELECT state_json FROM ${schema}.run_snapshots WHERE tenant_id=$1 AND run_id=$2`,
        [tenantId, runId],
      ),
      client.query<{
        tenant_id: string;
        run_id: string;
        sequence: string | number;
        event_id: string;
        event_json: unknown;
      }>(
        `SELECT tenant_id,run_id,sequence,event_id,event_json FROM ${schema}.run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence`,
        [tenantId, runId],
      ),
      client.query<{
        tenant_id: string;
        scope: string;
        idempotency_key: string;
        fingerprint: string;
        run_id: string;
        result_json: unknown;
      }>(
        `SELECT tenant_id,scope,idempotency_key,fingerprint,run_id,result_json
         FROM ${schema}.idempotency_receipts WHERE scope=$1 AND idempotency_key=$2`,
        [stored.generalIdempotency.scope, stored.generalIdempotency.key],
      ),
      client.query<{
        message_id: string;
        tenant_id: string;
        run_id: string;
        topic: string;
        message_json: unknown;
      }>(
        `SELECT message_id,tenant_id,run_id,topic,message_json FROM ${schema}.outbox WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,message_id`,
        [tenantId, runId],
      ),
      client.query<{
        work_item_id: string;
        tenant_id: string;
        run_id: string;
        kind: string;
        work_item_json: unknown;
      }>(
        `SELECT work_item_id,tenant_id,run_id,kind,work_item_json FROM ${schema}.work_items WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,work_item_id`,
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
  const compiled = parseCompiledWorkflowVersion(
    workflowVersion.definitionJson,
    digester,
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
    !events.rows.every((row, index) => {
      const event = result.run.events[index];
      return (
        event !== undefined &&
        row.tenant_id === tenantId &&
        row.run_id === runId &&
        Number(row.sequence) === event.sequence &&
        row.event_id === event.eventId
      );
    }) ||
    stableJson(outbox.rows.map(({ message_json }) => message_json)) !==
      stableJson(result.run.outbox) ||
    !outbox.rows.every((row, index) => {
      const message = result.run.outbox[index];
      return (
        message !== undefined &&
        row.message_id === message.messageId &&
        row.tenant_id === tenantId &&
        row.run_id === runId &&
        row.topic === message.topic
      );
    }) ||
    stableJson(workItems.rows.map(({ work_item_json }) => work_item_json)) !==
      stableJson(result.run.workItems) ||
    !workItems.rows.every((row, index) => {
      const item = result.run.workItems[index];
      return (
        item !== undefined &&
        row.work_item_id === item.workItemId &&
        row.tenant_id === tenantId &&
        row.run_id === runId &&
        row.kind === item.kind
      );
    }) ||
    general.rows.length !== 1 ||
    general.rows[0]!.tenant_id !== tenantId ||
    general.rows[0]!.scope !== stored.generalIdempotency.scope ||
    general.rows[0]!.idempotency_key !== stored.generalIdempotency.key ||
    general.rows[0]!.run_id !== runId ||
    general.rows[0]!.fingerprint !==
      stored.generalIdempotency.requestFingerprint ||
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
  const rootValue = {
    schemaVersion: "crewon.workflow-execution-value.v0" as const,
    valueId: rootRow.value_id,
    valueDigest: rootRow.value_digest,
    value: rootRow.value_json as JsonValue,
  };
  if (canonicalJson(rootRow.value_json) !== canonicalJson(input.workflowInput))
    replayCorrupt();
  validateWorkflowSchemaValue(rootRow.value_json, compiled.inputSchema);
  validatePrepared(
    input,
    {
      tenantId,
      idempotency: stored.generalIdempotency,
      expectedRevision: 0,
      events: result.run.events,
      outbox: result.run.outbox,
      workItems: result.run.workItems,
    },
    workflowVersion,
    result.authority.route,
    rootValue,
  );
  validateSchedulerWork(work?.payload, rootValue, compiled);
}

async function loadFreshAuthority(
  client: PoolClient,
  schema: string,
  input: CommitWorkflowRunStartInput,
  candidateRoute: RunRoute,
  digester: WorkflowContentDigester,
  lock: boolean,
) {
  const workflowVersion = await loadWorkflowVersion(
    client,
    schema,
    input,
    digester,
    lock,
  );
  const releaseResult = await client.query<{ bundle_json: unknown }>(
    `SELECT bundles.bundle_json FROM ${schema}.active_agent_version_releases active
     JOIN ${schema}.agent_version_release_bundles bundles
       ON bundles.tenant_id=active.tenant_id AND bundles.release_id=active.release_id
     WHERE active.tenant_id=$1${lock ? " FOR UPDATE OF active,bundles" : ""}`,
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
  const authorities = [];
  for (const agentVersionId of ids) {
    authorities.push(
      await loadAgentAuthority(
        client,
        schema,
        input.tenantId,
        agentVersionId,
        digester,
        lock,
      ),
    );
  }
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
  );
  if (defaultAuthority === undefined)
    throw new RunStoreError("workflow_agent_deployment_mismatch");
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
  return {
    releaseId: bundle.releaseId,
    authority: { workflowVersion, route: candidateRoute },
  };
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
  lock: boolean,
) {
  const result = await client.query<{
    asset_json: AgentVersionAsset;
    deployment_json: AgentVersionDeployment;
  }>(
    `SELECT versions.asset_json,deployments.deployment_json FROM ${schema}.agent_versions versions JOIN ${schema}.agent_version_deployments deployments USING (tenant_id,agent_version_id) WHERE versions.tenant_id=$1 AND versions.agent_version_id=$2${lock ? " FOR SHARE OF versions,deployments" : ""}`,
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
    stableJson(value.workflowInput) !==
      stableJson({ valueId: root.valueId, valueDigest: root.valueDigest }) ||
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
