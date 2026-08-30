import {
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_OPERATIONS,
} from "./device-workspace-list-dispatch-api.ts";
import { deviceWorkspaceListCommandJsonSchema } from "./device-protocol-workspace-schema.ts";
import { deviceWorkspaceListEventJsonSchema } from "./device-protocol-workspace-event-schema.ts";

const opaqueId = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$",
} as const;
const timestamp = {
  type: "string",
  format: "date-time",
  pattern: "Z$",
} as const;
const completedEvent = deviceWorkspaceListEventJsonSchema.oneOf[1];
const failedEvent = deviceWorkspaceListEventJsonSchema.oneOf[2];
const canceledEvent = deviceWorkspaceListEventJsonSchema.oneOf[3];
const unknownEvent = deviceWorkspaceListEventJsonSchema.oneOf[4];

const dispatchReference = {
  type: "object",
  additionalProperties: false,
  required: [
    "deviceId",
    "executionId",
    "workspaceBindingId",
    "incarnationId",
    "deviceBindingId",
    "runtimeBindingId",
    "actionDigest",
    "commandDigest",
    "receiptId",
  ],
  properties: {
    deviceId: opaqueId,
    executionId: opaqueId,
    workspaceBindingId: opaqueId,
    incarnationId: opaqueId,
    deviceBindingId: opaqueId,
    runtimeBindingId: opaqueId,
    actionDigest: {
      type: "string",
      pattern: "^sha256:[a-f0-9]{64}$",
    },
    commandDigest: {
      type: "string",
      pattern: "^sha256:[a-f0-9]{64}$",
    },
    receiptId: { oneOf: [opaqueId, { type: "null" }] },
  },
} as const;

export const deviceWorkspaceListWorkerDispatchRequestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-dispatch-request/v0",
  title: "DeviceWorkspaceListWorkerDispatchRequestV0",
  oneOf: [
    workerExecuteRequest(),
    workerReferenceRequest("reconcile"),
    workerReferenceRequest("cancel"),
  ],
} as const;

export const deviceWorkspaceListWorkerDispatchResponseJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-dispatch-response/v0",
  title: "DeviceWorkspaceListWorkerDispatchResponseV0",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "apiVersion", "operation", "resolution"],
  properties: {
    schemaVersion: {
      const: "crewon.device-workspace-list-dispatch-response.v0",
    },
    apiVersion: { const: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION },
    operation: { enum: DEVICE_WORKSPACE_LIST_DISPATCH_OPERATIONS },
    resolution: workspaceResolutionSchema(),
  },
} as const;

const peerRoute = {
  type: "object",
  additionalProperties: false,
  required: [
    "deviceId",
    "gatewayId",
    "connectionId",
    "connectionEpoch",
    "leaseExpiresAt",
  ],
  properties: {
    deviceId: opaqueId,
    gatewayId: opaqueId,
    connectionId: opaqueId,
    connectionEpoch: { type: "integer", minimum: 1 },
    leaseExpiresAt: timestamp,
  },
} as const;

const peerSourceWorker = {
  type: "object",
  additionalProperties: false,
  required: ["workerId", "credentialId"],
  properties: {
    workerId: opaqueId,
    credentialId: opaqueId,
  },
} as const;

export const deviceWorkspaceListPeerDispatchRequestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-peer-dispatch-request/v0",
  title: "DeviceWorkspaceListPeerDispatchRequestV0",
  oneOf: [
    peerExecuteRequest(),
    peerReferenceRequest("reconcile"),
    peerReferenceRequest("cancel"),
  ],
} as const;

export const deviceWorkspaceListPeerDispatchResponseJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-peer-dispatch-response/v0",
  title: "DeviceWorkspaceListPeerDispatchResponseV0",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "apiVersion", "route", "operation", "resolution"],
  properties: {
    schemaVersion: {
      const: "crewon.device-workspace-list-peer-dispatch-response.v0",
    },
    apiVersion: { const: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION },
    route: peerRoute,
    operation: { enum: DEVICE_WORKSPACE_LIST_DISPATCH_OPERATIONS },
    resolution: workspaceResolutionSchema(),
  },
} as const;

export const deviceWorkspaceListDispatchErrorJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/device-workspace-list-dispatch-error/v0",
  title: "DeviceWorkspaceListDispatchErrorV0",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "apiVersion", "code", "retryable", "certainty"],
  properties: {
    schemaVersion: {
      const: "crewon.device-workspace-list-dispatch-error.v0",
    },
    apiVersion: { const: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION },
    code: { type: "string", pattern: "^[a-z0-9_.:-]{1,128}$" },
    retryable: { type: "boolean" },
    certainty: { enum: ["notSent", "possiblySent"] },
  },
} as const;

export const deviceWorkspaceListDispatchApiJsonSchemas = {
  workerRequest: deviceWorkspaceListWorkerDispatchRequestJsonSchema,
  workerResponse: deviceWorkspaceListWorkerDispatchResponseJsonSchema,
  peerRequest: deviceWorkspaceListPeerDispatchRequestJsonSchema,
  peerResponse: deviceWorkspaceListPeerDispatchResponseJsonSchema,
  error: deviceWorkspaceListDispatchErrorJsonSchema,
} as const;

function workerExecuteRequest() {
  return requestBranch(
    "crewon.device-workspace-list-dispatch-request.v0",
    "execute",
    { command: deviceWorkspaceListCommandJsonSchema },
  );
}

function workerReferenceRequest(operation: "reconcile" | "cancel") {
  return requestBranch(
    "crewon.device-workspace-list-dispatch-request.v0",
    operation,
    { reference: dispatchReference },
  );
}

function peerExecuteRequest() {
  return peerRequestBranch("execute", {
    command: deviceWorkspaceListCommandJsonSchema,
  });
}

function peerReferenceRequest(operation: "reconcile" | "cancel") {
  return peerRequestBranch(operation, { reference: dispatchReference });
}

function peerRequestBranch(
  operation: "execute" | "reconcile" | "cancel",
  payload: Readonly<Record<string, unknown>>,
) {
  return requestBranch(
    "crewon.device-workspace-list-peer-dispatch-request.v0",
    operation,
    {
      sourceGatewayId: opaqueId,
      sourceWorker: peerSourceWorker,
      route: peerRoute,
      ...payload,
    },
  );
}

function requestBranch(
  schemaVersion:
    | "crewon.device-workspace-list-dispatch-request.v0"
    | "crewon.device-workspace-list-peer-dispatch-request.v0",
  operation: "execute" | "reconcile" | "cancel",
  payload: Readonly<Record<string, unknown>>,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "apiVersion",
      "operation",
      ...Object.keys(payload),
    ],
    properties: {
      schemaVersion: { const: schemaVersion },
      apiVersion: { const: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION },
      operation: { const: operation },
      ...payload,
    },
  } as const;
}

function workspaceResolutionSchema() {
  return {
    oneOf: [
      terminalResolution("completed", completedEvent),
      terminalResolution("failed", failedEvent),
      terminalResolution("canceled", canceledEvent),
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "executionId", "receiptId", "terminal"],
        properties: {
          status: { const: "unknownOutcome" },
          executionId: opaqueId,
          receiptId: { oneOf: [opaqueId, { type: "null" }] },
          terminal: { oneOf: [unknownEvent, { type: "null" }] },
        },
      },
    ],
  } as const;
}

function terminalResolution(
  status: "completed" | "failed" | "canceled",
  terminal: Readonly<Record<string, unknown>>,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "executionId", "receiptId", "terminal"],
    properties: {
      status: { const: status },
      executionId: opaqueId,
      receiptId: opaqueId,
      terminal,
    },
  } as const;
}
