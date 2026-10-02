import type {
  PluginDisposable,
  PluginJsonValue,
  PluginUiProps,
} from "./sdk-types.js";

/** Browser-specific ABI types stay outside the portable Node and pure DTO declaration closures. */
export type PluginUiInvocationOptions = Readonly<{
  signal?: AbortSignal;
}>;
export type PluginUiServices = Readonly<{
  invoke(
    action: string,
    input: PluginJsonValue,
    options: PluginUiInvocationOptions,
  ): Promise<PluginJsonValue>;
}>;
export type PluginUiInstance = PluginDisposable &
  Readonly<{
    update(nextProps: PluginUiProps): void | Promise<void>;
  }>;
export type PluginUiDefinition = Readonly<{
  apiVersion: "crewon.plugin-ui.v1";
  pluginId: string;
  mount(
    root: HTMLElement,
    props: PluginUiProps,
    services: PluginUiServices,
  ): PluginUiInstance | Promise<PluginUiInstance>;
}>;
