import assert from "node:assert/strict";
import test from "node:test";
import { ToolBrokerError, ToolResultCapacity } from "@crewon/tool-broker";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import { toolReconciliationDelay } from "./tool-reconciliation-backoff.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };

  test(
    `${backend}: a rejected mutation transfers its bounded fence to storage and resumes without replay or prefix changes`,
    options,
    async (context) => {
      const baseline = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
      });
      assert.equal((await baseline.worker().wake()).kind, "completed");
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        providerFailure: true,
        resultCapacity: capacity,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      const prefix = await fixture.history();
      await fixture.reopen();
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal((await fixture.run())?.status, "reconciling");
      assert.equal((await fixture.receipts())[0]?.status, "unknownOutcome");
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.deepEqual(await fixture.history(), prefix);
      fixture.broker.reconcile = (command) =>
        Promise.resolve({
          status: "completed",
          executionId: command.executionId,
          providerReceiptId: "verified-provider-receipt",
          result: {
            schemaVersion: "crewon.tool-result.v0",
            callId: command.callId,
            output: "tool-result",
            isError: false,
            artifactRef: null,
          },
        });
      await fixture.reopen();
      assert.equal((await fixture.worker().wake()).kind, "completed");
      assert.equal(fixture.executions(), 1);
      assert.deepEqual(fixture.requests, baseline.requests);
      assert.equal((await fixture.receipts())[0]?.status, "completed");
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "tool.completed",
        ).length,
        1,
      );
    },
  );

  test(
    `${backend}: unknown outcomes and reconciliation errors retain backoff across reopen without model calls or idle writes`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        unknownOutcome: true,
        retryAfterMs: 1000,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      const prefix = await fixture.history();
      for (let index = 0; index < 12; index += 1) {
        if (index === 3)
          fixture.broker.reconcile = async () => {
            throw new ToolBrokerError("provider_unavailable");
          };
        if (index === 6)
          fixture.broker.reconcile = async (command) => ({
            status: "unknownOutcome",
            executionId: command.executionId,
            providerReceiptId: null,
          });
        await fixture.makeDue();
        await fixture.reopen();
        const result = await fixture.worker().wake();
        assert.equal(result.kind, "retried", JSON.stringify(result));
        const attempts = (await fixture.toolAttempts())[0]!;
        assert.equal(
          fixture.retryDelays.at(-1),
          toolReconciliationDelay(1000, attempts.at(-1)!.attemptNumber),
        );
        assert.deepEqual(await fixture.history(), prefix);
      }
      assert.equal(fixture.retryDelays.at(-1), 300_000);
      const attempts = await fixture.toolAttempts();
      const events = await fixture.events();
      for (let index = 0; index < 200; index += 1)
        assert.equal((await fixture.worker().wake()).kind, "idle");
      assert.deepEqual(await fixture.toolAttempts(), attempts);
      assert.deepEqual(await fixture.events(), events);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.executions(), 1);
    },
  );

  for (const mode of ["pending", "leased"] as const) {
    test(
      `${backend}: ${mode} cancellation wakes a five-minute retry once and does not abort its own provider cancellation`,
      options,
      async (context) => {
        const ticks = new Set<() => Promise<void>>();
        const fixture = await createFixture(context, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          unknownOutcome: true,
          retryAfterMs: 300_000,
          cancellationScheduler: {
            every: (_interval, tick) => {
              ticks.add(tick);
              return () => {
                ticks.delete(tick);
              };
            },
          },
        });
        assert.equal((await fixture.worker().wake()).kind, "retried");
        const prefix = await fixture.history();
        if (mode === "leased") {
          const entered = deferred();
          const release = deferred();
          fixture.broker.reconcile = async (command) => {
            entered.resolve();
            await release.promise;
            return {
              status: "unknownOutcome",
              executionId: command.executionId,
              providerReceiptId: null,
            };
          };
          await fixture.makeDue();
          const active = fixture.worker().wake();
          try {
            await entered.promise;
            await fixture.cancel();
          } finally {
            release.resolve();
          }
          assert.equal((await active).kind, "retried");
        } else {
          assert.equal((await fixture.worker().wake()).kind, "idle");
          await fixture.cancel();
        }
        let cancellations = 0;
        fixture.broker.cancel = async (command, signal) => {
          cancellations += 1;
          for (const tick of ticks) await tick();
          assert.equal(
            signal.aborted,
            false,
            "an existing cancellation request must not abort provider.cancel",
          );
          return {
            status: "unknownOutcome",
            executionId: command.executionId,
            providerReceiptId: null,
          };
        };
        await fixture.reopen();
        assert.equal(
          (await fixture.worker().wake()).kind,
          "retried",
          "cancel should be immediately claimable after reopen",
        );
        assert.equal(cancellations, 1);
        assert.equal((await fixture.worker().wake()).kind, "idle");
        assert.deepEqual(await fixture.history(), prefix);
        assert.equal(fixture.requests.length, 1);
        fixture.broker.cancel = async (command) => ({
          status: "canceled",
          executionId: command.executionId,
          providerReceiptId: "confirmed-cancel",
        });
        await fixture.makeDue();
        assert.equal((await fixture.worker().wake()).kind, "canceled");
        assert.equal(fixture.executions(), 1);
      },
    );
  }

  test(
    `${backend}: reconciliation ACK failure leaves exactly one durable retry`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        unknownOutcome: true,
        retryAfterMs: 1000,
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      const acknowledge = fixture.broker.acknowledgeExecutionResult.bind(
        fixture.broker,
      );
      fixture.broker.acknowledgeExecutionResult = () => {
        throw new Error("reconciliation_ack_failed");
      };
      await fixture.makeDue();
      assert.deepEqual(await fixture.worker().wake(), {
        kind: "retried",
        runId: (await fixture.run())!.runId,
        code: "tool_result_acknowledgement_pending",
      });
      assert.deepEqual(fixture.retryDelays, [1000, 2000]);
      assert.equal((await fixture.worker().wake()).kind, "idle");
      fixture.broker.acknowledgeExecutionResult = acknowledge;
      await fixture.makeDue();
      await fixture.reopen();
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(fixture.retryDelays.at(-1), 4000);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.executions(), 1);
    },
  );

  test(
    `${backend}: unknown outcome ACK failure does not retry an already released lease`,
    options,
    async (context) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        unknownOutcome: true,
        settlementFailure: "beforeAck",
        resultCapacity: capacity,
      });
      assert.deepEqual(await fixture.worker().wake(), {
        kind: "retried",
        runId: (await fixture.run())!.runId,
        code: "tool_result_acknowledgement_pending",
      });
      assert.equal((await fixture.run())?.status, "reconciling");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      await fixture.reopen();
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(capacity.resourceSnapshot().reservedBytes, 0);
      assert.equal(fixture.executions(), 1);
      assert.equal(fixture.requests.length, 1);
    },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
