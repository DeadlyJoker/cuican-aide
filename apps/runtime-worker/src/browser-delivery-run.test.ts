import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DomainStore } from "@crewon/application";
import { SpreadsheetEngine } from "@crewon/artifacts";
import {
  BROWSER_ACT_TOOL_NAME,
  BROWSER_MAX_ARTIFACT_BYTES,
  BROWSER_MAX_OUTPUT_BYTES,
  parseBrowserActInput,
} from "@crewon/contracts";
import type { DeliveryInputRecord } from "@crewon/domain";
import { SqliteDeliveryStore } from "@crewon/store";
import {
  validateToolExecutionCommand,
  type ToolExecutionCommand,
  type ToolExecutionResolution,
} from "@crewon/tool-broker";
import { BrowserExecutionReceipts } from "../../crewon-ui/electron/browserExecutionReceipts.ts";
import { startBrowserExecutionTransport } from "../../crewon-ui/electron/browserExecutionTransport.ts";
import { BrowserExecutionToolRuntime } from "./browser-execution-tool-runtime.ts";
import { withDeliveryToolRuntime } from "./delivery-composition.ts";
import {
  createFixture,
  responseEvents,
} from "./runtime-tool-continuation.test-support.ts";

// The model speaks scripted Responses SSE and the browser endpoint is a controlled
// fixture. Worker leases, approvals, HTTP transport, receipts and F01 storage are real.
test("F05/F01: streamed Run imports a 10 MiB browser CSV and resumes through authenticated receipts without another click or import", async (context) => {
  // Match the existing Run fixture's storage clock without rewriting its leases.
  context.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-08-08T01:00:00Z"),
  });
  const directory = mkdtempSync(join(tmpdir(), "crewon-browser-delivery-run-"));
  const content = csvAtArtifactLimit();
  const contentDigest = digest(content);
  const downloadReceipt = {
    receiptId: "fixture-download-receipt",
    name: "browser-report.csv",
    mediaType: "text/csv",
    sizeBytes: content.byteLength,
    sha256: contentDigest,
  };
  const toolInput = JSON.stringify({
    sessionId: "fixture-browser-session",
    generation: 0,
    observationId: "fixture-browser-observation",
    action: "download",
    target: { targetId: "fixture-download-button" },
  });
  const hostCommands: { operation: string; command: ToolExecutionCommand }[] =
    [];
  const hostFailures: unknown[] = [];
  const imported: DeliveryInputRecord[] = [];
  const importKeys: string[] = [];
  let clicks = 0;
  let materializations = 0;
  let authority!: DomainStore;
  let receipts = new BrowserExecutionReceipts(join(directory, "receipts"));
  class ObservedDeliveryStore extends SqliteDeliveryStore {
    override async putInput(
      input: Parameters<SqliteDeliveryStore["putInput"]>[0],
    ) {
      importKeys.push(input.key);
      return super.putInput(input);
    }
  }
  const vaultConfig = {
    databasePath: join(directory, "delivery.sqlite"),
    encryptionKey: new Uint8Array(32).fill(29),
  };
  let vault = new ObservedDeliveryStore(vaultConfig);

  async function verifyCommand(
    operation: string,
    command: ToolExecutionCommand,
  ) {
    try {
      validateToolExecutionCommand(command);
      assert.deepEqual(
        parseBrowserActInput(JSON.parse(command.input)),
        JSON.parse(toolInput),
      );
      assert.equal(command.name, BROWSER_ACT_TOOL_NAME);
      assert.equal(command.actionIntent.approvalRequirement, "perAction");
      assert.ok(command.approvalProof);
      assert.equal(command.approvalProof.actionDigest, command.actionDigest);
      const run = await authority.loadRun({
        tenantId: "tenant-1",
        runId: command.runId,
      });
      assert.ok(run);
      assert.ok(run.status === "running" || run.status === "reconciling");
      assert.equal(run.cancelRequested, false);
      const receipt = await authority.loadToolExecutionReceiptByAction({
        tenantId: run.tenantId,
        runId: run.runId,
        actionDigest: command.actionDigest,
      });
      assert.ok(
        receipt,
        "bridge commands must originate in the durable Tool journal",
      );
      assert.equal(receipt.executionId, command.executionId);
      assert.equal(receipt.call.callId, command.callId);
      assert.deepEqual(receipt.actionIntent, command.actionIntent);
      const attempt = await authority.loadRunAttempt({
        tenantId: run.tenantId,
        runId: run.runId,
        stepId: command.executionLease.stepId,
        attemptId: command.executionLease.attemptId,
      });
      assert.ok(
        attempt,
        "each bridge operation must carry a real claimed Run attempt",
      );
      // Receipt attempt identity is stable; a retry claims a fresh queue lease.
      assert.equal(attempt.attemptId, receipt.attemptId);
      assert.equal(attempt.workItemId, command.executionLease.workItemId);
      const attempts = await authority.listRunAttempts(
        { tenantId: run.tenantId, runId: run.runId, stepId: receipt.stepId },
        0,
        100,
      );
      assert.ok(
        attempts.some(
          (candidate) =>
            candidate.status === "running" &&
            candidate.leaseEpoch === command.executionLease.leaseEpoch,
        ),
      );
      assert.ok(Date.parse(command.executionLease.expiresAt) > Date.now());
      hostCommands.push({ operation, command: structuredClone(command) });
    } catch (error) {
      hostFailures.push(error);
      throw error;
    }
  }

  const bridge = await startBrowserExecutionTransport({
    async execute(command) {
      await verifyCommand("execute", command);
      const identity = {
        executionId: command.executionId,
        actionDigest: command.actionDigest,
        runId: command.runId,
      };
      const started = receipts.begin(identity);
      if (!started.created) {
        assert.ok(started.resolution);
        return started.resolution;
      }
      clicks++;
      const resolution: ToolExecutionResolution = {
        status: "completed",
        executionId: command.executionId,
        providerReceiptId: downloadReceipt.receiptId,
        result: {
          schemaVersion: "crewon.tool-result.v0",
          callId: command.callId,
          output: JSON.stringify({ downloadReceipt }),
          isError: false,
          artifactRef: null,
        },
      };
      receipts.complete(identity, resolution);
      return resolution;
    },
    async reconcile(command) {
      await verifyCommand("reconcile", command);
      const resolution = receipts.read(
        command.executionId,
        command.actionDigest,
        command.runId,
      );
      assert.ok(resolution, "recovery reads the persisted host result");
      return resolution;
    },
    async cancel(command) {
      hostCommands.push({ operation: "cancel", command });
      return {
        status: "canceled",
        executionId: command.executionId,
        providerReceiptId: null,
      };
    },
    async download(command, receiptId) {
      await verifyCommand("download", command);
      assert.equal(receiptId, downloadReceipt.receiptId);
      assert.equal(
        receipts.read(command.executionId, command.actionDigest, command.runId)
          ?.status,
        "completed",
      );
      return content;
    },
  });
  context.after(async () => {
    await bridge.close();
    await vault.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // Authentication rejection happens on the same live server used by the Worker.
  const denied = await fetch(`${bridge.url}/v1/browser/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 401);
  await denied.body?.cancel();
  assert.equal(hostCommands.length, 0);

  const fixture = await createFixture(context, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    crashAfterResolved: true,
    modelResponseEvents: (requestNumber) => {
      if (requestNumber === 1)
        return responseEvents(true, 1, BROWSER_ACT_TOOL_NAME, toolInput);
      if (requestNumber === 2) {
        return JSON.parse(
          JSON.stringify(
            responseEvents(
              true,
              1,
              "delivery_catalog",
              '{"kind":"inputs","offset":0,"limit":100}',
            ),
          )
            .replaceAll("call-1", "catalog-call-1")
            .replaceAll("resp-tools", "resp-catalog"),
        );
      }
      return responseEvents(false);
    },
    toolRuntimeFactory: (store) => {
      authority = store;
      if (materializations++ > 0)
        vault = new ObservedDeliveryStore(vaultConfig);
      const browser = new BrowserExecutionToolRuntime(bridge);
      return withDeliveryToolRuntime({
        runtime: browser,
        catalog: "enabled",
        delivery: { store: vault, engine: new SpreadsheetEngine() },
        store,
        tenantId: "tenant-1",
        configureDownloads: (importer) =>
          browser.setDownloadImporter(async (input) => {
            const record = await importer(input);
            imported.push(record);
            return record;
          }),
      });
    },
  });
  const run = await fixture.run();
  assert.ok(run);
  assert.deepEqual(await fixture.worker().wake(), {
    kind: "retried",
    runId: run.runId,
    code: "tool_approval_auto_approved",
  });
  await fixture.makeDue();
  const stopped = await fixture.worker().wake();
  assert.deepEqual(hostFailures, []);
  assert.equal(stopped.kind, "retried", JSON.stringify(stopped));
  assert.equal(
    imported.length,
    1,
    JSON.stringify({ stopped, events: await fixture.events() }),
  );
  const first = imported[0]!;
  const scope = { target: first.target, ownerActorId: first.ownerActorId };
  assert.equal(first.sourceRunId, run.runId);
  assert.equal(first.target.threadId, run.threadId);
  assert.equal(first.byteLength, 10 * 1024 * 1024);
  assert.equal(first.contentDigest, contentDigest);
  assert.equal(first.inspection.sheets.length, 1);
  assert.equal(first.inspection.sheets[0]?.name, "CSV");
  assert.equal(
    (await fixture.events()).filter((event) => event.type === "tool.completed")
      .length,
    0,
  );
  assert.equal((await vault.catalog(scope)).inputs.length, 1);
  const originalCommand = hostCommands.find(
    ({ operation }) => operation === "execute",
  )!.command;
  assert.deepEqual(importKeys, [
    `browser-download:${originalCommand.executionId}`,
  ]);

  await vault.close();
  receipts = new BrowserExecutionReceipts(join(directory, "receipts"));
  await fixture.reopen();
  assert.equal(materializations, 2);
  const resumed = await fixture.worker().wake();
  assert.deepEqual(hostFailures, []);
  assert.equal(
    resumed.kind,
    "completed",
    JSON.stringify({ resumed, events: await fixture.events() }),
  );
  assert.equal(clicks, 1);
  assert.deepEqual(
    hostCommands.map(({ operation }) => operation),
    ["execute", "download", "reconcile", "download"],
  );
  assert.equal(
    imported.length,
    2,
    "recovery calls F01 again with the same operation key",
  );
  assert.equal(imported[1]?.inputId, first.inputId);
  assert.deepEqual(
    importKeys,
    [`browser-download:${originalCommand.executionId}`],
    "F01 deduplicates before a second SQLite putInput",
  );
  for (const { command } of hostCommands) {
    assert.equal(command.executionId, originalCommand.executionId);
    assert.equal(command.actionDigest, originalCommand.actionDigest);
    assert.equal(command.runId, run.runId);
  }
  assert.notEqual(
    hostCommands[2]?.command.executionLease.leaseId,
    originalCommand.executionLease.leaseId,
  );
  assert.ok(
    hostCommands[2]!.command.executionLease.leaseEpoch >
      originalCommand.executionLease.leaseEpoch,
  );
  assert.deepEqual((await vault.catalog(scope)).inputs, [first]);
  const stored = await vault.getInput(scope, first.inputId);
  assert.ok(stored);
  assert.deepEqual(stored.content, content);
  assert.equal(digest(stored.content), contentDigest);
  assert.equal(
    readFileSync(vaultConfig.databasePath).includes(
      Buffer.from("C05_PRIVATE_DOWNLOADED_BYTES"),
    ),
    false,
  );

  const completed = (await fixture.events()).filter(
    (event) => event.type === "tool.completed",
  );
  assert.equal(completed.length, 2);
  const browserOutput = JSON.parse(completed[0]!.data.output);
  assert.deepEqual(browserOutput, {
    status: "completed",
    file: {
      inputId: first.inputId,
      name: first.name,
      mediaType: first.mediaType,
      byteLength: first.byteLength,
      contentDigest,
      sourceRunId: run.runId,
    },
  });
  const catalogOutput = JSON.parse(completed[1]!.data.output);
  assert.equal(catalogOutput.entries.length, 1);
  assert.equal(catalogOutput.entries[0].inputId, first.inputId);
  assert.equal(catalogOutput.entries[0].sourceRunId, run.runId);
  assert.equal(catalogOutput.entries[0].contentDigest, contentDigest);
  assert.equal(fixture.requests.length, 3);
  for (const [index, responseId, callId] of [
    [1, "resp-tools", "call-1"],
    [2, "resp-catalog", "catalog-call-1"],
  ] as const) {
    const output = completed[index - 1]!.data.output;
    assert.ok(Buffer.byteLength(output) <= BROWSER_MAX_OUTPUT_BYTES);
    assert.equal(fixture.requests[index]?.previous_response_id, responseId);
    assert.deepEqual(fixture.requests[index]?.input, [
      { type: "function_call_output", call_id: callId, output },
    ]);
  }
  assert.equal((await fixture.run())?.status, "completed");
});

function csvAtArtifactLimit(): Uint8Array {
  const prefix = "id,amount\nC05_PRIVATE_DOWNLOADED_BYTES,42\n";
  const row = `${"x".repeat(1020)},42\n`;
  const remaining = BROWSER_MAX_ARTIFACT_BYTES - Buffer.byteLength(prefix);
  const tailBytes = remaining % Buffer.byteLength(row);
  assert.ok(tailBytes >= 4);
  const bytes = Buffer.from(
    prefix +
      row.repeat(Math.floor(remaining / row.length)) +
      `${"x".repeat(tailBytes - 4)},42\n`,
  );
  assert.equal(bytes.byteLength, BROWSER_MAX_ARTIFACT_BYTES);
  return new Uint8Array(bytes);
}

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
