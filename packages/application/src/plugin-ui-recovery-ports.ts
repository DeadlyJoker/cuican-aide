import type {
  PluginUiRecoveryHintsResponse,
  StagePluginUiRecoveryResponse,
} from "@crewon/contracts";
import type {
  PluginUiActionContext,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";

/** Private handle bound to one real invocation, never a browser receipt grant. */
export type PluginUiRecoveryDispatch = Readonly<{
  confirmVerified(output: PluginUiJsonValue): Promise<void>;
  /** Only the original business invocation may report a scoped pre-COMMIT refusal. */
  observeFailure(error: unknown): Promise<void>;
}>;

/** Optional trusted host service. Reading a hint never admits a task or metadata write. */
export interface PluginUiRecoveryPort {
  get(context: PluginUiActionContext): Promise<PluginUiRecoveryHintsResponse>;
  stage(context: PluginUiActionContext): Promise<StagePluginUiRecoveryResponse>;
  beginDispatch(
    context: PluginUiActionContext,
  ): Promise<PluginUiRecoveryDispatch>;
}
