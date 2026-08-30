import type { ConfigReadResponse } from "@crewon/app-server-protocol/v2/ConfigReadResponse";
import { describe, expect, it } from "vitest";

import {
  modelProviderEntries,
  modelProviderEntry,
  selectedModelProviderId,
} from "./modelProviderConfig";

function configWith(config: Record<string, unknown>): ConfigReadResponse {
  return {
    config,
    origins: {},
    layers: null,
  } as unknown as ConfigReadResponse;
}

describe("modelProviderEntries", () => {
  it("reads provider entries and classifies how each supplies its credential", () => {
    const configRead = configWith({
      model_provider: "with-token",
      model_providers: {
        "with-token": {
          name: "Token Provider",
          base_url: "https://token.example.com/v1",
          experimental_bearer_token: "stored-secret",
          wire_api: "responses",
        },
        "with-env-key": {
          name: "Env Provider",
          base_url: "https://env.example.com/v1",
          env_key: "ENV_PROVIDER_KEY",
          wire_api: "responses",
        },
        "no-credential": {
          base_url: "http://127.0.0.1:11434/v1",
          wire_api: "responses",
        },
      },
    });

    expect(modelProviderEntries(configRead)).toEqual([
      {
        id: "no-credential",
        name: "no-credential",
        baseUrl: "http://127.0.0.1:11434/v1",
        credentialKind: "none",
        envKey: "",
        hasStoredToken: false,
        modelId: "",
      },
      {
        id: "with-env-key",
        name: "Env Provider",
        baseUrl: "https://env.example.com/v1",
        credentialKind: "env-key",
        envKey: "ENV_PROVIDER_KEY",
        hasStoredToken: false,
        modelId: "",
      },
      {
        id: "with-token",
        name: "Token Provider",
        baseUrl: "https://token.example.com/v1",
        credentialKind: "bearer-token",
        envKey: "",
        hasStoredToken: true,
        modelId: "",
      },
    ]);
  });

  /*
   * The secret itself must never travel into a panel field, or it would be
   * rendered back into the DOM and re-persisted on every save.
   */
  it("reports that a token is stored without exposing its value", () => {
    const configRead = configWith({
      model_providers: {
        secretive: {
          base_url: "https://secretive.example.com/v1",
          experimental_bearer_token: "super-secret-value",
        },
      },
    });

    const entry = modelProviderEntry(configRead, "secretive");

    expect(entry?.hasStoredToken).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("super-secret-value");
  });

  it("treats an empty stored token as no credential", () => {
    const configRead = configWith({
      model_providers: {
        blank: {
          base_url: "https://blank.example.com/v1",
          experimental_bearer_token: "",
        },
      },
    });

    expect(modelProviderEntry(configRead, "blank")?.credentialKind).toBe(
      "none",
    );
  });

  it("returns nothing when config has no provider table", () => {
    expect(modelProviderEntries(configWith({}))).toEqual([]);
    expect(modelProviderEntries(null)).toEqual([]);
    expect(selectedModelProviderId(null)).toBe("");
  });

  it("reads the selected provider id", () => {
    expect(
      selectedModelProviderId(configWith({ model_provider: "chosen" })),
    ).toBe("chosen");
  });

  it("uses the native catalog as credential and active-provider authority", () => {
    const configRead = configWith({
      model_provider: "legacy",
      model_providers: {
        legacy: {
          base_url: "https://legacy.example.com/v1",
          experimental_bearer_token: "must-not-count",
        },
      },
    });
    const catalog = {
      activeProviderId: "native",
      bindings: [
        {
          credentialAvailable: true,
          credentialKind: "keychain" as const,
          endpoint: "https://native.example.com/v1",
          environmentVariable: null,
          isActive: true,
          modelId: "native-model",
          providerId: "native",
        },
      ],
    };

    expect(modelProviderEntries(configRead, catalog)).toEqual([
      {
        id: "legacy",
        name: "legacy",
        baseUrl: "https://legacy.example.com/v1",
        credentialKind: "none",
        envKey: "",
        hasStoredToken: false,
        modelId: "",
      },
      {
        id: "native",
        name: "native",
        baseUrl: "https://native.example.com/v1",
        credentialKind: "bearer-token",
        envKey: "",
        hasStoredToken: true,
        modelId: "native-model",
      },
    ]);
    expect(selectedModelProviderId(configRead, catalog)).toBe("native");
    expect(
      JSON.stringify(modelProviderEntries(configRead, catalog)),
    ).not.toContain("must-not-count");
  });
});
