import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectTextPlanStore } from "@crewon/application";
import { ProjectTextPlanDurableCoordinator } from "./project-text-plan-durable-coordinator.ts";
import {
  actor,
  scope,
  deferred,
  digester,
} from "./installed-plugin-task.test-support.ts";
const locator = { actor, profileId: scope.profileId, planId: "named-plan" };
/** Named scheduling ports; real SQL checkpoint behavior is exercised separately by the dual-store conformance tests. */
function namedStore(
  scan: ProjectTextPlanStore["scanRecoverable"],
): Pick<
  ProjectTextPlanStore,
  "scanRecoverable" | "loadRunAdmission" | "readRequiredPlanDigest"
> {
  return {
    scanRecoverable: scan,
    readRequiredPlanDigest: async () => null,
    loadRunAdmission: async () => null,
  };
}
test("durable scanner reads one locator and cold replacement does not rely on an in-memory event subscription", async () => {
  const calls: string[] = [],
    limits: number[] = [];
  const store = namedStore(async (i) => {
    limits.push(i.limit);
    return { locators: [locator], nextPlanId: null };
  });
  const first = new ProjectTextPlanDurableCoordinator({
    store,
    scope,
    digester,
    coordinator: {
      process: async (l) => {
        calls.push(l.planId);
        return "observing";
      },
    },
  });
  await first.wake();
  await first.close();
  const cold = new ProjectTextPlanDurableCoordinator({
    store,
    scope,
    digester,
    coordinator: {
      process: async (l) => {
        calls.push(l.planId);
        return "waitingSelection";
      },
    },
  });
  await cold.wake();
  await cold.close();
  assert.deepEqual(calls, ["named-plan", "named-plan"]);
  assert.deepEqual(limits, [1, 1]);
});
test("coalesced wakes own one physical job and close joins its underlying preparation", async () => {
  const entered = deferred(),
    release = deferred();
  let runs = 0;
  const scan = namedStore(async () => ({
    locators: [locator],
    nextPlanId: null,
  }));
  const owner = new ProjectTextPlanDurableCoordinator({
    store: scan,
    scope,
    digester,
    coordinator: {
      process: async (_l, s) => {
        runs++;
        entered.resolve();
        await release.promise;
        s.throwIfAborted();
        return "unchanged";
      },
    },
  });
  const work = owner.wake();
  assert.equal(owner.wake(), work);
  await entered.promise;
  let joined = false;
  const closing = owner.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  await owner.wake();
  assert.equal(runs, 1);
  release.resolve();
  await assert.rejects(work);
  await closing;
  assert.equal(owner.status().pending, 0);
  assert.equal(joined, true);
});
test("foreign durable locator is refused before any coordinator work and unknown scan errors remain bounded", async () => {
  let calls = 0;
  const owner = new ProjectTextPlanDurableCoordinator({
    store: namedStore(async () => ({
      locators: [{ ...locator, profileId: "foreign" }],
      nextPlanId: null,
    })),
    scope,
    digester,
    coordinator: {
      process: async () => {
        calls++;
        return "unchanged";
      },
    },
  });
  await assert.rejects(owner.wake(), /project_text_plan_scan_scope_invalid/);
  assert.equal(calls, 0);
  assert.equal(
    owner.status().lastFailureCode,
    "project_text_plan_scan_scope_invalid",
  );
  await owner.close();
});
