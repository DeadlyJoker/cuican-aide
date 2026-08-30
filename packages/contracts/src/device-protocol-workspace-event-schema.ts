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
const safeCode = {
  type: "string",
  pattern: "^[a-z0-9_.:-]{1,128}$",
} as const;

const eventEnvelope = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "commandKind",
    "deviceId",
    "executionId",
    "receiptId",
    "connectionEpoch",
    "workspaceBindingId",
    "incarnationId",
    "deviceBindingId",
    "runtimeBindingId",
    "actionDigest",
    "commandDigest",
    "sequence",
    "observedAt",
    "type",
    "data",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-workspace-list-event.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    commandKind: { const: "workspaceList" },
    deviceId: opaqueId,
    executionId: opaqueId,
    receiptId: opaqueId,
    connectionEpoch: { type: "integer", minimum: 1 },
    workspaceBindingId: opaqueId,
    incarnationId: opaqueId,
    deviceBindingId: opaqueId,
    runtimeBindingId: opaqueId,
    actionDigest: digest,
    commandDigest: digest,
    sequence: { type: "integer", minimum: 1, maximum: 2 },
    observedAt: timestamp,
  },
} as const;

const workspaceListResult = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "executionId",
    "actionDigest",
    "commandDigest",
    "entries",
    "truncated",
  ],
  properties: {
    schemaVersion: { const: "crewon.workspace-list-result.v0" },
    executionId: opaqueId,
    actionDigest: digest,
    commandDigest: digest,
    entries: {
      type: "array",
      maxItems: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxEntries,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind"],
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxNameBytes,
            description:
              "The strict parser additionally enforces the UTF-8 byte limit, canonical byte ordering, and rejects links and unsafe Unicode controls.",
          },
          kind: { enum: ["file", "directory"] },
        },
      },
    },
    truncated: { type: "boolean" },
  },
} as const;

export const deviceWorkspaceListEventJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-event/v0",
  title: "DeviceWorkspaceListEventV0",
  oneOf: [
    eventVariant("workspace_list.accepted", 1, {
      type: "object",
      additionalProperties: false,
      required: ["leaseId", "leaseEpoch", "expiresAt", "policySnapshotId"],
      properties: {
        leaseId: opaqueId,
        leaseEpoch: { type: "integer", minimum: 1 },
        expiresAt: timestamp,
        policySnapshotId: opaqueId,
      },
    }),
    eventVariant("workspace_list.completed", 2, {
      type: "object",
      additionalProperties: false,
      required: ["result"],
      properties: { result: workspaceListResult },
    }),
    eventVariant("workspace_list.failed", 2, {
      type: "object",
      additionalProperties: false,
      required: ["code", "retryable"],
      properties: { code: safeCode, retryable: { type: "boolean" } },
    }),
    eventVariant("workspace_list.canceled", 2, {
      type: "object",
      additionalProperties: false,
      required: ["reasonCode"],
      properties: { reasonCode: safeCode },
    }),
    eventVariant("workspace_list.unknown_outcome", 2, {
      type: "object",
      additionalProperties: false,
      required: ["providerReceiptId"],
      properties: {
        providerReceiptId: { oneOf: [opaqueId, { type: "null" }] },
      },
    }),
  ],
} as const;

export const deviceWorkspaceListAckJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-ack/v0",
  title: "DeviceWorkspaceListAckV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "commandKind",
    "deviceId",
    "executionId",
    "receiptId",
    "connectionEpoch",
    "workspaceBindingId",
    "incarnationId",
    "deviceBindingId",
    "runtimeBindingId",
    "actionDigest",
    "commandDigest",
    "throughSequence",
    "acknowledgedAt",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-workspace-list-ack.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    commandKind: { const: "workspaceList" },
    deviceId: opaqueId,
    executionId: opaqueId,
    receiptId: opaqueId,
    connectionEpoch: { type: "integer", minimum: 1 },
    workspaceBindingId: opaqueId,
    incarnationId: opaqueId,
    deviceBindingId: opaqueId,
    runtimeBindingId: opaqueId,
    actionDigest: digest,
    commandDigest: digest,
    throughSequence: { type: "integer", minimum: 1, maximum: 2 },
    acknowledgedAt: timestamp,
  },
} as const;

export const deviceWorkspaceListProtocolJsonSchemas = {
  event: deviceWorkspaceListEventJsonSchema,
  ack: deviceWorkspaceListAckJsonSchema,
} as const;

function eventVariant(
  type: string,
  sequence: 1 | 2,
  data: Readonly<Record<string, unknown>>,
) {
  return {
    ...eventEnvelope,
    properties: {
      ...eventEnvelope.properties,
      sequence: { const: sequence },
      type: { const: type },
      data,
    },
  } as const;
}
