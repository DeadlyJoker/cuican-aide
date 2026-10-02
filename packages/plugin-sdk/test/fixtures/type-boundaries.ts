import { definePlugin } from "@crewon/plugin-sdk/node";
import { defineUiPlugin } from "@crewon/plugin-sdk/ui";
import type { PluginUiProps, PluginUiServices } from "@crewon/plugin-sdk/ui";
import type {
  PluginTaskService,
  PluginTaskRequest,
  PluginActionsService,
} from "@crewon/plugin-sdk/node";
import type { PluginTaskReceipt } from "@crewon/plugin-sdk/contracts";

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
