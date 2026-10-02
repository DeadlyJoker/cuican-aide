/** Portable ABI values only; services and lifecycle enforcement are implemented by the host. */
export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PluginJsonValue[]
  | Readonly<{ [key: string]: PluginJsonValue }>;

export type PluginDisposable = Readonly<{
  dispose(): void | Promise<void>;
}>;
export type PluginIdentity = Readonly<{
  pluginId: string;
  version: string;
  packageDigest: string;
}>;
export type PluginNodeServices = Readonly<{
  get<T extends object>(service: string, apiVersion: string): T;
  /** Feature-detect on older hosts. Only a declared optional dependency may be absent. */
  getOptional?<T extends object>(
    service: string,
    apiVersion: string,
  ): T | undefined;
  provide<T extends object>(
    service: string,
    apiVersion: string,
    value: T,
  ): PluginDisposable;
}>;
export type PluginNodeContext = Readonly<{
  identity: PluginIdentity;
  services: PluginNodeServices;
  onDispose(callback: () => void | Promise<void>): void;
}>;
export type PluginNodeSetupResult = void | PluginDisposable;
export type PluginNodeDefinition = Readonly<{
  apiVersion: "crewon.plugin-host.v1";
  pluginId: string;
  setup(
    context: PluginNodeContext,
  ): PluginNodeSetupResult | Promise<PluginNodeSetupResult>;
}>;

export type PluginUiTheme = Readonly<{
  mode: "light" | "dark";
  tokens: Readonly<Record<string, string>>;
}>;
export type PluginUiProps = Readonly<{
  schemaVersion: "crewon.plugin-ui-props.v1";
  contributionId: string;
  theme: PluginUiTheme;
  data: PluginJsonValue;
}>;
