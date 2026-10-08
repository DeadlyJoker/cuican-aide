import {
  CREWON_PROJECT_SOURCE_UPLOAD_SERVICE,
  CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  type ProjectSourceUploadPartLocator,
  type ProjectSourceUploadMutationResponse,
} from "@crewon/contracts/project-source-uploads";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import {
  assertPluginUiCurrent,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import { uiFailure } from "./pluginUiValidation";

/** A declaration permits this transport; each write still requires an actual mounted backend owner. */
export function sourceUploadPartDeclared(lease: PluginUiLease): boolean {
  return lease.descriptor.requires.some(
    (requirement) =>
      requirement.service === CREWON_PROJECT_SOURCE_UPLOAD_SERVICE &&
      requirement.apiVersion === CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION,
  );
}

/** Capture original native bytes synchronously; mutable plugin memory never crosses the first await. */
export function capturePluginSourceUploadPartBytes(
  input: Uint8Array,
): Uint8Array<ArrayBuffer> {
  try {
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    if (
      Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)!.get!.call(
        input,
      ) !== "Uint8Array"
    )
      throw new Error();
    const length = Object.getOwnPropertyDescriptor(
      prototype,
      "byteLength",
    )!.get!.call(input);
    const buffer = Object.getOwnPropertyDescriptor(
      prototype,
      "buffer",
    )!.get!.call(input);
    Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )!.get!.call(buffer);
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > PROJECT_SOURCE_UPLOAD_PART_BYTES
    )
      throw new Error();
    const copy = new Uint8Array(length);
    Uint8Array.prototype.set.call(copy, input);
    return copy;
  } catch {
    return uiFailure("plugin_ui_source_upload_bytes_invalid");
  }
}

export function createInstalledPluginSourceUploadPartTransport(
  input: Readonly<{
    client: ControlApiClient;
    assertCurrent: PluginUiCurrentScope;
  }>,
) {
  return async (
    lease: PluginUiLease,
    locator: ProjectSourceUploadPartLocator,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ProjectSourceUploadMutationResponse> => {
    if (!sourceUploadPartDeclared(lease))
      uiFailure("plugin_ui_source_upload_unavailable");
    assertPluginUiCurrent(input.assertCurrent, signal);
    return pluginUiControlRequest(
      (currentSignal) =>
        input.client.plugins.writeSourceUploadPart(
          lease.mountRef,
          locator,
          bytes,
          { signal: currentSignal },
        ),
      signal,
    );
  };
}
