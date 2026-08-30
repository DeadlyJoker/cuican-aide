import type { ProbeModelProviderResponse } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  modelProviderProbeSucceeded,
  modelProviderProbeText,
  modelProviderProbeTone,
} from "./modelProviderProbeText";

function probe(
  overrides: Partial<ProbeModelProviderResponse> = {},
): ProbeModelProviderResponse {
  return {
    disposition: "completed",
    providerId: "gateway",
    catalogRevision: 3,
    status: "ok",
    models: [{ id: "model-1", displayName: "Model One" }],
    modelCount: 1,
    latencyMs: 12,
    retryable: false,
    retryAfterMs: null,
    ...overrides,
  };
}

describe("modelProviderProbeText", () => {
  it("renders only the redacted public probe projection", () => {
    const text = modelProviderProbeText(probe(), "zh");
    expect(text).toContain("连接成功");
    expect(text).toContain("Catalog revision: 3");
    expect(text).toContain("可用模型: 1");
    expect(text).not.toContain("endpoint");
    expect(text).not.toContain("credential");
    expect(text).not.toContain("runtimeBinding");
  });

  it.each([
    ["ok", "success"],
    ["credentialMissing", "warning"],
    ["authenticationFailed", "warning"],
    ["invalidResponse", "warning"],
    ["bindingMismatch", "warning"],
    ["rateLimited", "error"],
    ["providerError", "error"],
    ["unreachable", "error"],
  ] as const)("maps %s to %s", (status, tone) => {
    expect(modelProviderProbeTone(probe({ status }))).toBe(tone);
  });

  it("shows bounded retry guidance without remote error text", () => {
    const text = modelProviderProbeText(
      probe({
        status: "rateLimited",
        models: null,
        modelCount: null,
        retryable: true,
        retryAfterMs: 1000,
      }),
      "en",
    );
    expect(text).toContain("Retry after: 1000ms");
    expect(text).toContain("separate limit");
  });

  it("rejects a successful connection that does not advertise the configured model", () => {
    expect(modelProviderProbeSucceeded(probe(), "missing-model")).toBe(false);
    expect(modelProviderProbeSucceeded(probe(), "model-1")).toBe(true);
    const text = modelProviderProbeText(probe(), "en", "missing-model");
    expect(text).toMatchInlineSnapshot(`
      "Model unavailable
      Provider: gateway
      Catalog revision: 3
      Configured model: missing-model
      Models advertised: 1
      Latency: 12ms
      This model is not advertised by the Provider /models response. Check the model ID or LiteLLM model_name."
    `);
  });
});
