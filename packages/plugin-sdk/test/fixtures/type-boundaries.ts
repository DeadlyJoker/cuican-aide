import { definePlugin } from "@crewon/plugin-sdk/node";
import { defineUiPlugin } from "@crewon/plugin-sdk/ui";
import type { PluginUiProps, PluginUiServices } from "@crewon/plugin-sdk/ui";
// @ts-expect-error Execution requirements are exposed only by Node and contracts entrypoints.
import type { PluginExecutionServiceRequirement as UiRequirement } from "@crewon/plugin-sdk/ui";
import type {
  PluginTaskService,
  PluginTaskRequest,
  PluginActionsService,
} from "@crewon/plugin-sdk/node";
import type {
  PluginTaskReceipt,
  PluginExecutionServiceRequirement as ContractsRequirement,
} from "@crewon/plugin-sdk/contracts";
import type {
  PluginExecutionService,
  PluginToolRuntime,
  PluginToolRuntimeContext,
  PluginToolRuntimeFactory,
  PluginExecutionServiceRequirement,
} from "@crewon/plugin-sdk/node";

export function checkExecutionBoundary(
  execution: PluginExecutionService,
  runtime: PluginToolRuntime,
  context: PluginToolRuntimeContext,
) {
  execution.register({ create: () => runtime });
  const required: readonly PluginExecutionServiceRequirement[] = [
    "externalOperations",
    "jsonHttp",
  ];
  const fromContracts: readonly ContractsRequirement[] = required;
  const declared: PluginToolRuntimeFactory = {
    requiredServices: fromContracts,
    create: () => runtime,
  };
  execution.register(declared);
  // @ts-expect-error Requirements are a bounded known-service union, not arbitrary host service names.
  execution.register({ requiredServices: ["network"], create: () => runtime });
  // @ts-expect-error Requirement metadata cannot be overwritten through the portable factory ABI.
  declared.requiredServices = [];
  // @ts-expect-error Requirement metadata exposes no mutable array methods.
  declared.requiredServices!.push("jsonHttp");
  // @ts-expect-error Registration requires an execution factory, not a runtime or arbitrary object.
  execution.register(runtime);
  execution.register({
    // @ts-expect-error Every execution adapter must implement reconciliation and cancellation.
    create: () => ({
      definitions: runtime.definitions,
      execute: runtime.execute,
    }),
  });
  // @ts-expect-error Runtime creation cannot rewrite the host's original Run identity.
  context.run.runId = "replacement";
  // @ts-expect-error Configuration references never expose credential material.
  context.configuration.credentialBindings[0].credentialValue;
  // @ts-expect-error Execution metadata is not a Store or new Run API.
  context.store.createRun();
  // @ts-expect-error Execution service registers factories; it does not admit new tasks.
  execution.createTask({});
}

export function checkTaskAuthorityBoundary(
  tasks: PluginTaskService,
  actions: PluginActionsService,
  request: PluginTaskRequest,
  receipt: PluginTaskReceipt,
) {
  void tasks.createTask(request);
  // @ts-expect-error Only the host-issued invocation can resolve the current actor.
  void tasks.createTask({ ...request, actorId: "forged" });
  // @ts-expect-error The plugin cannot choose a platform principal or payer.
  void tasks.createTask({ ...request, principalId: "forged" });
  // @ts-expect-error A task port is bound to the host's authorized profile.
  void tasks.createTask({ ...request, profileId: "forged" });
  // @ts-expect-error Package identity belongs to the actual bound Node instance.
  void tasks.createTask({ ...request, pluginId: "other.plugin" });
  // @ts-expect-error Pricing and credit pools are not plugin call inputs.
  void tasks.createTask({ ...request, poolId: "free" });
  // @ts-expect-error A task cannot be dispatched without the invocation reference.
  void tasks.createTask({
    threadId: request.threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "key",
    input: null,
  });
  // @ts-expect-error The original receipt is immutable.
  receipt.runId = "replacement";
  void actions.invoke({
    invocationRef: "ref",
    contributionId: "workbench",
    action: "read",
    input: null,
    // @ts-expect-error Node actions receive invocation authority without caller identity fields.
    actorId: "forged",
  });
}

export function checkAuthorityBoundary(
  services: PluginUiServices,
  props: PluginUiProps,
) {
  // @ts-expect-error UI service calls have no caller-supplied actor authority.
  void services.invoke("workbench.read", null, { actorId: "client-owner" });
  // @ts-expect-error UI props expose no platform principal or global session.
  props.principalId;
}
definePlugin({
  // @ts-expect-error Host API compatibility must be explicit.
  apiVersion: "crewon.plugin-host.v0",
  pluginId: "example.external",
  setup() {},
});
defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "example.external",
  // @ts-expect-error A mounted UI must own update and dispose.
  mount() {
    return { dispose() {} };
  },
});
