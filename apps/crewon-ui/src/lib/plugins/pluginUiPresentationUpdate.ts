import {
  ControlApiClientError,
  ControlApiProtocolError,
  ControlApiTransportError,
} from "@crewon/control-client";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import { PluginUiLoaderError } from "./pluginUiValidation";

/** Host-only delivery status. It is never an action receipt or a renewed authorization. */
export class PluginUiUpdateDeferredError extends PluginUiLoaderError {
  constructor(cause: unknown) {
    super("plugin_ui_update_deferred", { cause });
  }
}

export function isTransientPluginUiValidationError(error: unknown): boolean {
  return (
    error instanceof ControlApiTransportError ||
    (error instanceof ControlApiClientError && error.status >= 500) ||
    (error instanceof ControlApiProtocolError &&
      error.code === "control_api_error_envelope_invalid" &&
      error.httpStatus !== undefined &&
      error.httpStatus >= 500) ||
    (error instanceof PluginUiLoaderError &&
      error.code === "plugin_ui_control_timeout")
  );
}

/** Props have already been bounded and copied by checkedPluginUiProps. Object insertion order is immaterial. */
export function pluginUiPropsKey(props: PluginUiProps): string {
  return JSON.stringify(props, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, (value as Record<string, unknown>)[key]]),
    );
  });
}
