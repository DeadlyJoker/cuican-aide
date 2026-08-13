import type { ModelProviderProbeResponse } from "@crewon-ui-model/v2/ModelProviderProbeResponse";
import { describe, expect, it } from "vitest";

import {
  modelProviderProbeText,
  modelProviderProbeTone,
} from "./modelProviderProbeText";

function probeResponse(
  overrides: Partial<ModelProviderProbeResponse> = {},
): ModelProviderProbeResponse {
  return {
    providerId: "my-provider",
    endpoint: "https://api.example.com/v1/models",
    status: "ok",
    httpStatus: 200,
    modelCount: 4,
    authenticated: true,
    message: null,
    latencyMs: 128n,
    ...overrides,
  } as ModelProviderProbeResponse;
}

describe("modelProviderProbeTone", () => {
  it("maps each status onto a tone", () => {
    expect(modelProviderProbeTone(probeResponse())).toBe("success");
    expect(
      modelProviderProbeTone(probeResponse({ status: "unauthorized" })),
    ).toBe("warning");
    expect(
      modelProviderProbeTone(probeResponse({ status: "invalidResponse" })),
    ).toBe("warning");
    expect(modelProviderProbeTone(probeResponse({ status: "httpError" }))).toBe(
      "error",
    );
    expect(
      modelProviderProbeTone(probeResponse({ status: "unreachable" })),
    ).toBe("error");
  });
});

describe("modelProviderProbeText", () => {
  it("reports a successful probe with the endpoint and model count", () => {
    const text = modelProviderProbeText(probeResponse(), "zh");

    expect(text).toContain("连接成功");
    expect(text).toContain("https://api.example.com/v1/models");
    expect(text).toContain("可用模型: 4");
    expect(text).toContain("128ms");
  });

  /*
   * Each failure has a different fix, so the text has to name the specific one
   * rather than say the connection failed.
   */
  it("tells a rejected credential apart from a wrong address", () => {
    const rejected = modelProviderProbeText(
      probeResponse({
        status: "unauthorized",
        httpStatus: 401,
        modelCount: null,
        message: "invalid api key",
      }),
      "zh",
    );
    expect(rejected).toContain("密钥被拒绝");
    expect(rejected).toContain("API Key");
    expect(rejected).toContain("invalid api key");

    const unreachable = modelProviderProbeText(
      probeResponse({
        status: "unreachable",
        httpStatus: null,
        modelCount: null,
        message: "network error: connection refused",
      }),
      "zh",
    );
    expect(unreachable).toContain("无法连接");
    expect(unreachable).toContain("网络连通性");
    expect(unreachable).not.toContain("状态码");
  });

  /*
   * The most common cause of a reachable-but-wrong endpoint is a Chat
   * Completions service, which this build cannot use at all; saying so saves
   * the user a long round of trial and error.
   */
  it("names the responses-only limitation when the body is not a catalog", () => {
    const text = modelProviderProbeText(
      probeResponse({ status: "invalidResponse", modelCount: null }),
      "zh",
    );

    expect(text).toContain("不是模型接口");
    expect(text).toContain("Chat Completions");
  });

  /*
   * A catalog served without any credential usually means the key never got
   * applied, which would otherwise only surface on the first real turn.
   */
  it("flags a pass that sent no credential at all", () => {
    const text = modelProviderProbeText(
      probeResponse({ authenticated: false }),
      "zh",
    );

    expect(text).toContain("没有附带任何密钥");
  });

  it("renders english copy for each failure mode", () => {
    expect(
      modelProviderProbeText(probeResponse({ status: "httpError" }), "en"),
    ).toContain("Provider returned an error");
    expect(
      modelProviderProbeText(probeResponse({ status: "unreachable" }), "en"),
    ).toContain("Could not connect");
  });

  /*
   * A 5xx is rarely the path being wrong, and on a machine with a system HTTP
   * proxy it is what an address with nothing listening actually reports, so
   * pointing the user at /v1 would send them to the wrong place.
   */
  it("separates a server-side failure from a wrong path", () => {
    expect(
      modelProviderProbeText(
        probeResponse({ status: "httpError", httpStatus: 502 }),
        "en",
      ),
    ).toContain("intervening proxy");
    expect(
      modelProviderProbeText(
        probeResponse({ status: "httpError", httpStatus: 404 }),
        "en",
      ),
    ).toContain("usually ends in /v1");
  });
});
