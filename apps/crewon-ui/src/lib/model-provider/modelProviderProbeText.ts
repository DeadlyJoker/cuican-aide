import type { ProbeModelProviderResponse } from "@crewon/contracts";

import type { Locale } from "../i18n";

export type ProbeTone = "error" | "success" | "warning";

export function modelProviderProbeSucceeded(
  probe: ProbeModelProviderResponse,
  expectedModelId: string | null = null,
): boolean {
  return (
    probe.status === "ok" &&
    (expectedModelId === null ||
      probe.models?.some(({ id }) => id === expectedModelId) === true)
  );
}

export function modelProviderProbeTone(
  probe: ProbeModelProviderResponse,
): ProbeTone {
  switch (probe.status) {
    case "ok":
      return "success";
    case "credentialMissing":
    case "authenticationFailed":
    case "invalidResponse":
    case "bindingMismatch":
      return "warning";
    case "rateLimited":
    case "providerError":
    case "unreachable":
      return "error";
  }
}

function headline(
  status: ProbeModelProviderResponse["status"],
  locale: Locale,
): string {
  const zh = {
    ok: "连接成功",
    credentialMissing: "凭据不可用",
    authenticationFailed: "密钥被拒绝",
    rateLimited: "请求过于频繁",
    providerError: "服务返回错误",
    unreachable: "无法连接",
    invalidResponse: "模型接口响应无效",
    bindingMismatch: "运行时绑定已变化",
  } as const;
  const en = {
    ok: "Connected",
    credentialMissing: "Credential unavailable",
    authenticationFailed: "Credential rejected",
    rateLimited: "Probe rate limited",
    providerError: "Provider returned an error",
    unreachable: "Could not connect",
    invalidResponse: "Invalid model API response",
    bindingMismatch: "Runtime binding changed",
  } as const;
  return (locale === "zh" ? zh : en)[status];
}

function remedy(
  status: ProbeModelProviderResponse["status"],
  locale: Locale,
): string | null {
  if (status === "ok") return null;
  const zh = {
    credentialMissing: "请重新保存凭据，或确认配置的环境变量在 Worker 中可用。",
    authenticationFailed: "检查 API Key 是否正确、有效并有权访问该服务。",
    rateLimited: "请等待后再重试；连接测试本身有独立限流。",
    providerError: "稍后重试，并确认服务或前置代理运行正常。",
    unreachable: "检查地址、DNS 与网络连通性；不安全的出站目标会被拒绝。",
    invalidResponse:
      "该地址必须返回有界的 /models JSON；CrewON 不接受其它协议响应。",
    bindingMismatch: "设置已切换，请刷新页面后针对当前 Provider 重新测试。",
  } as const;
  const en = {
    credentialMissing:
      "Save the credential again, or confirm the configured environment variable is available to the Worker.",
    authenticationFailed:
      "Check that the API key is valid and authorized for this service.",
    rateLimited:
      "Wait before retrying; connectivity probes have a separate limit.",
    providerError:
      "Retry later and confirm the provider or intervening proxy is healthy.",
    unreachable:
      "Check the address, DNS, and network. Unsafe egress targets are denied.",
    invalidResponse:
      "The endpoint must return a bounded /models JSON response; other protocol shapes are rejected.",
    bindingMismatch:
      "Settings changed. Refresh and probe the currently active Provider.",
  } as const;
  return (locale === "zh" ? zh : en)[status];
}

export function modelProviderProbeText(
  probe: ProbeModelProviderResponse,
  locale: Locale,
  expectedModelId: string | null = null,
): string {
  const modelAvailable = modelProviderProbeSucceeded(probe, expectedModelId);
  const lines = [
    probe.status === "ok" && !modelAvailable
      ? locale === "zh"
        ? "模型不可用"
        : "Model unavailable"
      : headline(probe.status, locale),
    `Provider: ${probe.providerId}`,
    `Catalog revision: ${probe.catalogRevision}`,
  ];
  if (expectedModelId !== null) {
    lines.push(
      `${locale === "zh" ? "配置模型" : "Configured model"}: ${expectedModelId}`,
    );
  }
  if (probe.modelCount !== null) {
    lines.push(
      `${locale === "zh" ? "可用模型" : "Models advertised"}: ${probe.modelCount}`,
    );
  }
  lines.push(`${locale === "zh" ? "耗时" : "Latency"}: ${probe.latencyMs}ms`);
  if (probe.retryAfterMs !== null) {
    lines.push(
      `${locale === "zh" ? "建议等待" : "Retry after"}: ${probe.retryAfterMs}ms`,
    );
  }
  const next = remedy(probe.status, locale);
  if (next !== null) lines.push(next);
  if (probe.status === "ok" && !modelAvailable) {
    lines.push(
      locale === "zh"
        ? "该模型不在 Provider 返回的 /models 列表中，请检查模型 ID 或 LiteLLM model_name。"
        : "This model is not advertised by the Provider /models response. Check the model ID or LiteLLM model_name.",
    );
  }
  return lines.join("\n");
}
