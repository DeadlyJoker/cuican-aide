import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  RunApplicationService,
  ThreadApplicationService,
} from "@crewon/application";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { RuntimePreflight } from "./runtime-preflight.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import {
  deferred,
  storeAccessClock,
  until,
} from "./runtime-store-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 30000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: a resident runtime can settle cancellation while cold preflight admission is full`,
    options,
    async (t) => {
      const held = deferred(),
        clock = storeAccessClock();
      const owners = [0, 1].map(
        () =>
          new RuntimePreflight({ leaseDurationMs: 30000, time: clock.time }),
      );
      t.after(() => {
        held.resolve();
        for (const owner of owners) owner.close();
      });
      const blocked: Promise<unknown>[] = [];
      for (const owner of owners)
        for (let i = 0; i < 4; i++)
          blocked.push(
            owner
              .run({
                identity: {
                  tenantId: "other",
                  kind: "runtime",
                  resourceId: `loading-${i}`,
                },
                operation: () => held.promise,
              })
              .catch((e) => e.code),
          );
      let coldReads = 0;
      const registry = new InMemoryAgentVersionRuntimeRegistry({
        sha256: (value) => `sha256:${requireDigest(value)}`,
      });
      t.after(() => registry.close());
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        runtimeResolverFactory: (runtime) => {
          registry.register({ tenantId: "tenant-1", runtime });
          return {
            resolveResident: (locator) => registry.resolveResident(locator),
            resolve: (locator) => {
              coldReads++;
              return registry.resolve(locator);
            },
          };
        },
      });
      await f.cancel();
      assert.equal((await f.worker().wake()).kind, "canceled");
      assert.equal(coldReads, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.worker().preflightSnapshot().processRequests, 8);
      held.resolve();
      await Promise.all(blocked);
      assert.equal(f.worker().preflightSnapshot().processRequests, 0);
    },
  );
  test(
    `${backend}: a pending prior-model resolver cannot fall through to the current model after timeout`,
    options,
    async (t) => {
      const clock = storeAccessClock(),
        entered = deferred(),
        held = deferred();
      t.after(() => held.resolve());
      let switched = false,
        resolutions = 0,
        compactions = 0;
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        preflightTime: clock.time,
        runtimeResolverFactory: (base) => {
          const version = base.version;
          const runtime = switched
            ? {
                ...base,
                version: compileAgentVersion(
                  {
                    schemaVersion: "crewon.agent-version-source.v0",
                    agentVersionId: version.agentVersionId,
                    runtimeGeneration: version.runtimeGeneration,
                    policySnapshotId: version.policySnapshotId,
                    instructions: version.instructions,
                    model: {
                      ...version.model,
                      contextWindowTokens: 100,
                      autoCompactAtTokens: 50,
                    },
                    execution: version.execution,
                    resources: version.resources,
                    tools: version.tools,
                  },
                  { sha256: (value) => `sha256:${requireDigest(value)}` },
                ),
              }
            : base;
          return { resolve: () => runtime };
        },
        modelSwitchCompactionResolver: {
          resolve: async () => {
            resolutions++;
            entered.resolve();
            await held.promise;
            return {
              executionAuthority: "crewonKernel",
              compactor: {
                compact: async () => {
                  compactions++;
                  throw new Error("late compactor must not execute");
                },
              },
            };
          },
        },
      });
      assert.equal((await f.worker().wake()).kind, "completed");
      switched = true;
      f.fixtureScope.route.agentVersionId = "agent-version-small";
      await f.nextUserTurn();
      await f.reopen();
      const wake = f.worker().wake();
      await entered.promise;
      const history = await f.history(),
        requests = structuredClone(f.requests);
      assert.equal(requests.length, 2);
      clock.advance(10000);
      assert.equal((await wake).kind, "leaseLost");
      assert.equal(f.worker().preflightSnapshot().pendingRequests, 1);
      await f.worker().close();
      held.resolve();
      await until(() => f.worker().preflightSnapshot().pendingRequests === 0);
      assert.equal(resolutions, 1);
      assert.equal(compactions, 0);
      assert.deepEqual(f.requests, requests);
      assert.deepEqual(await f.history(), history);
    },
  );
  for (const storeResponses of [false, true])
    test(
      `${backend}: slow policy yields to another Thread and resumes the original model prefix, stored=${storeResponses}`,
      options,
      async (t) => {
        const clock = storeAccessClock(),
          held = deferred(),
          entered = deferred();
        t.after(() => held.resolve());
        let mainId: string | null = null,
          mainCalls = 0;
        const f = await createFixture(t, {
          backend,
          storeResponses,
          crashAfterCommit: false,
          preflightTime: clock.time,
          policy: {
            evaluate: async ({ run }) => {
              mainId ??= run.runId;
              if (run.runId === mainId && ++mainCalls === 2) {
                entered.resolve();
                await held.promise;
              }
              return { outcome: "allow" };
            },
          },
        });
        const siblingId = await startSibling(f);
        const wake = f.worker().wake();
        await entered.promise;
        const history = await f.history(),
          events = await f.events();
        assert.equal(f.requests.length, 1);
        assert.equal(f.executions(), 1);
        clock.advance(10000);
        assert.equal((await wake).kind, "leaseLost");
        assert.equal(f.worker().preflightSnapshot().pendingRequests, 1);
        assert.deepEqual(await f.worker().wake(), {
          kind: "completed",
          runId: siblingId,
        });
        assert.equal(f.requests.length, 2);
        assert.deepEqual(await f.history(), history);
        assert.deepEqual(await f.events(), events);
        await f.expireLease();
        assert.equal((await f.worker().wake()).kind, "leaseLost");
        assert.equal(mainCalls, 2);
        assert.equal(f.requests.length, 2);
        held.resolve();
        await until(() => f.worker().preflightSnapshot().pendingRequests === 0);
        assert.equal(f.requests.length, 2);
        await f.expireLease();
        const resumed = await wakeAfterStoreContention(f);
        assert.equal(resumed.kind, "completed", JSON.stringify(resumed));
        assert.equal(mainCalls, 3);
        assert.equal(f.executions(), 1);
        assert.equal(f.requests.length, 3);
        assert.deepEqual((await f.history()).slice(0, history.length), history);
        assert.deepEqual((await f.events()).slice(0, events.length), events);
        for (const key of ["model", "instructions", "tools"])
          assert.deepEqual(f.requests[2]?.[key], f.requests[0]?.[key]);
        if (storeResponses) {
          assert.equal(f.requests[2]?.previous_response_id, "resp-tools");
          assert.deepEqual(f.requests[2]?.input, [
            {
              type: "function_call_output",
              call_id: "call-1",
              output: "tool-result",
            },
          ]);
        } else {
          const original = f.requests[0]?.input as unknown[],
            input = f.requests[2]?.input as unknown[];
          assert.deepEqual(input.slice(0, original.length), original);
          assert.deepEqual(input.at(-1), {
            type: "function_call_output",
            call_id: "call-1",
            output: "tool-result",
          });
        }
      },
    );

  test(
    `${backend}: cancel completes while old policy is unresolved and late allow cannot restart it`,
    options,
    async (t) => {
      const clock = storeAccessClock(),
        held = deferred(),
        entered = deferred();
      t.after(() => held.resolve());
      let calls = 0;
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        preflightTime: clock.time,
        policy: {
          evaluate: async () => {
            calls++;
            entered.resolve();
            await held.promise;
            return { outcome: "allow" };
          },
        },
      });
      const wake = f.worker().wake();
      await entered.promise;
      clock.advance(10000);
      assert.equal((await wake).kind, "leaseLost");
      await f.cancel();
      await f.expireLease();
      assert.equal((await f.worker().wake()).kind, "canceled");
      const history = await f.history(),
        events = await f.events();
      held.resolve();
      await until(() => f.worker().preflightSnapshot().pendingRequests === 0);
      assert.equal((await f.worker().wake()).kind, "idle");
      assert.equal(calls, 1);
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await f.history(), history);
      assert.deepEqual(await f.events(), events);
    },
  );

  test(
    `${backend}: close ends the policy wait immediately but keeps its physical admission until release`,
    options,
    async (t) => {
      const clock = storeAccessClock(),
        held = deferred(),
        entered = deferred();
      t.after(() => held.resolve());
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        preflightTime: clock.time,
        policy: {
          evaluate: async () => {
            entered.resolve();
            await held.promise;
            return { outcome: "allow" };
          },
        },
      });
      const wake = f.worker().wake();
      await entered.promise;
      const before = {
        run: await f.run(),
        history: await f.history(),
        events: await f.events(),
      };
      await f.worker().close();
      assert.equal((await wake).kind, "leaseLost");
      assert.equal(f.worker().preflightSnapshot().pendingRequests, 1);
      assert.equal(f.worker().storeAccessSnapshot().wakePending, false);
      assert.equal(clock.timers.size, 0);
      held.resolve();
      await until(() => f.worker().preflightSnapshot().pendingRequests === 0);
      assert.equal(f.requests.length, 0);
      assert.deepEqual(
        {
          run: await f.run(),
          history: await f.history(),
          events: await f.events(),
        },
        before,
      );
      await f.expireLease();
      await f.reopen();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.executions(), 1);
    },
  );

  test(
    `${backend}: late lazy materialization stays owned by its registry and is reused without recreating the model runtime`,
    options,
    async (t) => {
      const clock = storeAccessClock(),
        held = deferred(),
        entered = deferred();
      t.after(() => held.resolve());
      let factoryCalls = 0,
        closes = 0,
        resolver: StoreBackedAgentVersionRuntimeResolver | undefined;
      let registry: InMemoryAgentVersionRuntimeRegistry | undefined;
      let cached:
        | import("./agent-version-runtime.ts").AgentVersionRuntime
        | undefined;
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        preflightTime: clock.time,
        runtimeResolverFactory: (runtime, store) => {
          if (resolver !== undefined) return resolver;
          const digester = {
            sha256: (value: string) => `sha256:${requireDigest(value)}`,
          };
          registry = new InMemoryAgentVersionRuntimeRegistry(digester);
          const registered = store.registerAgentVersion(
            createAgentVersionAsset({
              tenantId: "tenant-1",
              version: runtime.version,
              createdAt: "2026-09-15T00:00:00Z",
            }),
          );
          const inner = new StoreBackedAgentVersionRuntimeResolver({
            store,
            registry,
            digester,
            factory: {
              create: async ({ version }) => {
                factoryCalls++;
                assert.deepEqual(version, runtime.version);
                entered.resolve();
                await held.promise;
                cached = {
                  ...runtime,
                  close: async () => {
                    closes++;
                  },
                };
                return cached;
              },
            },
          });
          resolver = inner;
          return {
            resolveResident: (locator) => inner.resolveResident(locator),
            resolve: async (locator) => {
              await registered;
              return inner.resolve(locator);
            },
            nextToolResultMaintenanceRuntime: () =>
              inner.nextToolResultMaintenanceRuntime(),
          };
        },
      });
      t.after(() => registry?.close());
      const wake = f.worker().wake();
      await entered.promise;
      clock.advance(10000);
      assert.equal((await wake).kind, "leaseLost");
      const before = { history: await f.history(), events: await f.events() };
      await f.expireLease();
      assert.equal((await f.worker().wake()).kind, "leaseLost");
      assert.equal(factoryCalls, 1);
      assert.equal(closes, 0);
      assert.equal(f.requests.length, 0);
      held.resolve();
      await until(() => f.worker().preflightSnapshot().pendingRequests === 0);
      assert.ok(cached !== undefined);
      assert.equal(
        registry?.resolve({
          tenantId: "tenant-1",
          agentVersionId: cached.version.agentVersionId,
        }),
        cached,
      );
      assert.deepEqual(
        { history: await f.history(), events: await f.events() },
        before,
      );
      await f.expireLease();
      await f.reopen();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(factoryCalls, 1);
      assert.equal(closes, 0);
      assert.equal(f.executions(), 1);
      assert.equal(f.requests[0]?.instructions, cached.version.instructions);
      assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(f.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
      ]);
      await f.worker().close();
      await registry?.close();
      assert.equal(closes, 1);
    },
  );
}

async function wakeAfterStoreContention(
  f: Awaited<ReturnType<typeof createFixture>>,
) {
  for (let wake = 0; wake < 8; wake++) {
    const outcome = await f.worker().wake();
    if (outcome.kind !== "retried" || outcome.code !== "run_store_busy")
      return outcome;
    await delay(250);
    await f.makeDue();
  }
  throw new Error("fixture_store_contention_did_not_settle");
}

async function startSibling(f: Awaited<ReturnType<typeof createFixture>>) {
  const { actor, route, ...deps } = f.fixtureScope,
    store = f.store();
  const threads = new ThreadApplicationService({ store, ...deps });
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "sibling-thread",
    title: null,
  });
  await threads.appendMessage(actor, {
    kind: "thread.message.append",
    threadId: thread.state.threadId,
    expectedRevision: thread.state.revision,
    idempotencyKey: "sibling-message",
    role: "user",
    content: "independent sibling",
  });
  const run = await new RunApplicationService({ store, ...deps }).createRun(
    actor,
    {
      kind: "run.create",
      threadId: thread.state.threadId,
      idempotencyKey: "sibling-run",
      route,
      toolPermissionMode: "fullAccess",
    },
  );
  return run.state.runId;
}

import { createHash } from "node:crypto";
function requireDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
