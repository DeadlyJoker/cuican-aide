import { defineUiPlugin } from "@crewon/plugin-sdk/ui";
import type { PluginUiProps, PluginUiServices } from "@crewon/plugin-sdk/ui";

export default defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "example.external",
  mount(root: HTMLElement, props: PluginUiProps, services: PluginUiServices) {
    const controller = new AbortController();
    const paint = (next: PluginUiProps) => {
      root.textContent = JSON.stringify(next.data);
    };
    paint(props);
    void services.invoke("workbench.read", null, { signal: controller.signal });
    return {
      update(nextProps) {
        paint(nextProps);
      },
      dispose() {
        controller.abort();
        root.textContent = "";
      },
    };
  },
});
