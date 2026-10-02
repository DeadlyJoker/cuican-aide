import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginUiLease } from "@crewon/contracts/plugins";
import type {
  PluginUiActionContext,
  PluginUiCommittedTaskAuthority,
} from "@crewon/application";
import type {
  PluginActionsService,
  PluginIdentity,
  PluginTaskService,
} from "@crewon/plugin-sdk/node";
import {
  uiTestActor,
  uiTestScope,
  uiTestDescriptor,
  uiTestPackage,
  uiTestSelection,
  uiTestAt,
} from "../../application/src/plugin-ui.test-support.ts";
import { PluginNodeHost } from "./plugin-node-host.ts";
import { PluginTaskActionBridge } from "./plugin-task-action-bridge.ts";
import { registerPluginUiInvocation } from "../../application/src/plugin-ui-invocation-authority.ts";

function fixture() {
  let now = uiTestAt;
  let epoch = "fixture-epoch";
  let scope = uiTestScope;
  let selection = uiTestSelection;
  let releases = 0;
  let taskCalls = 0;
  let id = 0;
  const context: PluginUiActionContext = {
    actor: uiTestActor,
    scope: uiTestScope,
    selection: uiTestSelection,
    package: uiTestPackage,
    authorityEpoch: epoch,
    action: "read",
    input: { value: 1 },
    lease: parsePluginUiLease({
      schemaVersion: "crewon.plugin-ui-lease.v1",
      mountRef: "m".repeat(32),
      expiresAt: "2026-10-02T03:05:00.000Z",
      selectionRevision: 2,
      packageDigest: uiTestPackage.packageDigest,
      descriptor: uiTestDescriptor,
      contributionId: "workbench",
      publicAssets: ["ui.mjs"],
    }),
  };
  // These are narrow unit doubles; real package/Run/credit behavior is covered by the integration suite.
  const bridge = new PluginTaskActionBridge({
    tasks: {
      async createTaskFromPlugin() {
        taskCalls++;
        throw new Error("fixture_task_rejected");
      },
    },
    committedTasks: {
      async issue() {
        throw new Error("must_not_issue");
      },
    } as unknown as PluginUiCommittedTaskAuthority,
    profiles: {
      async resolve() {
        return scope;
      },
    },
    authorization: {
      async authorize() {
        return { outcome: "allow", authorityEpoch: epoch };
      },
    },
    currentSelection: () => selection,
    clock: { now: () => now },
    ids: { nextId: () => (++id).toString().padStart(32, "r") },
  });
  const identity = Object.freeze({
    pluginId: context.package.pluginId,
    version: context.package.version,
    packageDigest: context.package.packageDigest,
  });
  let actualIdentity: PluginIdentity = identity;
  let service: PluginActionsService = {
    actions: [{ contributionId: "workbench", action: "read", kind: "read" }],
    async invoke() {
      return { read: true };
    },
  };
  const node = {
    acquire(input: Parameters<PluginNodeHost["acquire"]>[0]) {
      assert.equal(input.authorizeBorrow(actualIdentity), "allow");
      return {
        identity: actualIdentity,
        getService: () => service,
        release() {
          releases++;
        },
      };
    },
  } as unknown as PluginNodeHost;
  const bound = (owner: PluginIdentity = identity) =>
    bridge.hostService().bindForPlugin!(owner) as PluginTaskService;
  return {
    bridge,
    context,
    node,
    identity,
    bound,
    async invoke(next: PluginUiActionContext = context) {
      const dispose = registerPluginUiInvocation(next, async () => {});
      try {
        return await bridge.actions(node).invoke(next);
      } finally {
        dispose();
      }
    },
    setService: (next: PluginActionsService) => {
      service = next;
    },
    setIdentity: (next: PluginIdentity) => {
      actualIdentity = next;
    },
    setEpoch: (next: string) => {
      epoch = next;
    },
    setNow: (next: string) => {
      now = next;
    },
    setScope: (next: typeof scope) => {
      scope = next;
    },
    setSelection: (next: typeof selection) => {
      selection = next;
    },
    counts: () => ({ releases, taskCalls }),
  };
}
const request = (invocationRef: string) => ({
  invocationRef,
  threadId: "thread",
  expectedThreadRevision: 1,
  idempotencyKey: "intent",
  input: { prompt: "Image" },
});

test("bridge binds opaque references to the actual instance and refuses same-shaped foreign ports", async () => {
  const f = fixture();
  const foreign = f.bound(Object.freeze({ ...f.identity }));
  f.setService({
    actions: [
      { contributionId: "workbench", action: "generate", kind: "generateTask" },
    ],
    async invoke({ invocationRef }) {
      await assert.rejects(
        foreign.createTask(request(invocationRef)),
        /plugin_invocation_owner_mismatch/u,
      );
      return { refused: true };
    },
  });
  assert.deepEqual(await f.invoke({ ...f.context, action: "generate" }), {
    refused: true,
  });
  assert.deepEqual(f.counts(), { releases: 1, taskCalls: 0 });
});

test("read declarations cannot create tasks; references expire at dispatch completion", async () => {
  const f = fixture();
  const bound = f.bound();
  let ref = "";
  f.setService({
    actions: [{ contributionId: "workbench", action: "read", kind: "read" }],
    async invoke({ invocationRef }) {
      ref = invocationRef;
      await assert.rejects(
        bound.createTask(request(ref)),
        /plugin_invocation_owner_mismatch/u,
      );
      return { read: true };
    },
  });
  await f.invoke(f.context);
  await assert.rejects(
    bound.createTask(request(ref)),
    /plugin_invocation_owner_mismatch/u,
  );
  assert.deepEqual(f.counts(), { releases: 1, taskCalls: 0 });
});

test("host validates the complete declared action table before invoking business code", async () => {
  const f = fixture();
  let invoked = 0;
  let getters = 0;
  const declaration = Object.defineProperty(
    { contributionId: "workbench", action: "read", kind: "read" },
    "kind",
    {
      enumerable: true,
      get() {
        getters++;
        return "read";
      },
    },
  );
  f.setService({
    actions: [declaration as never],
    async invoke() {
      invoked++;
      return null;
    },
  });
  await assert.rejects(f.invoke(f.context), /plugin_action_input_invalid/u);
  assert.equal(invoked, 0);
  assert.equal(getters, 0);
  assert.equal(f.counts().releases, 1);
});

test("action table rejects accessor indices, overridden iterators, sparse and extra entries without executing them", async () => {
  const declaration = {
    contributionId: "workbench",
    action: "read",
    kind: "read" as const,
  };
  let invoked = 0;
  let getters = 0;
  const indexed = Object.defineProperty([declaration], "0", {
    enumerable: true,
    get() {
      getters++;
      return declaration;
    },
  });
  const iterator = Object.defineProperty([declaration], Symbol.iterator, {
    value() {
      getters++;
      throw new Error("must_not_iterate");
    },
  });
  const hidden = Object.defineProperty([declaration], "extra", {
    value: declaration,
  });
  const sparse = new Array(1);
  const prototype = Object.setPrototypeOf([declaration], null);
  for (const actions of [indexed, iterator, hidden, sparse, prototype]) {
    const f = fixture();
    f.setService({
      actions,
      async invoke() {
        invoked++;
        return null;
      },
    });
    await assert.rejects(
      f.invoke(f.context),
      /plugin_action_declarations_invalid/u,
    );
    assert.equal(f.counts().releases, 1);
  }
  assert.equal(getters, 0);
  assert.equal(invoked, 0);
});

test("SDK task requests reject client actor/payer fields and accessors before invoking task admission", async () => {
  const f = fixture();
  const bound = f.bound();
  let getters = 0;
  f.setService({
    actions: [
      { contributionId: "workbench", action: "generate", kind: "generateTask" },
    ],
    async invoke({ invocationRef }) {
      await assert.rejects(
        bound.createTask({
          ...request(invocationRef),
          actor: uiTestActor,
        } as never),
        /plugin_action_input_invalid/u,
      );
      const hidden = Object.defineProperty(request(invocationRef), "input", {
        enumerable: true,
        get() {
          getters++;
          return {};
        },
      });
      await assert.rejects(
        bound.createTask(hidden),
        /plugin_action_input_invalid/u,
      );
      await assert.rejects(
        bound.createTask({
          ...request(invocationRef),
          idempotencyKey: "x".repeat(16_384),
        }),
        /plugin_task_request_invalid/u,
      );
      return null;
    },
  });
  await f.invoke({ ...f.context, action: "generate" });
  assert.equal(getters, 0);
  assert.equal(f.counts().taskCalls, 0);
});

test("one invocation permits one stable task command even if plugin calls the port repeatedly", async () => {
  const f = fixture();
  const bound = f.bound();
  f.setService({
    actions: [
      { contributionId: "workbench", action: "generate", kind: "generateTask" },
    ],
    async invoke({ invocationRef }) {
      const first = bound.createTask(request(invocationRef));
      await assert.rejects(
        bound.createTask({
          ...request(invocationRef),
          idempotencyKey: "other",
        }),
        /plugin_invocation_task_conflict/u,
      );
      await assert.rejects(first, /fixture_task_rejected/u);
      await assert.rejects(
        bound.createTask(request(invocationRef)),
        /fixture_task_rejected/u,
      );
      return null;
    },
  });
  await assert.rejects(
    f.invoke({ ...f.context, action: "generate" }),
    /fixture_task_rejected/u,
  );
  assert.deepEqual(f.counts(), { releases: 1, taskCalls: 1 });
});

for (const change of [
  "epoch",
  "scope",
  "selection",
  "expiry",
  "close",
] as const)
  test(`ordinary action remains fenced after ${change} changes`, async () => {
    const f = fixture();
    f.setService({
      actions: [{ contributionId: "workbench", action: "read", kind: "read" }],
      async invoke() {
        if (change === "epoch") f.setEpoch("changed");
        if (change === "scope")
          f.setScope({ ...uiTestScope, profileId: "foreign" });
        if (change === "selection")
          f.setSelection({
            ...uiTestSelection,
            revision: 3,
            state: "disabled",
          });
        if (change === "expiry") f.setNow("2026-10-02T03:00:30.000Z");
        if (change === "close") f.bridge.close();
        return { read: true };
      },
    });
    await assert.rejects(
      f.invoke(f.context),
      /plugin_invocation_(?:authority_changed|scope_changed|unavailable)/u,
    );
    assert.deepEqual(f.counts(), { releases: 1, taskCalls: 0 });
  });
