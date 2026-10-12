import assert from "node:assert/strict";
import test from "node:test";
import { resolvePluginProjectWorkspaceTarget as resolve } from "../dist/ui.js";
test("workspace discovery uses the original mounted invocation exactly once without allocating or retrying", async () => {
  let calls = 0;
  const services = {
    async invoke(action, input, options) {
      calls++;
      assert.equal(this, services);
      assert.equal(action, "crewon.project-workspace-target.v1.resolveTarget");
      assert.deepEqual(input, { projectId: "p1" });
      assert.deepEqual(options, {});
      return { ...input, workspaceId: `workspace-project-${"a".repeat(64)}` };
    },
  };
  assert.equal((await resolve(services, { projectId: "p1" })).projectId, "p1");
  assert.equal(calls, 1);
  await assert.rejects(resolve(services, { projectId: "p1", owner: {} }));
  assert.equal(calls, 1);
  await assert.rejects(
    resolve(
      {
        invoke: async () => {
          calls++;
          throw Error("unavailable");
        },
      },
      { projectId: "p1" },
    ),
  );
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolve(services, { projectId: "p1" }, { signal: controller.signal }),
  );
  assert.equal(calls, 2);
  await assert.rejects(
    resolve(
      {
        invoke: async () => ({
          projectId: "other",
          workspaceId: `workspace-project-${"a".repeat(64)}`,
        }),
      },
      { projectId: "p1" },
    ),
  );
  let read = false;
  await assert.rejects(
    resolve(
      {
        get invoke() {
          read = true;
          return services.invoke;
        },
      },
      { projectId: "p1" },
    ),
  );
  assert.equal(read, false);
});

test("workspace lookup cancellation returns promptly when the Host is still pending and observes its late failure", async () => {
  const controller = new AbortController();
  let rejectHost;
  let calls = 0;
  const services = {
    invoke: () => {
      calls++;
      return new Promise((_, reject) => {
        rejectHost = reject;
      });
    },
  };
  const pending = resolve(
    services,
    { projectId: "p1" },
    { signal: controller.signal },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await cancelled;
  rejectHost(Error("late failure"));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
});
