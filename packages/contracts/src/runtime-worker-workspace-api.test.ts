import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS,
  parseRuntimeWorkerWorkspaceDispatchError,
  parseRuntimeWorkerWorkspaceDispatchRequest,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  parseRuntimeWorkerWorkspaceFreezeCommandError,
  parseRuntimeWorkerWorkspaceFreezeCommandRequest,
  parseRuntimeWorkerWorkspaceFreezeCommandResponse,
  type RuntimeWorkerWorkspacePhase,
} from "./runtime-worker-workspace-api.ts";

type Reference = Readonly<{
  apiVersion: number;
  paths: Readonly<{ freezeCommand: string; dispatch: string }>;
  freeze: Readonly<{ request: unknown; response: unknown; error: unknown }>;
  dispatch: Readonly<
    Record<
      RuntimeWorkerWorkspacePhase,
      Readonly<{ request: unknown; response: unknown }>
    >
  >;
  error: unknown;
}>;

const reference = JSON.parse(
  readFileSync(
    new URL("./runtime-worker-workspace-api.reference.json", import.meta.url),
    "utf8",
  ),
) as Reference;

test("freezes independent private paths and the provider-neutral command fixture", () => {
  assert.deepEqual(
    {
      apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
      paths: {
        freezeCommand: RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
        dispatch: RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
      },
    },
    { apiVersion: reference.apiVersion, paths: reference.paths },
  );
  const request = parseRuntimeWorkerWorkspaceFreezeCommandRequest(
    reference.freeze.request,
  );
  const response = parseRuntimeWorkerWorkspaceFreezeCommandResponse(
    reference.freeze.response,
    request,
  );
  assert.deepEqual(request, reference.freeze.request);
  assert.deepEqual(response, reference.freeze.response);
  assert.deepEqual(
    parseRuntimeWorkerWorkspaceFreezeCommandError(reference.freeze.error),
    reference.freeze.error,
  );
  assert.equal("path" in response.command, false);
  assert.equal("authorization" in response.command, false);
  assert.equal("secret" in response.command, false);
});

test("parses execute, reconcile, and cancel with exact lease and result binding", () => {
  for (const phase of ["execute", "reconcile", "cancel"] as const) {
    const expected = reference.dispatch[phase];
    const request = parseRuntimeWorkerWorkspaceDispatchRequest(
      expected.request,
    );
    assert.deepEqual(request, expected.request);
    assert.deepEqual(
      parseRuntimeWorkerWorkspaceDispatchResponse(expected.response, request),
      expected.response,
    );
    assert.equal(request.phase, request.deliveryLease.phase);
    assert.equal(
      request.operation.executionId,
      request.deliveryLease.executionId,
    );
  }
  assert.deepEqual(
    parseRuntimeWorkerWorkspaceDispatchError(reference.error, "execute"),
    reference.error,
  );
});

test("rejects extra fields, private path injection, and non-Workspace authorities", () => {
  const freezeRequest = parseRuntimeWorkerWorkspaceFreezeCommandRequest(
    reference.freeze.request,
  );
  const freezeResponse = parseRuntimeWorkerWorkspaceFreezeCommandResponse(
    reference.freeze.response,
    freezeRequest,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceFreezeCommandRequest({
        ...freezeRequest,
        runId: "forged-run",
      }),
    contractCode("runtime_workspace_fields_invalid"),
  );
  for (const injected of [
    { path: "/Users/private" },
    { secret: "plaintext" },
    { authorization: { signature: "forged" } },
    { tenantId: "tenant-in-device-command" },
  ]) {
    assert.throws(
      () =>
        parseRuntimeWorkerWorkspaceFreezeCommandResponse(
          {
            ...freezeResponse,
            command: { ...freezeResponse.command, ...injected },
          },
          freezeRequest,
        ),
      contractCode("runtime_workspace_fields_invalid"),
    );
  }

  const dispatch = parseRuntimeWorkerWorkspaceDispatchRequest(
    reference.dispatch.execute.request,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchRequest({
        ...dispatch,
        operation: { ...dispatch.operation, workItemId: "forged-work" },
      }),
    contractCode("runtime_workspace_fields_invalid"),
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchRequest({
        ...dispatch,
        operation: {
          ...dispatch.operation,
          command: { ...dispatch.operation.command, path: "/tmp" },
        },
      }),
    contractCode("runtime_workspace_fields_invalid"),
  );
});

test("fails closed on phase, lease, operation, and response correlation drift", () => {
  const execute = parseRuntimeWorkerWorkspaceDispatchRequest(
    reference.dispatch.execute.request,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => parseRuntimeWorkerWorkspaceDispatchRequest(cyclic),
    contractCode("runtime_workspace_dispatch_request_too_large"),
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchRequest({
        ...execute,
        deliveryLease: { ...execute.deliveryLease, phase: "reconcile" },
      }),
    contractCode("runtime_workspace_dispatch_request_mismatch"),
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchRequest({
        ...execute,
        operation: { ...execute.operation, executionId: "substituted" },
      }),
    contractCode("runtime_workspace_operation_mismatch"),
  );

  const cancel = parseRuntimeWorkerWorkspaceDispatchRequest(
    reference.dispatch.cancel.request,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchResponse(
        reference.dispatch.reconcile.response,
        cancel,
      ),
    contractCode("runtime_workspace_dispatch_response_mismatch"),
  );
  const cancelResponse = parseRuntimeWorkerWorkspaceDispatchResponse(
    reference.dispatch.cancel.response,
    cancel,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchResponse(
        {
          ...cancelResponse,
          resolution: {
            ...cancelResponse.resolution,
            commandDigest: `sha256:${"f".repeat(64)}`,
          },
        },
        cancel,
      ),
    contractCode("runtime_workspace_resolution_mismatch"),
  );
  assert.throws(
    () => parseRuntimeWorkerWorkspaceDispatchError(reference.error, "cancel"),
    contractCode("runtime_workspace_dispatch_error_invalid"),
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceFreezeCommandError({
        ...(reference.freeze.error as Record<string, unknown>),
        certainty: "possiblySent",
      }),
    contractCode("runtime_workspace_freeze_error_invalid"),
  );
});

test("accepts completed and failed durable winners for a cancel race", () => {
  const cancel = parseRuntimeWorkerWorkspaceDispatchRequest(
    reference.dispatch.cancel.request,
  );
  const completed = reference.dispatch.reconcile.response as Record<
    string,
    unknown
  >;
  const completedWinner = parseRuntimeWorkerWorkspaceDispatchResponse(
    { ...completed, phase: "cancel" },
    cancel,
  );
  assert.equal(completedWinner.resolution.status, "completed");

  const failedWinner = parseRuntimeWorkerWorkspaceDispatchResponse(
    {
      schemaVersion: "crewon.runtime-worker-workspace-dispatch-response.v0",
      apiVersion: 1,
      phase: "cancel",
      resolution: {
        status: "failed",
        executionId: cancel.operation.executionId,
        actionDigest: cancel.operation.command.actionDigest,
        commandDigest: cancel.operation.command.commandDigest,
        providerReceiptId: "gateway-receipt-failed",
        code: "workspace_list_failed",
        retryable: false,
      },
    },
    cancel,
  );
  assert.equal(failedWinner.resolution.status, "failed");
});

test("enforces limits and aggregate request, response, and error byte caps", () => {
  const freezeRequest = parseRuntimeWorkerWorkspaceFreezeCommandRequest(
    reference.freeze.request,
  );
  const longId = `a${"b".repeat(511)}`;
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceFreezeCommandRequest({
        ...freezeRequest,
        tenantId: longId,
        spaceId: longId,
        actor: { principalId: longId, actorId: longId },
        threadFence: { ...freezeRequest.threadFence, threadId: longId },
        idempotencyKey: "i".repeat(256),
      }),
    contractCode("runtime_workspace_freeze_request_too_large"),
  );

  const freezeResponse = parseRuntimeWorkerWorkspaceFreezeCommandResponse(
    reference.freeze.response,
    freezeRequest,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceFreezeCommandResponse(
        {
          ...freezeResponse,
          command: {
            ...freezeResponse.command,
            executionId: longId,
            workspaceBindingId: longId,
            incarnationId: longId,
            runtimeBindingId: longId,
            policySnapshotId: longId,
          },
        },
        freezeRequest,
      ),
    contractCode("runtime_workspace_freeze_response_too_large"),
  );

  const execute = parseRuntimeWorkerWorkspaceDispatchRequest(
    reference.dispatch.execute.request,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchRequest({
        ...execute,
        operation: {
          ...execute.operation,
          tenantId: longId,
          spaceId: longId,
          threadId: longId,
          principalId: longId,
          actorId: longId,
          idempotencyKey: "i".repeat(256),
          executionId: longId,
          command: {
            ...execute.operation.command,
            executionId: longId,
            workspaceBindingId: longId,
            incarnationId: longId,
            runtimeBindingId: longId,
            policySnapshotId: longId,
          },
        },
        deliveryLease: {
          ...execute.deliveryLease,
          executionId: longId,
          ownerId: longId,
          leaseId: longId,
        },
      }),
    contractCode("runtime_workspace_dispatch_request_too_large"),
  );

  const reconcile = parseRuntimeWorkerWorkspaceDispatchRequest(
    reference.dispatch.reconcile.request,
  );
  const response = parseRuntimeWorkerWorkspaceDispatchResponse(
    reference.dispatch.reconcile.response,
    reconcile,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchResponse(
        {
          ...response,
          resolution: {
            ...response.resolution,
            entries: Array.from({ length: 10_000 }, (_, index) => ({
              name: `${index.toString().padStart(5, "0")}.txt`,
              kind: "file",
            })),
          },
        },
        reconcile,
      ),
    contractCode("runtime_workspace_dispatch_response_too_large"),
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchResponse(
        {
          ...response,
          resolution: {
            ...response.resolution,
            entries: Array.from({ length: 6 }, (_, index) => ({
              name: `${index}.txt`,
              kind: "file",
            })),
          },
        },
        reconcile,
      ),
    contractCode("runtime_workspace_resolution_invalid"),
  );

  const error = parseRuntimeWorkerWorkspaceDispatchError(
    reference.error,
    "execute",
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceDispatchError(
        {
          ...error,
          code: "a".repeat(128),
        },
        "execute",
      ),
    contractCode("runtime_workspace_dispatch_error_too_large"),
  );
  const freezeError = parseRuntimeWorkerWorkspaceFreezeCommandError(
    reference.freeze.error,
  );
  assert.throws(
    () =>
      parseRuntimeWorkerWorkspaceFreezeCommandError({
        ...freezeError,
        code: "a".repeat(128),
      }),
    contractCode("runtime_workspace_freeze_error_too_large"),
  );
  assert.ok(
    new TextEncoder().encode(JSON.stringify(reference.freeze.request))
      .byteLength < RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeRequestBytes,
  );
});

function contractCode(code: string) {
  return (error: unknown) =>
    error instanceof ContractValidationError && error.code === code;
}
