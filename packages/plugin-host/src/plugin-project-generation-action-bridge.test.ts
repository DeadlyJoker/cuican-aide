import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import type { PluginUiActionContext } from "@crewon/application";
import { PluginProjectGenerationActionBridge } from "./plugin-project-generation-action-bridge.ts";
import { assertPluginProjectGenerationActionDeclaration } from "./plugin-project-generation-action-bridge-support.ts";
import {
  projectGenerationBridgeFixture,
  bridgeDeferred,
} from "./plugin-project-generation-action-bridge.test-support.ts";

test("reserved generation keeps the actual business context and verifies the original paid task outcome", async () => {
  const f = projectGenerationBridgeFixture();
  const context = f.app.detachedContext();
  const outcome = await f.invoke(context);
  assert.ok(f.app.authority.isOutcome(outcome));
  assert.equal(f.state.lastInput!.context, context);
  assert.equal(
    f.state.lastInput!.sourcePin.pluginId,
    f.app.publication.source.pluginId,
  );
  assert.notEqual(
    f.state.lastInput!.sourcePin.pluginId,
    f.app.publication.target.pluginId,
  );
  assert.deepEqual(f.state.lastInput!.request, f.app.request);
  assert.ok(Object.isFrozen(f.state.lastInput!.request.reference));
  const receipt = f.app.authority.verify(context, outcome);
  assert.equal(
    (receipt as { threadId: string }).threadId,
    f.app.request.threadId,
  );
  assert.throws(
    () => f.app.authority.verify(context, outcome),
    /plugin_ui_committed_task_invalid/u,
  );
  assert.equal(f.state.generationCalls, 1);
});

test("same-shaped detached contexts cannot obtain source invocation authority", async () => {
  const f = projectGenerationBridgeFixture();
  const context = f.app.detachedContext();
  const dispose = f.register(context);
  try {
    await assert.rejects(
      f.actions.invoke({ ...context }),
      /plugin_ui_invocation_unavailable/u,
    );
  } finally {
    dispose();
  }
  assert.equal(f.state.generationCalls, 0);
});

test("old packages without a generation declaration and non-module contributions cannot generate", async () => {
  for (const [change, code] of [
    [{ requires: [] }, "plugin_project_generation_source_unsupported"],
    [
      {
        contributions: [
          {
            id: "workbench",
            kind: "settings",
            title: "Story",
            slot: "settings.section",
          },
        ],
      },
      "plugin_ui_contribution_unsupported",
    ],
  ] as const) {
    const f = projectGenerationBridgeFixture();
    const context = f.app.detachedContext();
    const descriptor = parsePluginPackageDescriptor({
      ...context.lease.descriptor,
      ...change,
    });
    const next = { ...context, lease: { ...context.lease, descriptor } };
    await assert.rejects(f.invoke(next), { code });
    assert.equal(f.state.generationCalls, 0);
  }
});

test("an optional exact generation declaration permits dispatch without granting availability or project permission", async () => {
  const f = projectGenerationBridgeFixture();
  f.state.available = false;
  const context = f.app.detachedContext();
  const descriptor = parsePluginPackageDescriptor({
    ...context.lease.descriptor,
    requires: [
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  const next = {
    ...context,
    lease: parsePluginUiLease({ ...context.lease, descriptor }),
  };
  const outcome = await f.invoke(next);
  assert.ok(f.app.authority.isOutcome(outcome));
  assert.equal(f.state.availabilityCalls, 0);
});

test("unpublished source identities and strict input failures never enter the execution owner", async () => {
  const f = projectGenerationBridgeFixture();
  const unavailable = new PluginProjectGenerationActionBridge({
    publications: [
      {
        ...f.app.publication,
        source: { ...f.app.publication.source, contributionId: "other" },
      },
    ],
    generation: f.generation,
    committedTasks: f.app.authority,
  });
  const context = f.app.detachedContext();
  const dispose = f.register(context);
  try {
    await assert.rejects(
      unavailable.actions(f.fallback).invoke(context),
      /plugin_project_generation_publication_missing/u,
    );
  } finally {
    dispose();
  }
  for (const input of [
    { ...f.app.request, prompt: "untrusted draft" },
    { ...f.app.request, target: f.app.publication.target },
    { ...f.app.request, expectedThreadRevision: 0 },
  ])
    await assert.rejects(
      f.invoke({ ...f.app.detachedContext(), input }),
      /invalid/u,
    );
  assert.equal(f.state.generationCalls, 0);
});

test("ordinary actions retain the fallback receiver and never read projects even after bridge close", async () => {
  const f = projectGenerationBridgeFixture();
  const fallback = {
    calls: 0,
    async invoke(context: PluginUiActionContext) {
      assert.equal(this, fallback);
      this.calls++;
      return context.input;
    },
  };
  const actions = f.bridge.actions(fallback);
  fallback.invoke = async () => {
    throw new Error("replacement must not dispatch");
  };
  f.bridge.close();
  assert.deepEqual(
    await actions.invoke({
      ...f.app.detachedContext(),
      action: "ordinary.read",
      input: { old: true },
    }),
    { old: true },
  );
  assert.equal(fallback.calls, 1);
  assert.equal(f.state.currentCalls, 0);
  assert.equal(f.state.generationCalls, 0);
  for (const action of [
    "crewon.project-generations",
    "crewon.project-generations.v1.other",
    "crewon.project-generations.v2.generateConcept",
  ])
    assert.throws(
      () => actions.invoke({ ...f.app.detachedContext(), action }),
      /plugin_project_generation_action_invalid/u,
    );
  assert.equal(fallback.calls, 1);
});

test("captured dispatch and receipt callbacks keep their original receivers after replacement", async () => {
  const f = projectGenerationBridgeFixture();
  const calls: string[] = [];
  const generation = {
    async generate(input: Parameters<typeof f.generation.generate>[0]) {
      assert.equal(this, generation);
      calls.push("dispatch");
      return f.generation.generate(input);
    },
    isAvailable() {
      assert.equal(this, generation);
      return true;
    },
  };
  const issuer = {
    async issueProjectGeneration(
      input: Parameters<typeof f.app.authority.issueProjectGeneration>[0],
    ) {
      assert.equal(this, issuer);
      calls.push("receipt");
      return f.app.authority.issueProjectGeneration(input);
    },
  };
  const bridge = new PluginProjectGenerationActionBridge({
    publications: [f.app.publication],
    generation,
    committedTasks: issuer,
  });
  generation.generate = async () => {
    throw new Error("replacement");
  };
  issuer.issueProjectGeneration = async () => {
    throw new Error("replacement");
  };
  const context = f.app.detachedContext();
  const dispose = f.register(context);
  try {
    assert.ok(
      f.app.authority.isOutcome(
        await bridge.actions(f.fallback).invoke(context),
      ),
    );
  } finally {
    dispose();
  }
  assert.deepEqual(calls, ["dispatch", "receipt"]);
});

test("same invocation dispatches once and close or observed policy withdrawal during await prevents commit", async () => {
  for (const withdrawal of ["close", "policy", "registration"] as const) {
    const f = projectGenerationBridgeFixture();
    const wait = bridgeDeferred();
    const started = bridgeDeferred();
    f.state.beforeGenerate = async () => {
      started.resolve();
      await wait.promise;
    };
    const context = f.app.detachedContext();
    const dispose = f.register(context);
    const first = f.actions.invoke(context);
    const second = f.actions.invoke(context);
    assert.equal(first, second);
    const rejected = assert.rejects(first, /unavailable|denied/u);
    await started.promise;
    if (withdrawal === "close") f.bridge.close();
    else if (withdrawal === "policy") f.state.allow = false;
    else dispose();
    wait.resolve();
    await rejected;
    dispose();
    assert.equal(f.state.generationCalls, 1);
    assert.equal(f.app.project.base.state.receipts.size, 0);
  }
});

test("a verified commit survives close and policy withdrawal without a post-commit admission check", async () => {
  const f = projectGenerationBridgeFixture();
  const context = f.app.detachedContext();
  f.state.afterCommit = () => {
    f.bridge.close();
    f.state.allow = false;
    f.state.open = false;
  };
  const outcome = await f.invoke(context);
  assert.ok(f.app.authority.isOutcome(outcome));
  assert.equal(
    (f.app.authority.verify(context, outcome) as { disposition: string })
      .disposition,
    "committed",
  );
  assert.equal(f.app.project.base.state.receipts.size, 1);
});

test("exact execution declarations reject read/query substitutes, duplicates and getters without executing them", () => {
  const f = projectGenerationBridgeFixture();
  const target = { contributionId: "workbench", action: "generate" };
  const descriptor = f.app.detachedContext().lease.descriptor;
  assertPluginProjectGenerationActionDeclaration(
    {
      actions: [{ ...target, kind: "generateTask" }],
      async invoke() {
        return null;
      },
    },
    descriptor,
    target,
  );
  for (const kind of ["read", "queryTask"])
    assert.throws(
      () =>
        assertPluginProjectGenerationActionDeclaration(
          {
            actions: [{ ...target, kind }],
            async invoke() {
              return null;
            },
          },
          descriptor,
          target,
        ),
      /plugin_project_generation_action_invalid/u,
    );
  let getterCalls = 0;
  const getter = {
    get actions() {
      getterCalls++;
      return [];
    },
    async invoke() {
      return null;
    },
  };
  assert.throws(
    () =>
      assertPluginProjectGenerationActionDeclaration(
        getter,
        descriptor,
        target,
      ),
    /plugin_action_input_invalid/u,
  );
  assert.throws(
    () =>
      assertPluginProjectGenerationActionDeclaration(
        {
          actions: [
            { ...target, kind: "generateTask" },
            { ...target, kind: "generateTask" },
          ],
          async invoke() {
            return null;
          },
        },
        descriptor,
        target,
      ),
    /plugin_action_declarations_invalid/u,
  );
  assert.equal(getterCalls, 0);
});
