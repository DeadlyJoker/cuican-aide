import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { DomainStore } from "@crewon/application";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const stored of [false, true])
  for (const canceled of [false, true]) {
    test(
      `postgres: checkpoint contention preserves committed tools and exact model input, stored=${stored}, canceled=${canceled}`,
      {
        skip: !process.env.CREWON_TEST_POSTGRES_URL,
        timeout: 30_000,
      },
      async (t) => {
        // Advisory Run keys are database-wide, even when fixture schemas differ.
        const runIdPrefix = randomUUID();
        const retryAfterMs = stored ? 1_000 : 0;
        const admin = new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        });
        let blocker: PoolClient | null = null;
        let fallback: NodeJS.Timeout | null = null;
        let blocked = false;
        let captured!: {
          tenantId: string;
          runId: string;
          stepId: string;
        };
        let stepBefore!: Awaited<ReturnType<DomainStore["loadRunStep"]>>;
        let attemptBefore!: Awaited<ReturnType<DomainStore["loadRunAttempt"]>>;
        const release = async () => {
          if (fallback) clearTimeout(fallback);
          fallback = null;
          const client = blocker;
          blocker = null;
          if (client) {
            try {
              await client.query("ROLLBACK");
            } finally {
              client.release();
            }
          }
        };
        t.after(async () => {
          await release();
          await admin.end();
        });
        const normal = await createFixture(t, {
          runIdPrefix,
          backend: "postgres",
          storeResponses: stored,
          crashAfterCommit: false,
        });
        const normalOutcome = await normal.worker().wake();
        assert.equal(
          normalOutcome.kind,
          "completed",
          JSON.stringify(normalOutcome),
        );
        const f = await createFixture(t, {
          runIdPrefix,
          retryAfterMs,
          backend: "postgres",
          storeResponses: stored,
          crashAfterCommit: false,
          executionBudget: { maxBoundariesPerWake: 1 },
          decorateStore: (store) =>
            new Proxy(store, {
              get(target, property) {
                if (property === "executionProgress") {
                  const port = target.executionProgress!;
                  return {
                    ...port,
                    load: async (input: Parameters<typeof port.load>[0]) => {
                      if (blocked && blocker === null) {
                        captured = {
                          ...input.scope,
                          stepId: input.lease.workItemId,
                        };
                        stepBefore = await target.loadRunStep(captured);
                        if (stepBefore?.currentAttemptId) {
                          attemptBefore = await target.loadRunAttempt({
                            ...captured,
                            attemptId: stepBefore.currentAttemptId,
                          });
                        }
                        blocker = await admin.connect();
                        await blocker.query("BEGIN");
                        await blocker.query(
                          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                          [`run:${input.scope.tenantId}:${input.scope.runId}`],
                        );
                        // Failures must still release the fixture's lock without hanging cleanup.
                        fallback = setTimeout(() => {
                          void release();
                        }, 5_000);
                      }
                      return port.load(input);
                    },
                  };
                }
                const value: unknown = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
        });
        assert.equal((await f.worker().wake()).kind, "retried");
        assert.equal(f.requests.length, 1);
        assert.equal(f.executions(), 1);
        await f.reopen();
        await f.makeDue();
        if (canceled) await f.cancel();
        const history = await f.history(),
          events = await f.events(),
          calls = await f.callRecords();
        blocked = true;
        const outcome = await f.worker().wake();
        assert.equal(outcome.kind, "retried", JSON.stringify(outcome));
        assert.equal(
          "code" in outcome && outcome.code,
          "run_store_busy",
          JSON.stringify(outcome),
        );
        assert(blocker, "the lock should still be held when scheduling yields");
        assert(captured);
        assert.deepEqual(await f.store().loadRunStep(captured), stepBefore!);
        if (stepBefore?.currentAttemptId) {
          assert.deepEqual(
            await f.store().loadRunAttempt({
              ...captured,
              attemptId: stepBefore.currentAttemptId,
            }),
            attemptBefore!,
          );
        }
        assert.deepEqual(await f.history(), history);
        assert.deepEqual(await f.events(), events);
        assert.deepEqual(await f.callRecords(), calls);
        assert.equal(f.requests.length, 1);
        assert.equal(f.executions(), 1);
        assert.equal(f.retryDelays.at(-1), Math.max(250, retryAfterMs));
        blocked = false;
        await release();
        await f.reopen();
        await f.makeDue();
        const result = await f.worker().wake();
        assert.equal(
          result.kind,
          canceled ? "canceled" : "completed",
          JSON.stringify(result),
        );
        assert.equal(f.executions(), 1);
        assert.equal(f.requests.length, canceled ? 1 : 2);
        assert.deepEqual(
          f.requests,
          normal.requests.slice(0, canceled ? 1 : 2),
        );
        assert.deepEqual(
          f.requestBodyDigests,
          normal.requestBodyDigests.slice(0, canceled ? 1 : 2),
        );
        assert.equal(
          (await f.events()).filter((event) => event.type === "tool.completed")
            .length,
          1,
        );
      },
    );
  }
