/**
 * Turns a probe result into text a user can act on.
 *
 * Each status has a different fix, so they are spelled out rather than
 * collapsed into "connection failed": a rejected key, a wrong address, and an
 * endpoint that speaks the wrong protocol all look identical otherwise.
 */

import type { ModelProviderProbeResponse } from "@crewon-ui-model/v2/ModelProviderProbeResponse";

import type { Locale } from "../i18n";

export type ProbeTone = "error" | "success" | "warning";

export function modelProviderProbeTone(
  probe: ModelProviderProbeResponse,
): ProbeTone {
  switch (probe.status) {
    case "ok":
      return "success";
    case "unauthorized":
    case "invalidResponse":
      return "warning";
    case "httpError":
    case "unreachable":
      return "error";
  }
}

function probeHeadline(
  probe: ModelProviderProbeResponse,
  locale: Locale,
): string {
  switch (probe.status) {
    case "ok":
      return locale === "zh" ? "连接成功" : "Connected";
    case "unauthorized":
      return locale === "zh" ? "密钥被拒绝" : "Credential rejected";
    case "httpError":
      return locale === "zh" ? "服务返回错误" : "Provider returned an error";
    case "unreachable":
      return locale === "zh" ? "无法连接" : "Could not connect";
    case "invalidResponse":
      return locale === "zh"
        ? "地址可达，但不是模型接口"
        : "Reachable, but not a model API";
  }
}

/**
 * What to change next, per status.
 *
 * `invalidResponse` names the Responses-vs-Chat-Completions mismatch, because
 * that is the most common cause and the backend supports only the former.
 */
function probeRemedy(
  probe: ModelProviderProbeResponse,
  locale: Locale,
): string | null {
  switch (probe.status) {
    case "ok":
      return null;
    case "unauthorized":
      return locale === "zh"
        ? "检查 API Key 是否正确、是否已过期，或该 Key 是否有权访问这个地址。"
        : "Check whether the API key is correct, still valid, and allowed to access this endpoint.";
    case "httpError":
      /*
       * A 5xx is not usually the address being wrong. It is commonly the
       * provider itself, or a proxy in front of it answering on its behalf,
       * which is what a machine with a system HTTP proxy sees for an address
       * that nothing is listening on.
       */
      return probe.httpStatus !== null && probe.httpStatus >= 500
        ? locale === "zh"
          ? "服务端或中间代理返回了错误。稍后重试，并确认该地址正在运行、且本机代理设置没有拦截它。"
          : "The provider or an intervening proxy returned an error. Retry later, and confirm the address is running and not being intercepted by a local proxy."
        : locale === "zh"
          ? "检查 Base URL 的路径部分是否正确（通常以 /v1 结尾）。"
          : "Check the path part of the base URL; it usually ends in /v1.";
    case "unreachable":
      return locale === "zh"
        ? "检查地址拼写、网络连通性，以及是否需要代理。"
        : "Check the address, network reachability, and whether a proxy is required.";
    case "invalidResponse":
      return locale === "zh"
        ? "该地址没有返回模型清单。CrewON 目前只支持 Responses 兼容接口，不支持 Chat Completions 格式的服务。"
        : "That address did not return a model catalog. CrewON supports Responses-compatible APIs only, not Chat Completions endpoints.";
  }
}

/** Renders a probe result as panel body text. */
export function modelProviderProbeText(
  probe: ModelProviderProbeResponse,
  locale: Locale,
): string {
  const lines = [
    probeHeadline(probe, locale),
    `${locale === "zh" ? "Provider" : "Provider"}: ${probe.providerId}`,
    `${locale === "zh" ? "请求地址" : "Endpoint"}: ${probe.endpoint}`,
  ];

  if (probe.httpStatus !== null) {
    lines.push(
      `${locale === "zh" ? "状态码" : "HTTP status"}: ${probe.httpStatus}`,
    );
  }
  if (probe.modelCount !== null) {
    lines.push(
      `${locale === "zh" ? "可用模型" : "Models advertised"}: ${probe.modelCount}`,
    );
  }
  lines.push(
    `${locale === "zh" ? "已附带密钥" : "Credential attached"}: ${
      probe.authenticated
        ? locale === "zh"
          ? "是"
          : "yes"
        : locale === "zh"
          ? "否"
          : "no"
    }`,
  );
  lines.push(`${locale === "zh" ? "耗时" : "Latency"}: ${probe.latencyMs}ms`);

  if (probe.message) {
    lines.push(`${locale === "zh" ? "返回信息" : "Detail"}: ${probe.message}`);
  }

  const remedy = probeRemedy(probe, locale);
  if (remedy) {
    lines.push(remedy);
  }

  /*
   * A provider that answers a catalog without any credential is reported
   * rather than treated as a clean pass: it usually means the key was never
   * applied, and the first real turn is where that would otherwise surface.
   */
  if (probe.status === "ok" && !probe.authenticated) {
    lines.push(
      locale === "zh"
        ? "注意：本次请求没有附带任何密钥。如果该服务本应鉴权，请检查密钥是否已保存。"
        : "Note: no credential was attached to this request. If the provider expects authentication, check that the key was saved.",
    );
  }

  return lines.join("\n");
}
