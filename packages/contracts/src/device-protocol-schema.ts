import {
  DEVICE_EXECUTION_EVENT_TYPES,
  DEVICE_PROTOCOL_VERSION,
} from "./device-protocol.ts";
import { deviceWorkspaceListCommandJsonSchema } from "./device-protocol-workspace-schema.ts";

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
const capability = {
  type: "string",
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,15}$",
} as const;

export const deviceExecutionCommandJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-command/v0",
  title: "DeviceExecutionCommandV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "deviceId",
    "leaseId",
    "leaseEpoch",
    "expiresAt",
    "runId",
    "stepId",
    "attemptId",
    "executionId",
    "workspaceBindingId",
    "capability",
    "actionDigest",
    "authorization",
    "arguments",
    "payloadRef",
    "limits",
    "idempotencyKey",
    "traceContext",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-command.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    deviceId: opaqueId,
    leaseId: opaqueId,
    leaseEpoch: { type: "integer", minimum: 1 },
    expiresAt: timestamp,
    runId: opaqueId,
    stepId: opaqueId,
    attemptId: opaqueId,
    executionId: opaqueId,
    workspaceBindingId: opaqueId,
    capability,
    actionDigest: digest,
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
        approvalProof: {
          oneOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: [
                "schemaVersion",
                "approvalId",
                "approvalRevision",
                "actionDigest",
                "policySnapshotId",
                "decidedAt",
              ],
              properties: {
                schemaVersion: { const: "crewon.device-approval-proof.v0" },
                approvalId: opaqueId,
                approvalRevision: { type: "integer", minimum: 2 },
                actionDigest: digest,
                policySnapshotId: opaqueId,
                decidedAt: timestamp,
              },
            },
          ],
        },
        signature: {
          type: "string",
          pattern: "^[A-Za-z0-9_-]{86}$",
        },
      },
    },
    arguments: {},
    payloadRef: { oneOf: [opaqueId, { type: "null" }] },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["timeoutMs", "maxOutputBytes", "maxArtifactBytes"],
      properties: {
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 86_400_000,
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 1,
          maximum: 1_048_576,
        },
        maxArtifactBytes: {
          type: "integer",
          minimum: 1,
          maximum: 1_073_741_824,
        },
      },
    },
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
  },
  oneOf: [
    {
      properties: {
        arguments: { not: { type: "null" } },
        payloadRef: { type: "null" },
      },
    },
    {
      properties: {
        arguments: { type: "null" },
        payloadRef: opaqueId,
      },
    },
  ],
} as const;

const eventEnvelope = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "deviceId",
    "executionId",
    "receiptId",
    "sequence",
    "observedAt",
    "type",
    "data",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-event.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    deviceId: opaqueId,
    executionId: opaqueId,
    receiptId: opaqueId,
    sequence: { type: "integer", minimum: 1 },
    observedAt: timestamp,
  },
} as const;

export const deviceExecutionEventJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-event/v0",
  title: "DeviceExecutionEventV0",
  oneOf: [
    eventVariant("execution.accepted", {
      type: "object",
      additionalProperties: false,
      required: ["leaseEpoch", "actionDigest"],
      properties: {
        leaseEpoch: { type: "integer", minimum: 1 },
        actionDigest: digest,
      },
    }),
    eventVariant("execution.output", {
      type: "object",
      additionalProperties: false,
      required: ["channel", "chunk"],
      properties: {
        channel: { enum: ["stdout", "stderr"] },
        chunk: { type: "string", maxLength: 16_384 },
      },
    }),
    eventVariant("execution.completed", {
      type: "object",
      additionalProperties: false,
      required: [
        "output",
        "artifactRef",
        "outputDigest",
        "stdoutDigest",
        "stderrDigest",
        "exitCode",
        "exitSignal",
      ],
      properties: {
        output: {
          oneOf: [{ type: "string", maxLength: 40_000 }, { type: "null" }],
        },
        artifactRef: { oneOf: [opaqueId, { type: "null" }] },
        outputDigest: digest,
        stdoutDigest: digest,
        stderrDigest: digest,
        exitCode: {
          oneOf: [
            {
              type: "integer",
              minimum: -2_147_483_648,
              maximum: 2_147_483_647,
            },
            { type: "null" },
          ],
        },
        exitSignal: {
          oneOf: [
            { type: "string", pattern: "^[a-z0-9_.:-]{1,128}$" },
            { type: "null" },
          ],
        },
      },
    }),
    eventVariant("execution.failed", {
      type: "object",
      additionalProperties: false,
      required: ["code", "retryable"],
      properties: {
        code: { type: "string", pattern: "^[a-z0-9_.:-]{1,128}$" },
        retryable: { type: "boolean" },
      },
    }),
    eventVariant("execution.canceled", {
      type: "object",
      additionalProperties: false,
      required: ["reasonCode"],
      properties: {
        reasonCode: { type: "string", pattern: "^[a-z0-9_.:-]{1,128}$" },
      },
    }),
    eventVariant("execution.unknown_outcome", {
      type: "object",
      additionalProperties: false,
      required: ["providerReceiptId"],
      properties: {
        providerReceiptId: { oneOf: [opaqueId, { type: "null" }] },
      },
    }),
  ],
} as const;

export const deviceExecutionAckJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-ack/v0",
  title: "DeviceExecutionAckV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "deviceId",
    "executionId",
    "throughSequence",
    "acknowledgedAt",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-ack.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    deviceId: opaqueId,
    executionId: opaqueId,
    throughSequence: { type: "integer", minimum: 1 },
    acknowledgedAt: timestamp,
  },
} as const;

export const deviceExecutionCancelJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-cancel/v0",
  title: "DeviceExecutionCancelV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "deviceId",
    "executionId",
    "leaseId",
    "leaseEpoch",
    "reasonCode",
    "requestedAt",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-cancel.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    deviceId: opaqueId,
    executionId: opaqueId,
    leaseId: opaqueId,
    leaseEpoch: { type: "integer", minimum: 1 },
    reasonCode: { type: "string", pattern: "^[a-z0-9_.:-]{1,128}$" },
    requestedAt: timestamp,
  },
} as const;

export const deviceHelloJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-hello/v0",
  title: "DeviceHelloV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "supportedProtocolVersions",
    "deviceId",
    "connectionId",
    "capabilities",
    "lastAcknowledged",
    "sentAt",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-hello.v0" },
    supportedProtocolVersions: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ const: DEVICE_PROTOCOL_VERSION }],
      items: false,
    },
    deviceId: opaqueId,
    connectionId: opaqueId,
    capabilities: {
      type: "array",
      maxItems: 256,
      uniqueItems: true,
      items: capability,
    },
    lastAcknowledged: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["executionId", "sequence"],
        properties: {
          executionId: opaqueId,
          sequence: { type: "integer", minimum: 0 },
        },
      },
    },
    sentAt: timestamp,
  },
} as const;

export const deviceGatewayWelcomeJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-welcome/v0",
  title: "DeviceGatewayWelcomeV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "protocolVersion",
    "deviceId",
    "connectionId",
    "gatewayId",
    "connectionEpoch",
    "leaseExpiresAt",
    "sentAt",
  ],
  properties: {
    schemaVersion: { const: "crewon.device-welcome.v0" },
    protocolVersion: { const: DEVICE_PROTOCOL_VERSION },
    deviceId: opaqueId,
    connectionId: opaqueId,
    gatewayId: opaqueId,
    connectionEpoch: { type: "integer", minimum: 1 },
    leaseExpiresAt: timestamp,
    sentAt: timestamp,
  },
} as const;

export const deviceProtocolJsonSchemas = {
  command: deviceExecutionCommandJsonSchema,
  workspaceCommand: deviceWorkspaceListCommandJsonSchema,
  event: deviceExecutionEventJsonSchema,
  ack: deviceExecutionAckJsonSchema,
  cancel: deviceExecutionCancelJsonSchema,
  hello: deviceHelloJsonSchema,
  welcome: deviceGatewayWelcomeJsonSchema,
} as const;

function eventVariant(
  type: (typeof DEVICE_EXECUTION_EVENT_TYPES)[number],
  data: Readonly<Record<string, unknown>>,
) {
  return {
    ...eventEnvelope,
    properties: {
      ...eventEnvelope.properties,
      type: { const: type },
      data,
    },
  } as const;
}
