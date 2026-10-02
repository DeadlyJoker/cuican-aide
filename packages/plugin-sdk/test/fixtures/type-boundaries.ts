import { definePlugin } from "@crewon/plugin-sdk/node";
import { defineUiPlugin } from "@crewon/plugin-sdk/ui";
import type { PluginUiProps, PluginUiServices } from "@crewon/plugin-sdk/ui";

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
