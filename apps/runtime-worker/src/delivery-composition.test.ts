import assert from "node:assert/strict";
import test from "node:test";
import { SpreadsheetEngine } from "@crewon/artifacts";
import {
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
} from "@crewon/domain";
import { SqliteDeliveryStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import {
  withDeliveryToolRuntime,
  type DeliveryDownloadImporter,
} from "./delivery-composition.ts";

test("F01/F05 adapter: browser download bytes use the same delivery vault and verified Run identity", async (context) => {
  const tenantId = "tenant-1";
  const spaceId = "space-1";
  const threadId = "thread-1";
  const createdByActorId = "owner-1";
  const event = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: "run-1" },
    eventId: "create-run",
    sequence: 1,
    occurredAt: "2026-09-14T00:00:00Z",
  };
  const created = reduceRunLifecycleEvent(null, {
    ...event,
    type: "run.created",
    data: {
      tenantId,
      spaceId,
      threadId,
      createdByActorId,
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
      agentVersionId: "version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: null,
    },
  });
  let run = reduceRunLifecycleEvent(created, {
    ...event,
    sequence: 2,
    eventId: "start-run",
    type: "run.started",
    data: {},
  });
  const thread = reduceThreadLifecycleEvent(null, {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId },
    eventId: "create-thread",
    sequence: 1,
    occurredAt: event.occurredAt,
    type: "thread.created",
    data: { tenantId, spaceId, createdByActorId, title: null },
  });
  const vault = new SqliteDeliveryStore({
    databasePath: ":memory:",
    encryptionKey: new Uint8Array(32).fill(11),
  });
  context.after(() => vault.close());
  let importer!: DeliveryDownloadImporter;
  const runtime = withDeliveryToolRuntime({
    runtime: new InMemoryToolBroker(),
    catalog: "enabled",
    delivery: { store: vault, engine: new SpreadsheetEngine() },
    tenantId,
    store: { loadRun: async () => run, loadThreadInSpace: async () => thread },
    configureDownloads: (value) => {
      importer = value;
    },
  });
  assert.ok(
    runtime
      .definitions()
      .some((definition) => definition.name === "delivery_catalog"),
  );
  const input = {
    runId: run.runId,
    executionId: "download-1",
    name: "browser.csv",
    mediaType: "text/csv",
    content: new TextEncoder().encode("id,amount\norder-1,12\n"),
  };
  const imported = await importer(input);
  const repeated = await importer(input);
  assert.equal(imported.inputId, repeated.inputId);
  assert.equal(imported.sourceRunId, run.runId);
  assert.equal(imported.target.threadId, threadId);
  assert.equal(imported.ownerActorId, createdByActorId);
  const scope = { target: imported.target, ownerActorId: createdByActorId };
  assert.deepEqual(
    (await vault.getInput(scope, imported.inputId))?.content,
    input.content,
  );
  assert.equal((await vault.catalog(scope)).inputs.length, 1);
  assert.equal((await vault.catalog(scope)).deliveries.length, 0);
  await assert.rejects(
    importer({ ...input, mediaType: "application/pdf" }),
    /delivery_input_type_invalid/,
  );
  await assert.rejects(
    importer({ ...input, runId: "forged-run" }),
    /delivery_run_access_denied/,
  );
  await assert.rejects(
    importer({ ...input, executionId: "../host-path" }),
    /delivery_id_invalid/,
  );
  await assert.rejects(
    importer({ ...input, content: new TextEncoder().encode("changed") }),
    /delivery_idempotency_conflict/,
  );
  run = { ...run, status: "completed" };
  await assert.rejects(
    importer({ ...input, executionId: "download-2" }),
    /delivery_run_access_denied/,
  );
});

test("F01/F05 adapter: disabled delivery never installs a download importer", () => {
  withDeliveryToolRuntime({
    runtime: new InMemoryToolBroker(),
    catalog: "disabled",
    delivery: undefined,
    tenantId: "tenant-1",
    store: {
      loadRun: async () => null,
      loadThreadInSpace: async () => null,
    },
    configureDownloads: () =>
      assert.fail("disabled delivery installed importer"),
  });
});
