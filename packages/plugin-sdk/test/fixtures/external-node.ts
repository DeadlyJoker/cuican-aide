import { definePlugin } from "@crewon/plugin-sdk/node";
import type {
  PluginJsonValue,
  PluginNodeContext,
} from "@crewon/plugin-sdk/contracts";

export const events: string[] = [];
export const expectedIdentity = "example.external";
export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: expectedIdentity,
  async setup(context: PluginNodeContext) {
    events.push(`setup:${context.identity.pluginId}`);
    const greeting = context.services.get<{ greet(): string }>(
      "example.greeting",
      "v1",
    );
    const registration = context.services.provide("example.echo", "v1", {
      echo(input: PluginJsonValue): PluginJsonValue {
        return { greeting: greeting.greet(), input };
      },
    });
    context.onDispose(async () => {
      await registration.dispose();
      events.push("cleanup");
    });
    return {
      async dispose() {
        events.push("dispose");
      },
    };
  },
});
