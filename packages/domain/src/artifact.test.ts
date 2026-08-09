import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactRecord, parseArtifactRecord } from "./artifact.ts";

test("creates an immutable encrypted Tool output Artifact record", () => {
  assert.deepEqual(createArtifactRecord(record()), record());
});

test("rejects provenance, digest, retention and injected-field drift", () => {
  for (const input of [
    { ...record(), contentDigest: `sha256:${"z".repeat(64)}` },
    { ...record(), source: { ...record().source, runId: "run/ambient" } },
    {
      ...record(),
      retention: { kind: "run", expiresAt: "2028-08-09T00:00:00.000Z" },
    },
    { ...record(), bucketPath: "/secret/path" },
  ]) {
    assert.throws(() => parseArtifactRecord(input));
  }
});

test("requires scan evidence for clean or blocked content", () => {
  assert.throws(() =>
    parseArtifactRecord({
      ...record(),
      scan: { status: "clean", scannedAt: null, scanner: null },
    }),
  );
  assert.deepEqual(
    parseArtifactRecord({
      ...record(),
      scan: {
        status: "clean",
        scannedAt: "2026-08-09T00:01:00.000Z",
        scanner: "scanner-1",
      },
    }).scan.status,
    "clean",
  );
});

function record() {
  return {
    schemaVersion: "crewon.artifact.v0" as const,
    artifactId: "artifact-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    ownerActorId: "actor-1",
    kind: "toolOutput" as const,
    mediaType: "text/plain",
    sensitivity: "workspaceSensitive" as const,
    source: {
      kind: "toolOutput" as const,
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      callId: "call-1",
    },
    contentDigest: `sha256:${"a".repeat(64)}`,
    byteLength: 42,
    retention: {
      kind: "run" as const,
      expiresAt: "2026-09-08T00:00:00.000Z",
    },
    encryption: { scheme: "aes256gcm" as const, keyId: "artifact-key-1" },
    scan: { status: "notRequired" as const, scannedAt: null, scanner: null },
    createdAt: "2026-08-09T00:00:00.000Z",
  };
}
