import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "./control-api-client.ts";
import { createControlApiTeamOperations } from "./team-operations.ts";

test("fencing keeps one Team operations facade and preserves operation instrumentation", async () => {
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () => {
      throw new Error("network must not be used");
    },
  });
  const operations = createControlApiTeamOperations(client);
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
