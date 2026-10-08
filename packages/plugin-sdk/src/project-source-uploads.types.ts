import type {
  ProjectSourceUploadInputMap,
  ProjectSourceUploadMethod,
  ProjectSourceUploadMutationResponse,
  ProjectSourceUploadPartLocator,
  ProjectSourceUploadResponseMap,
} from "../../contracts/src/project-source-uploads.ts";
import type { PluginJsonValue } from "./sdk-types.js";

/** Portable declaration view; runtime requires the original native AbortSignal. */
export interface PluginProjectSourceUploadSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export type PluginProjectSourceUploadInvocationOptions = Readonly<{
  signal?: PluginProjectSourceUploadSignal;
}>;
export interface PluginProjectSourceUploadUiServices {
  invoke(
    action: string,
    input: PluginJsonValue,
    options: PluginProjectSourceUploadInvocationOptions,
  ): Promise<PluginJsonValue>;
}

/** The native mount supplies this separate byte transport. It grants no permission by itself. */
export interface PluginProjectSourceUploadRawPort {
  writePart(
    locator: ProjectSourceUploadPartLocator,
    bytes: Uint8Array,
    options?: PluginProjectSourceUploadInvocationOptions,
  ): Promise<ProjectSourceUploadMutationResponse>;
}
export type PluginProjectSourceUploadClientOptions = Readonly<{
  raw?: PluginProjectSourceUploadRawPort;
}>;
export type PluginProjectSourceUploadsClient = Readonly<{
  [Method in ProjectSourceUploadMethod]: (
    input: ProjectSourceUploadInputMap[Method],
    options?: PluginProjectSourceUploadInvocationOptions,
  ) => Promise<ProjectSourceUploadResponseMap[Method]>;
}> &
  Readonly<{
    writePart(
      locator: ProjectSourceUploadPartLocator,
      bytes: Uint8Array,
      options?: PluginProjectSourceUploadInvocationOptions,
    ): Promise<ProjectSourceUploadMutationResponse>;
  }>;
