import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseDeviceWorkspaceListDispatchError,
  parseDeviceWorkspaceListDispatchReference,
  parseDeviceWorkspaceListPeerDispatchRequest,
  parseDeviceWorkspaceListPeerDispatchResponse,
  parseDeviceWorkspaceListWorkerDispatchRequest,
  parseDeviceWorkspaceListWorkerDispatchResponse,
} from "./device-workspace-list-dispatch-api.ts";
import {
  deviceWorkspaceListDispatchErrorJsonSchema,
  deviceWorkspaceListPeerDispatchRequestJsonSchema,
  deviceWorkspaceListPeerDispatchResponseJsonSchema,
  deviceWorkspaceListWorkerDispatchRequestJsonSchema,
  deviceWorkspaceListWorkerDispatchResponseJsonSchema,
} from "./device-workspace-list-dispatch-api-schema.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  valid: Readonly<{
    command: unknown;
    workspaceCommand: Readonly<Record<string, unknown>>;
    workspaceEvents: readonly unknown[];
  }>;
}>;

const executeRequest = {
  schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
  apiVersion: 1,
  operation: "execute",
  command: fixture.valid.workspaceCommand,
} as const;

const reference = {
  deviceId: "device-1",
  executionId: "workspace-execution-1",
  workspaceBindingId: "workspace-binding-1",
  incarnationId: "incarnation-1",
  deviceBindingId: "device-binding-1",
  runtimeBindingId: "runtime-binding-1",
  actionDigest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  commandDigest:
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  receiptId: "workspace-receipt-1",
} as const;

const reconcileRequest = {
  schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
  apiVersion: 1,
  operation: "reconcile",
  reference,
} as const;

const cancelRequest = {
  ...reconcileRequest,
  operation: "cancel",
} as const;

const completedResolution = {
  status: "completed",
  executionId: "workspace-execution-1",
  receiptId: "workspace-receipt-1",
  terminal: fixture.valid.workspaceEvents[1],
} as const;

const route = {
  deviceId: "device-1",
  gatewayId: "gateway-2",
  connectionId: "connection-2",
  connectionEpoch: 3,
  leaseExpiresAt: "2026-08-08T00:00:34Z",
} as const;

const sourceWorker = {
  workerId: "worker-1",
  credentialId: "worker-credential-1",
} as const;

test("parses every strict Worker execute/reference request branch", () => {
  assert.deepEqual(
    parseDeviceWorkspaceListWorkerDispatchRequest(executeRequest),
    executeRequest,
  );
  assert.deepEqual(
    parseDeviceWorkspaceListWorkerDispatchRequest(reconcileRequest),
    reconcileRequest,
  );
  assert.deepEqual(
    parseDeviceWorkspaceListWorkerDispatchRequest(cancelRequest),
    cancelRequest,
  );
  assert.deepEqual(
    parseDeviceWorkspaceListDispatchReference(reference),
    reference,
  );
});

test("rejects mixed command/reference branches and extra reference fields", () => {
  for (const invalid of [
    { ...executeRequest, reference },
    { ...reconcileRequest, command: fixture.valid.workspaceCommand },
    { ...reconcileRequest, reference: { ...reference, extra: true } },
    { ...reconcileRequest, operation: "execute" },
  ]) {
    assert.throws(
      () => parseDeviceWorkspaceListWorkerDispatchRequest(invalid),
      hasCode("device_workspace_dispatch_fields_invalid"),
    );
  }
  assert.throws(
    () =>
      parseDeviceWorkspaceListWorkerDispatchRequest({
        ...reconcileRequest,
        reference: { ...reference, commandDigest: `sha256:${"g".repeat(64)}` },
      }),
    hasCode("device_command_digest_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceWorkspaceListWorkerDispatchRequest({
        ...executeRequest,
        command: fixture.valid.command,
      }),
    hasCode("device_fields_invalid"),
  );
});

test("deep-validates responses against either the exact command or reference", () => {
  for (const request of [
    executeRequest,
    reconcileRequest,
    cancelRequest,
  ] as const) {
    const expected = parseDeviceWorkspaceListWorkerDispatchRequest(request);
    const response = {
      schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
      apiVersion: 1,
      operation: request.operation,
      resolution: completedResolution,
    } as const;
    assert.deepEqual(
      parseDeviceWorkspaceListWorkerDispatchResponse(response, expected),
      response,
    );
  }

  const expected =
    parseDeviceWorkspaceListWorkerDispatchRequest(reconcileRequest);
  assert.throws(
    () =>
      parseDeviceWorkspaceListWorkerDispatchResponse(
        {
          schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
          apiVersion: 1,
          operation: "reconcile",
          resolution: {
            ...completedResolution,
            receiptId: "workspace-receipt-other",
          },
        },
        expected,
      ),
    hasCode("device_workspace_dispatch_resolution_identity_mismatch"),
  );
  assert.throws(
    () =>
      parseDeviceWorkspaceListWorkerDispatchResponse(
        {
          schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
          apiVersion: 1,
          operation: "reconcile",
          resolution: {
            ...completedResolution,
            terminal: {
              ...(completedResolution.terminal as object),
              runtimeBindingId: "runtime-binding-substituted",
            },
          },
        },
        expected,
      ),
    hasCode("device_workspace_dispatch_resolution_identity_mismatch"),
  );
});

test("allows a null reference receipt to discover a durable receipt", () => {
  const request = parseDeviceWorkspaceListWorkerDispatchRequest({
    ...reconcileRequest,
    reference: { ...reference, receiptId: null },
  });
  const response = {
    schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
    apiVersion: 1,
    operation: "reconcile",
    resolution: completedResolution,
  } as const;
  assert.deepEqual(
    parseDeviceWorkspaceListWorkerDispatchResponse(response, request),
    response,
  );
});

test("parses every strict peer branch and route-binds only fresh execute events", () => {
  for (const request of [
    executeRequest,
    reconcileRequest,
    cancelRequest,
  ] as const) {
    const peerRequest = {
      schemaVersion: "crewon.device-workspace-list-peer-dispatch-request.v0",
      apiVersion: 1,
      sourceGatewayId: "gateway-1",
      sourceWorker,
      route,
      operation: request.operation,
      ...(request.operation === "execute"
        ? { command: request.command }
        : { reference: request.reference }),
    } as const;
    const parsed = parseDeviceWorkspaceListPeerDispatchRequest(peerRequest);
    assert.deepEqual(parsed, peerRequest);
    const response = {
      schemaVersion: "crewon.device-workspace-list-peer-dispatch-response.v0",
      apiVersion: 1,
      route,
      operation: request.operation,
      resolution: completedResolution,
    } as const;
    assert.deepEqual(
      parseDeviceWorkspaceListPeerDispatchResponse(response, parsed),
      response,
    );
  }

  assert.throws(
    () =>
      parseDeviceWorkspaceListPeerDispatchRequest({
        schemaVersion: "crewon.device-workspace-list-peer-dispatch-request.v0",
        apiVersion: 1,
        sourceGatewayId: "gateway-1",
        sourceWorker,
        route: { ...route, deviceId: "device-other" },
        operation: "reconcile",
        reference,
      }),
    hasCode("device_workspace_peer_dispatch_route_mismatch"),
  );

  for (const [invalidSourceWorker, code] of [
    [undefined, "device_workspace_peer_source_worker_invalid"],
    [{ workerId: "worker-1" }, "device_workspace_dispatch_fields_invalid"],
    [
      { ...sourceWorker, credentialId: "unsafe credential" },
      "device_workspace_peer_worker_credential_id_invalid",
    ],
    [
      { ...sourceWorker, extra: true },
      "device_workspace_dispatch_fields_invalid",
    ],
  ] as const) {
    assert.throws(
      () =>
        parseDeviceWorkspaceListPeerDispatchRequest({
          schemaVersion:
            "crewon.device-workspace-list-peer-dispatch-request.v0",
          apiVersion: 1,
          sourceGatewayId: "gateway-1",
          ...(invalidSourceWorker === undefined
            ? {}
            : { sourceWorker: invalidSourceWorker }),
          route,
          operation: "reconcile",
          reference,
        }),
      hasCode(code),
    );
  }

  assert.throws(
    () =>
      parseDeviceWorkspaceListWorkerDispatchRequest({
        ...reconcileRequest,
        sourceWorker,
      }),
    hasCode("device_workspace_dispatch_fields_invalid"),
  );
});

test("strictly parses bounded certainty-bearing private errors", () => {
  const error = {
    schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
    apiVersion: 1,
    code: "device_unavailable",
    retryable: true,
    certainty: "notSent",
  } as const;
  assert.deepEqual(parseDeviceWorkspaceListDispatchError(error), error);
  for (const invalid of [
    { ...error, certainty: "unknown" },
    { ...error, code: "Invalid Code" },
  ]) {
    assert.throws(
      () => parseDeviceWorkspaceListDispatchError(invalid),
      hasCode("device_workspace_dispatch_error_invalid"),
    );
  }
  assert.throws(
    () => parseDeviceWorkspaceListDispatchError({ ...error, extra: true }),
    hasCode("device_workspace_dispatch_fields_invalid"),
  );
});

test("publishes three exact request branches and bounded response/error schemas", () => {
  assert.equal(
    deviceWorkspaceListWorkerDispatchRequestJsonSchema.oneOf.length,
    3,
  );
  assert.equal(
    deviceWorkspaceListPeerDispatchRequestJsonSchema.oneOf.length,
    3,
  );
  assert.deepEqual(
    deviceWorkspaceListWorkerDispatchRequestJsonSchema.oneOf.map(
      (branch) => branch.properties.operation.const,
    ),
    ["execute", "reconcile", "cancel"],
  );
  assert.deepEqual(
    deviceWorkspaceListPeerDispatchRequestJsonSchema.oneOf.map(
      (branch) => branch.properties.operation.const,
    ),
    ["execute", "reconcile", "cancel"],
  );
  assert.deepEqual(
    deviceWorkspaceListPeerDispatchRequestJsonSchema.oneOf.map((branch) =>
      [...branch.required].sort(),
    ),
    [
      [
        "apiVersion",
        "command",
        "operation",
        "route",
        "schemaVersion",
        "sourceGatewayId",
        "sourceWorker",
      ],
      [
        "apiVersion",
        "operation",
        "reference",
        "route",
        "schemaVersion",
        "sourceGatewayId",
        "sourceWorker",
      ],
      [
        "apiVersion",
        "operation",
        "reference",
        "route",
        "schemaVersion",
        "sourceGatewayId",
        "sourceWorker",
      ],
    ],
  );
  assert.deepEqual(
    [...deviceWorkspaceListWorkerDispatchResponseJsonSchema.required].sort(),
    ["apiVersion", "operation", "resolution", "schemaVersion"],
  );
  assert.deepEqual(
    [...deviceWorkspaceListPeerDispatchResponseJsonSchema.required].sort(),
    ["apiVersion", "operation", "resolution", "route", "schemaVersion"],
  );
  assert.deepEqual(
    [...deviceWorkspaceListDispatchErrorJsonSchema.required].sort(),
    ["apiVersion", "certainty", "code", "retryable", "schemaVersion"],
  );
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ContractValidationError && error.code === code;
}
