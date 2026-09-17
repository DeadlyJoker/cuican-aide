import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ArtifactApplicationService } from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ToolResultCapacity } from "@crewon/tool-broker";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import { ToolResultMaintenanceQuery } from "./tool-result-maintenance-query.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };
  test(
    `${backend}: idle maintenance releases a terminal Run's interrupted ACK without changing durable history or model requests`,
    options,
    async (t) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const artifacts = new ArtifactApplicationService({
        store: new InMemoryArtifactStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => "2026-09-14T00:00:00Z" },
        ids: { nextId: () => "artifact-result-1" },
        digester: {
          sha256: (value) =>
            `sha256:${createHash("sha256").update(value).digest("hex")}`,
        },
        encryptionKeyId: "test-key",
      });
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        resultCapacity: capacity,
        output: "result".repeat(40_000),
        artifacts,
      });
      const interrupted = t.mock.method(
        f.broker,
        "acknowledgeExecutionResult",
        () => undefined,
      );
      const completed = await f.worker().wake();
      assert.equal(completed.kind, "completed", JSON.stringify(completed));
      assert.equal((await f.run())?.status, "completed");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      assert.equal((await f.receipts())[0]?.status, "completed");
      const history = await f.history(),
        events = await f.events(),
        requests = structuredClone(f.requests);
      interrupted.mock.restore();
      assert.equal((await f.worker().wake()).kind, "idle");
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(f.worker().toolResultMaintenanceSnapshot().acknowledged, 1);
      assert.deepEqual(await f.history(), history);
      assert.deepEqual(await f.events(), events);
      assert.deepEqual(f.requests, requests);
      assert.equal(f.executions(), 1);
      await f.nextUserTurn();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.requests[2]?.previous_response_id, "resp-answer");
      assert.deepEqual(f.requests[2]?.input, [
        { role: "user", content: "next user turn" },
      ]);
      for (const key of ["model", "instructions", "tools"])
        assert.deepEqual(f.requests[2]?.[key], f.requests[0]?.[key]);
      assert.equal(f.executions(), 1);
    },
  );

  test(
    `${backend}: saturated maintenance admission preserves execution and resumes ACK without changing model continuation`,
    options,
    async (t) => {
      const blocked = Array.from(
        { length: 4 },
        () => new ToolResultMaintenanceQuery(),
      );
      const releases: (() => void)[] = [];
      const pending = blocked.map((owner) =>
        owner.read({
          query: {
            tenantId: "other-tenant",
            runId: "old-run",
            actionDigest: "old-action",
          },
          store: {
            loadToolExecutionReceiptByAction: () =>
              new Promise((resolve) => {
                releases.push(() => resolve(null));
              }),
          },
        }),
      );
      t.after(async () => {
        blocked.forEach((owner) => owner.close());
        releases.forEach((release) => release());
        await Promise.all(pending);
        await new Promise<void>((done) => setImmediate(done));
      });
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        resultCapacity: capacity,
      });
      const interrupted = t.mock.method(
        f.broker,
        "acknowledgeExecutionResult",
        () => undefined,
      );
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      interrupted.mock.restore();
      const history = await f.history(),
        events = await f.events(),
        requests = structuredClone(f.requests);
      assert.equal((await f.worker().wake()).kind, "idle");
      assert.equal(f.worker().toolResultMaintenanceSnapshot().receiptReads, 0);
      assert.equal(
        f.worker().toolResultMaintenanceSnapshot().processReceiptReads,
        4,
      );
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      releases[0]();
      await pending[0];
      assert.equal((await f.worker().wake()).kind, "idle");
      assert.equal(f.worker().toolResultMaintenanceSnapshot().acknowledged, 1);
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.deepEqual(await f.history(), history);
      assert.deepEqual(await f.events(), events);
      assert.deepEqual(f.requests, requests);
      assert.equal(f.executions(), 1);
      await f.nextUserTurn();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.requests[2]?.previous_response_id, "resp-answer");
      assert.deepEqual(f.requests[2]?.input, [
        { role: "user", content: "next user turn" },
      ]);
      for (const key of ["model", "instructions", "tools"])
        assert.deepEqual(f.requests[2]?.[key], f.requests[0]?.[key]);
      assert.equal(f.executions(), 1);
    },
  );

  test(
    `${backend}: maintenance preserves a resolved but uncommitted effect until normal leased recovery`,
    options,
    async (t) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        crashAfterResolved: true,
        resultCapacity: capacity,
      });
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.equal((await f.receipts())[0]?.status, "dispatched");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.worker().toolResultMaintenanceSnapshot().acknowledged, 0);
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(f.executions(), 1);
      assert.equal(f.requests.length, 2);
    },
  );
}
