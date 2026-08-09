import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ArtifactStoreError, type PutArtifactInput } from "@crewon/application";
import { createArtifactRecord } from "@crewon/domain";

import { FilesystemArtifactStore } from "./filesystem-artifact-store.ts";

const encryptionKey = Buffer.alloc(32, 0x2a);

test("encrypts immutable content, survives restart and replays semantic retries", async () => {
  const fixture = createFixture();
  const input = artifactInput();
  const store = fixture.open();
  try {
    assert.deepEqual(await store.put(input), {
      disposition: "created",
      record: input.record,
    });
    assert.deepEqual(await store.get(locator(input)), input.record);
    assert.deepEqual(await store.read(locator(input)), {
      record: input.record,
      content: input.content,
    });

    const encrypted = readFileSync(artifactFile(fixture.rootDirectory));
    assert.equal(encrypted.includes(Buffer.from("raw secret output")), false);
    await store.close();

    const restarted = fixture.open();
    try {
      const replayInput = artifactInput({
        artifactId: "artifact-retry",
        createdAt: "2026-08-09T00:02:00.000Z",
        expiresAt: "2026-09-08T00:02:00.000Z",
      });
      assert.deepEqual(await restarted.put(replayInput), {
        disposition: "replayed",
        record: input.record,
      });
      assert.deepEqual(await restarted.read(locator(input)), {
        record: input.record,
        content: input.content,
      });
    } finally {
      await restarted.close();
    }
  } finally {
    await store.close();
    fixture.cleanup();
  }
});

test("recovers a committed blob whose metadata was left in writing state", async () => {
  const fixture = createFixture();
  const input = artifactInput();
  const store = fixture.open();
  try {
    await store.put(input);
    await store.close();
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("UPDATE artifacts SET state = 'writing' WHERE artifact_id = ?")
      .run(input.record.artifactId);
    database.close();

    const restarted = fixture.open();
    try {
      assert.deepEqual(await restarted.put(input), {
        disposition: "replayed",
        record: input.record,
      });
      assert.deepEqual(await restarted.read(locator(input)), {
        record: input.record,
        content: input.content,
      });
    } finally {
      await restarted.close();
    }
  } finally {
    await store.close();
    fixture.cleanup();
  }
});

test("fails closed on idempotency drift, cross-tenant reads and ciphertext corruption", async () => {
  const fixture = createFixture();
  const input = artifactInput();
  const store = fixture.open();
  try {
    await store.put(input);
    await assert.rejects(
      store.put(
        artifactInput({
          content: new TextEncoder().encode("different content"),
        }),
      ),
      (error) => artifactError(error, "artifact_idempotency_conflict"),
    );
    assert.equal(
      await store.read({
        tenantId: "tenant-other",
        artifactId: input.record.artifactId,
      }),
      null,
    );

    const file = artifactFile(fixture.rootDirectory);
    const encrypted = readFileSync(file);
    encrypted[encrypted.length - 1] ^= 0xff;
    writeFileSync(file, encrypted, { mode: 0o600 });
    await assert.rejects(store.read(locator(input)), (error) =>
      artifactError(error, "artifact_authentication_failed"),
    );
  } finally {
    await store.close();
    fixture.cleanup();
  }
});

function artifactInput(
  overrides: {
    artifactId?: string;
    createdAt?: string;
    expiresAt?: string;
    content?: Uint8Array;
  } = {},
): PutArtifactInput {
  const content =
    overrides.content ?? new TextEncoder().encode("raw secret output");
  const createdAt = overrides.createdAt ?? "2026-08-09T00:00:00.000Z";
  const expiresAt = overrides.expiresAt ?? "2026-09-08T00:00:00.000Z";
  return {
    idempotencyKey: "tool-output-receipt-1",
    content,
    record: createArtifactRecord({
      schemaVersion: "crewon.artifact.v0",
      artifactId: overrides.artifactId ?? "artifact-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      ownerActorId: "actor-1",
      kind: "toolOutput",
      mediaType: "text/plain",
      sensitivity: "workspaceSensitive",
      source: {
        kind: "toolOutput",
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        callId: "call-1",
      },
      contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      byteLength: content.byteLength,
      retention: { kind: "run", expiresAt },
      encryption: { scheme: "aes256gcm", keyId: "artifact-key-1" },
      scan: { status: "notRequired", scannedAt: null, scanner: null },
      createdAt,
    }),
  };
}

function locator(input: PutArtifactInput) {
  return {
    tenantId: input.record.tenantId,
    artifactId: input.record.artifactId,
  };
}

function createFixture() {
  const rootDirectory = mkdtempSync(path.join(tmpdir(), "crewon-artifacts-"));
  const databasePath = path.join(rootDirectory, "metadata.sqlite");
  return {
    rootDirectory,
    databasePath,
    open: () =>
      new FilesystemArtifactStore({
        rootDirectory,
        databasePath,
        encryptionKey,
        keyId: "artifact-key-1",
      }),
    cleanup: () => rmSync(rootDirectory, { recursive: true, force: true }),
  };
}

function artifactFile(rootDirectory: string): string {
  const files = listFiles(path.join(rootDirectory, "blobs"));
  assert.equal(files.length, 1);
  return files[0]!;
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  });
}

function artifactError(error: unknown, code: string): boolean {
  return error instanceof ArtifactStoreError && error.code === code;
}
