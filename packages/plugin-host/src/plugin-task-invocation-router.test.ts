import assert from "node:assert/strict";
import test from "node:test";
import type { PluginTaskService } from "@crewon/plugin-sdk/node";
import { taskActionFixture } from "./plugin-task-action-bridge.integration.test-support.ts";
import { projectGenerationExecutionFixture } from "./plugin-project-generation-execution-bridge.test-support.ts";
import { PluginTaskInvocationRouter } from "./plugin-task-invocation-router.ts";

test("shared task routing preserves the project bridge's original invocation and identity checks", async (t) => {
  const ordinary = await taskActionFixture(t);
  const project = projectGenerationExecutionFixture();
  const router = new PluginTaskInvocationRouter({
    ordinary: ordinary.bridge,
    projects: [project.bridge],
  });
  const service = router.hostService("1");
  const bound = service.bindForPlugin!(project.identity, {
    onDispose() {},
  }) as PluginTaskService;
  const foreign = service.bindForPlugin!(
    Object.freeze({ ...project.identity }),
    { onDispose() {} },
  ) as PluginTaskService;
  let issuedReference: string | undefined;
  project.setService({
    actions: [
      {
        contributionId: project.input.executionPin.contributionId,
        action: project.input.executionPin.action,
        kind: "generateTask",
      },
    ],
    async invoke(invocation) {
      issuedReference = invocation.invocationRef;
      const input = {
        ...(invocation.input as object),
        invocationRef: invocation.invocationRef,
      } as Parameters<PluginTaskService["createTask"]>[0];
      await assert.rejects(
        foreign.createTask(input),
        /plugin_invocation_owner_mismatch/u,
      );
      let getterCalls = 0;
      const getterInput = { ...input };
      Object.defineProperty(getterInput, "invocationRef", {
        enumerable: true,
        get() {
          getterCalls++;
          return invocation.invocationRef;
        },
      });
      await assert.rejects(
        bound.createTask(getterInput),
        /plugin_action_input_invalid/u,
      );
      assert.equal(getterCalls, 0);
      return bound.createTask(input);
    },
  });
  const result = await project.execute();
  assert.equal(result.result.turn.disposition, "committed");
  assert.equal(project.state.commitCalls, 1);
  assert.ok(issuedReference);
  assert.equal(
    project.bridge.ownsInvocation({
      invocationRef: issuedReference,
    }),
    false,
  );
});

test("router rejects accessor configuration, copied owners, sparse arrays and unsupported task versions", async (t) => {
  const ordinary = await taskActionFixture(t);
  const project = projectGenerationExecutionFixture();
  const valid = { ordinary: ordinary.bridge, projects: [project.bridge] };
  const create = (input: unknown) =>
    new PluginTaskInvocationRouter(input as typeof valid);
  let getterCalls = 0;
  assert.throws(
    () =>
      create({
        get ordinary() {
          getterCalls++;
          return ordinary.bridge;
        },
        projects: [],
      }),
    /plugin_action_input_invalid/u,
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () =>
      create({
        ...valid,
        ordinary: Object.create(Object.getPrototypeOf(ordinary.bridge)),
      }),
    /plugin_task_router_invalid/u,
  );
  assert.throws(
    () => create({ ...valid, projects: [project.bridge, project.bridge] }),
    /plugin_task_router_invalid/u,
  );
  assert.throws(
    () => create({ ...valid, projects: new Array(1) }),
    /plugin_task_router_invalid/u,
  );
  const projects = [project.bridge];
  Object.defineProperty(projects, "0", {
    enumerable: true,
    get() {
      getterCalls++;
      return project.bridge;
    },
  });
  assert.throws(
    () => create({ ...valid, projects }),
    /plugin_task_router_invalid/u,
  );
  assert.equal(getterCalls, 0);
  const router = create(valid);
  assert.throws(
    () => router.hostService("3" as "1"),
    /plugin_task_router_api_version_invalid/u,
  );
  assert.throws(
    () =>
      (router.hostService("1").value as PluginTaskService).createTask(
        {} as never,
      ),
    /plugin_task_port_unbound/u,
  );
});
