import { describe, expect, it } from "vitest";

import {
  buildClearModelProviderSelectionEdits,
  buildModelProviderDeleteEdits,
  buildModelProviderEdits,
  buildSelectModelProviderEdits,
  modelProviderBaseUrlError,
  modelProviderDraftError,
  modelProviderIdError,
  type ModelProviderDraft,
} from "./modelProviderEdits";

function draft(
  overrides: Partial<ModelProviderDraft> = {},
): ModelProviderDraft {
  return {
    id: "my-provider",
    name: "My Provider",
    baseUrl: "https://api.example.com/v1",
    credentialKind: "bearer-token",
    envKey: "",
    modelId: "provider-model",
    apiKey: "sk-test",
    setAsDefault: false,
    ...overrides,
  };
}

describe("modelProviderIdError", () => {
  it("accepts a lowercase slug", () => {
    expect(modelProviderIdError("my-provider_2", "en")).toBeNull();
  });

  /*
   * The backend rejects reserved ids outright, so catching them here keeps the
   * user from filling in a whole form only to have the write fail.
   */
  it("rejects built-in provider ids that config cannot override", () => {
    expect(modelProviderIdError("openai", "en")).toContain("built-in");
    expect(modelProviderIdError("amazon-bedrock", "en")).toContain("built-in");
    expect(modelProviderIdError("ollama", "en")).toContain("built-in");
  });

  /*
   * The id is spliced into a dotted key path, so a separator would silently
   * write to a different location than the one displayed.
   */
  it("rejects ids that would break the config key path", () => {
    expect(modelProviderIdError("has.dot", "en")).not.toBeNull();
    expect(modelProviderIdError("has space", "en")).not.toBeNull();
    expect(modelProviderIdError('has"quote', "en")).not.toBeNull();
    expect(modelProviderIdError("UPPER", "en")).not.toBeNull();
    expect(modelProviderIdError("-leading-hyphen", "en")).not.toBeNull();
  });

  it("rejects an empty id and a duplicate id", () => {
    expect(modelProviderIdError("  ", "en")).toContain("required");
    expect(modelProviderIdError("taken", "en", ["taken"])).toContain(
      "already exists",
    );
  });
});

describe("modelProviderBaseUrlError", () => {
  it("accepts https and loopback http urls", () => {
    expect(
      modelProviderBaseUrlError("https://api.example.com/v1", "en"),
    ).toBeNull();
    expect(
      modelProviderBaseUrlError("http://127.0.0.1:11434/v1", "en"),
    ).toBeNull();
  });

  it("rejects cleartext remote endpoints", () => {
    expect(
      modelProviderBaseUrlError("http://api.example.com/v1", "en"),
    ).toContain("loopback");
  });

  /*
   * The backend joins `/models` onto this value directly, so a relative path
   * produces a request that cannot be built rather than a clear failure.
   */
  it("rejects relative and non-http urls", () => {
    expect(modelProviderBaseUrlError("/v1", "en")).toContain("absolute");
    expect(modelProviderBaseUrlError("api.example.com/v1", "en")).toContain(
      "absolute",
    );
    expect(
      modelProviderBaseUrlError("ftp://api.example.com/v1", "en"),
    ).toContain("http");
    expect(modelProviderBaseUrlError("", "en")).toContain("required");
  });
});

describe("modelProviderDraftError", () => {
  it("accepts a complete draft", () => {
    expect(modelProviderDraftError(draft(), "en")).toBeNull();
  });

  it("requires an environment variable name when the credential is an env key", () => {
    expect(
      modelProviderDraftError(
        draft({ credentialKind: "env-key", envKey: "", apiKey: "" }),
        "en",
      ),
    ).toContain("Environment variable");
  });

  it("requires an api key for a new bearer-token provider", () => {
    expect(modelProviderDraftError(draft({ apiKey: "" }), "en")).toContain(
      "API key",
    );
  });

  it("requires a model id", () => {
    expect(modelProviderDraftError(draft({ modelId: "" }), "en")).toContain(
      "Model ID",
    );
  });

  /*
   * Editing an existing provider must not force the user to retype a secret
   * they cannot read back, so a stored token satisfies the requirement.
   */
  it("allows saving an existing bearer-token provider without retyping the key", () => {
    expect(
      modelProviderDraftError(draft({ apiKey: "" }), "en", {
        hasStoredToken: true,
      }),
    ).toBeNull();
  });

  it("does not require a credential when the provider needs none", () => {
    expect(
      modelProviderDraftError(
        draft({ credentialKind: "none", apiKey: "", envKey: "" }),
        "en",
      ),
    ).toBeNull();
  });
});

describe("buildModelProviderEdits", () => {
  it("writes the whole entry with the supported wire api", () => {
    expect(buildModelProviderEdits(draft())).toEqual([
      {
        keyPath: "model_providers.my-provider",
        mergeStrategy: "replace",
        value: {
          name: "My Provider",
          base_url: "https://api.example.com/v1",
          wire_api: "responses",
        },
      },
    ]);
  });

  /*
   * Replacing rather than upserting is what makes a credential switch clean: an
   * upsert would leave the old `env_key` beside the new token, and which one
   * the backend honours would depend on resolution order rather than on what
   * the user chose.
   */
  it("drops the previous credential when the kind changes", () => {
    const edits = buildModelProviderEdits(
      draft({
        credentialKind: "env-key",
        envKey: "MY_PROVIDER_KEY",
        apiKey: "",
      }),
    );

    expect(edits[0]?.mergeStrategy).toBe("replace");
    expect(edits[0]?.value).toEqual({
      name: "My Provider",
      base_url: "https://api.example.com/v1",
      wire_api: "responses",
      env_key: "MY_PROVIDER_KEY",
    });
  });

  it("never writes a bearer token into config", () => {
    const edits = buildModelProviderEdits(draft({ apiKey: "already-stored" }));

    expect(JSON.stringify(edits)).not.toContain("already-stored");
    expect(edits[0]?.value).not.toHaveProperty("experimental_bearer_token");
  });

  it("omits the credential entirely for a provider that needs none", () => {
    const edits = buildModelProviderEdits(
      draft({ credentialKind: "none", apiKey: "", envKey: "" }),
    );

    expect(edits[0]?.value).toEqual({
      name: "My Provider",
      base_url: "https://api.example.com/v1",
      wire_api: "responses",
    });
  });

  it("falls back to the id when no display name was given", () => {
    expect(
      buildModelProviderEdits(draft({ name: "  " }))[0]?.value,
    ).toMatchObject({ name: "my-provider" });
  });

  it("selects the provider as default when asked", () => {
    expect(buildModelProviderEdits(draft({ setAsDefault: true }))).toHaveLength(
      2,
    );
    expect(buildModelProviderEdits(draft({ setAsDefault: true }))[1]).toEqual({
      keyPath: "model_provider",
      mergeStrategy: "replace",
      value: "my-provider",
    });
  });

  it("trims surrounding whitespace out of persisted values", () => {
    const edits = buildModelProviderEdits(
      draft({
        id: " spaced ",
        name: " Spaced Provider ",
        baseUrl: " https://api.example.com/v1 ",
        apiKey: " sk-spaced ",
      }),
    );

    expect(edits[0]).toEqual({
      keyPath: "model_providers.spaced",
      mergeStrategy: "replace",
      value: {
        name: "Spaced Provider",
        base_url: "https://api.example.com/v1",
        wire_api: "responses",
      },
    });
  });
});

describe("buildModelProviderDeleteEdits", () => {
  /** A null value is how the backend clears a config path. */
  it("clears the provider path", () => {
    expect(buildModelProviderDeleteEdits("gone")).toEqual([
      {
        keyPath: "model_providers.gone",
        mergeStrategy: "replace",
        value: null,
      },
    ]);
  });
});

describe("buildSelectModelProviderEdits", () => {
  it("points the selected provider at the given id", () => {
    expect(buildSelectModelProviderEdits(" chosen ")).toEqual([
      { keyPath: "model_provider", mergeStrategy: "replace", value: "chosen" },
    ]);
  });
});

describe("buildClearModelProviderSelectionEdits", () => {
  it("unsets the selected provider", () => {
    expect(buildClearModelProviderSelectionEdits()).toEqual([
      { keyPath: "model_provider", mergeStrategy: "replace", value: null },
    ]);
  });
});
