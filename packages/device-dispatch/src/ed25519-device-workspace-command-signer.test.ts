import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalDeviceCommandSigningPayload,
  canonicalDeviceWorkspaceListCommandSigningPayload,
  type DeviceExecutionCommand,
  type DeviceWorkspaceListCommand,
} from "@crewon/contracts";

import {
  DeviceWorkspaceListSigningError,
  Ed25519DeviceWorkspaceListCommandSigner,
} from "./ed25519-device-workspace-command-signer.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  signingPayloadSha256: string;
  workspaceSigningPayloadSha256: string;
  valid: Readonly<{
    command: DeviceExecutionCommand;
    workspaceCommand: DeviceWorkspaceListCommand;
  }>;
}>;

test("signs only the exact independent Workspace canonical payload", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = new Ed25519DeviceWorkspaceListCommandSigner({
    keyId: "control-key-1",
    privateKey: keys.privateKey,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
    authorizationTtlMs: 60_000,
  });

  const signed = await signer.sign({ command: draft() });
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
      Buffer.from(
        canonicalDeviceWorkspaceListCommandSigningPayload(signed),
        "utf8",
      ),
      keys.publicKey,
      Buffer.from(signed.authorization.signature, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(
        canonicalDeviceWorkspaceListCommandSigningPayload({
          ...signed,
          runtimeBindingId: "runtime-binding-substituted",
        }),
        "utf8",
      ),
      keys.publicKey,
      Buffer.from(signed.authorization.signature, "base64url"),
    ),
    false,
  );
});

test("preserves both shared TS/Rust canonical fixture hashes", () => {
  assert.equal(
    sha256(canonicalDeviceCommandSigningPayload(fixture.valid.command)),
    fixture.signingPayloadSha256,
  );
  assert.equal(
    sha256(
      canonicalDeviceWorkspaceListCommandSigningPayload(
        fixture.valid.workspaceCommand,
      ),
    ),
    fixture.workspaceSigningPayloadSha256,
  );
});

test("rejects non-Ed25519 keys and expired Workspace leases", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      new Ed25519DeviceWorkspaceListCommandSigner({
        keyId: "control-key-1",
        privateKey: rsa.privateKey,
      }),
    hasCode("device_workspace_signing_key_invalid"),
  );
  const keys = generateKeyPairSync("ed25519");
  const signer = new Ed25519DeviceWorkspaceListCommandSigner({
    keyId: "control-key-1",
    privateKey: keys.privateKey,
    now: () => new Date("2026-08-09T00:10:00.000Z"),
  });
  await assert.rejects(
    signer.sign({ command: draft() }),
    hasCode("device_workspace_signing_lease_expired"),
  );
});

function draft(): Omit<DeviceWorkspaceListCommand, "authorization"> {
  const { authorization: _, ...command } = fixture.valid.workspaceCommand;
  return {
    ...command,
    expiresAt: "2026-08-09T00:10:00.000Z",
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof DeviceWorkspaceListSigningError && error.code === code;
}
