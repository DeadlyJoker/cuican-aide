import type { ControlApiClient } from "@crewon/control-client";
import { parsePluginUiRecoveryHint } from "@crewon/contracts/plugins";
import {
  parseProjectMediaGenerationUiRequest,
  parseGenerateProjectMediaResponse,
} from "@crewon/contracts/project-media-generations";
import {
  assertPluginUiCurrent,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import { awaitPluginUiOperation, uiFailure } from "./pluginUiValidation";
import type { PluginUiLease } from "@crewon/contracts/plugins";

/** Stage the exact original request before upload. A cancelled response remains recoverable from Control. */
export function createInstalledPluginMediaGenerationTransport(options: {
  client: ControlApiClient;
  assertCurrent: PluginUiCurrentScope;
  stage(
    lease: PluginUiLease,
    request: ReturnType<typeof parseProjectMediaGenerationUiRequest>,
  ): ((signal: AbortSignal) => Promise<unknown>) | undefined;
}) {
  const pending = new Set<Promise<unknown>>();
  return async (
    lease: PluginUiLease,
    input: { action: string; input: unknown; signal: AbortSignal },
  ) => {
    assertPluginUiCurrent(options.assertCurrent, input.signal);
    if (pending.size >= 16) uiFailure("plugin_ui_inflight_limit");
    const request = parseProjectMediaGenerationUiRequest({
      action: input.action,
      input: input.input,
    });
    const stage = options.stage(lease, request);
    if (!stage) uiFailure("plugin_ui_recovery_unavailable");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(90_000)]);
    const actual = (async () => {
      const hint = parsePluginUiRecoveryHint(
        await pluginUiControlRequest(stage, input.signal),
      );
      if (JSON.stringify(hint.request) !== JSON.stringify(request))
        uiFailure("plugin_ui_recovery_request_mismatch");
      if (hint.phase === "accepted")
        return parseGenerateProjectMediaResponse(request.input, hint.receipt);
      if (!hint.retryable) uiFailure("plugin_ui_recovery_not_retryable");
      assertPluginUiCurrent(options.assertCurrent, input.signal);
      // Only this known long operation has a larger deadline; the plugin shows cancel/recovery controls.
      const response = await options.client.plugins.invoke(
        lease.mountRef,
        request,
        { signal },
      );
      assertPluginUiCurrent(options.assertCurrent);
      return parseGenerateProjectMediaResponse(request.input, response.output);
    })();
    pending.add(actual);
    void actual.then(
      () => pending.delete(actual),
      () => pending.delete(actual),
    );
    return awaitPluginUiOperation(actual, signal);
  };
}
