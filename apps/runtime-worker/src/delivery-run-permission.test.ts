import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DeliveryApplicationService,
  type DomainStore,
} from "@crewon/application";
import { SpreadsheetEngine } from "@crewon/artifacts";
import { XLSX_MEDIA_TYPE, type RunToolPermissionMode } from "@crewon/domain";
import { SqliteDeliveryStore } from "@crewon/store";
import type {
  ToolExecutionResolution,
  ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  createDeliveryToolRuntime,
  StoreBackedDeliveryAccess,
} from "./delivery-tool-runtime.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

// Inspect persisted XML without invoking the production reader/formula evaluator.
// fflate is an existing artifacts dependency; this is a test-only independent read.
const { unzipSync } = createRequire(
  new URL("../../../packages/artifacts/package.json", import.meta.url),
)("fflate") as {
  unzipSync(content: Uint8Array): Record<string, Uint8Array>;
};

test("F01 Run approveForMe: durable per-action approval resumes real delivery_assemble over HTTP/SSE after reopen", async (context) => {
  const fixture = await createDeliveryFixture(context, "approveForMe");
  const { run, workerFixture } = fixture;
  assert.equal(run.toolPermissionMode, "approveForMe");
  assertPerActionPolicies(fixture.runtime());
  const created = (await workerFixture.events()).find(
    (event) => event.type === "run.created",
  );
  assert.equal(created?.data.toolPermissionMode, "approveForMe");

  assert.deepEqual(await workerFixture.worker().wake(), {
    kind: "retried",
    runId: run.runId,
    code: "tool_approval_auto_approved",
  });
  const approval = await fixture.approval();
  assert.ok(approval !== null);
  assert.equal(approval.status, "approved");
  assert.equal(approval.revision, 2);
  assert.equal(approval.runId, run.runId);
  assert.equal(approval.tenantId, run.tenantId);
  assert.equal(approval.spaceId, run.spaceId);
  assert.equal(approval.requestedByActorId, run.createdByActorId);
  assert.deepEqual(approval.decision, {
    outcome: "approved",
    actorId: run.createdByActorId,
    comment: "Approved by approveForMe Run permission",
    decidedAt: approval.updatedAt,
  });
  assert.equal((await fixture.catalog()).deliveries.length, 0);
  assert.equal(fixture.resolutions.length, 0);
  const prepared = (await workerFixture.receipts())[0];
  assert.ok(prepared !== null && prepared !== undefined);
  assert.equal(approval.receiptId, prepared.receiptId);
  assert.equal(approval.actionDigest, prepared.actionDigest);
  assert.equal(
    approval.policySnapshotId,
    prepared.actionIntent?.policySnapshotId,
  );
  assert.equal(prepared.actionIntent?.approvalRequirement, "perAction");

  // A changed caller preference cannot rewrite the already admitted Run.
  fixture.options.toolPermissionMode = "requestApproval";
  await workerFixture.reopen();
  assert.equal(fixture.materializations(), 2);
  assert.equal((await workerFixture.run())?.toolPermissionMode, "approveForMe");
  assert.deepEqual(await fixture.approval(), approval);
  assertPerActionPolicies(fixture.runtime());
  await workerFixture.makeDue();
  assert.deepEqual(await workerFixture.worker().wake(), {
    kind: "completed",
    runId: run.runId,
  });
  assert.equal(fixture.resolutions.length, 1);

  const deliveries = (await fixture.catalog()).deliveries;
  assert.equal(deliveries.length, 1);
  const version = deliveries[0]!;
  assert.equal(version.sourceRunId, run.runId);
  assert.equal(version.validation.writtenRows, 3);
  assert.equal(version.validation.numericTotals.B, 60);
  const written = await fixture.readVersion(version.versionId);
  assert.equal(written.content.byteLength, version.byteLength);
  assert.equal(
    version.contentDigest,
    `sha256:${createHash("sha256").update(written.content).digest("hex")}`,
  );
  assert.deepEqual([...written.content.slice(0, 2)], [0x50, 0x4b]);
  const sheet = new TextDecoder().decode(
    unzipSync(written.content)["xl/worksheets/sheet1.xml"],
  );
  assert.match(
    sheet,
    /<c\b[^>]*\br="B10"[^>]*><f>SUM\(B2:B9\)<\/f><v>60<\/v><\/c>/u,
  );
  assert.match(
    sheet,
    /<c\b[^>]*\br="C10"[^>]*><f>B10\*2<\/f><v>120<\/v><\/c>/u,
  );

  const events = await workerFixture.events();
  const required = events.filter(
    (event) => event.type === "run.approval.required",
  );
  assert.equal(required.length, 1);
  assert.equal(required[0]?.data.approvalId, approval.approvalId);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "run.resumed" &&
        event.data.reasonCode === "tool_approval_approved",
    ).length,
    1,
  );
  const completed = events.filter((event) => event.type === "tool.completed");
  assert.equal(completed.length, 1);
  const output = completed[0]!.data.output;
  const reference = JSON.parse(output).reference;
  assert.equal(reference.versionId, version.versionId);
  assert.equal(reference.sourceRunId, run.runId);
  assert.equal(reference.contentDigest, version.contentDigest);
  assert.equal(reference.availability, "ready");
  assert.ok(Buffer.byteLength(output) <= 9 * 1024);
  assert.equal(workerFixture.requests.length, 2);
  assert.equal(workerFixture.requests[1]?.previous_response_id, "resp-tools");
  assert.deepEqual(workerFixture.requests[1]?.input, [
    { type: "function_call_output", call_id: "call-1", output },
  ]);

  await workerFixture.reopen();
  assert.equal((await workerFixture.run())?.toolPermissionMode, "approveForMe");
  assert.deepEqual(await fixture.approval(), approval);
  assert.deepEqual(
    (await fixture.readVersion(version.versionId)).content,
    written.content,
  );
  assert.equal((await fixture.catalog()).deliveries.length, 1);
  assert.equal((await fixture.history(version.deliveryId)).length, 1);
});

for (const mode of [null, "requestApproval"] as const) {
  test(`F01 Run ${mode ?? "omitted permission"}: delivery_assemble remains waitingApproval with no file after reopen`, async (context) => {
    const fixture = await createDeliveryFixture(context, mode);
    const { run, workerFixture } = fixture;
    assert.equal(run.toolPermissionMode, mode ?? undefined);
    assertPerActionPolicies(fixture.runtime());
    const waiting = await workerFixture.worker().wake();
    assert.equal(waiting.kind, "waitingApproval");
    const approval = await fixture.approval();
    assert.ok(approval !== null);
    assert.deepEqual(waiting, {
      kind: "waitingApproval",
      runId: run.runId,
      approvalId: approval.approvalId,
    });
    assert.equal(approval.status, "required");
    assert.equal(approval.revision, 1);
    assert.equal(approval.decision, null);
    assert.equal((await workerFixture.run())?.status, "waitingApproval");
    assert.equal((await fixture.catalog()).deliveries.length, 0);
    assert.equal(fixture.resolutions.length, 0);

    fixture.options.toolPermissionMode = "approveForMe";
    await workerFixture.reopen();
    assert.equal(
      (await workerFixture.run())?.toolPermissionMode,
      mode ?? undefined,
    );
    await workerFixture.makeDue();
    assert.deepEqual(await workerFixture.worker().wake(), waiting);
    assert.deepEqual(await fixture.approval(), approval);
    assert.equal((await workerFixture.run())?.status, "waitingApproval");
    assert.equal((await fixture.catalog()).deliveries.length, 0);
    assert.equal(fixture.resolutions.length, 0);
    assert.equal(workerFixture.requests.length, 1);
    const receipts = await workerFixture.receipts();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.actionIntent?.approvalRequirement, "perAction");
    assert.equal(receipts[0]?.actionDigest, approval.actionDigest);
    const events = await workerFixture.events();
    assert.equal(
      events.filter((event) => event.type === "tool.completed").length,
      0,
    );
    assert.equal(
      events.filter((event) => event.type === "run.resumed").length,
      0,
    );
    assert.equal(
      events.filter((event) => event.type === "run.approval.required").length,
      1,
    );
    assertPerActionPolicies(fixture.runtime());
  });
}

function assertPerActionPolicies(runtime: ToolRuntimePort): void {
  for (const name of ["delivery_assemble", "delivery_patch"]) {
    const policy = runtime.executionPolicy("function", name);
    assert.equal(policy?.effect, "mutation");
    assert.equal(policy?.recovery, "reconcilable");
    assert.equal(policy?.approvalRequirement, "perAction");
  }
}

async function createDeliveryFixture(
  context: TestContext,
  mode: RunToolPermissionMode | null,
) {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-delivery-run-permission-"),
  );
  const config = {
    databasePath: join(directory, "artifacts.sqlite.delivery.sqlite"),
    encryptionKey: new Uint8Array(32).fill(23),
  };
  let vault = new SqliteDeliveryStore(config);
  context.after(async () => {
    await vault.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let store!: DomainStore;
  let application!: DeliveryApplicationService;
  let runtime!: ToolRuntimePort;
  let materializations = 0;
  const resolutions: ToolExecutionResolution[] = [];
  const options = {
    backend: "sqlite" as const,
    storeResponses: true,
    crashAfterCommit: false,
    toolPermissionMode: mode,
    toolName: "delivery_assemble",
    toolInput: "{}",
    afterToolProviderResolved: async (resolution: ToolExecutionResolution) => {
      resolutions.push(resolution);
    },
    toolRuntimeFactory: (opened: DomainStore) => {
      if (materializations++ > 0) {
        void vault.close();
        vault = new SqliteDeliveryStore(config);
      }
      store = opened;
      const access = new StoreBackedDeliveryAccess(store, "tenant-1");
      application = new DeliveryApplicationService({
        store: vault,
        engine: new SpreadsheetEngine(),
        access,
      });
      runtime = createDeliveryToolRuntime({ application, access });
      return runtime;
    },
  };
  const workerFixture = await createFixture(context, options);
  const run = await workerFixture.run();
  assert.ok(run !== null);
  const actor = {
    tenantId: run.tenantId,
    spaceId: run.spaceId,
    actorId: run.createdByActorId,
    principalId: run.createdByActorId,
  };
  const template = await application.upload(
    actor,
    run.threadId,
    {
      name: "template.xlsx",
      role: "template",
      mediaType: XLSX_MEDIA_TYPE,
      content: new Uint8Array(
        readFileSync(
          new URL("./fixtures/delivery-template.xlsx", import.meta.url),
        ),
      ),
    },
    "upload-template",
  );
  const data = await application.upload(
    actor,
    run.threadId,
    {
      name: "orders.csv",
      role: "data",
      mediaType: "text/csv",
      content: new TextEncoder().encode("id,amount\na,10\nb,20\nc,30\n"),
    },
    "upload-orders",
  );
  options.toolInput = JSON.stringify({
    templateInputId: template.inputId,
    name: "approved-report.xlsx",
    sources: [
      {
        inputId: data.inputId,
        sheet: data.inspection.sheets[0]!.name,
        headerRow: 1,
      },
    ],
    targetSheet: "Report",
    startRow: 2,
    columns: [
      { sourceHeader: "id", targetColumn: "A" },
      { sourceHeader: "amount", targetColumn: "B" },
    ],
  });
  return {
    run,
    workerFixture,
    options,
    resolutions,
    runtime: () => runtime,
    materializations: () => materializations,
    approval: () =>
      store.loadLatestToolApprovalForRun({
        tenantId: run.tenantId,
        runId: run.runId,
      }),
    catalog: () => application.catalog(actor, run.threadId),
    readVersion: (versionId: string) =>
      application.readVersion(actor, run.threadId, versionId),
    history: (deliveryId: string) =>
      application.history(actor, run.threadId, deliveryId),
  };
}
