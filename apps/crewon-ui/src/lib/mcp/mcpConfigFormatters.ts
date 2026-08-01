import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";
import type { McpServerConfigRecord } from "@crewon-protocol/v2/McpServerConfigRecord";

import type { Locale } from "../i18n";

export function mcpConfigObject(
  record: McpServerConfigRecord,
): Record<string, JsonValue> {
  return record.config &&
    typeof record.config === "object" &&
    !Array.isArray(record.config)
    ? (record.config as Record<string, JsonValue>)
    : {};
}

export function mcpConfigEnabled(record: McpServerConfigRecord): boolean {
  const config = mcpConfigObject(record);
  return config.enabled !== false;
}

export function mcpConfigEndpoint(record: McpServerConfigRecord): string {
  const config = mcpConfigObject(record);
  const command = typeof config.command === "string" ? config.command : "";
  const url = typeof config.url === "string" ? config.url : "";
  return command || url;
}

export function mcpConfigEnvSummary(
  record: McpServerConfigRecord,
  locale: Locale,
): string | null {
  const config = mcpConfigObject(record);
  const env = config.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return null;
  }
  const count = Object.keys(env).length;
  if (count === 0) {
    return null;
  }
  return locale === "zh"
    ? `环境变量: ${count} 个 key（值已隐藏）`
    : `Environment: ${count} keys (values hidden)`;
}

export function mcpConfigDetailText(
  record: McpServerConfigRecord,
  locale: Locale,
): string {
  const config = mcpConfigObject(record);
  const endpoint = mcpConfigEndpoint(record);
  const args = Array.isArray(config.args)
    ? config.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const environmentId =
    typeof config.environment_id === "string" ? config.environment_id : "";

  return [
    locale === "zh"
      ? "已写入服务配置，等待运行态加载或当前线程使用。"
      : "Saved in MCP config; waiting for runtime load or thread use.",
    `Name: ${record.name}`,
    `${locale === "zh" ? "状态" : "Status"}: ${
      mcpConfigEnabled(record)
        ? locale === "zh"
          ? "启用"
          : "enabled"
        : locale === "zh"
          ? "停用"
          : "disabled"
    }`,
    endpoint ? `${locale === "zh" ? "入口" : "Endpoint"}: ${endpoint}` : null,
    args.length > 0
      ? locale === "zh"
        ? `参数: ${args.length} 项（值已隐藏）`
        : `Args: ${args.length} items (values hidden)`
      : null,
    mcpConfigEnvSummary(record, locale),
    environmentId ? `Environment: ${environmentId}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function mcpConfigSummaryText(
  records: McpServerConfigRecord[],
  locale: Locale,
): string {
  if (records.length === 0) {
    return locale === "zh"
      ? "暂无持久化服务配置。"
      : "No persisted MCP configs.";
  }

  return records
    .map((record) => {
      const endpoint = mcpConfigEndpoint(record);
      return [
        `- ${record.name}`,
        `  ${locale === "zh" ? "状态" : "status"}: ${
          mcpConfigEnabled(record)
            ? locale === "zh"
              ? "启用"
              : "enabled"
            : locale === "zh"
              ? "停用"
              : "disabled"
        }`,
        endpoint
          ? `  ${locale === "zh" ? "入口" : "endpoint"}: ${endpoint}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
