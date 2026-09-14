import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCredentialStore } from "./providerCredentials.ts";
import {
  PACKAGED_DEFAULT_MODEL_FILE,
  PACKAGED_DEFAULT_PROVIDER_ID,
  provisionPackagedDefaultModel,
} from "./packagedDefaultModel.ts";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => {
      const text = value.toString();
      if (!text.startsWith("encrypted:")) throw new Error("foreign keychain");
      return text.slice(10);
    },
  },
}));
const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "crewon-default-model-test-"));
  temporary.push(path);
  return path;
}
const profile = {
  schemaVersion: "crewon.internal-default-model.v1",
  endpoint: "https://api.aicuican.com/v1",
  modelId: "gpt-5.5",
  apiKey: "synthetic-internal-test-key-not-a-real-secret",
};
function fixture() {
  const resourcesPath = directory();
  const data = directory();
  writeFileSync(
    join(resourcesPath, PACKAGED_DEFAULT_MODEL_FILE),
    JSON.stringify(profile),
  );
  const onChange = vi.fn(async () => undefined);
  const providers = new ProviderCredentialStore(data, onChange, {
    allowEnvironmentBootstrap: false,
  });
  return { resourcesPath, data, providers, onChange };
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
describe("internal build default model provisioning", () => {
  it("activates the packaged default on an empty Mac without any environment key", async () => {
    const context = fixture();
    expect(await provisionPackagedDefaultModel(context)).toBe("provisioned");
    expect(context.providers.active()).toMatchObject({
      providerId: PACKAGED_DEFAULT_PROVIDER_ID,
      modelId: "gpt-5.5",
      apiKey: profile.apiKey,
    });
    expect(context.providers.catalog().bindings[0]).toMatchObject({
      isActive: true,
      credentialAvailable: true,
      credentialKind: "keychain",
    });
    const persisted = readFileSync(
      join(context.data, "provider-credentials.json"),
      "utf8",
    );
    expect(persisted).not.toContain(profile.apiKey);
    const restarted = new ProviderCredentialStore(
      context.data,
      context.onChange,
      { allowEnvironmentBootstrap: false },
    );
    expect(restarted.active()).toEqual(context.providers.active());
    expect(
      await provisionPackagedDefaultModel({ ...context, providers: restarted }),
    ).toBe("preserved");
    expect(context.onChange).toHaveBeenCalledOnce();
  });
  it("preserves a usable user-selected model", async () => {
    const context = fixture();
    await context.providers.upsert({
      providerId: "custom",
      endpoint: "https://custom.example/v1",
      modelId: "chosen",
      credentialKind: "keychain",
      environmentVariable: null,
      secret: "user-chosen-key",
      activate: true,
    });
    expect(await provisionPackagedDefaultModel(context)).toBe("preserved");
    expect(context.providers.active()?.providerId).toBe("custom");
  });
  it("recovers from a migrated credential that the new Mac cannot decrypt", async () => {
    const context = fixture();
    writeFileSync(
      join(context.data, "provider-credentials.json"),
      JSON.stringify({
        schemaVersion: "crewon.provider-credentials.v1",
        activeProviderId: "old",
        bindings: [
          {
            providerId: "old",
            endpoint: "https://custom.example/v1",
            modelId: "old",
            credentialKind: "keychain",
            environmentVariable: null,
            encryptedSecret: Buffer.from("foreign").toString("base64"),
          },
        ],
      }),
    );
    const migrated = new ProviderCredentialStore(
      context.data,
      context.onChange,
      { allowEnvironmentBootstrap: false },
    );
    expect(
      await provisionPackagedDefaultModel({ ...context, providers: migrated }),
    ).toBe("provisioned");
    expect(migrated.active()?.providerId).toBe(PACKAGED_DEFAULT_PROVIDER_ID);
    expect(
      migrated
        .catalog()
        .bindings.some((binding) => binding.providerId === "old"),
    ).toBe(true);
  });
  it("does not invent a credential in ordinary release builds", async () => {
    const context = fixture();
    expect(
      await provisionPackagedDefaultModel({
        ...context,
        resourcesPath: directory(),
      }),
    ).toBe("not-bundled");
    expect(context.providers.active()).toBeNull();
  });
  it("rejects invalid profile data without exposing its contents", async () => {
    const context = fixture();
    writeFileSync(
      join(context.resourcesPath, PACKAGED_DEFAULT_MODEL_FILE),
      JSON.stringify({ ...profile, endpoint: "http://unexpected.example" }),
    );
    await expect(provisionPackagedDefaultModel(context)).rejects.toThrow(
      "packaged_default_model_invalid",
    );
    expect(context.providers.active()).toBeNull();
  });
});
