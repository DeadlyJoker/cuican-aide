import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  DeliveryError,
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  type DeliveryInputRecord,
  type DeliveryVersionRecord,
} from "@crewon/domain";
import type { DeliveryApplicationService } from "@crewon/application";
import type {
  ToolExecutionCommand,
  ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  createDeliveryToolRuntime,
  StoreBackedDeliveryAccess,
} from "./delivery-tool-runtime.ts";
import {
  configuredDeliveryToolCatalog,
  DELIVERY_MODEL_OUTPUT_BYTES,
} from "./delivery-tool-catalog.ts";
import { runtimeReleaseToolDefinitions } from "./runtime-workspace-read-tool-catalog.ts";

const target = {
  schemaVersion: "crewon.delivery-target.v1",
  tenantId: "tenant-1",
  spaceId: "space-1",
  threadId: "thread-1",
  targetId: "thread-deliveries",
} as const;
type Application = Pick<
  DeliveryApplicationService,
  "catalog" | "page" | "assemble" | "patch"
>;

test("F01-R07: command identity is resolved from a real Run and owner-scoped Thread; forged identity fails closed", async () => {
  const f = fixture();
  const input = { kind: "inputs", offset: 0, limit: 10 };
  assert.equal(
    (await execute(f.runtime, "delivery_catalog", input)).isError,
    false,
  );
  for (const [field, value] of [
    ["threadId", "other"],
    ["sourceRunId", "other"],
    ["path", "/tmp/fabricated.xlsx"],
  ]) {
    const result = await execute(f.runtime, "delivery_catalog", {
      ...input,
      [field!]: value,
    });
    assert.equal(result.isError, true);
    assert.match(result.output, /delivery_fields_invalid/);
  }
  const request = command(f.runtime, "delivery_catalog", input);
  f.setRun({ ...f.run, tenantId: "other-tenant" });
  await assert.rejects(
    f.runtime.execute(request, signal()),
    /delivery_run_access_denied/,
  );
  f.setRun({ ...f.run, spaceId: "other-space" });
  await assert.rejects(
    f.runtime.execute(request, signal()),
    /delivery_access_denied/,
  );
  f.setRun({ ...f.run, createdByActorId: "other-owner" });
  await assert.rejects(
    f.runtime.execute(request, signal()),
    /delivery_access_denied/,
  );
  f.setRun({ ...f.run, status: "completed" });
  await assert.rejects(
    f.runtime.execute(request, signal()),
    /delivery_run_access_denied/,
  );
  f.setRun(f.run);
  f.setThread({
    ...f.thread,
    deletedAt: "2026-09-14T00:00:00Z",
    status: "deleted",
  });
  await assert.rejects(
    f.runtime.execute(request, signal()),
    /delivery_access_denied/,
  );
  assert.equal(f.catalogCalls(), 1);
});

test("F01-R07: execution rejects a Run whose policy or workspace differs from its signed action", async () => {
  const f = fixture();
  const request = command(f.runtime, "delivery_catalog", {
    kind: "inputs",
    offset: 0,
    limit: 10,
  });
  f.setRun({ ...f.run, policySnapshotId: "policy-other" });
  await assert.rejects(
    f.runtime.execute(request, signal()),
    /delivery_run_intent_mismatch/,
  );
  f.setRun({ ...f.run, workspaceBindingId: "workspace-other" });
  await assert.rejects(
    f.runtime.execute(request, signal()),
    /delivery_run_intent_mismatch/,
  );
});

test("F01-R01/R08: every sheet is discoverable through explicit catalog pages within 9 KiB", async () => {
  const sheets = Array.from({ length: 350 }, (_, i) => ({
    name: `sheet-${i + 1}`,
    rows: 1000,
    columns: 30,
  }));
  const record: DeliveryInputRecord = {
    inputId: "input-1",
    target,
    ownerActorId: "owner-1",
    name: "full.xlsx",
    role: "data",
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byteLength: 123,
    contentDigest: `sha256:${"a".repeat(64)}`,
    inspection: { sheets, formulaCount: 0 },
    createdAt: "2026-09-14T00:00:00Z",
  };
  const f = fixture({
    catalog: async () => ({ target, inputs: [record], deliveries: [] }),
  });
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await execute(f.runtime, "delivery_catalog", {
      kind: "inputs",
      offset,
      limit: 100,
    });
    assert.equal(result.isError, false);
    assert.ok(Buffer.byteLength(result.output) <= DELIVERY_MODEL_OUTPUT_BYTES);
    const page = JSON.parse(result.output);
    seen.push(
      ...page.entries.map(
        (entry: { sheet: { name: string } }) => entry.sheet.name,
      ),
    );
    if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.deepEqual(
    seen,
    sheets.map((sheet) => sheet.name),
  );
});

test("F01-R08: UTF-8 row paging preserves complete rows and exposes continuation; oversized row fails explicitly", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => [
    i + 1,
    "完整数据".repeat(150),
  ]);
  const f = fixture({
    page: async (_actor, _threadId, query) => ({
      sheet: "Fourth",
      startRow: query.startRow,
      rows: rows.slice(query.startRow - 1, query.startRow - 1 + query.limit),
      nextRow: null,
      totalRows: rows.length,
      totalColumns: 2,
    }),
  });
  const seen: unknown[] = [];
  let startRow: number | null = 1;
  while (startRow !== null) {
    const result = await execute(f.runtime, "delivery_read", {
      kind: "input",
      id: "input-1",
      sheet: "Fourth",
      startRow,
      limit: 100,
    });
    assert.equal(result.isError, false);
    assert.ok(Buffer.byteLength(result.output) <= DELIVERY_MODEL_OUTPUT_BYTES);
    const page = JSON.parse(result.output);
    seen.push(...page.rows);
    startRow = page.nextRow;
  }
  assert.deepEqual(seen, rows);
  const huge = fixture({
    page: async () => ({
      sheet: "Huge",
      startRow: 1,
      rows: [["汉".repeat(5000)]],
      nextRow: null,
      totalRows: 1,
      totalColumns: 1,
    }),
  });
  const result = await execute(huge.runtime, "delivery_read", {
    kind: "input",
    id: "input-1",
    sheet: "Huge",
    startRow: 1,
    limit: 1,
  });
  assert.equal(result.isError, true);
  assert.match(result.output, /delivery_model_row_too_large/);
});

test("F01-R04/R07: ordinary replies never create deliveries; write tools require per-action approval", async () => {
  const f = fixture();
  const result = await execute(f.runtime, "delivery_catalog", {
    kind: "deliveries",
    offset: 0,
    limit: 10,
  });
  assert.deepEqual(JSON.parse(result.output).entries, []);
  assert.equal(result.artifactRef, null);
  const request = command(f.runtime, "delivery_assemble", assembleRequest());
  await assert.rejects(
    f.runtime.execute({ ...request, approvalProof: null }, signal()),
    /tool_approval_proof_invalid/,
  );
  assert.equal(
    f.runtime.executionPolicy("function", "delivery_assemble")?.recovery,
    "reconcilable",
  );
  assert.equal(
    f.runtime.executionPolicy("function", "delivery_read")?.recovery,
    "replaySafe",
  );
});

test("F01-R03/R05: model tools accept explicit filtering/summary rules and numeric cell formats", async () => {
  let received: unknown;
  const f = fixture({
    assemble: async (_actor, _thread, request) => {
      received = request;
      throw new DeliveryError("fixture_reached_assemble");
    },
    patch: async (_actor, _thread, request) => {
      received = request;
      throw new DeliveryError("fixture_reached_patch");
    },
  });
  const request = {
    ...assembleRequest(),
    rules: {
      exclude: [{ header: "status", equals: "canceled" }],
      requiredHeaders: ["amount"],
      exceptionSheet: "Exceptions",
      lineageSheet: "Lineage",
      summary: {
        sheet: "Summary",
        startRow: 2,
        groupBy: ["channel", "currency"],
        valueHeader: "amount",
      },
    },
  };
  assert.match(
    (await execute(f.runtime, "delivery_assemble", request)).output,
    /fixture_reached_assemble/,
  );
  assert.deepEqual(received, request);
  const patch = {
    deliveryId: "delivery-1",
    expectedVersionId: "version-1",
    expectedContentDigest: `sha256:${"a".repeat(64)}`,
    patches: [
      { sheet: "Report", cell: "B2", value: 12.3, numberFormat: "0.0" },
    ],
  };
  assert.match(
    (await execute(f.runtime, "delivery_patch", patch)).output,
    /fixture_reached_patch/,
  );
  assert.deepEqual(received, patch);
  const definition = f.runtime
    .definitions()
    .find((d) => d.name === "delivery_assemble");
  assert.ok(definition?.kind === "function");
  assert.ok(!JSON.stringify(definition.inputSchema.required).includes("rules"));
  assert.ok(JSON.stringify(definition.inputSchema).includes("exceptionSheet"));
});

test("F01-R07: release and live catalog agree; absent local storage and production remain disabled", () => {
  const environment = {
    CREWON_ARTIFACT_ROOT: "/files",
    CREWON_ARTIFACT_DB_PATH: "/files/tool.sqlite",
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: "/key",
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "key-1",
  };
  assert.equal(configuredDeliveryToolCatalog({}), "disabled");
  assert.equal(configuredDeliveryToolCatalog(environment), "enabled");
  assert.equal(
    configuredDeliveryToolCatalog({
      ...environment,
      CREWON_CONTROL_SECURITY_MODE: "production",
    }),
    "disabled",
  );
  assert.equal(
    configuredDeliveryToolCatalog({
      ...environment,
      CREWON_CONTROL_DATABASE_URL: "postgres://example",
    }),
    "disabled",
  );
  const f = fixture();
  const definitions = runtimeReleaseToolDefinitions({
    nativeWorkspaceReadCatalog: "disabled",
    deliveryToolCatalog: "enabled",
  });
  assert.deepEqual(
    definitions,
    [...f.runtime.definitions()].sort((a, b) => a.name.localeCompare(b.name)),
  );
  assert.throws(
    () =>
      runtimeReleaseToolDefinitions({
        toolRuntime: f.runtime,
        nativeWorkspaceReadCatalog: "disabled",
        deliveryToolCatalog: "enabled",
      }),
    /runtime_release_delivery_tool_collision/,
  );
});

function fixture(overrides: Partial<Application> = {}) {
  const created = reduceRunLifecycleEvent(null, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-1" },
    eventId: "run-created",
    sequence: 1,
    occurredAt: "2026-09-14T00:00:00Z",
    type: "run.created",
    data: {
      threadId: target.threadId,
      tenantId: target.tenantId,
      spaceId: target.spaceId,
      createdByActorId: "owner-1",
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
      agentVersionId: "version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: null,
    },
  });
  const run = reduceRunLifecycleEvent(created, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-1" },
    eventId: "run-started",
    sequence: 2,
    occurredAt: "2026-09-14T00:00:01Z",
    type: "run.started",
    data: {},
  });
  const thread = reduceThreadLifecycleEvent(null, {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: target.threadId },
    eventId: "thread-created",
    sequence: 1,
    occurredAt: "2026-09-14T00:00:00Z",
    type: "thread.created",
    data: {
      tenantId: target.tenantId,
      spaceId: target.spaceId,
      createdByActorId: "owner-1",
      title: "I saved /tmp/report.xlsx (ordinary text)",
    },
  });
  let currentRun = run;
  let currentThread = thread;
  let catalogCalls = 0;
  const application: Application = {
    catalog: async () => {
      catalogCalls++;
      return { target, inputs: [], deliveries: [] };
    },
    page: async () => {
      throw new DeliveryError("unexpected_read");
    },
    assemble: async () => {
      throw new DeliveryError("unexpected_write");
    },
    patch: async () => {
      throw new DeliveryError("unexpected_write");
    },
    ...overrides,
  };
  const access = new StoreBackedDeliveryAccess(
    {
      loadRun: async () => currentRun,
      loadThreadInSpace: async () => currentThread,
    },
    target.tenantId,
  );
  return {
    runtime: createDeliveryToolRuntime({ application, access }),
    run,
    thread,
    setRun: (value: typeof run) => {
      currentRun = value;
    },
    setThread: (value: typeof thread) => {
      currentThread = value;
    },
    catalogCalls: () => catalogCalls,
  };
}

export function assembleRequest() {
  return {
    templateInputId: "template-1",
    name: "report.xlsx",
    sources: [{ inputId: "source-1", sheet: "Sheet1", headerRow: 1 }],
    targetSheet: "Report",
    startRow: 2,
    columns: [
      { sourceHeader: "id", targetColumn: "A" },
      { sourceHeader: "amount", targetColumn: "B" },
    ],
  };
}
let sequence = 0;
export function command(
  runtime: ToolRuntimePort,
  name: string,
  value: unknown,
  runId = "run-1",
): ToolExecutionCommand {
  const policy = runtime.executionPolicy("function", name);
  assert.ok(policy);
  const input = JSON.stringify(value);
  const callId = `call-${++sequence}`;
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId,
    segmentId: "segment-1",
    callId,
    tool: { kind: "function" as const, name, inputDigest: digest(input) },
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    ...policy,
  };
  const actionDigest = digest(canonicalActionIntent(actionIntent));
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: `execution-${sequence}`,
    idempotencyKey: `${runId}/tool/${callId}`,
    runId,
    segmentId: "segment-1",
    callId,
    kind: "function",
    name,
    input,
    actionIntent,
    actionDigest,
    executionLease: {
      workItemId: "work-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00Z",
    },
    approvalProof:
      policy.approvalRequirement === "none"
        ? null
        : {
            schemaVersion: "crewon.tool-approval-proof.v0",
            approvalId: "approval-1",
            actionDigest,
            policySnapshotId: "policy-1",
            approvalRevision: 2,
            decidedAt: "2026-09-14T00:00:00Z",
          },
  };
}
async function execute(runtime: ToolRuntimePort, name: string, input: unknown) {
  const result = await runtime.execute(command(runtime, name, input), signal());
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected_completed");
  return result.result;
}
function signal() {
  return new AbortController().signal;
}
function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
