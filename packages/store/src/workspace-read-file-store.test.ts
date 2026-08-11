import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import type {
  FrozenWorkspaceReadFileDispatch,
  IdempotencyDescriptor,
  WorkspaceReadFileStore,
} from "@crewon/application";
import {
  WorkspaceReadFileApplicationService,
  WorkspaceReadFileDispatchError,
} from "@crewon/application";

import { InMemoryWorkspaceReadFileStore } from "./in-memory-workspace-read-file-store.ts";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkspaceReadFileStore } from "./sqlite-workspace-read-file-store.ts";

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

function conformance(name: string, create: () => WorkspaceReadFileStore) {
  test(`${name}: freezes before send and replays receipt before mutable authority`, async () => {
    const store = create();
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
    assert.equal(first.operation.status, "prepared");
    assert.equal(first.operation.frozen.reference.receiptId, null);
    assert.deepEqual(replay?.operation, first.operation);
  });

  test(`${name}: possiblySent forbids blind execute and null receipt reconciles`, async () => {
    const store = create();
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    const unknown = await store.markWorkspaceReadFilePossiblySent({
      ...locator,
      expectedRevision: prepared.operation.revision,
    });
    const replay = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    assert.equal(unknown.status, "possiblySent");
    assert.equal(replay.operation.status, "possiblySent");
    const reconcileIdempotency = idempotency("reconcile-key");
    const action = await store.prepareWorkspaceReadFileAction({
      ...locator,
      phase: "reconcile",
      idempotency: reconcileIdempotency,
    });
    const committed = await store.commitWorkspaceReadFileResolution({
      ...locator,
      phase: "reconcile",
      idempotency: reconcileIdempotency,
      expectedRevision: action.operation.revision,
      resolution: completed(),
    });
    assert.equal(
      committed.operation.frozen.reference.receiptId,
      "receipt-read-1",
    );
  });

  test(`${name}: exact terminal replays and receipt cannot drift`, async () => {
    const store = create();
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    const fenced = await store.markWorkspaceReadFilePossiblySent({
      ...locator,
      expectedRevision: prepared.operation.revision,
    });
    const committed = await store.commitWorkspaceReadFileResolution({
      ...locator,
      phase: "execute",
      idempotency: executeIdempotency,
      expectedRevision: fenced.revision,
      resolution: completed(),
    });
    const replay = await store.commitWorkspaceReadFileResolution({
      ...locator,
      phase: "execute",
      idempotency: executeIdempotency,
      expectedRevision: fenced.revision,
      resolution: completed(),
    });
    assert.equal(committed.operation.status, "completed");
    assert.equal(replay.disposition, "replayed");
    await assert.rejects(() =>
      store.commitWorkspaceReadFileResolution({
        ...locator,
        phase: "execute",
        idempotency: executeIdempotency,
        expectedRevision: fenced.revision,
        resolution: { ...completed(), receiptId: "receipt-drift" },
      }),
    );
  });

  test(`${name}: notSent abandon is a revisioned prepared transition`, async () => {
    const store = create();
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    const fenced = await store.markWorkspaceReadFilePossiblySent({
      ...locator,
      expectedRevision: prepared.operation.revision,
    });
    const abandoned = await store.abandonWorkspaceReadFileSend({
      ...locator,
      expectedRevision: fenced.revision,
    });
    assert.deepEqual(
      { status: abandoned.status, revision: abandoned.revision },
      { status: "prepared", revision: 3 },
    );
  });

  test(`${name}: exact locator and revision fence every mutation`, async () => {
    const store = create();
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    const wrong = { ...locator, runId: "run-drift" };
    await assert.rejects(() =>
      store.prepareWorkspaceReadFileAction({
        ...wrong,
        phase: "reconcile",
        idempotency: idempotency("wrong-action"),
      }),
    );
    await assert.rejects(() =>
      store.markWorkspaceReadFilePossiblySent({
        ...wrong,
        expectedRevision: prepared.operation.revision,
      }),
    );
    await assert.rejects(() =>
      store.commitWorkspaceReadFileResolution({
        ...locator,
        phase: "execute",
        idempotency: executeIdempotency,
        expectedRevision: prepared.operation.revision,
        resolution: completed(),
      }),
    );
    const action = await store.prepareWorkspaceReadFileAction({
      ...locator,
      phase: "reconcile",
      idempotency: idempotency("wrong-action"),
    });
    assert.equal(action.disposition, "committed");
  });

  test(`${name}: rejects unbounded or noncanonical idempotency`, async () => {
    await assert.rejects(() =>
      create().loadWorkspaceReadFileReceipt({
        tenantId: locator.tenantId,
        spaceId: locator.spaceId,
        phase: "execute",
        idempotency: {
          scope: "x".repeat(129),
          key: "key",
          requestFingerprint: "not-a-digest",
        },
      }),
    );
  });
}

conformance(
  "in-memory workspace read authority",
  () => new InMemoryWorkspaceReadFileStore(),
);
conformance(
  "SQLite workspace read authority",
  () => new SqliteWorkspaceReadFileStore(new DatabaseSync(":memory:")),
);

test("SQLite fails closed when persisted terminal correlation drifts", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new SqliteWorkspaceReadFileStore(database);
  const prepared = await store.prepareWorkspaceReadFile({
    ...locator,
    idempotency: executeIdempotency,
    frozen: frozen(),
  });
  const fenced = await store.markWorkspaceReadFilePossiblySent({
    ...locator,
    expectedRevision: prepared.operation.revision,
  });
  await store.commitWorkspaceReadFileResolution({
    ...locator,
    phase: "execute",
    idempotency: executeIdempotency,
    expectedRevision: fenced.revision,
    resolution: completed(),
  });
  database
    .prepare(
      `UPDATE workspace_read_file_operations
      SET record_json = json_set(record_json, '$.resolution.executionId', 'execution-drift')`,
    )
    .run();
  await assert.rejects(() =>
    store.loadWorkspaceReadFileReceipt({
      tenantId: locator.tenantId,
      spaceId: locator.spaceId,
      phase: "execute",
      idempotency: executeIdempotency,
    }),
  );
});

test("owned SQLite authority reopens a possiblySent receipt after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-read-"));
  const path = join(directory, "authority.sqlite3");
  try {
    const first = SqliteWorkspaceReadFileStore.open(path);
    const prepared = await first.prepareWorkspaceReadFile({
      ...locator,
      idempotency: executeIdempotency,
      frozen: frozen(),
    });
    await first.markWorkspaceReadFilePossiblySent({
      ...locator,
      expectedRevision: prepared.operation.revision,
    });
    await first.close();
    await first.close();

    const reopened = SqliteWorkspaceReadFileStore.open(path);
    const receipt = await reopened.loadWorkspaceReadFileReceipt({
      tenantId: locator.tenantId,
      spaceId: locator.spaceId,
      phase: "execute",
      idempotency: executeIdempotency,
    });
    assert.equal(receipt?.operation.status, "possiblySent");
    await reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("execute fences before network and a crash replay performs zero dispatch", async () => {
  const store = new InMemoryWorkspaceReadFileStore();
  const prepared = await store.prepareWorkspaceReadFile({
    ...locator,
    idempotency: executeIdempotency,
    frozen: frozen(),
  });
  await store.markWorkspaceReadFilePossiblySent({
    ...locator,
    expectedRevision: prepared.operation.revision,
  });
  let dispatches = 0;
  let authorityReads = 0;
  const service = serviceOf(store, async () => {
    dispatches += 1;
    return completed();
  });
  const replay = await service.executeWithAuthority(
    {
      ...locator,
      idempotency: executeIdempotency,
      relativePathSegments: ["docs", "README.md"],
    },
    {
      async resolve() {
        authorityReads += 1;
        return executeIntent();
      },
    },
    new AbortController().signal,
  );
  assert.equal(replay.operation.status, "possiblySent");
  assert.equal(dispatches, 0);
  assert.equal(authorityReads, 0);
});

test("notSent reopens execute while possiblySent remains fenced", async () => {
  const store = new InMemoryWorkspaceReadFileStore();
  let dispatches = 0;
  const notSent = serviceOf(store, async () => {
    dispatches += 1;
    throw Object.assign(new Error("before write"), { certainty: "notSent" });
  });
  await assert.rejects(
    () => notSent.execute(executeIntent(), new AbortController().signal),
    WorkspaceReadFileDispatchError,
  );
  const receipt = await store.loadWorkspaceReadFileReceipt({
    tenantId: locator.tenantId,
    spaceId: locator.spaceId,
    phase: "execute",
    idempotency: executeIdempotency,
  });
  assert.deepEqual(
    {
      status: receipt?.operation.status,
      revision: receipt?.operation.revision,
    },
    { status: "prepared", revision: 3 },
  );

  const possiblySent = serviceOf(store, async () => {
    dispatches += 1;
    throw Object.assign(new Error("after write"), {
      certainty: "possiblySent",
    });
  });
  await assert.rejects(
    () => possiblySent.execute(executeIntent(), new AbortController().signal),
    WorkspaceReadFileDispatchError,
  );
  const fenced = await possiblySent.execute(
    executeIntent(),
    new AbortController().signal,
  );
  assert.equal(fenced.operation.status, "possiblySent");
  assert.equal(dispatches, 2);
});

test("reconcile and cancel remain passive across a cancel race", async () => {
  const store = new InMemoryWorkspaceReadFileStore();
  const prepared = await store.prepareWorkspaceReadFile({
    ...locator,
    idempotency: executeIdempotency,
    frozen: frozen(),
  });
  await store.markWorkspaceReadFilePossiblySent({
    ...locator,
    expectedRevision: prepared.operation.revision,
  });
  let executes = 0;
  let cancels = 0;
  const service = new WorkspaceReadFileApplicationService({
    store,
    commands: {
      async create() {
        throw new Error("must not resolve current binding");
      },
    },
    gateway: {
      async execute() {
        executes += 1;
        return completed();
      },
      async reconcile() {
        return completed();
      },
      async cancel() {
        cancels += 1;
        if (cancels === 1)
          throw Object.assign(new Error("cancel race"), {
            certainty: "possiblySent",
          });
        return completed();
      },
    },
  });
  const intent = { ...locator, idempotency: idempotency("cancel-key") };
  await assert.rejects(
    () => service.cancel(intent, new AbortController().signal),
    WorkspaceReadFileDispatchError,
  );
  const committed = await service.cancel(intent, new AbortController().signal);
  assert.equal(committed.operation.status, "completed");
  assert.deepEqual({ executes, cancels }, { executes: 0, cancels: 2 });
});

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
    requestFingerprint: `sha256:${"a".repeat(64)}`,
  };
}
function executeIntent() {
  return {
    ...locator,
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    leaseId: command.leaseId,
    leaseEpoch: command.leaseEpoch,
    expiresAt: command.expiresAt,
    idempotency: executeIdempotency,
    relativePathSegments: ["docs", "README.md"],
  };
}
function serviceOf(
  store: WorkspaceReadFileStore,
  execute: () => Promise<ReturnType<typeof completed>>,
) {
  return new WorkspaceReadFileApplicationService({
    store,
    commands: {
      async create() {
        return frozen();
      },
    },
    gateway: {
      execute,
      async reconcile() {
        return completed();
      },
      async cancel() {
        return completed();
      },
    },
  });
}
