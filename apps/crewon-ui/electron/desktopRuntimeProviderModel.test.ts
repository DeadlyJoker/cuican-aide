import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";
import { describe, expect, it } from "vitest";
import { desktopRuntimeProviderModel } from "./desktopRuntimeProviderModel.ts";
const provider = Object.freeze({
  providerId: "aicuican",
  endpoint: "https://api.aicuican.com/v1",
  modelId: "gpt-5.5",
  apiKey: null,
});
describe("runtime model chosen from the actual Agent catalog", () => {
  it("retains identity when the configured model is still available", () => {
    expect(
      desktopRuntimeProviderModel(provider, ["gpt-5.6-sol", "gpt-5.5"]),
    ).toBe(provider);
  });
  it("replaces a removed default in runtime only without changing the stored provider", () => {
    expect(
      desktopRuntimeProviderModel(provider, [
        "gpt-image-2",
        "gpt-5.6-sol",
        "gpt-5.6-luna",
      ]),
    ).toEqual({ ...provider, modelId: "gpt-5.6-sol" });
    expect(provider.modelId).toBe("gpt-5.5");
  });
  it("refuses empty or malformed catalogs before a runtime can publish a default", () => {
    expect(desktopRuntimeProviderModel(provider, [])).toBeNull();
    expect(desktopRuntimeProviderModel(provider, ["gpt-image-2"])).toBeNull();
    for (const catalog of [[""], ["model", "model"]])
      expect(() => desktopRuntimeProviderModel(provider, catalog)).toThrow();
  });
});

it("the actual supervisor gives release and Worker the newly advertised default", async () => {
  const f = desktopPluginManagementFixture({
    provider: "configured",
    approval: "absent",
    modelCatalog: ["gpt-image-2", "fixture-new-model"],
  });
  try {
    await f.owner.start();
    const records = f
      .records()
      .filter(
        (record) => record.kind === "release" || record.kind === "worker",
      );
    expect(records.map((record) => record.kind).sort()).toEqual([
      "release",
      "worker",
    ]);
    expect(
      records.every((record) => record.modelId === "fixture-new-model"),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("no runnable model retains the original management Control without starting a Worker", async () => {
  const f = desktopPluginManagementFixture({
    provider: "configured",
    approval: "present",
    modelCatalog: [],
  });
  try {
    await f.owner.start();
    expect(f.records().map((record) => record.kind)).toEqual(["control"]);
    expect(f.records()[0]!.modelId).toBeNull();
  } finally {
    await f.close();
  }
});
