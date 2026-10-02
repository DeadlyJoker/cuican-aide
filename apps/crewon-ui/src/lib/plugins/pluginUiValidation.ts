import {
  parsePluginUiJsonValue,
  PluginUiContractError,
} from "@crewon/contracts/plugins";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { PluginUiInstance, PluginUiProps } from "@crewon/plugin-sdk/ui";

export class PluginUiLoaderError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "PluginUiLoaderError";
  }
}

export function uiFailure(code: string): never {
  throw new PluginUiLoaderError(code);
}

export function uiRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    uiFailure("plugin_ui_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    uiFailure("plugin_ui_object_invalid");
  const result: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(input);
  if (keys.length > 8192) uiFailure("plugin_ui_json_limit");
  for (const key of keys) {
    if (typeof key !== "string") uiFailure("plugin_ui_field_invalid");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
      uiFailure("plugin_ui_field_invalid");
    result[key] = descriptor.value;
  }
  return result;
}

function fields(value: Record<string, unknown>, expected: readonly string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    uiFailure("plugin_ui_fields_invalid");
}

/** Descriptor-only copy: no accessors, cycles, private object types or non-JSON numbers. */
export function copyPluginUiJson(
  input: unknown,
  maxBytes: number,
): PluginJsonValue {
  try {
    return parsePluginUiJsonValue(input, { maxBytes });
  } catch (error) {
    if (error instanceof PluginUiContractError)
      throw new PluginUiLoaderError(error.code, { cause: error });
    throw error;
  }
}

export function checkedPluginUiProps(
  input: unknown,
  contributionId: string,
): PluginUiProps {
  const value = uiRecord(copyPluginUiJson(input, 64 * 1024));
  fields(value, ["schemaVersion", "contributionId", "theme", "data"]);
  if (
    value.schemaVersion !== "crewon.plugin-ui-props.v1" ||
    value.contributionId !== contributionId
  )
    uiFailure("plugin_ui_props_identity_invalid");
  const theme = uiRecord(value.theme);
  fields(theme, ["mode", "tokens"]);
  if (theme.mode !== "light" && theme.mode !== "dark")
    uiFailure("plugin_ui_theme_invalid");
  const tokens = uiRecord(theme.tokens);
  if (Object.keys(tokens).length > 64) uiFailure("plugin_ui_theme_limit");
  for (const [key, token] of Object.entries(tokens)) {
    if (
      !/^--[a-zA-Z][a-zA-Z0-9_-]{0,126}$/u.test(key) ||
      typeof token !== "string" ||
      token.length > 2048
    )
      uiFailure("plugin_ui_theme_invalid");
  }
  return Object.freeze({
    schemaVersion: "crewon.plugin-ui-props.v1",
    contributionId,
    theme: Object.freeze({
      mode: theme.mode,
      tokens: Object.freeze({ ...tokens }) as Readonly<Record<string, string>>,
    }),
    data: value.data as PluginJsonValue,
  });
}

export function checkedPluginUiInstance(input: unknown): PluginUiInstance {
  if (!input || typeof input !== "object")
    uiFailure("plugin_ui_instance_invalid");
  function method(name: "update" | "dispose") {
    let object: object | null = input as object;
    for (let depth = 0; object && depth < 16; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function")
          uiFailure("plugin_ui_instance_invalid");
        return descriptor.value.bind(input);
      }
      object = Object.getPrototypeOf(object);
    }
    return uiFailure("plugin_ui_instance_invalid");
  }
  // The structural SDK ABI permits class methods and private state; only lifecycle methods cross this boundary.
  return Object.freeze({
    update: method("update") as PluginUiInstance["update"],
    dispose: method("dispose") as PluginUiInstance["dispose"],
  });
}

export function checkedPluginUiAction(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/u.test(input)
  )
    uiFailure("plugin_ui_action_invalid");
  return input;
}

export function checkedPluginUiAssetBase(input: string): string {
  if (
    typeof input !== "string" ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/u.test(input) ||
    input.split("/").some((part) => part === "src" || part.startsWith("@"))
  )
    uiFailure("plugin_ui_asset_base_invalid");
  return input.replace(/\/$/u, "");
}

export function pluginUiAssetUrl(
  base: string,
  mountRef: string,
  path: string,
  routeStyle: PluginUiAssetRouteStyle = "mount-root",
): string {
  if (routeStyle !== "mount-root" && routeStyle !== "control-mount-assets")
    uiFailure("plugin_ui_asset_route_invalid");
  if (
    !/^[A-Za-z0-9_-]{32,128}$/u.test(mountRef) ||
    path
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith("@"),
      ) ||
    /[\\?#:%\u0000-\u001f]/u.test(path) ||
    path.startsWith("/")
  )
    uiFailure("plugin_ui_asset_path_invalid");
  const assets = routeStyle === "control-mount-assets" ? "/assets" : "";
  return `${base}/${mountRef}${assets}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export type PluginUiAssetRouteStyle = "mount-root" | "control-mount-assets";

export function abortedPluginUiOperation(): PluginUiLoaderError {
  return new PluginUiLoaderError("plugin_ui_operation_aborted");
}

export function awaitPluginUiOperation<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedPluginUiOperation());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedPluginUiOperation());
    signal.addEventListener("abort", abort, { once: true });
    task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
