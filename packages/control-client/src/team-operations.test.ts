import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "./control-api-client.ts";
import { createControlApiTeamOperations } from "./team-operations.ts";

test("default fencing returns an immutable facade for concurrent Team tasks", () => {
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () => {
      throw new Error("network must not be used");
    },
  });
  const operations = createControlApiTeamOperations(client);
  const fenced = operations.withTeamTaskFence({
    tenantId: "tenant-1",
    spaceId: "space-1",
    taskId: "task-1",
    ownerId: "owner-1",
    leaseId: "lease-1",
    epoch: 1,
  });
  assert.notEqual(fenced, operations);
});

test("preserveIdentity keeps operation instrumentation for recovery tests", async () => {
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () => {
      throw new Error("network must not be used");
    },
  });
  const operations = createControlApiTeamOperations(client, {
    preserveIdentity: true,
  });
  let calls = 0;
  operations.getRun = async () => {
    calls++;
    return {} as never;
  };
  const fenced = operations.withTeamTaskFence({
    tenantId: "tenant-1",
    spaceId: "space-1",
    taskId: "task-1",
    ownerId: "owner-1",
    leaseId: "lease-1",
    epoch: 1,
  });
  assert.equal(fenced, operations);
  await fenced.getRun("run-1");
  assert.equal(calls, 1);
});
