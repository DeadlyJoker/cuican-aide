import { DEVICE_PROTOCOL_VERSION } from "./device-protocol.ts";
import { DEVICE_WORKSPACE_LIST_HARD_LIMITS } from "./device-protocol-workspace.ts";

const opaqueId = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$",
} as const;
const digest = {
  type: "string",
  pattern: "^sha256:[a-f0-9]{64}$",
} as const;
const timestamp = {
  type: "string",
  format: "date-time",
  pattern: "Z$",
} as const;

export const deviceWorkspaceListCommandJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-command/v0",
  title: "DeviceWorkspaceListCommandV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "commandKind",
    "deviceId",
    "executionId",
    "leaseId",
    "leaseEpoch",
    "expiresAt",
    "workspaceBindingId",
    "incarnationId",
    "deviceBindingId",
    "runtimeBindingId",
    "policySnapshotId",
    "operation",
    "limits",
    "actionDigest",
    "commandDigest",
    "idempotencyKey",
    "traceContext",
    "authorization",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-workspace-list-command.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    commandKind: { const: "workspaceList" },
    deviceId: opaqueId,
    executionId: opaqueId,
    leaseId: opaqueId,
    leaseEpoch: { type: "integer", minimum: 1 },
    expiresAt: timestamp,
    workspaceBindingId: opaqueId,
    incarnationId: opaqueId,
    deviceBindingId: opaqueId,
    runtimeBindingId: opaqueId,
    policySnapshotId: opaqueId,
    operation: { const: "listTopLevel" },
    limits: {
      type: "object",
      additionalProperties: false,
      required: [
        "depth",
        "maxEntries",
        "maxNameBytes",
        "maxOutputBytes",
        "maxScannedEntries",
        "maxScannedNameBytes",
        "timeoutMs",
      ],
      properties: {
        depth: { const: 0 },
        maxEntries: {
          type: "integer",
          minimum: 1,
          maximum: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxEntries,
        },
        maxNameBytes: {
          type: "integer",
          minimum: 1,
          maximum: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxNameBytes,
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 1,
          maximum: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxOutputBytes,
        },
        maxScannedEntries: {
          type: "integer",
          minimum: 1,
          maximum: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxScannedEntries,
        },
        maxScannedNameBytes: {
          type: "integer",
          minimum: 1,
          maximum: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxScannedNameBytes,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxTimeoutMs,
        },
      },
    },
    actionDigest: digest,
    commandDigest: digest,
    idempotencyKey: opaqueId,
    traceContext: {
      type: "object",
      additionalProperties: false,
      required: ["traceparent", "tracestate"],
      properties: {
        traceparent: {
          oneOf: [
            {
              type: "string",
              pattern: "^[\\da-f]{2}-[\\da-f]{32}-[\\da-f]{16}-[\\da-f]{2}$",
            },
            { type: "null" },
          ],
        },
        tracestate: {
          oneOf: [
            { type: "string", maxLength: 512, pattern: "^[^\\r\\n]*$" },
            { type: "null" },
          ],
        },
      },
    },
    authorization: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "scheme",
        "keyId",
        "issuedAt",
        "expiresAt",
        "approvalProof",
        "signature",
      ],
      properties: {
        schemaVersion: { const: "crewon.device-authorization.v0" },
        scheme: { const: "ed25519" },
        keyId: opaqueId,
        issuedAt: timestamp,
        expiresAt: timestamp,
        approvalProof: { type: "null" },
        signature: {
          type: "string",
          pattern: "^[A-Za-z0-9_-]{86}$",
        },
      },
    },
  },
} as const;
