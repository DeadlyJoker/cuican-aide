import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeliveryApplicationService,
  type DomainStore,
} from "@crewon/application";
import { SpreadsheetEngine } from "@crewon/artifacts";
import { XLSX_MEDIA_TYPE } from "@crewon/domain";
import { SqliteDeliveryStore } from "@crewon/store";
import type { ToolExecutionResolution } from "@crewon/tool-broker";
import {
  createFixture,
  responseEvents,
} from "./runtime-tool-continuation.test-support.ts";
import {
  createDeliveryToolRuntime,
  StoreBackedDeliveryAccess,
} from "./delivery-tool-runtime.ts";

test("F01-R01/R03/R04/R05/R06: real XLSX persists across a streamed Worker crash and fresh tool runtime; no duplicate delivery", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-worker-delivery-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const storeConfig = {
    databasePath: join(directory, "artifacts.sqlite.delivery.sqlite"),
    encryptionKey: new Uint8Array(32).fill(19),
  };
  let vault = new SqliteDeliveryStore(storeConfig);
  context.after(() => vault.close());
  const engine = new SpreadsheetEngine();
  let application!: DeliveryApplicationService;
  let materializations = 0;
  const resolutions: ToolExecutionResolution[] = [];
  const options = {
    backend: "sqlite" as const,
    storeResponses: true,
    crashAfterCommit: false,
    crashAfterResolved: true,
    toolName: "delivery_assemble",
    toolInput: "{}",
    modelResponseEvents: (requestNumber: number) => {
      const events = responseEvents(
        requestNumber % 2 === 1,
        1,
        options.toolName,
        options.toolInput,
      );
      return requestNumber <= 2
        ? events
        : JSON.parse(
            JSON.stringify(events)
              .replaceAll("call-1", "patch-call-1")
              .replaceAll("resp-tools", "resp-patch-tools")
              .replaceAll("resp-answer", "resp-patch-answer"),
          );
    },
    afterToolProviderResolved: async (resolution: ToolExecutionResolution) => {
      resolutions.push(resolution);
    },
    toolRuntimeFactory: (store: DomainStore) => {
      if (materializations++ > 0) {
        void vault.close();
        vault = new SqliteDeliveryStore(storeConfig);
      }
      const access = new StoreBackedDeliveryAccess(store, "tenant-1");
      application = new DeliveryApplicationService({
        store: vault,
        engine,
        access,
      });
      return createDeliveryToolRuntime({ application, access });
    },
  };
  const fixture = await createFixture(context, options);
  const run = await fixture.run();
  assert.ok(run);
  const actor = {
    tenantId: run.tenantId,
    spaceId: run.spaceId,
    actorId: run.createdByActorId,
    principalId: run.createdByActorId,
  };
  const templateBytes = new Uint8Array(
    readFileSync(new URL("./fixtures/delivery-template.xlsx", import.meta.url)),
  );
  const template = await application.upload(
    actor,
    run.threadId,
    {
      name: "template.xlsx",
      role: "template",
      mediaType: XLSX_MEDIA_TYPE,
      content: templateBytes,
    },
    "upload-template",
  );
  const first = await application.upload(
    actor,
    run.threadId,
    {
      name: "first.csv",
      role: "data",
      mediaType: "text/csv",
      content: new TextEncoder().encode("id,amount\na,10\nb,20\nc,30\n"),
    },
    "upload-first",
  );
  const second = await application.upload(
    actor,
    run.threadId,
    {
      name: "second.csv",
      role: "data",
      mediaType: "text/csv",
      content: new TextEncoder().encode("id,amount\nd,40\ne,50\nf,60\n"),
    },
    "upload-second",
  );
  const fourth = await application.upload(
    actor,
    run.threadId,
    {
      name: "four-sheets.xlsx",
      role: "data",
      mediaType: XLSX_MEDIA_TYPE,
      content: templateBytes,
    },
    "upload-fourth",
  );
  options.toolInput = JSON.stringify({
    templateInputId: template.inputId,
    name: "complete-report.xlsx",
    sources: [
      {
        inputId: first.inputId,
        sheet: first.inspection.sheets[0]!.name,
        headerRow: 1,
      },
      {
        inputId: second.inputId,
        sheet: second.inspection.sheets[0]!.name,
        headerRow: 1,
      },
      { inputId: fourth.inputId, sheet: "Fourth", headerRow: 1 },
    ],
    targetSheet: "Report",
    startRow: 2,
    columns: [
      { sourceHeader: "id", targetColumn: "A" },
      { sourceHeader: "amount", targetColumn: "B" },
    ],
  });
  const approved = await fixture.worker().wake();
  assert.deepEqual(approved, {
    kind: "retried",
    runId: run.runId,
    code: "tool_approval_auto_approved",
  });
  await fixture.makeDue();
  const stopped = await fixture.worker().wake();
  assert.equal(stopped.kind, "retried", JSON.stringify(stopped));
  const savedBeforeRecovery = (await application.catalog(actor, run.threadId))
    .deliveries;
  assert.equal(
    savedBeforeRecovery.length,
    1,
    JSON.stringify({
      resolutions,
      stopped,
      events: await fixture.events(),
      receipts: await fixture.receipts(),
    }),
  );
  const version = savedBeforeRecovery[0]!;
  assert.equal(version.sourceRunId, run.runId);
  assert.equal(version.validation.writtenRows, 7);
  assert.equal(version.validation.numericTotals.B, 217);
  const written = await application.readVersion(
    actor,
    run.threadId,
    version.versionId,
  );
  assert.equal(
    written.record.contentDigest,
    `sha256:${createHash("sha256").update(written.content).digest("hex")}`,
  );
  assert.deepEqual([...written.content.slice(0, 2)], [0x50, 0x4b]);
  assert.equal(written.content.byteLength, version.byteLength);
  assert.notDeepEqual(written.content, templateBytes);

  await fixture.reopen();
  assert.equal(materializations, 2);
  assert.equal((await fixture.worker().wake()).kind, "completed");
  const afterRecovery = (await application.catalog(actor, run.threadId))
    .deliveries;
  assert.equal(afterRecovery.length, 1);
  assert.equal(afterRecovery[0]?.versionId, version.versionId);
  assert.equal(
    (await application.history(actor, run.threadId, version.deliveryId)).length,
    1,
  );
  assert.deepEqual(
    (await application.readVersion(actor, run.threadId, version.versionId))
      .content,
    written.content,
  );
  const completed = (await fixture.events()).filter(
    (event) => event.type === "tool.completed",
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.data.artifactRef, null);
  const output = JSON.parse(completed[0]!.data.output);
  assert.equal(output.reference.versionId, version.versionId);
  assert.equal(output.reference.availability, "ready");
  assert.equal(output.reference.sourceRunId, run.runId);
  assert.ok(Buffer.byteLength(completed[0]!.data.output) <= 9 * 1024);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[1]?.previous_response_id, "resp-tools");
  assert.deepEqual(fixture.requests[1]?.input, [
    {
      type: "function_call_output",
      call_id: "call-1",
      output: completed[0]!.data.output,
    },
  ]);
  assert.deepEqual(
    (await application.readInput(actor, run.threadId, template.inputId))
      .content,
    templateBytes,
  );
  const rows = await application.page(actor, run.threadId, {
    kind: "version",
    id: version.versionId,
    sheet: "Report",
    startRow: 1,
    limit: 100,
  });
  assert.equal(rows.rows[7]?.[0], "fourth-row");
  assert.equal(rows.rows[9]?.[1], 217);
  assert.equal(rows.rows[9]?.[2], 434);

  // A user edit after the Run completes is attributed to a user and creates a fixed version.
  const manual = await application.patch(
    actor,
    run.threadId,
    {
      deliveryId: version.deliveryId,
      expectedVersionId: version.versionId,
      expectedContentDigest: version.contentDigest,
      patches: [{ sheet: "Report", cell: "D1", value: "User reviewed" }],
    },
    { key: "manual-review", sourceRunId: null },
  );
  await assert.rejects(
    application.patch(
      actor,
      run.threadId,
      {
        deliveryId: version.deliveryId,
        expectedVersionId: version.versionId,
        expectedContentDigest: version.contentDigest,
        patches: [{ sheet: "Report", cell: "A2", value: "stale update" }],
      },
      { key: "stale-edit", sourceRunId: null },
    ),
    /delivery_version_conflict/,
  );
  options.toolName = "delivery_patch";
  options.toolInput = JSON.stringify({
    deliveryId: manual.deliveryId,
    expectedVersionId: manual.versionId,
    expectedContentDigest: manual.contentDigest,
    patches: [
      { sheet: "Report", cell: "A2", value: "Reviewed order" },
      { sheet: "Report", cell: "B2", value: 10, numberFormat: "0.0" },
    ],
  });
  await fixture.nextUserTurn();
  const patchApproval = await fixture.worker().wake();
  assert.equal(patchApproval.kind, "retried", JSON.stringify(patchApproval));
  const patchOutcome = await fixture.worker().wake();
  assert.equal(patchOutcome.kind, "completed", JSON.stringify(patchOutcome));
  const revised = (await application.catalog(actor, run.threadId))
    .deliveries[0]!;
  assert.equal(revised.parentVersionId, manual.versionId);
  assert.notEqual(revised.sourceRunId, null);
  assert.notEqual(revised.sourceRunId, run.runId);
  const revisedPage = await application.page(actor, run.threadId, {
    kind: "version",
    id: revised.versionId,
    sheet: "Report",
    startRow: 1,
    limit: 2,
  });
  assert.equal(revisedPage.rows[0]?.[3], "User reviewed");
  assert.equal(revisedPage.rows[1]?.[0], "Reviewed order");
  assert.equal(
    (await application.history(actor, run.threadId, version.deliveryId)).length,
    3,
  );
  const evidenceDirectory = process.env.CREWON_F01_WORKER_EVIDENCE_DIR;
  if (evidenceDirectory !== undefined) {
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(
      join(evidenceDirectory, "worker-assembled.xlsx"),
      written.content,
    );
    const final = await application.readVersion(
      actor,
      run.threadId,
      revised.versionId,
    );
    writeFileSync(
      join(evidenceDirectory, "worker-revised.xlsx"),
      final.content,
    );
    writeFileSync(
      join(evidenceDirectory, "worker-files.json"),
      JSON.stringify(
        {
          assembled: {
            versionId: version.versionId,
            contentDigest: version.contentDigest,
            byteLength: version.byteLength,
            sourceRunId: version.sourceRunId,
          },
          revised: {
            versionId: revised.versionId,
            contentDigest: revised.contentDigest,
            byteLength: revised.byteLength,
            sourceRunId: revised.sourceRunId,
          },
          expectations: {
            dataRows: 7,
            amountTotal: 217,
            formulaB10: 217,
            formulaC10: 434,
            preservedD1: "User reviewed",
            revisedA2: "Reviewed order",
            revisedB2NumberFormat: "0.0",
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
});
