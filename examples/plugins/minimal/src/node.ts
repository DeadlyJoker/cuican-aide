import { definePlugin } from "@crewon/plugin-sdk/node";
import { metadata } from "./metadata.ts";

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: metadata.pluginId,
  setup(context) {
    const registration = context.services.provide(
      metadata.service,
      metadata.apiVersion,
      {
        echo(text: string): string {
          if (typeof text !== "string" || text.length > 2048)
            throw new Error("echo_input_invalid");
          return text;
        },
      },
    );
    context.onDispose(() => registration.dispose());
  },
});
