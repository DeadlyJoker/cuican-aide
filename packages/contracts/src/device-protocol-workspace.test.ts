import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  canonicalDeviceWorkspaceListCommandSigningPayload,
  canonicalUnsignedDeviceWorkspaceListCommandSigningPayload,
  parseDeviceWorkspaceListCommand,
  verifyDeviceWorkspaceListCommandAuthorization,
} from "./device-protocol-workspace.ts";
import { deviceWorkspaceListCommandJsonSchema } from "./device-protocol-workspace-schema.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const command = {
  schemaVersion: "crewon.device-workspace-list-command.v0",
  protocolVersion: 1,
  commandKind: "workspaceList",
  deviceId: "device-1",
  executionId: "workspace-execution-1",
  leaseId: "lease-1",
  leaseEpoch: 4,
  expiresAt: "2026-08-08T01:00:00Z",
  workspaceBindingId: "workspace-binding-1",
  incarnationId: "incarnation-1",
  deviceBindingId: "device-binding-1",
  runtimeBindingId: "runtime-binding-1",
  policySnapshotId: "policy-1",
  operation: "listTopLevel",
  limits: {
    depth: 0,
    maxEntries: 200,
    maxNameBytes: 255,
    maxOutputBytes: 65_536,
    maxScannedEntries: 10_000,
    maxScannedNameBytes: 1_048_576,
    timeoutMs: 30_000,
  },
  actionDigest: digest("a"),
  commandDigest: digest("b"),
  idempotencyKey: "workspace-list-key-1",
  traceContext: { traceparent: null, tracestate: null },
  authorization: {
    schemaVersion: "crewon.device-authorization.v0",
    scheme: "ed25519",
    keyId: "control-key-1",
    issuedAt: "2026-08-08T00:00:00Z",
    expiresAt: "2026-08-08T00:30:00Z",
    approvalProof: null,
    signature: "A".repeat(86),
  },
} as const;

const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  workspaceSigningPayloadSha256: string;
  valid: Readonly<{ workspaceCommand: unknown }>;
  invalid: readonly Readonly<{
    parser: string;
    code: string;
    value: unknown;
  }>[];
}>;

test("parses an independent bounded workspace list command", () => {
  assert.deepEqual(parseDeviceWorkspaceListCommand(command), command);
  assert.deepEqual(
    [...deviceWorkspaceListCommandJsonSchema.required].sort(),
    Object.keys(command).sort(),
  );
  for (const forbidden of [
    "path",
    "tenantId",
    "spaceId",
    "runId",
    "stepId",
    "attemptId",
    "workItemId",
  ]) {
    assert.equal(forbidden in command, false);
  }
});

test("canonical signing binds every workspace authority field but not signature bytes", () => {
  const payload = canonicalDeviceWorkspaceListCommandSigningPayload(command);
  const { signature: _signature, ...authorization } = command.authorization;
  assert.equal(
    payload,
    canonicalUnsignedDeviceWorkspaceListCommandSigningPayload({
      ...command,
      authorization,
    }),
  );
  assert.equal(
    payload,
    canonicalDeviceWorkspaceListCommandSigningPayload({
      ...command,
      authorization: { ...command.authorization, signature: "B".repeat(86) },
    }),
  );
  const mutations = [
    { ...command, deviceId: "device-2" },
    { ...command, executionId: "workspace-execution-2" },
    { ...command, leaseEpoch: 5 },
    { ...command, workspaceBindingId: "workspace-binding-2" },
    { ...command, incarnationId: "incarnation-2" },
    { ...command, deviceBindingId: "device-binding-2" },
    { ...command, runtimeBindingId: "runtime-binding-2" },
    { ...command, policySnapshotId: "policy-2" },
    { ...command, limits: { ...command.limits, maxEntries: 199 } },
    { ...command, actionDigest: digest("c") },
    { ...command, commandDigest: digest("d") },
    { ...command, idempotencyKey: "workspace-list-key-2" },
  ];
  assert.equal(
    new Set(
      [command, ...mutations].map(
        canonicalDeviceWorkspaceListCommandSigningPayload,
      ),
    ).size,
    mutations.length + 1,
  );
});

test("verifies Ed25519 authorization and rejects a post-sign mutation", async () => {
  const keys = (await globalThis.crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const signature = await globalThis.crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(
      canonicalDeviceWorkspaceListCommandSigningPayload(command),
    ),
  );
  const authorized = {
    ...command,
    authorization: {
      ...command.authorization,
      signature: Buffer.from(signature).toString("base64url"),
    },
  };
  assert.deepEqual(
    await verifyDeviceWorkspaceListCommandAuthorization(
      authorized,
      "control-key-1",
      keys.publicKey,
      new Date("2026-08-08T00:00:03Z"),
      300_000,
    ),
    authorized,
  );
  await assert.rejects(
    verifyDeviceWorkspaceListCommandAuthorization(
      { ...authorized, leaseEpoch: 5 },
      "control-key-1",
      keys.publicKey,
      new Date("2026-08-08T00:00:03Z"),
      300_000,
    ),
    hasCode("device_authorization_signature_invalid"),
  );
});

test("rejects ambient path authority, approval proof and unsafe workspace limits", () => {
  for (const [input, code] of [
    [{ ...command, path: "/private/workspace" }, "device_fields_invalid"],
    [
      {
        ...command,
        authorization: {
          ...command.authorization,
          approvalProof: {
            schemaVersion: "crewon.device-approval-proof.v0",
          },
        },
      },
      "device_approval_proof_forbidden",
    ],
    [
      { ...command, limits: { ...command.limits, depth: 1 } },
      "device_workspace_depth_invalid",
    ],
    [
      {
        ...command,
        limits: { ...command.limits, maxScannedEntries: 199 },
      },
      "device_workspace_limits_invalid",
    ],
    [
      {
        ...command,
        limits: { ...command.limits, maxScannedNameBytes: 254 },
      },
      "device_workspace_limits_invalid",
    ],
  ] as const) {
    assert.throws(() => parseDeviceWorkspaceListCommand(input), hasCode(code));
  }
});

test("matches the shared Rust workspace command golden and reject vectors", () => {
  assert.deepEqual(
    parseDeviceWorkspaceListCommand(reference.valid.workspaceCommand),
    reference.valid.workspaceCommand,
  );
  assert.equal(
    `sha256:${createHash("sha256")
      .update(
        canonicalDeviceWorkspaceListCommandSigningPayload(
          reference.valid.workspaceCommand,
        ),
        "utf8",
      )
      .digest("hex")}`,
    reference.workspaceSigningPayloadSha256,
  );
  for (const invalid of reference.invalid.filter(
    ({ parser }) => parser === "workspaceCommand",
  )) {
    assert.throws(
      () => parseDeviceWorkspaceListCommand(invalid.value),
      hasCode(invalid.code),
    );
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ContractValidationError && error.code === code;
}
