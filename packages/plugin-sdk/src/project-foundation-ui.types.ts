import type {
  ProjectFoundationUiInputMap,
  ProjectFoundationUiMethod,
  ProjectFoundationUiResponseMap,
} from "../../contracts/src/project-foundation.ts";
import type { PluginJsonValue } from "./sdk-types.js";

/** Portable declaration view of the original native UI signal; runtime accepts native signals only. */
export interface PluginProjectFoundationUiSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export type PluginProjectFoundationUiInvocationOptions = Readonly<{
  signal?: PluginProjectFoundationUiSignal;
}>;

/** Same UI invocation ABI. No transport, activation, policy callback or authority is supplied here. */
export interface PluginProjectFoundationUiServices {
  invoke(
    action: string,
    input: PluginJsonValue,
    options: PluginProjectFoundationUiInvocationOptions,
  ): Promise<PluginJsonValue>;
}

export type PluginProjectFoundationClient = Readonly<{
  [Method in ProjectFoundationUiMethod]: (
    input: ProjectFoundationUiInputMap[Method],
    options?: PluginProjectFoundationUiInvocationOptions,
  ) => Promise<ProjectFoundationUiResponseMap[Method]>;
}>;
