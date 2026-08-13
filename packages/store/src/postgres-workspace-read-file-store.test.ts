import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  canonicalJson,
  type FrozenWorkspaceReadFileDispatch,
  type IdempotencyDescriptor,
  type WorkspaceReadFileResolution,
} from "@crewon/application";
import { Pool } from "pg";

import { PostgresWorkspaceReadFileStore } from "./postgres-workspace-read-file-store.ts";

const url = process.env.CREWON_TEST_POSTGRES_URL;
const locator = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  runId: "run-1",
  stepId: "step-1",
  attemptId: "attempt-1",
  executionId: "execution-filesystem-1",
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
    assert.equal(first.operation.frozen.providerReceiptId, null);
    assert.deepEqual(replay?.operation, first.operation);
  },
);

test(
  "PostgreSQL two pools converge prepare and terminal while rejecting frozen conflict",
  {
    skip:
      url === undefined ? "CREWON_TEST_POSTGRES_URL is not configured" : false,
  },
  async () => {
    const firstPool = new Pool({ connectionString: url, max: 2 });
    const secondPool = new Pool({ connectionString: url, max: 2 });
    const schema = `workspace_read_${randomUUID().replaceAll("-", "")}`;
    const first = new PostgresWorkspaceReadFileStore(firstPool, schema);
    const second = new PostgresWorkspaceReadFileStore(secondPool, schema);
    try {
      await first.initialize();
      const preparations = await Promise.all([
        first.prepareWorkspaceReadFile({
          ...locator,
          idempotency: executeIdempotency,
          frozen: frozen(),
        }),
        second.prepareWorkspaceReadFile({
          ...locator,
          idempotency: executeIdempotency,
          frozen: frozen(),
        }),
      ]);
      assert.deepEqual(preparations.map((value) => value.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.equal(
        (
          await second.prepareWorkspaceReadFile({
            ...locator,
            idempotency: idempotency("same-frozen-new-receipt"),
            frozen: frozen(),
          })
        ).disposition,
        "replayed",
      );
      await assert.rejects(() =>
        second.prepareWorkspaceReadFile({
          ...locator,
          idempotency: idempotency("conflicting-prepare"),
          frozen: conflictingFrozen(),
        }),
      );
      const sharedReceipt = idempotency("shared-receipt-different-execution");
      const firstCollision = executionAuthority("execution-collision-1");
      const secondCollision = executionAuthority("execution-collision-2");
      const receiptCollision = await Promise.allSettled([
        first.prepareWorkspaceReadFile({
          ...firstCollision.locator,
          idempotency: sharedReceipt,
          frozen: firstCollision.frozen,
        }),
        second.prepareWorkspaceReadFile({
          ...secondCollision.locator,
          idempotency: sharedReceipt,
          frozen: secondCollision.frozen,
        }),
      ]);
      assert.deepEqual(receiptCollision.map((value) => value.status).sort(), [
        "fulfilled",
        "rejected",
      ]);
      const fenced = await first.markWorkspaceReadFilePossiblySent({
        ...locator,
        expectedRevision: preparations[0]!.operation.revision,
      });
      const terminals = await Promise.all([
        first.commitWorkspaceReadFileResolution({
          ...locator,
          phase: "execute",
          idempotency: executeIdempotency,
          expectedRevision: fenced.revision,
          resolution: completed(),
        }),
        second.commitWorkspaceReadFileResolution({
          ...locator,
          phase: "execute",
          idempotency: executeIdempotency,
          expectedRevision: fenced.revision,
          resolution: completed(),
        }),
      ]);
      assert.deepEqual(terminals.map((value) => value.disposition).sort(), [
        "committed",
        "replayed",
      ]);
    } finally {
      await firstPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
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
      committed.operation.frozen.providerReceiptId,
      "receipt-read-1",
    );
    await assert.rejects(() =>
      store.commitWorkspaceReadFileResolution({
        ...locator,
        phase: "reconcile",
        idempotency: reconcile,
        expectedRevision: fenced.revision,
        resolution: { ...completed(), providerReceiptId: "receipt-drift" },
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
  return commandFor(locator.executionId);
}
function conflictingFrozen(): FrozenWorkspaceReadFileDispatch {
  const value = {
    ...frozen(),
    actionDigest: `sha256:${"c".repeat(64)}`,
    commandDigest: `sha256:${"0".repeat(64)}`,
  };
  return {
    ...value,
    commandDigest: sha256(
      canonicalJson({
        schemaVersion: "crewon.workspace-read-file-command-digest.v0",
        command: value,
      }),
    ),
  };
}
function executionAuthority(executionId: string) {
  return {
    locator: { ...locator, executionId },
    frozen: commandFor(executionId),
  };
}
function completed(): WorkspaceReadFileResolution {
  const command = frozen();
  const content = "workspace content";
  return {
    status: "completed" as const,
    executionId: locator.executionId,
    actionDigest: command.actionDigest,
    commandDigest: command.commandDigest,
    providerReceiptId: "receipt-read-1",
    result: {
      schemaVersion: "crewon.workspace-file-read-result.v0",
      encoding: "utf8",
      content,
      byteLength: Buffer.byteLength(content),
      outputDigest: sha256(content),
    },
  };
}

function commandFor(executionId: string): FrozenWorkspaceReadFileDispatch {
  const command: FrozenWorkspaceReadFileDispatch = {
    schemaVersion: "crewon.workspace-read-file-command.v0",
    executionId,
    runId: locator.runId,
    stepId: locator.stepId,
    attemptId: locator.attemptId,
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2026-08-15T00:00:00.000Z",
    workspaceBindingId: "workspace-binding-1",
    incarnationId: "incarnation-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    commandDigest: `sha256:${"0".repeat(64)}`,
    relativePathSegments: ["docs", "README.md"],
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    providerReceiptId: null,
  };
  return {
    ...command,
    commandDigest: sha256(
      canonicalJson({
        schemaVersion: "crewon.workspace-read-file-command-digest.v0",
        command,
      }),
    ),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function idempotency(key: string): IdempotencyDescriptor {
  return {
    scope: "workspace-read-file",
    key,
    requestFingerprint: `sha256:${createHash("sha256").update(key).digest("hex")}`,
  };
}
