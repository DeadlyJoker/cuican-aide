import { deviceExecutionCommandJsonSchema } from "./device-protocol-schema.ts";

const id = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$",
} as const;
const digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const;
const intent = object(["deviceBindingId", "runtimeBindingId"], {
  deviceBindingId: id,
  runtimeBindingId: id,
});
const reference = object(
  [
    "actionDigest",
    "commandDigest",
    "deviceBindingId",
    "deviceId",
    "executionId",
    "incarnationId",
    "leaseEpoch",
    "leaseId",
    "receiptId",
    "runtimeBindingId",
    "workspaceBindingId",
  ],
  {
    actionDigest: digest,
    commandDigest: digest,
    deviceBindingId: id,
    deviceId: id,
    executionId: id,
    incarnationId: id,
    leaseEpoch: { type: "integer", minimum: 1 },
    leaseId: id,
    receiptId: { oneOf: [id, { type: "null" }] },
    runtimeBindingId: id,
    workspaceBindingId: id,
  },
);
const route = object(
  [
    "capability",
    "connectionEpoch",
    "connectionId",
    "deviceBindingId",
    "deviceId",
    "gatewayId",
    "leaseExpiresAt",
    "runtimeBindingId",
  ],
  {
    capability: { const: "workspace.read_file.v0" },
    connectionEpoch: { type: "integer", minimum: 1 },
    connectionId: id,
    deviceBindingId: id,
    deviceId: id,
    gatewayId: id,
    leaseExpiresAt: { type: "string", format: "date-time", pattern: "Z$" },
    runtimeBindingId: id,
  },
);
const sourceWorker = object(["credentialId", "workerId"], {
  credentialId: id,
  workerId: id,
});
const readCommand = {
  allOf: [
    deviceExecutionCommandJsonSchema,
    {
      properties: {
        capability: { const: "workspace.read_file.v0" },
        payloadRef: { type: "null" },
        arguments: object(
          [
            "encoding",
            "relativePathSegments",
            "schemaVersion",
            "workspaceIncarnationId",
          ],
          {
            schemaVersion: {
              const: "crewon.device-filesystem-read-arguments.v0",
            },
            workspaceIncarnationId: id,
            relativePathSegments: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 255,
                not: { enum: [".", ".."] },
                pattern: "^[^/\\\\:\\u0000]+$",
              },
            },
            encoding: { const: "utf8" },
          },
        ),
        limits: {
          properties: {
            timeoutMs: { type: "integer", minimum: 1, maximum: 30_000 },
            maxOutputBytes: {
              type: "integer",
              minimum: 1,
              maximum: 65_536,
            },
          },
        },
        authorization: {
          properties: { approvalProof: { type: "null" } },
        },
      },
    },
  ],
} as const;
const resolution = object(["executionId", "receiptId", "status", "terminal"], {
  executionId: id,
  receiptId: { oneOf: [id, { type: "null" }] },
  status: { enum: ["completed", "failed", "canceled", "unknownOutcome"] },
  terminal: { oneOf: [{ type: "object" }, { type: "null" }] },
});

export const deviceFilesystemReadWorkerDispatchRequestJsonSchema = apiSchema(
  "device-filesystem-read-dispatch-request/v0",
  [
    worker("execute", "command"),
    worker("reconcile", "reference"),
    worker("cancel", "reference"),
  ],
);
export const deviceFilesystemReadPeerDispatchRequestJsonSchema = apiSchema(
  "device-filesystem-read-peer-dispatch-request/v0",
  [
    peer("execute", "command"),
    peer("reconcile", "reference"),
    peer("cancel", "reference"),
  ],
);
export const deviceFilesystemReadWorkerDispatchResponseJsonSchema =
  responseSchema(
    "device-filesystem-read-dispatch-response/v0",
    "crewon.device-filesystem-read-dispatch-response.v0",
    false,
  );
export const deviceFilesystemReadPeerDispatchResponseJsonSchema =
  responseSchema(
    "device-filesystem-read-peer-dispatch-response/v0",
    "crewon.device-filesystem-read-peer-dispatch-response.v0",
    true,
  );
export const deviceFilesystemReadDispatchErrorJsonSchema = {
  ...apiSchema("device-filesystem-read-dispatch-error/v0", []),
  ...object(["apiVersion", "certainty", "code", "retryable", "schemaVersion"], {
    apiVersion: { const: 1 },
    certainty: { enum: ["notSent", "possiblySent"] },
    code: { type: "string", pattern: "^[a-z][a-z0-9_]{0,127}$" },
    retryable: { type: "boolean" },
    schemaVersion: { const: "crewon.device-filesystem-read-dispatch-error.v0" },
  }),
} as const;
export const deviceFilesystemReadDispatchApiJsonSchemas = {
  workerRequest: deviceFilesystemReadWorkerDispatchRequestJsonSchema,
  workerResponse: deviceFilesystemReadWorkerDispatchResponseJsonSchema,
  peerRequest: deviceFilesystemReadPeerDispatchRequestJsonSchema,
  peerResponse: deviceFilesystemReadPeerDispatchResponseJsonSchema,
  error: deviceFilesystemReadDispatchErrorJsonSchema,
} as const;

function worker(operation: string, payload: "command" | "reference") {
  return branch(
    "crewon.device-filesystem-read-dispatch-request.v0",
    operation,
    {
      routeIntent: intent,
      [payload]: payload === "command" ? readCommand : reference,
    },
  );
}
function peer(operation: string, payload: "command" | "reference") {
  return branch(
    "crewon.device-filesystem-read-peer-dispatch-request.v0",
    operation,
    {
      route,
      sourceGatewayId: id,
      sourceWorker,
      [payload]: payload === "command" ? readCommand : reference,
    },
  );
}
function branch(
  schemaVersion: string,
  operation: string,
  fields: Record<string, unknown>,
) {
  return object(
    ["apiVersion", "operation", "schemaVersion", ...Object.keys(fields)],
    {
      apiVersion: { const: 1 },
      operation: { const: operation },
      schemaVersion: { const: schemaVersion },
      ...fields,
    },
  );
}
function responseSchema(
  name: string,
  schemaVersion: string,
  peerResponse: boolean,
) {
  const fields = {
    apiVersion: { const: 1 },
    operation: { enum: ["execute", "reconcile", "cancel"] },
    resolution,
    schemaVersion: { const: schemaVersion },
    ...(peerResponse ? { route } : {}),
  };
  return {
    ...apiSchema(name, []),
    ...object(Object.keys(fields), fields),
  } as const;
}
function apiSchema<const T extends readonly unknown[]>(name: string, oneOf: T) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://schemas.crewon.local/${name}`,
    ...(oneOf.length === 0 ? {} : { oneOf }),
  } as const;
}
function object(
  required: readonly string[],
  properties: Record<string, unknown>,
) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  } as const;
}
