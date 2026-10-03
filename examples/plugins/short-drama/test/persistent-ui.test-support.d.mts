import type {
  PluginUiProps,
  PluginUiServices,
  PluginUiTheme,
} from "@crewon/plugin-sdk/ui";
import type {
  PublicCreativeProject,
  PublicProjectBrief,
} from "@crewon/plugin-sdk/contracts";

export function persistentProps(
  ready?: boolean,
  tokens?: PluginUiTheme["tokens"],
  mode?: PluginUiTheme["mode"],
): PluginUiProps;
export function deferred<T = unknown>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};
type Details = { project: PublicCreativeProject; brief: PublicProjectBrief };
type Call = { action: string; input: unknown; signal: AbortSignal };
export function metadataService(options?: { pageSize?: number }): {
  services: PluginUiServices;
  calls: Call[];
  records: Map<
    string,
    { project: PublicCreativeProject; briefs: PublicProjectBrief[] }
  >;
  create(title: string, briefText: string): Details;
  externalBrief(projectId: string, text: string): Details;
  refuse(value: boolean): void;
  loseNextWrite(): void;
  gateList(gate: { promise: Promise<unknown> }): void;
  methodCalls(method: string): Call[];
};
