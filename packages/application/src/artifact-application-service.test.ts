import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactRecord, type ArtifactRecord } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import { ArtifactApplicationService } from "./artifact-application-service.ts";
import type {
  ArtifactContent,
  ArtifactLocator,
  ArtifactStorePort,
  PutArtifactInput,
} from "./artifact-store-port.ts";
import type { AuthorizationPort } from "./authorization-port.ts";

test("persists one digest-bound Tool output and replays its idempotency key", async () => {
  const store = new MemoryArtifacts();
  const service = artifactService(store);
  const first = await service.persistToolOutput(toolOutput());
  const replay = await service.persistToolOutput(toolOutput());

  assert.deepEqual(replay, first);
  assert.equal(first.contentDigest, sha256A);
  assert.deepEqual(first.source, {
    kind: "toolOutput",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    callId: "call-1",
  });
  assert.equal(store.putCount, 2);
});

test("authorizes scoped metadata/content and hides cross-space Artifacts", async () => {
  const store = new MemoryArtifacts();
  const service = artifactService(store);
  const artifact = await service.persistToolOutput(toolOutput());
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };

  assert.deepEqual(
    await service.getArtifact(actor, artifact.artifactId),
    artifact,
  );
  assert.equal(store.readCount, 0);
  assert.equal(
    new TextDecoder().decode(
      (await service.readArtifact(actor, artifact.artifactId)).content,
    ),
    "raw output",
  );
  await assert.rejects(
    service.getArtifact({ ...actor, spaceId: "space-2" }, artifact.artifactId),
  );
});

test("never reads content before scope, authorization, expiry, and blocked checks", async () => {
  const store = new MemoryArtifacts();
  const service = artifactService(store);
  const artifact = await service.persistToolOutput(toolOutput());
  const actor = artifactActor();

  await assert.rejects(
    service.readArtifact({ ...actor, spaceId: "space-2" }, artifact.artifactId),
    applicationError("notFound", "artifact_not_found"),
  );
  assert.equal(store.readCount, 0);

  const denied = artifactService(store, {
    authorization: {
      authorize: async () => ({
        outcome: "deny",
        reasonCode: "artifact_read_forbidden",
      }),
    },
  });
  await assert.rejects(
    denied.readArtifact(actor, artifact.artifactId),
    applicationError("authorization", "artifact_read_forbidden"),
  );
  assert.equal(store.readCount, 0);

  const expired = artifactService(store, {
    clock: { now: () => "2026-10-01T00:00:00.000Z" },
  });
  await assert.rejects(
    expired.readArtifact(actor, artifact.artifactId),
    applicationError("notFound", "artifact_expired"),
  );
  assert.equal(store.readCount, 0);

  const content = new TextEncoder().encode("raw output");
  const blocked = createArtifactRecord({
    ...recordForBlockedArtifact(),
    byteLength: content.byteLength,
  });
  await store.put({
    record: blocked,
    content,
    idempotencyKey: "blocked-artifact-no-read",
  });
  await assert.rejects(
    service.readArtifact(actor, blocked.artifactId),
    applicationError("notFound", "artifact_not_found"),
  );
  assert.equal(store.readCount, 0);
});

test("fails closed when authorized content is absent or its authority drifts", async () => {
  const store = new MemoryArtifacts();
  const service = artifactService(store);
  const artifact = await service.persistToolOutput(toolOutput());

  store.readOverride = () => null;
  await assert.rejects(
    service.readArtifact(artifactActor(), artifact.artifactId),
    applicationError("internal", "artifact_store_result_invalid"),
  );

  store.readOverride = (stored) => ({
    ...stored,
    record: {
      ...stored.record,
      source: { ...stored.record.source, callId: "call-drifted" },
    },
  });
  await assert.rejects(
    service.readArtifact(artifactActor(), artifact.artifactId),
    applicationError("internal", "artifact_store_result_invalid"),
  );
});

test("fails closed when authorized content length or digest does not match metadata", async () => {
  const store = new MemoryArtifacts();
  const service = artifactService(store);
  const artifact = await service.persistToolOutput(toolOutput());

  store.readOverride = (stored) => ({
    ...stored,
    content: new TextEncoder().encode("short"),
  });
  await assert.rejects(
    service.readArtifact(artifactActor(), artifact.artifactId),
    applicationError("internal", "artifact_store_result_invalid"),
  );

  store.readOverride = (stored) => ({
    ...stored,
    content: new TextEncoder().encode("bad output"),
  });
  await assert.rejects(
    service.readArtifact(artifactActor(), artifact.artifactId),
    applicationError("internal", "artifact_store_result_invalid"),
  );
});

test("rejects forged Artifact provenance and oversized raw output", async () => {
  const store = new MemoryArtifacts();
  const service = artifactService(store);
  const artifact = await service.persistToolOutput(toolOutput());
  await assert.rejects(
    service.requireToolOutputReference({
      tenantId: "tenant-1",
      spaceId: "space-1",
      ownerActorId: "actor-1",
      artifactId: artifact.artifactId,
      runId: "run-1",
      stepId: "step-forged",
      attemptId: "attempt-1",
      callId: "call-1",
      verification: "content",
      output: "raw output",
    }),
  );
  await assert.rejects(
    service.requireToolOutputReference({
      tenantId: "tenant-1",
      spaceId: "space-forged",
      ownerActorId: "actor-1",
      artifactId: artifact.artifactId,
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      callId: "call-1",
      verification: "provenance",
    }),
  );
  await assert.rejects(
    service.requireToolOutputReference({
      tenantId: "tenant-1",
      spaceId: "space-1",
      ownerActorId: "actor-1",
      artifactId: artifact.artifactId,
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      callId: "call-1",
      verification: "content",
      output: "forged output",
    }),
  );
  await assert.rejects(
    service.persistToolOutput({
      ...toolOutput(),
      output: "too large",
      maxArtifactBytes: 2,
    }),
  );
});

test("allows blocked metadata but refuses blocked content and model references", async () => {
  const store = new MemoryArtifacts();
  const service = artifactService(store);
  const content = new TextEncoder().encode("raw output");
  const blocked = createArtifactRecord({
    ...recordForBlockedArtifact(),
    byteLength: content.byteLength,
  });
  await store.put({
    record: blocked,
    content,
    idempotencyKey: "blocked-artifact-1",
  });
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };

  assert.equal(
    (await service.getArtifact(actor, blocked.artifactId)).scan.status,
    "blocked",
  );
  await assert.rejects(service.readArtifact(actor, blocked.artifactId));
  await assert.rejects(
    service.requireToolOutputReference({
      tenantId: "tenant-1",
      spaceId: "space-1",
      ownerActorId: "actor-1",
      artifactId: blocked.artifactId,
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      callId: "call-1",
      verification: "content",
      output: "raw output",
    }),
  );
});

test("uses the injected clock to hide expired Artifacts", async () => {
  const store = new MemoryArtifacts();
  let now = "2026-08-09T00:00:00.000Z";
  const service = artifactService(store, { clock: { now: () => now } });
  const artifact = await service.persistToolOutput(toolOutput());
  now = "2026-10-01T00:00:00.000Z";

  await assert.rejects(
    service.getArtifact(
      {
        principalId: "principal-1",
        actorId: "actor-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
      },
      artifact.artifactId,
    ),
    (error) => error instanceof Error && error.message === "artifact_expired",
  );
});

const sha256A = `sha256:${"a".repeat(64)}`;
const sha256B = `sha256:${"b".repeat(64)}`;

function artifactService(
  store: ArtifactStorePort,
  config: {
    clock?: { now(): string };
    authorization?: AuthorizationPort;
  } = {},
) {
  let ids = 0;
  return new ArtifactApplicationService({
    store,
    authorization:
      config.authorization ??
      ({ authorize: async () => ({ outcome: "allow" }) } as const),
    clock: config.clock ?? { now: () => "2026-08-09T00:00:00.000Z" },
    ids: { nextId: () => `artifact-${++ids}` },
    digester: {
      sha256: (value) => (value === "raw output" ? sha256A : sha256B),
    },
    encryptionKeyId: "artifact-key-1",
  });
}

function artifactActor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

function applicationError(category: string, code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}

function toolOutput() {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    ownerActorId: "actor-1",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    callId: "call-1",
    output: "raw output",
    idempotencyKey: "tool-output-1",
    maxArtifactBytes: 1024,
  };
}

function recordForBlockedArtifact(): ArtifactRecord {
  return {
    schemaVersion: "crewon.artifact.v0",
    artifactId: "artifact-blocked",
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
    contentDigest: sha256A,
    byteLength: 10,
    retention: {
      kind: "run",
      expiresAt: "2026-09-08T00:00:00.000Z",
    },
    encryption: { scheme: "aes256gcm", keyId: "artifact-key-1" },
    scan: {
      status: "blocked",
      scannedAt: "2026-08-09T00:01:00.000Z",
      scanner: "scanner-1",
    },
    createdAt: "2026-08-09T00:00:00.000Z",
  };
}

class MemoryArtifacts implements ArtifactStorePort {
  readonly #records = new Map<
    string,
    { record: ArtifactRecord; content: Uint8Array }
  >();
  readonly #idempotency = new Map<string, string>();
  putCount = 0;
  readCount = 0;
  readOverride:
    | ((stored: ArtifactContent) => ArtifactContent | null)
    | undefined;

  async put(input: PutArtifactInput) {
    this.putCount += 1;
    const priorId = this.#idempotency.get(input.idempotencyKey);
    if (priorId !== undefined) {
      return {
        disposition: "replayed" as const,
        record: structuredClone(this.#records.get(priorId)!.record),
      };
    }
    this.#idempotency.set(input.idempotencyKey, input.record.artifactId);
    this.#records.set(input.record.artifactId, {
      record: structuredClone(input.record),
      content: new Uint8Array(input.content),
    });
    return { disposition: "created" as const, record: input.record };
  }

  async get(locator: ArtifactLocator) {
    const stored = this.#records.get(locator.artifactId);
    return stored?.record.tenantId === locator.tenantId
      ? structuredClone(stored.record)
      : null;
  }

  async read(locator: ArtifactLocator) {
    const stored = this.#records.get(locator.artifactId);
    this.readCount += 1;
    if (stored?.record.tenantId !== locator.tenantId) {
      return null;
    }
    const result = {
      record: structuredClone(stored.record),
      content: new Uint8Array(stored.content),
    };
    return this.readOverride === undefined ? result : this.readOverride(result);
  }

  async close() {}
}
