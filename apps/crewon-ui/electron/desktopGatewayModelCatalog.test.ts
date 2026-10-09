import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readGatewayModelCatalog,
  writeGatewayModelCatalog,
} from "./desktopGatewayModelCatalog.ts";

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);
const provider = {
  providerId: "gateway",
  endpoint: "https://model.example/v1",
  apiKey: "gateway-fixture-secret",
  modelId: "model-a",
};

it("keeps the complete gateway directory when only the default model changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-directory-"));
  directories.push(directory);
  const models = Array.from({ length: 100 }, (_, index) => `model-${index}`);
  writeGatewayModelCatalog(directory, provider, models);
  expect(
    readGatewayModelCatalog(directory, { ...provider, modelId: "model-99" }),
  ).toEqual(models);
  expect(
    readGatewayModelCatalog(directory, {
      ...provider,
      endpoint: `${provider.endpoint}/`,
    }),
  ).toEqual(models);
  const text = readFileSync(
    join(directory, "desktop-model-catalog-cache.json"),
    "utf8",
  );
  expect(text).not.toContain(provider.apiKey);
  expect(text).not.toContain(provider.modelId);
});

it("never carries model permissions across credentials or endpoints", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-directory-"));
  directories.push(directory);
  writeGatewayModelCatalog(directory, provider, ["model-a", "model-b"]);
  expect(
    readGatewayModelCatalog(directory, { ...provider, apiKey: "other-secret" }),
  ).toBeNull();
  expect(
    readGatewayModelCatalog(directory, {
      ...provider,
      endpoint: "https://other.example/v1",
    }),
  ).toBeNull();
  expect(() =>
    writeGatewayModelCatalog(directory, provider, ["model-a", "model-a"]),
  ).toThrow();
  expect(readGatewayModelCatalog(directory, provider)).toEqual([
    "model-a",
    "model-b",
  ]);
});
