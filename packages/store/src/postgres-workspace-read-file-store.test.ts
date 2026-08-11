import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import type {
  FrozenWorkspaceReadFileDispatch,
  IdempotencyDescriptor,
} from "@crewon/application";
import { Pool } from "pg";

import { PostgresWorkspaceReadFileStore } from "./postgres-workspace-read-file-store.ts";

const url = process.env.CREWON_TEST_POSTGRES_URL;
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  valid: {
    filesystemReadCommand: DeviceFilesystemReadCommand;
    filesystemReadEvents: readonly DeviceFilesystemReadEvent[];
  };
};
const command = fixture.valid.filesystemReadCommand;
const terminal = fixture.valid.filesystemReadEvents[1]!;
const locator = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  runId: command.runId,
  stepId: command.stepId,
  attemptId: command.attemptId,
  executionId: command.executionId,
};
const executeIdempotency = idempotency("execute-key");

postgresTest(
  "PostgreSQL freezes and receipt-first replays exact authority",
  async (store) => {
    const first = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    const replay = await store.loadWorkspaceReadFileReceipt({
      tenantId: locator.tenantId,
      spaceId: locator.spaceId,
      phase: "execute",
      idempotency: executeIdempotency,
    });
    assert.equal(first.operation.frozen.reference.receiptId, null);
    assert.deepEqual(replay?.operation, first.operation);
  },
);

postgresTest(
  "PostgreSQL fences possiblySent and revisionally abandons notSent",
  async (store) => {
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    const fenced = await store.markWorkspaceReadFilePossiblySent({
      ...locator,
      expectedRevision: prepared.operation.revision,
    });
    const replay = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    assert.equal(replay.operation.status, "possiblySent");
    const abandoned = await store.abandonWorkspaceReadFileSend({
      ...locator,
      expectedRevision: fenced.revision,
    });
    assert.deepEqual(
      { status: abandoned.status, revision: abandoned.revision },
      { status: "prepared", revision: 3 },
    );
  },
);

postgresTest(
  "PostgreSQL upgrades a null receipt only on exact terminal commit",
  async (store) => {
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    const fenced = await store.markWorkspaceReadFilePossiblySent({
      ...locator,
      expectedRevision: prepared.operation.revision,
    });
    const reconcile = idempotency("reconcile-key");
    await store.prepareWorkspaceReadFileAction({
      ...locator,
      phase: "reconcile",
      idempotency: reconcile,
    });
    const committed = await store.commitWorkspaceReadFileResolution({
      ...locator,
      phase: "reconcile",
      idempotency: reconcile,
      expectedRevision: fenced.revision,
      resolution: completed(),
    });
    assert.equal(
      committed.operation.frozen.reference.receiptId,
      "receipt-read-1",
    );
    await assert.rejects(() =>
      store.commitWorkspaceReadFileResolution({
        ...locator,
        phase: "reconcile",
        idempotency: reconcile,
        expectedRevision: fenced.revision,
        resolution: { ...completed(), receiptId: "receipt-drift" },
      }),
    );
  },
);

function postgresTest(
  name: string,
  run: (store: PostgresWorkspaceReadFileStore) => Promise<void>,
) {
  test(
    name,
    {
      skip:
        url === undefined
          ? "CREWON_TEST_POSTGRES_URL is not configured"
          : false,
    },
    async () => {
      const pool = new Pool({ connectionString: url, max: 2 });
      const schema = `workspace_read_${randomUUID().replaceAll("-", "")}`;
      const store = new PostgresWorkspaceReadFileStore(pool, schema);
      try {
        await store.initialize();
        await run(store);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );
}
function frozen(): FrozenWorkspaceReadFileDispatch {
  return {
    command: structuredClone(command),
    routeIntent: {
      deviceBindingId: "device-binding-1",
      runtimeBindingId: "runtime-binding-1",
    },
    reference: {
      deviceId: command.deviceId,
      executionId: command.executionId,
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.arguments.workspaceIncarnationId,
      deviceBindingId: "device-binding-1",
      runtimeBindingId: "runtime-binding-1",
      actionDigest: command.actionDigest,
      commandDigest: terminal.commandDigest,
      leaseId: command.leaseId,
      leaseEpoch: command.leaseEpoch,
      receiptId: null,
    },
  };
}
function completed() {
  return {
    status: "completed" as const,
    executionId: command.executionId,
    receiptId: "receipt-read-1",
    terminal: structuredClone(terminal) as Extract<
      DeviceFilesystemReadEvent,
      { type: "workspace_read.completed" }
    >,
  };
}
function idempotency(key: string): IdempotencyDescriptor {
  return {
    scope: "workspace-read-file",
    key,
    requestFingerprint: `sha256:${createHash("sha256").update(key).digest("hex")}`,
  };
}
