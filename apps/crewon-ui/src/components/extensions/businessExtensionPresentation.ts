import type { ExtensionCatalogEntry } from "@crewon/contracts";
import {
  ControlApiClientError,
  ControlApiProtocolError,
} from "@crewon/control-client";
import type { Locale } from "../../lib/i18n";

export const KREA2_PLUGIN_ID = "crewon.comfyui-krea2";

/** This initial form is intentionally limited to the shipped Krea2 schema. */
export function supportedImageExtension(entry: ExtensionCatalogEntry): boolean {
  return (
    entry.pluginId === KREA2_PLUGIN_ID &&
    entry.pluginVersion === "0.1.0" &&
    entry.credentialSlots.length === 0 &&
    singleTextSchema(entry.configurationSchema, "baseUrl", 2_048) &&
    singleTextSchema(entry.inputSchema, "prompt", 2_000)
  );
}
function singleTextSchema(
  schema: Record<string, unknown>,
  field: string,
  maximum: number,
): boolean {
  if (
    Object.keys(schema).sort().join() !==
      "additionalProperties,properties,required,type" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    JSON.stringify(schema.required) !== JSON.stringify([field])
  )
    return false;
  const properties = schema.properties;
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    Object.keys(properties).join() !== field
  )
    return false;
  const value = (properties as Record<string, unknown>)[field];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const text = value as Record<string, unknown>;
  return (
    text.type === "string" &&
    text.maxLength === maximum &&
    text.enum === null &&
    Object.keys(text).sort().join() === "enum,maxLength,type"
  );
}
export function extensionMutationUncertain(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ControlApiProtocolError ||
    (error instanceof ControlApiClientError &&
      (error.category === "unknownOutcome" ||
        error.status >= 500 ||
        error.status === 408))
  );
}
export function extensionErrorCopy(error: unknown, locale: Locale): string {
  const zh = locale === "zh";
  if (error instanceof ControlApiClientError && error.status === 409)
    return zh
      ? "状态已变化，或当前会话有尚未完成的任务。请刷新状态后重试。"
      : "State changed or this conversation has unfinished work. Refresh status and retry.";
  if (error instanceof ControlApiClientError && error.status === 403)
    return zh
      ? "当前身份没有此插件的操作权限。"
      : "Your identity is not authorized for this plugin action.";
  if (error instanceof ControlApiClientError && error.status === 400)
    return zh
      ? "请求未通过校验，请检查服务地址、描述或所选 Agent。"
      : "The request was rejected. Check the service URL, description, or selected Agent.";
  return zh
    ? "暂时无法核对插件状态。请刷新后重试。"
    : "Plugin state could not be verified. Refresh and retry.";
}
