import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  canonicalDeviceWorkspaceListCommandSigningPayload,
  type DeviceWorkspaceListCommand,
} from "@crewon/contracts";

import { command } from "./workspace-dispatch-store-conformance.test-support.ts";
import { Ed25519WorkspaceCommandAuthorizationVerifier } from "./workspace-command-authorization-verifier.ts";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

test("verifies only the independent Workspace command canonical payload", async () => {
  const verifier = new Ed25519WorkspaceCommandAuthorizationVerifier(
    [{ keyId: "control-key-1", publicKeyPem }],
    { now: () => new Date("2026-08-09T00:00:01.000Z") },
  );
  const valid = signedCommand();
  await verifier.verify(valid);
  await assert.rejects(
    verifier.verify({ ...valid, commandDigest: `sha256:${"f".repeat(64)}` }),
    hasCode("device_authorization_signature_invalid"),
  );
});

test("fails expired and invalid-clock Workspace authorization closed", async () => {
  const expired = new Ed25519WorkspaceCommandAuthorizationVerifier(
    [{ keyId: "control-key-1", publicKeyPem }],
    { now: () => new Date("2099-01-01T00:00:00.000Z") },
  );
  await assert.rejects(
    expired.verify(signedCommand()),
    hasCode("device_authorization_expired"),
  );
  const invalidClock = new Ed25519WorkspaceCommandAuthorizationVerifier(
    [{ keyId: "control-key-1", publicKeyPem }],
    { now: () => new Date(Number.NaN) },
  );
  await assert.rejects(
    invalidClock.verify(signedCommand()),
    hasCode("device_authorization_expired"),
  );
});

function signedCommand(): DeviceWorkspaceListCommand {
  const unsigned = command();
  const placeholder = {
    ...unsigned,
    authorization: { ...unsigned.authorization, signature: "A".repeat(86) },
  };
  return {
    ...placeholder,
    authorization: {
      ...placeholder.authorization,
      signature: sign(
        null,
        Buffer.from(
          canonicalDeviceWorkspaceListCommandSigningPayload(placeholder),
          "utf8",
        ),
        keys.privateKey,
      ).toString("base64url"),
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
