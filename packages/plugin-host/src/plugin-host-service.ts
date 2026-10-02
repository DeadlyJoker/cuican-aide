import type { PluginIdentity } from "@crewon/plugin-sdk/node";

/** Trusted instance lifetime; callbacks can only be registered during actual setup. */
export type PluginHostServiceLifetime = Readonly<{
  onDispose(callback: () => void | Promise<void>): void;
}>;

export type PluginHostService = Readonly<{
  service: string;
  apiVersion: string;
  value: object;
  /** Actual frozen package identity and host-owned setup/cleanup lifetime. */
  bindForPlugin?(
    identity: PluginIdentity,
    lifetime: PluginHostServiceLifetime,
  ): object;
}>;
