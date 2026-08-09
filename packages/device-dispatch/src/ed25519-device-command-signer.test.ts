import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  canonicalDeviceCommandSigningPayload,
  type DeviceExecutionCommand,
} from "@crewon/contracts";

import { Ed25519DeviceCommandSigner } from "./ed25519-device-command-signer.ts";

test("signs the exact Device command with a lease-bounded Ed25519 envelope", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: keys.privateKey,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
    authorizationTtlMs: 60_000,
  });

  const signed = await signer.sign({ command: draft(), approvalProof: null });
  assert.deepEqual(signed.authorization, {
    schemaVersion: "crewon.device-authorization.v0",
    scheme: "ed25519",
    keyId: "control-key-1",
    issuedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-09T00:01:00.000Z",
    approvalProof: null,
    signature: signed.authorization.signature,
  });
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalDeviceCommandSigningPayload(signed), "utf8"),
      keys.publicKey,
      Buffer.from(signed.authorization.signature, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(
        canonicalDeviceCommandSigningPayload({
          ...signed,
          leaseEpoch: signed.leaseEpoch + 1,
        }),
        "utf8",
      ),
      keys.publicKey,
      Buffer.from(signed.authorization.signature, "base64url"),
    ),
    false,
  );
});

test("rejects non-Ed25519 keys and an expired durable lease", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      new Ed25519DeviceCommandSigner({
        keyId: "control-key-1",
        privateKey: rsa.privateKey,
      }),
    hasCode("device_signing_key_invalid"),
  );
  const keys = generateKeyPairSync("ed25519");
  const signer = new Ed25519DeviceCommandSigner({
    keyId: "control-key-1",
    privateKey: keys.privateKey,
    now: () => new Date("2026-08-09T00:11:00.000Z"),
  });
  await assert.rejects(
    signer.sign({ command: draft(), approvalProof: null }),
    hasCode("device_signing_lease_expired"),
  );
});

function draft(): Omit<DeviceExecutionCommand, "authorization"> {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2026-08-09T00:10:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: `sha256:${"a".repeat(64)}`,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: `device:${"a".repeat(64)}`,
    traceContext: { traceparent: null, tracestate: null },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
