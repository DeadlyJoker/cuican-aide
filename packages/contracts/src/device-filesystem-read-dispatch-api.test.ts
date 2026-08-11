import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseDeviceFilesystemReadPeerDispatchRequest,
  parseDeviceFilesystemReadWorkerDispatchRequest,
} from "./device-filesystem-read-dispatch-api.ts";
import { deviceFilesystemReadDispatchApiJsonSchemas } from "./device-filesystem-read-dispatch-api-schema.ts";
import {
  canonicalDeviceFilesystemReadCommandDigest,
  type DeviceFilesystemReadCommand,
} from "./device-filesystem-read.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const command = fixture.valid
  .filesystemReadCommand as DeviceFilesystemReadCommand;
const intent = {
  deviceBindingId: "device-binding-1",
  runtimeBindingId: "runtime-binding-1",
};
const reference = {
  deviceId: command.deviceId,
  executionId: command.executionId,
  workspaceBindingId: command.workspaceBindingId,
  incarnationId: command.arguments.workspaceIncarnationId,
  ...intent,
  actionDigest: command.actionDigest,
  commandDigest: canonicalDeviceFilesystemReadCommandDigest(
    command,
    digestUtf8,
  ),
  leaseId: command.leaseId,
  leaseEpoch: command.leaseEpoch,
  receiptId: null,
};

test("parses strict read execute, durable reconcile, and lease-exact cancel", () => {
  for (const request of [
    {
      schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
      apiVersion: 1,
      operation: "execute",
      routeIntent: intent,
      command,
    },
    {
      schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
      apiVersion: 1,
      operation: "reconcile",
      routeIntent: intent,
      reference,
    },
    {
      schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
      apiVersion: 1,
      operation: "cancel",
      routeIntent: intent,
      reference,
    },
  ])
    assert.deepEqual(
      parseDeviceFilesystemReadWorkerDispatchRequest(request),
      request,
    );
});

test("peer transport freezes complete route intent and rejects drift", () => {
  const route = {
    deviceId: command.deviceId,
    gatewayId: "gateway-b",
    connectionId: "connection-1",
    connectionEpoch: 7,
    ...intent,
    capability: "workspace.read_file.v0",
    leaseExpiresAt: "2026-08-08T00:01:00Z",
  };
  const request = {
    schemaVersion: "crewon.device-filesystem-read-peer-dispatch-request.v0",
    apiVersion: 1,
    sourceGatewayId: "gateway-a",
    sourceWorker: { workerId: "worker-1", credentialId: "credential-1" },
    route,
    operation: "cancel",
    reference,
  };
  assert.deepEqual(
    parseDeviceFilesystemReadPeerDispatchRequest(request),
    request,
  );
  assert.throws(() =>
    parseDeviceFilesystemReadPeerDispatchRequest({
      ...request,
      route: { ...route, runtimeBindingId: "other" },
    }),
  );
});

test("parser branches and schemas expose the same exact top-level fields", () => {
  const worker = deviceFilesystemReadDispatchApiJsonSchemas.workerRequest.oneOf!;
  const peer = deviceFilesystemReadDispatchApiJsonSchemas.peerRequest.oneOf!;
  assert.deepEqual(
    worker.map((branch) => [...branch.required].sort()),
    [
      ["apiVersion", "command", "operation", "routeIntent", "schemaVersion"],
      ["apiVersion", "operation", "reference", "routeIntent", "schemaVersion"],
      ["apiVersion", "operation", "reference", "routeIntent", "schemaVersion"],
    ],
  );
  assert.ok(
    peer.every(
      (branch) =>
        branch.additionalProperties === false &&
        branch.required.includes("route") &&
        branch.required.includes("sourceWorker"),
    ),
  );
  assert.equal(
    deviceFilesystemReadDispatchApiJsonSchemas.workerResponse
      .additionalProperties,
    false,
  );
  assert.equal(
    deviceFilesystemReadDispatchApiJsonSchemas.peerResponse
      .additionalProperties,
    false,
  );
});

function digestUtf8(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
