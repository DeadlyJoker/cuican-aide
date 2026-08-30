import {
  DEVICE_DISPATCH_API_VERSION,
  DEVICE_DISPATCH_OPERATIONS,
} from "./device-dispatch-api.ts";
import {
  deviceExecutionCommandJsonSchema,
  deviceExecutionEventJsonSchema,
} from "./device-protocol-schema.ts";

const opaqueId = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$",
} as const;
const completedEvent = deviceExecutionEventJsonSchema.oneOf[2];
const failedEvent = deviceExecutionEventJsonSchema.oneOf[3];
const canceledEvent = deviceExecutionEventJsonSchema.oneOf[4];
const unknownEvent = deviceExecutionEventJsonSchema.oneOf[5];
const outputEvent = deviceExecutionEventJsonSchema.oneOf[1];

export const deviceDispatchRequestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-dispatch-request/v0",
  title: "DeviceDispatchRequestV0",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "apiVersion", "operation", "command"],
  properties: {
    schemaVersion: { const: "crewon.device-dispatch-request.v0" },
    apiVersion: { const: DEVICE_DISPATCH_API_VERSION },
    operation: { enum: DEVICE_DISPATCH_OPERATIONS },
    command: deviceExecutionCommandJsonSchema,
  },
} as const;

export const deviceDispatchResponseJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-dispatch-response/v0",
  title: "DeviceDispatchResponseV0",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "apiVersion", "operation", "resolution"],
  properties: {
    schemaVersion: { const: "crewon.device-dispatch-response.v0" },
    apiVersion: { const: DEVICE_DISPATCH_API_VERSION },
    operation: { enum: DEVICE_DISPATCH_OPERATIONS },
    resolution: {
      oneOf: [
        resolution("completed", completedEvent, {
          output: {
            type: "array",
            maxItems: 4_096,
            items: outputEvent,
          },
        }),
        resolution("failed", failedEvent),
        resolution("canceled", canceledEvent),
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "executionId", "providerReceiptId", "terminal"],
          properties: {
            status: { const: "unknownOutcome" },
            executionId: opaqueId,
            providerReceiptId: { oneOf: [opaqueId, { type: "null" }] },
            terminal: { oneOf: [unknownEvent, { type: "null" }] },
          },
        },
      ],
    },
  },
} as const;

export const deviceDispatchErrorJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-dispatch-error/v0",
  title: "DeviceDispatchErrorV0",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "apiVersion", "code", "retryable"],
  properties: {
    schemaVersion: { const: "crewon.device-dispatch-error.v0" },
    apiVersion: { const: DEVICE_DISPATCH_API_VERSION },
    code: { type: "string", pattern: "^[a-z0-9_.:-]{1,128}$" },
    retryable: { type: "boolean" },
  },
} as const;

export const deviceDispatchApiJsonSchemas = {
  request: deviceDispatchRequestJsonSchema,
  response: deviceDispatchResponseJsonSchema,
  error: deviceDispatchErrorJsonSchema,
} as const;

function resolution(
  status: "completed" | "failed" | "canceled",
  terminal: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "executionId",
      "providerReceiptId",
      "terminal",
      ...Object.keys(extra),
    ],
    properties: {
      status: { const: status },
      executionId: opaqueId,
      providerReceiptId: opaqueId,
      terminal,
      ...extra,
    },
  } as const;
}
