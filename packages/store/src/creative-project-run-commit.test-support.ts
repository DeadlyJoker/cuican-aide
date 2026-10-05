import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
  deriveProjectToolMutationIdempotencyKey,
  projectToolRunMutationCommand,
  type CreativeProjectCommitOptions,
  type CreativeProjectRunCommitTransactionAuthority,
  type ProjectToolMutationOperation,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  extensionToolName,
  prepareToolExecutionReceipt,
  type ToolActionIntentState,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { unmeteredFixture } from "./plugin-task-unmetered.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";

/** Original admitted task/Run/queue/Tool writers; no SQL seeds or model/supplier/balance activity. */
export async function projectRunCommitFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  prepareAdmission?: (
    fixture: Awaited<ReturnType<typeof unmeteredFixture>>,
  ) => ReturnType<Awaited<ReturnType<typeof unmeteredFixture>>["generate"]>,
  existingFixture?: Awaited<ReturnType<typeof unmeteredFixture>>,
) {
  const f = existingFixture ?? (await unmeteredFixture(t, backend));
  const parent = f.first.parent;
  const admitted =
    prepareAdmission === undefined
      ? await f.generate()
      : await prepareAdmission(f);
  const locator = { tenantId: f.actor.tenantId, runId: admitted.binding.runId };
  const admission = await f.first.store.loadPluginTaskAdmission!(
    admitted.binding,
  );
  assert.ok(admission);
  const claim = await parent.claimNextWorkItem({
    ownerId: "project-tool-test-worker",
    leaseId: randomUUID(),
    leaseDurationMs: 300000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, locator.runId);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const eventId = randomUUID();
  const before = await parent.loadRun(locator);
  assert.ok(before);
  await parent.commitLeasedRun({
    lease,
    history: null,
    commit: {
      tenantId: locator.tenantId,
      expectedRevision: before.revision,
      idempotency: {
        scope: "project-tools-test-start",
        key: eventId,
        requestFingerprint: digester.sha256(eventId),
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: locator.runId },
          eventId,
          sequence: before.lastSequence + 1,
          occurredAt: new Date().toISOString(),
          type: "run.started",
          data: {},
        },
      ],
      outbox: [],
      workItems: [],
    },
  });
  const state = {
    live: true,
    policy: true,
    transactionChecks: 0,
    beforeTransaction: null as (() => void | Promise<void>) | null,
  };
  const active = () => {
    if (!state.live) throw new Error("project_tool_test_withdrawn");
  };
  const authorization = {
    authorize: async () =>
      state.policy
        ? { outcome: "allow" as const }
        : { outcome: "deny" as const, reasonCode: "project_tool_test_denied" },
  };
  const texts = parent.projectTextStore();
  await texts.migrate();
  const application = {
    authorization,
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester,
  };
  const projects = new CreativeProjectApplicationService({
    ...application,
    store: f.metadata,
  });
  const text = new ProjectTextApplicationService({
    ...application,
    store: texts,
    projects: f.metadata,
  });
  const installation = Object.freeze(
    Object.fromEntries(
      (
        [
          "tenantId",
          "spaceId",
          "profileId",
          "pluginId",
          "publisherId",
          "version",
          "packageDigest",
          "selectionRevision",
        ] as const
      ).map((key) => [key, admission[key]]),
    ),
  ) as CreativeProjectRunCommitTransactionAuthority["installation"];
  async function prepareOperation(
    operationId: ProjectToolMutationOperation,
    request: unknown,
    projectStageAdmission?: ProjectStageRunAdmission,
  ) {
    active();
    const run = await parent.loadRun(locator);
    assert.ok(run);
    const commandInput = JSON.stringify(request);
    const name = extensionToolName(installation.pluginId, operationId);
    const callId = randomUUID(),
      segmentId = randomUUID();
    const intent: ToolActionIntentState = {
      schemaVersion: "crewon.action-intent.v0",
      runId: run.runId,
      segmentId,
      callId,
      tool: {
        kind: "function",
        name,
        inputDigest: digester.sha256(commandInput),
      },
      effect: "mutation",
      recovery: "reconcilable",
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: {
        kind: "control",
        bindingId: "named-project-tools-test-control",
      },
      capability: "project.write",
      approvalRequirement: "none",
      limits: { timeoutMs: 5000, maxOutputBytes: 8192, maxArtifactBytes: 8192 },
    };
    const actionDigest = digester.sha256(canonicalActionIntent(intent));
    const base = prepareToolExecutionReceipt({
      receiptId: randomUUID(),
      ...locator,
      stepId: `tool:${actionDigest.slice(7)}`,
      attemptId: randomUUID(),
      workItemId: claim!.workItem.workItemId,
      executionId: randomUUID(),
      idempotencyKey: `${run.runId}/tool/${actionDigest.slice(7)}`,
      actionDigest,
      actionIntent: intent,
      call: {
        segmentId,
        callId,
        kind: "function",
        name,
        inputDigest: intent.tool.inputDigest,
      },
      effect: "mutation",
      recovery: "reconcilable",
      preparedAt: new Date().toISOString(),
    });
    await parent.beginRunAttempt({
      ...locator,
      lease,
      stepId: base.stepId,
      attemptId: base.attemptId,
      kind: "tool",
      startedAt: base.preparedAt,
    });
    await parent.prepareToolExecution({ lease, receipt: base });
    const receipt = await parent.transitionToolExecution({
      ...locator,
      receiptId: base.receiptId,
      lease,
      expectedRevision: base.revision,
      transition: { kind: "dispatch", occurredAt: new Date().toISOString() },
    });
    const transaction: CreativeProjectRunCommitTransactionAuthority =
      Object.freeze({
        version: "crewon.creative-project-run-commit.v1",
        actor: f.actor,
        run,
        receipt,
        claim: claim!,
        commandInput,
        operationId,
        installation,
        admission: admission!,
        selection: f.enabled.selection,
        package: f.installed.package,
        ...(projectStageAdmission === undefined
          ? {}
          : { projectStageAdmission }),
        assertCurrent: async () => {
          state.transactionChecks++;
          await state.beforeTransaction?.();
          active();
        },
      });
    const options: CreativeProjectCommitOptions = {
      authority: {
        assertCurrent: async () => {
          active();
        },
        assertActive: active,
        runTransaction: transaction,
      },
    };
    const executionLease = {
      workItemId: receipt.workItemId,
      stepId: receipt.stepId,
      attemptId: receipt.attemptId,
      leaseId: claim!.lease.leaseId,
      leaseEpoch: claim!.lease.epoch,
      expiresAt: claim!.lease.expiresAt,
    };
    const command = {
      schemaVersion: "crewon.tool-invocation.v0" as const,
      runId: run.runId,
      idempotencyKey: receipt.idempotencyKey,
      segmentId,
      callId,
      kind: "function" as const,
      name,
      input: commandInput,
      executionId: receipt.executionId,
      executionLease,
      actionDigest,
      actionIntent: intent,
      approvalProof: null,
    };
    return {
      run,
      admission: admission!,
      claim: claim!,
      receipt,
      command,
      transaction,
      options,
      request,
      commandBody: {
        ...(request as Record<string, unknown>),
        idempotencyKey: deriveProjectToolMutationIdempotencyKey(
          transaction,
          digester,
        ),
      },
      normalized: projectToolRunMutationCommand(transaction, digester),
    };
  }
  const db = backend === "sqlite" ? new DatabaseSync(f.databasePath) : null;
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        })
      : null;
  t.after(async () => {
    db?.close();
    await pool?.end();
  });
  async function sql(query: string, values: (string | number | null)[] = []) {
    return db
      ? db.prepare(query).all(...values)
      : (await pool!.query(query, values)).rows;
  }
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of [
      "creative_projects",
      "creative_project_briefs",
      "project_text_artifacts",
      "project_text_revisions",
      "project_text_mutation_receipts",
      "tool_execution_receipts",
      "extension_external_operations",
    ])
      result[table] = Number(
        (await sql(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]?.n,
      );
    return result;
  };
  return {
    ...f,
    backend,
    parent,
    locator,
    admission,
    claim,
    lease,
    state,
    projects,
    texts,
    text,
    prepareOperation,
    sql,
    counts,
    schema: backend === "postgres" ? f.prefix.slice(1, -2) : null,
    pool,
    db,
    digester,
  };
}
