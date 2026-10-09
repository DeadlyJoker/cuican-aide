import { expect, it } from "vitest";
import { desktopRuntimeModelDiscovery } from "./desktopRuntimeModelDiscovery.ts";
import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";
import { readGatewayModelCatalog } from "./desktopGatewayModelCatalog.ts";

it.each(["credentialMissing", "authenticationFailed", "bindingMismatch"])(
  "%s replaces a previously successful directory and starts only base Control across restart",
  async (deniedStatus) => {
    let status = "ok";
    const f = desktopPluginManagementFixture({
      provider: "configured",
      approval: "absent",
      modelDiscoveryOutcome: () => ({
        status,
        models: ["fixture-model", "second-model"],
      }),
    });
    const provider = {
      providerId: "orchestration-fixture",
      endpoint: "http://127.0.0.1:1/v1",
      modelId: "fixture-model",
      apiKey: "fixture-model-secret",
    };
    try {
      await f.owner.start();
      expect(
        f
          .records()
          .map((record) => record.kind)
          .sort(),
      ).toEqual(["control", "release", "worker"]);
      expect(readGatewayModelCatalog(f.dataDirectory, provider)).toEqual([
        "fixture-model",
        "second-model",
      ]);
      await f.owner.stop();
      const before = f.records().length;
      status = deniedStatus;
      await f.owner.start();
      expect(
        f
          .records()
          .slice(before)
          .map((record) => record.kind),
      ).toEqual(["control"]);
      expect(readGatewayModelCatalog(f.dataDirectory, provider)).toEqual([]);
      await f.owner.stop();
      const afterDenied = f.records().length;
      status = "unreachable";
      await f.owner.start();
      expect(
        f
          .records()
          .slice(afterDenied)
          .map((record) => record.kind),
      ).toEqual(["control"]);
      expect(readGatewayModelCatalog(f.dataDirectory, provider)).toEqual([]);
      await f.owner.stop();
      const beforeRecovery = f.records().length;
      status = "ok";
      await f.owner.start();
      expect(
        f
          .records()
          .slice(beforeRecovery)
          .map((record) => record.kind)
          .sort(),
      ).toEqual(["control", "release", "worker"]);
    } finally {
      await f.close();
    }
  },
);

it("preserves fallback only for temporary failures and copies successful discovery", () => {
  for (const status of [
    "unreachable",
    "rateLimited",
    "providerError",
    "invalidResponse",
  ])
    expect(desktopRuntimeModelDiscovery({ status, models: [] })).toBeNull();
  const models = ["one", "two"];
  const discovered = desktopRuntimeModelDiscovery({ status: "ok", models });
  models.push("later");
  expect(discovered).toEqual(["one", "two"]);
  expect(Object.isFrozen(discovered)).toBe(true);
});
