import type { ControlApiClient } from "@crewon/control-client";
import type {
  PluginUiLease,
  PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  PROJECT_MEDIA_RESULT_UI_ACTIONS as actions,
  parseProjectMediaResultUiRequest,
  parseProjectMediaResultUiResponse,
} from "@crewon/contracts/project-media-results-ui";
import { parseGetProjectMediaResultResponse } from "@crewon/contracts/project-media-results";
import {
  assertPluginUiCurrent,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import { uiFailure } from "./pluginUiValidation";

/** One authenticated, byte-verified PNG preview per mount. URLs never come from a plugin or supplier. */
export function createInstalledPluginMediaResultTransport(
  options: Readonly<{
    client: ControlApiClient;
    assertCurrent: PluginUiCurrentScope;
    validateLease(
      lease: PluginUiLease,
      signal: AbortSignal,
    ): Promise<PluginUiLease>;
  }>,
) {
  type Preview = { token: symbol; url?: string; cancel(): void };
  const previews = new Map<string, Preview>();
  const release = (lease: PluginUiLease) => {
    const preview = previews.get(lease.mountRef);
    previews.delete(lease.mountRef);
    preview?.cancel();
    if (preview?.url) URL.revokeObjectURL(preview.url);
  };
  return Object.freeze({
    release,
    async invoke(
      lease: PluginUiLease,
      input: Readonly<{
        action: string;
        input: PluginUiJsonValue;
        signal: AbortSignal;
      }>,
    ): Promise<PluginUiJsonValue> {
      assertPluginUiCurrent(options.assertCurrent, input.signal);
      if (input.action === actions.releasePreview) {
        const value = input.input;
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).join() !== "url" ||
          typeof (value as { url?: unknown }).url !== "string"
        )
          uiFailure("plugin_ui_media_result_release_invalid");
        if (
          previews.get(lease.mountRef)?.url === (value as { url: string }).url
        )
          release(lease);
        return null;
      }
      const request = parseProjectMediaResultUiRequest({
        action: input.action,
        input: input.input,
      });
      if (request.action !== actions.preview) {
        const response = await pluginUiControlRequest(
          (signal) =>
            options.client.plugins.invoke(lease.mountRef, request, { signal }),
          input.signal,
        );
        assertPluginUiCurrent(options.assertCurrent, input.signal);
        return parseProjectMediaResultUiResponse(request, response.output);
      }
      release(lease);
      const token = Symbol(),
        controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const entry: Preview = { token, cancel: () => controller.abort() };
      previews.set(lease.mountRef, entry);
      const current = () => {
        assertPluginUiCurrent(options.assertCurrent, signal);
        if (previews.get(lease.mountRef) !== entry)
          uiFailure("plugin_ui_media_result_preview_superseded");
      };
      try {
        const response = await pluginUiControlRequest(
          (s) =>
            options.client.plugins.invoke(lease.mountRef, request, {
              signal: s,
            }),
          signal,
        );
        current();
        const { candidate } = parseGetProjectMediaResultResponse(
          request.input,
          response.output,
        );
        if (!candidate) {
          release(lease);
          return { candidate: null, url: null };
        }
        const bytes = await options.client.projectMediaResults.readContent(
          candidate,
          { signal },
        );
        current();
        await options.validateLease(lease, signal);
        current();
        entry.url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        );
        current();
        const abort = () => {
          if (previews.get(lease.mountRef) === entry) release(lease);
        };
        signal.addEventListener("abort", abort, { once: true });
        entry.cancel = () => {
          signal.removeEventListener("abort", abort);
          controller.abort();
        };
        return { candidate, url: entry.url };
      } catch (error) {
        if (previews.get(lease.mountRef) === entry) release(lease);
        throw error;
      }
    },
  });
}
