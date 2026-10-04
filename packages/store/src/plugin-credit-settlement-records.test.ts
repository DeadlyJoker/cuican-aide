import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreditAccount,
  createExtensionCreditAdmission,
  dispatchToolExecutionReceipt,
  finishRunAttempt,
  grantCreditAccount,
  parsePluginTaskAdmission,
  prepareToolExecutionReceipt,
  reduceRunLifecycleEvent,
  releaseCreditReservation,
  reserveCreditAccount,
  resolveToolExecutionReceipt,
  settleCreditReservation,
  startRunAttempt,
  type RunAttemptState,
  type RunStepState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import { runInput, timestamp } from "./extension-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { encodeSqliteToolReceiptState } from "./sqlite-tool-result-codec.ts";
import {
  assertSettlementReplay,
  buildSettlementSnapshot,
  createSettlementFinalization,
  parseSettlementDecision,
  parseSettlementFinalization,
  parseSettlementLocator,
  type SettlementEvidenceRows,
  type SettlementRow,
} from "./plugin-credit-settlement-records.ts";

const end = "2026-09-30T00:00:05.000Z";
const dispatchAt = "2026-09-30T00:00:01.000Z";
const digest = extensionStoreDigester.sha256("named settlement fixture");

function toolRow(state: ToolExecutionReceiptState): SettlementRow {
  return {
    tenant_id: state.tenantId,
    run_id: state.runId,
    receipt_id: state.receiptId,
    step_id: state.stepId,
    attempt_id: state.attemptId,
    work_item_id: state.workItemId,
    action_digest: state.actionDigest,
    idempotency_key: state.idempotencyKey,
    status: state.status,
    revision: state.revision,
    prepared_at: state.preparedAt,
    updated_at: state.updatedAt,
    resolved_at: state.resolvedAt,
    state_json: state,
  };
}
function stepRow(state: RunStepState): SettlementRow {
  return {
    tenant_id: state.tenantId,
    run_id: state.runId,
    step_id: state.stepId,
    kind: state.kind,
    status: state.status,
    revision: state.revision,
    current_attempt_id: state.currentAttemptId,
    attempt_count: state.attemptCount,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    terminal_at: state.terminalAt,
    state_json: state,
  };
}
function attemptRow(state: RunAttemptState): SettlementRow {
  return {
    tenant_id: state.tenantId,
    run_id: state.runId,
    step_id: state.stepId,
    attempt_id: state.attemptId,
    work_item_id: state.workItemId,
    attempt_number: state.attemptNumber,
    retry_of_attempt_id: state.retryOfAttemptId,
    lease_epoch: state.leaseEpoch,
    status: state.status,
    started_at: state.startedAt,
    updated_at: state.updatedAt,
    terminal_at: state.terminalAt,
    state_json: state,
  };
}
function fixture(output = "private supplier output") {
  const input = runInput("settlement-run");
  const binding = input.binding;
  const locator = { tenantId: binding.tenantId, runId: binding.runId };
  const scope = {
    tenantId: binding.tenantId,
    principalId: "named-settlement-payer",
    poolId: "named-settlement-pool",
  };
  const admission = createExtensionCreditAdmission(
    {
      binding,
      receipt: input.receipt,
      principalId: scope.principalId,
      poolId: scope.poolId,
      priceRevision: 4,
      quotedCredits: "30",
    },
    extensionStoreDigester,
  );
  // Explicit fixture funding; neither the codec nor production composition supplies a grant.
  const held = reserveCreditAccount(
    grantCreditAccount(createCreditAccount(scope), "100"),
    admission.reservation,
  );
  const created = input.commit.events[0]!;
  const initial = reduceRunLifecycleEvent(null, created);
  const running = reduceRunLifecycleEvent(initial, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: binding.runId },
    eventId: "named-start",
    sequence: 2,
    occurredAt: timestamp,
    type: "run.started",
    data: {},
  });
  const run = reduceRunLifecycleEvent(running, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: binding.runId },
    eventId: "named-finish",
    sequence: 3,
    occurredAt: end,
    type: "run.completed",
    data: { outputRef: null },
  });
  const work = input.commit.workItems[0]!;
  const begun = startRunAttempt(null, null, {
    ...locator,
    stepId: "named-tool-step",
    kind: "tool",
    attemptId: "named-tool-attempt",
    workItemId: work.workItemId,
    leaseEpoch: 1,
    startedAt: timestamp,
  });
  const finished = finishRunAttempt(begun.step, begun.attempt, {
    status: "completed",
    finishedAt: end,
    checkpointDigest: null,
  });
  const prepared = prepareToolExecutionReceipt({
    receiptId: "named-tool-receipt",
    ...locator,
    stepId: begun.step.stepId,
    attemptId: begun.attempt.attemptId,
    workItemId: work.workItemId,
    executionId: "named-tool-execution",
    idempotencyKey: "named-tool-key",
    actionDigest: digest,
    call: {
      segmentId: "named-segment",
      callId: "named-call",
      kind: "function",
      name: "named_plugin.submit",
      inputDigest: digest,
    },
    effect: "mutation",
    recovery: "reconcilable",
    preparedAt: timestamp,
    actionIntent: {
      schemaVersion: "crewon.action-intent.v0",
      runId: binding.runId,
      segmentId: "named-segment",
      callId: "named-call",
      tool: {
        kind: "function",
        name: "named_plugin.submit",
        inputDigest: digest,
      },
      effect: "mutation",
      recovery: "reconcilable",
      policySnapshotId: binding.target.policySnapshotId,
      workspaceBindingId: binding.target.workspaceBindingId,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "named-plugin-binding" },
      capability: "plugin.execute",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 1000,
        maxOutputBytes: 256 * 1024,
        maxArtifactBytes: 1024,
      },
    },
  });
  const tool = resolveToolExecutionReceipt(
    dispatchToolExecutionReceipt(prepared, dispatchAt),
    {
      status: "completed",
      resolvedAt: end,
      providerReceiptId: "named-provider-receipt",
      result: {
        output,
        outputDigest: extensionStoreDigester.sha256(output),
        isError: false,
        artifactRef: null,
      },
    },
  );
  const installedAdmission = parsePluginTaskAdmission({
    schemaVersion: "crewon.plugin-task-admission.v1",
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    profileId: "named-profile",
    pluginId: binding.pluginId,
    publisherId: "crewon",
    version: "1.0.0",
    packageDigest: digest,
    selectionRevision: 2,
    principalId: scope.principalId,
    actorId: binding.actorId,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "named-authority-epoch",
    runId: binding.runId,
    threadId: binding.threadId,
    extensionBindingDigest: binding.bindingDigest,
    requestDigest: input.receipt.requestDigest,
    idempotencyKey: input.receipt.idempotencyKey,
  });
  const rows: SettlementEvidenceRows = {
    admissionRow: {
      tenant_id: binding.tenantId,
      space_id: binding.spaceId,
      run_id: binding.runId,
      principal_id: scope.principalId,
      pool_id: scope.poolId,
      reservation_id: held.reservation.reservationId,
      admission_json: admission,
    },
    bindingRow: {
      tenant_id: binding.tenantId,
      space_id: binding.spaceId,
      plugin_id: binding.pluginId,
      run_id: binding.runId,
      configuration_revision: binding.configurationRevision,
      binding_json: binding,
    },
    taskReceiptRow: {
      tenant_id: binding.tenantId,
      space_id: binding.spaceId,
      plugin_id: binding.pluginId,
      kind: "task",
      actor_id: input.receipt.actorId,
      idempotency_key: input.receipt.idempotencyKey,
      request_digest: input.receipt.requestDigest,
      result_json: {
        binding,
        creditAdmission: admission,
        run: {
          disposition: "committed",
          state: initial,
          events: [created],
          outbox: input.commit.outbox,
          workItems: input.commit.workItems,
        },
      },
    },
    runRow: {
      tenant_id: run.tenantId,
      space_id: run.spaceId,
      run_id: run.runId,
      thread_id: run.threadId,
      revision: run.revision,
      last_sequence: run.lastSequence,
      updated_at: run.updatedAt,
      state_json: run,
    },
    accountRow: {
      tenant_id: scope.tenantId,
      principal_id: scope.principalId,
      pool_id: scope.poolId,
      revision: held.account.revision,
      account_json: held.account,
    },
    reservationRow: {
      tenant_id: scope.tenantId,
      principal_id: scope.principalId,
      pool_id: scope.poolId,
      reservation_id: held.reservation.reservationId,
      idempotency_key: held.reservation.idempotencyKey,
      record_json: held.reservation,
    },
    installedAdmission,
    creditVersions: [{ id: 1, version: 1 }],
    admissionVersions: [{ id: 1, version: 1 }],
    operations: [],
    steps: [stepRow(finished.step)],
    attempts: [attemptRow(finished.attempt)],
    toolReceipts: [toolRow(tool)],
    workItems: [
      {
        work_item_id: work.workItemId,
        tenant_id: work.tenantId,
        run_id: work.runId,
        kind: work.kind,
        work_item_json: work,
        created_at: work.createdAt,
        status: "completed",
        available_at_ms: Date.parse(timestamp),
        lease_owner_id: null,
        lease_id: null,
        lease_epoch: 1,
        lease_expires_at_ms: null,
        attempt_count: 1,
        completed_at_ms: Date.parse(end),
        last_error_code: null,
      },
    ],
  };
  return { rows, locator, scope, binding, held, tool, prepared, finished };
}
function decision(
  evidenceDigest: string,
  outcome: unknown = { kind: "settle", actualCredits: "12" },
) {
  return parseSettlementDecision({
    schemaVersion: "crewon.plugin-credit-settlement-decision.v1",
    evidenceDigest,
    authorityId: "named-server-authority",
    authorityRevision: "named-policy-v4",
    decisionId: "named-decision",
    outcome,
  });
}

test("settlement locator and decision reject accessors, inherited shapes, extras and future versions without invoking getters", () => {
  let reads = 0;
  const input = Object.defineProperty({ tenantId: "tenant" }, "runId", {
    enumerable: true,
    get() {
      ++reads;
      return "run";
    },
  });
  assert.throws(() => parseSettlementLocator(input));
  assert.throws(() =>
    parseSettlementLocator({ tenantId: "tenant", runId: "run", extra: true }),
  );
  assert.throws(() =>
    parseSettlementLocator(Object.create({ tenantId: "tenant", runId: "run" })),
  );
  const good = decision(digest);
  assert.throws(() =>
    parseSettlementDecision({
      ...good,
      outcome: { ...good.outcome, extra: true },
    }),
  );
  assert.throws(() =>
    parseSettlementDecision({
      ...good,
      schemaVersion: "crewon.plugin-credit-settlement-decision.v2",
    }),
  );
  assert.throws(() =>
    decision(digest, { kind: "settle", actualCredits: "-1" }),
  );
  assert.equal(reads, 0);
  assert.ok(Object.isFrozen(good));
  assert.ok(Object.isFrozen(good.outcome));
});

test("bounded evidence verifies original payer, quote and execution without revealing input/output", () => {
  const f = fixture();
  const snapshot = buildSettlementSnapshot(f.locator, f.rows)!;
  assert.equal(snapshot.evidence.readyToFinalize, true);
  assert.equal(snapshot.evidence.quotedCredits, "30");
  assert.equal(snapshot.evidence.priceRevision, 4);
  assert.equal(snapshot.account.availableCredits, "70");
  assert.equal(snapshot.account.reservedCredits, "30");
  assert.equal(
    JSON.stringify(snapshot.evidence).includes("private supplier output"),
    false,
  );
  assert.equal(JSON.stringify(snapshot.evidence).includes("prompt:"), false);
  assert.ok(Object.isFrozen(snapshot.evidence));
  assert.ok(Object.isFrozen(snapshot.evidence.mutationReceipts));
  assert.ok(Object.isFrozen(snapshot.evidence.mutationReceipts[0]));
  assert.throws(() =>
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      installedAdmission: {
        ...f.rows.installedAdmission!,
        principalId: "different-payer",
      },
    }),
  );
  assert.throws(() =>
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      bindingRow: { ...f.rows.bindingRow!, configuration_revision: 99 },
    }),
  );
  assert.throws(() =>
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      runRow: { ...f.rows.runRow!, thread_id: "different-thread" },
    }),
  );
  assert.throws(() =>
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      toolReceipts: [
        {
          ...f.rows.toolReceipts[0]!,
          action_digest: extensionStoreDigester.sha256("other"),
        },
      ],
    }),
  );
  assert.throws(() =>
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      admissionVersions: [{ id: 1, version: 2 }],
    }),
  );
});

test("equivalent PostgreSQL indexed integers/timestamps and SQLite compressed output preserve the evidence digest", () => {
  const f = fixture("private repeated result ".repeat(5000));
  const original = buildSettlementSnapshot(f.locator, f.rows)!;
  const work = f.rows.workItems[0]!;
  const {
    available_at_ms,
    lease_expires_at_ms,
    completed_at_ms,
    ...workWithoutTimes
  } = work;
  const pgRows: SettlementEvidenceRows = {
    ...f.rows,
    creditVersions: [{ id: "1", version: "1" }],
    admissionVersions: [{ id: "1", version: "1" }],
    runRow: {
      ...f.rows.runRow!,
      revision: "3",
      last_sequence: "3",
      updated_at: new Date(end),
    },
    accountRow: {
      ...f.rows.accountRow!,
      revision: String(f.held.account.revision),
    },
    steps: f.rows.steps.map((row) => ({
      ...row,
      revision: String(row.revision),
      attempt_count: String(row.attempt_count),
      created_at: new Date(timestamp),
      updated_at: new Date(end),
      terminal_at: new Date(end),
    })),
    attempts: f.rows.attempts.map((row) => ({
      ...row,
      attempt_number: "1",
      lease_epoch: "1",
      started_at: new Date(timestamp),
      updated_at: new Date(end),
      terminal_at: new Date(end),
    })),
    toolReceipts: [
      {
        ...f.rows.toolReceipts[0]!,
        revision: String(f.tool.revision),
        prepared_at: new Date(timestamp),
        updated_at: new Date(end),
        resolved_at: new Date(end),
      },
    ],
    workItems: [
      {
        ...workWithoutTimes,
        lease_epoch: "1",
        attempt_count: "1",
        created_at: new Date(timestamp),
        available_at: new Date(available_at_ms as number),
        lease_expires_at: lease_expires_at_ms,
        completed_at: new Date(completed_at_ms as number),
      },
    ],
  };
  assert.equal(
    buildSettlementSnapshot(f.locator, pgRows)!.evidence.evidenceDigest,
    original.evidence.evidenceDigest,
  );
  const compressed = encodeSqliteToolReceiptState(f.tool);
  assert.ok(compressed.includes("deflate-raw"));
  assert.equal(
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      toolReceipts: [{ ...f.rows.toolReceipts[0]!, state_json: compressed }],
    })!.evidence.evidenceDigest,
    original.evidence.evidenceDigest,
  );
});

test("a completed Run cannot finalize while dispatch/attempt/lease evidence remains unresolved", () => {
  const f = fixture();
  for (const tool of [
    f.prepared,
    dispatchToolExecutionReceipt(f.prepared, dispatchAt),
    resolveToolExecutionReceipt(
      dispatchToolExecutionReceipt(f.prepared, dispatchAt),
      { status: "canceled", resolvedAt: end, providerReceiptId: null },
    ),
  ]) {
    const evidence = buildSettlementSnapshot(f.locator, {
      ...f.rows,
      operations: [],
      toolReceipts: [toolRow(tool)],
    })!.evidence;
    assert.equal(evidence.readyToFinalize, false);
  }
  const attempt = {
    ...f.finished.attempt,
    status: "running" as const,
    terminalAt: null,
  };
  assert.equal(
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      attempts: [attemptRow(attempt)],
    })!.evidence.readyToFinalize,
    false,
  );
  assert.equal(
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      workItems: [
        {
          ...f.rows.workItems[0]!,
          status: "leased",
          completed_at_ms: null,
          lease_owner_id: "expired-owner",
          lease_id: "expired-lease",
          lease_expires_at_ms: Date.parse(timestamp),
        },
      ],
    })!.evidence.readyToFinalize,
    false,
  );
  assert.throws(() =>
    buildSettlementSnapshot(f.locator, { ...f.rows, steps: [] }),
  );
  assert.throws(() =>
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      toolReceipts: Array.from({ length: 65 }, () => f.rows.toolReceipts[0]!),
    }),
  );
});

test("legacy paid evidence is readable but cannot acquire installed authority, and a missing paid admission cannot become free", () => {
  const f = fixture();
  const legacy = buildSettlementSnapshot(f.locator, {
    ...f.rows,
    installedAdmission: null,
  })!;
  assert.equal(legacy.evidence.installedAdmissionDigest, null);
  assert.equal(legacy.evidence.readyToFinalize, false);
  assert.throws(
    () =>
      buildSettlementSnapshot(f.locator, {
        ...f.rows,
        admissionRow: undefined,
      }),
    /admission_missing/u,
  );
  const {
    admissionRow: _admission,
    taskReceiptRow: _receipt,
    ...freeRows
  } = f.rows;
  assert.equal(buildSettlementSnapshot(f.locator, freeRows), null);
});

test("read-only receipt and Step facts change the CAS digest, unrelated account grants do not", () => {
  const f = fixture();
  const original = buildSettlementSnapshot(f.locator, f.rows)!;
  const readOnly = {
    ...f.tool,
    effect: "readOnly" as const,
    actionIntent: { ...f.tool.actionIntent!, effect: "readOnly" as const },
  };
  const changed = buildSettlementSnapshot(f.locator, {
    ...f.rows,
    toolReceipts: [toolRow(readOnly)],
  })!;
  assert.notEqual(
    changed.evidence.evidenceDigest,
    original.evidence.evidenceDigest,
  );
  assert.equal(changed.evidence.mutationReceipts.length, 0);
  const changedStep = {
    ...f.finished.step,
    revision: f.finished.step.revision + 1,
  };
  assert.notEqual(
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      steps: [stepRow(changedStep)],
    })!.evidence.evidenceDigest,
    original.evidence.evidenceDigest,
  );
  const granted = grantCreditAccount(f.held.account, "7");
  assert.equal(
    buildSettlementSnapshot(f.locator, {
      ...f.rows,
      accountRow: {
        ...f.rows.accountRow!,
        revision: granted.revision,
        account_json: granted,
      },
    })!.evidence.evidenceDigest,
    original.evidence.evidenceDigest,
  );
});

test("finalization validates the actual ledger transition and returns immutable original accounting for identical decision replay", () => {
  const f = fixture();
  const snapshot = buildSettlementSnapshot(f.locator, f.rows)!;
  const approved = decision(snapshot.evidence.evidenceDigest);
  const next = settleCreditReservation(
    snapshot.account,
    snapshot.reservation,
    "12",
  );
  const saved = createSettlementFinalization(snapshot, approved, next);
  assert.equal(saved.account.availableCredits, "88");
  assert.equal(saved.account.reservedCredits, "0");
  assert.equal(saved.account.spentCredits, "12");
  assert.deepEqual(
    parseSettlementFinalization(JSON.stringify(saved), f.locator),
    saved,
  );
  assertSettlementReplay(saved, approved);
  assert.throws(
    () =>
      assertSettlementReplay(saved, {
        ...approved,
        decisionId: "different-decision",
      }),
    /decision_conflict/u,
  );
  assert.throws(
    () => createSettlementFinalization(snapshot, decision(digest), next),
    /evidence_changed/u,
  );
  assert.throws(() =>
    createSettlementFinalization(
      snapshot,
      approved,
      settleCreditReservation(snapshot.account, snapshot.reservation, "13"),
    ),
  );
  assert.throws(() =>
    parseSettlementFinalization({ ...saved, extra: true }, f.locator),
  );
  const released = createSettlementFinalization(
    snapshot,
    decision(snapshot.evidence.evidenceDigest, { kind: "release" }),
    releaseCreditReservation(snapshot.account, snapshot.reservation),
  );
  assert.equal(released.account.availableCredits, "100");
  assert.equal(released.reservation.state, "released");
  assert.throws(() =>
    parseSettlementFinalization({ ...released, decision: approved }, f.locator),
  );
});
