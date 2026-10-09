import type {
  ActiveAgentVersionCatalogResponse,
  ModelProviderSettingsSnapshot,
  ProbeModelProviderResponse,
} from "@crewon/contracts";
import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  handleModelProviderAction,
  refreshModelProvidersPanelAction,
  type ModelProviderActionParams,
} from "./modelProviderActions";
import {
  MODEL_PROVIDER_FIELD_IDS,
  modelProviderFormPanel,
} from "./modelProviderPanel";
import type {
  ProviderCredentialStorePort,
  ProviderModelCatalogResult,
} from "./providerCredentialStore";

const settings: ModelProviderSettingsSnapshot = {
  revision: 2,
  activeProviderId: "gateway",
  providers: [
    {
      providerId: "gateway",
      displayName: "Gateway",
      endpoint: "https://api.example.com/v1",
      credentialKind: "keychain" as const,
      environmentVariable: null,
      isActive: true,
    },
  ],
  runtimeAvailability: "available" as const,
  updatedAt: "2026-08-09T00:00:00Z",
};

const catalog = {
  activeProviderId: "gateway",
  bindings: [
    {
      credentialAvailable: true,
      credentialKind: "keychain" as const,
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      isActive: true,
      modelId: "gateway-model",
      providerId: "gateway",
    },
  ],
};

const activeAgents: ActiveAgentVersionCatalogResponse = {
  releaseId: "release-1",
  activatedAt: "2026-09-09T00:00:00Z",
  defaultAgentVersionId: "agent-1",
  data: [
    {
      agentVersionId: "agent-1",
      contentDigest: "sha256:test",
      runtimeGeneration: "runtime-1",
      policySnapshotId: "policy-1",
      model: {
        adapterName: "responses",
        adapterVersion: "1",
        modelId: "actual-task-model",
      },
      createdAt: "2026-09-09T00:00:00Z",
    },
  ],
};

function probe(): ProbeModelProviderResponse {
  return {
    disposition: "completed",
    providerId: "gateway",
    catalogRevision: 2,
    status: "ok",
    models: [{ id: "model-1", displayName: "Model One" }],
    modelCount: 1,
    latencyMs: 4,
    retryable: false,
    retryAfterMs: null,
  };
}

function fixture(
  input: {
    values?: Partial<Record<string, string>>;
    store?: ProviderCredentialStorePort | null;
    probe?: ModelProviderActionParams["controlClient"] extends infer _T
      ? (body: {}, key: string) => Promise<ProbeModelProviderResponse>
      : never;
  } = {},
) {
  let panel: CapabilityPanel | null = null;
  const states: CapabilityPanel[] = [];
  const store =
    input.store === undefined
      ? {
          activate: vi.fn(async () => catalog),
          catalog: vi.fn(async () => catalog),
          delete: vi.fn(async () => catalog),
          modelCatalog: vi.fn(async () => ({ models: [], status: "ok" })),
          upsert: vi.fn(async () => catalog),
        }
      : input.store;
  const controlClient = {
    getModelProviderSettings: vi.fn(async () => ({ settings })),
    probeModelProvider: vi.fn(input.probe ?? (async () => probe())),
  };
  const values: Record<string, string> = {
    [MODEL_PROVIDER_FIELD_IDS.vendor]: "custom",
    [MODEL_PROVIDER_FIELD_IDS.id]: "gateway",
    [MODEL_PROVIDER_FIELD_IDS.name]: "Typed Gateway",
    [MODEL_PROVIDER_FIELD_IDS.modelId]: "gateway-model",
    [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "https://api.example.com/v1",
    [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "bearer-token",
    [MODEL_PROVIDER_FIELD_IDS.envKey]: "",
    [MODEL_PROVIDER_FIELD_IDS.apiKey]: "new-secret",
    [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
    ...input.values,
  };
  const params: ModelProviderActionParams = {
    client: null,
    controlClient,
    credentialStore: store,
    fieldValue: (fieldId) => values[fieldId] ?? "",
    locale: "en",
    nextIdempotencyKey: () => "same-user-action-key",
    setCapabilityPanel: (next) => {
      panel = typeof next === "function" ? next(panel) : next;
      if (panel !== null) states.push(panel);
    },
  };
  return { controlClient, params, panel: () => panel, states, store };
}

describe("final Provider control actions", () => {
  it("keeps the Native configured source visible when Control has no managed provider", async () => {
    const test = fixture();
    test.controlClient.getModelProviderSettings.mockResolvedValue({
      settings: {
        ...settings,
        activeProviderId: null,
        providers: [],
        runtimeAvailability: "unconfigured",
      },
    });

    await refreshModelProvidersPanelAction(test.params);

    expect(test.panel()?.rows?.some((row) => row.id === "gateway")).toBe(true);
    expect(test.panel()?.body).not.toContain("No model service added yet");
    expect(
      test
        .panel()
        ?.rows?.find((row) => row.id === "gateway")
        ?.actions?.map(({ id }) => id),
    ).toContain("model-provider-edit:gateway");
  });

  it("keeps native model setup available before the Control runtime starts", async () => {
    const test = fixture();
    test.params.controlClient = null;

    await refreshModelProvidersPanelAction(test.params);

    expect(test.store?.catalog).toHaveBeenCalledOnce();
    expect(test.panel()).toMatchSnapshot();
  });

  it("renders Team/Web as Control-backed read-only unavailable", async () => {
    const test = fixture({ store: null });
    test.controlClient.getModelProviderSettings.mockResolvedValue({
      settings: { ...settings, runtimeAvailability: "unavailable" },
    });
    await refreshModelProvidersPanelAction(test.params);
    expect(test.panel()?.body).toContain(
      "Adding or editing model services is not supported on this web page",
    );
    expect(test.panel()?.fields).toBeUndefined();
    expect(test.panel()?.body).toContain("Model source status: Unavailable");
    expect(test.panel()?.actions?.map(({ id }) => id)).toEqual([
      "refresh-model-providers",
    ]);
  });

  it("shows the actual task model on the web model page even without managed providers", async () => {
    const test = fixture({ store: null });
    test.params.controlClient = {
      ...test.controlClient,
      getActiveAgentVersionCatalog: vi.fn(async () => activeAgents),
    };
    test.controlClient.getModelProviderSettings.mockResolvedValue({
      settings: {
        ...settings,
        activeProviderId: null,
        providers: [],
        runtimeAvailability: "unconfigured",
      },
    });

    await refreshModelProvidersPanelAction(test.params);

    expect(test.panel()?.rows).toEqual([
      {
        id: "runtime:default-task-model",
        title: "Default task model",
        subtitle: "actual-task-model",
      },
    ]);
    expect(test.panel()?.body).not.toContain("Not configured");
    expect(test.panel()?.body).toContain("Settings → AI models → Add model");
    expect(test.panel()?.body).toContain("do not automatically apply");
    expect(test.panel()?.actions?.map(({ id }) => id)).toEqual([
      "refresh-model-providers",
    ]);
  });

  it("opens native setup on the same page when the Control runtime is unreachable", async () => {
    const test = fixture();
    test.controlClient.getModelProviderSettings.mockRejectedValue(
      new Error("runtime_not_started"),
    );
    await refreshModelProvidersPanelAction(test.params);
    expect(test.panel()?.actions?.map(({ id }) => id)).toContain(
      "model-provider-add",
    );
    expect(test.panel()?.error).toBeUndefined();

    handleModelProviderAction(test.params, "add", null);
    await vi.waitFor(() =>
      expect(test.panel()?.fields?.length).toBeGreaterThan(0),
    );
    expect(test.panel()?.fields?.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        MODEL_PROVIDER_FIELD_IDS.baseUrl,
        MODEL_PROVIDER_FIELD_IDS.apiKey,
        MODEL_PROVIDER_FIELD_IDS.modelId,
      ]),
    );
    expect(test.panel()?.actions?.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["model-provider-save", "model-provider-cancel"]),
    );
    expect(test.store?.upsert).not.toHaveBeenCalled();
    expect(test.store?.activate).not.toHaveBeenCalled();

    handleModelProviderAction(test.params, "cancel", null);
    await vi.waitFor(() =>
      expect(test.panel()?.actions?.map(({ id }) => id)).toContain(
        "model-provider-add",
      ),
    );
    expect(test.panel()?.fields).toBeUndefined();
  });

  it("keeps setup available without claiming a default when task metadata fails or is ambiguous", async () => {
    for (const getActiveAgentVersionCatalog of [
      async () => {
        throw new Error("catalog_unavailable");
      },
      async () => ({ ...activeAgents, data: [] }),
      async () => ({
        ...activeAgents,
        data: [...activeAgents.data, ...activeAgents.data],
      }),
    ]) {
      const test = fixture();
      test.params.controlClient = {
        ...test.controlClient,
        getActiveAgentVersionCatalog,
      };
      await refreshModelProvidersPanelAction(test.params);
      expect(
        test
          .panel()
          ?.rows?.some(({ id }) => id === "runtime:default-task-model"),
      ).toBe(false);
      expect(test.panel()?.actions?.map(({ id }) => id)).toContain(
        "model-provider-add",
      );
    }
  });

  it("does not expose a setup form or swallow Control failures on web", async () => {
    const test = fixture({ store: null });
    test.controlClient.getModelProviderSettings.mockRejectedValue(
      new Error("runtime_not_started"),
    );
    await refreshModelProvidersPanelAction(test.params);
    expect(test.panel()?.error).toBeTruthy();
    handleModelProviderAction(test.params, "add", null);
    expect(test.panel()?.fields).toBeUndefined();
  });

  it("saves only through native IPC and rehydrates from public Control", async () => {
    const test = fixture();
    const legacyClient = {
      readConfig: vi.fn(),
      writeConfigBatch: vi.fn(),
      probeModelProvider: vi.fn(),
    };
    test.params.client = legacyClient;
    test.params.setCapabilityPanel({
      title: "Model access",
      fields: [
        {
          id: MODEL_PROVIDER_FIELD_IDS.apiKey,
          label: "API key",
          value: "new-secret",
        },
      ],
    });
    handleModelProviderAction(test.params, "save", null);
    expect(test.panel()?.fields?.[0]?.value).toBe("");
    await vi.waitFor(() => expect(test.store?.upsert).toHaveBeenCalledOnce());
    expect(test.store?.upsert).toHaveBeenCalledWith({
      activate: true,
      credentialKind: "keychain",
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      modelId: "gateway-model",
      providerId: "gateway",
      secret: "new-secret",
    });
    expect(test.controlClient.getModelProviderSettings).toHaveBeenCalledTimes(
      2,
    );
    expect(legacyClient.readConfig).not.toHaveBeenCalled();
    expect(legacyClient.writeConfigBatch).not.toHaveBeenCalled();
    expect(legacyClient.probeModelProvider).not.toHaveBeenCalled();
  });

  it("reuses one idempotency key after an unknown probe outcome", async () => {
    let attempt = 0;
    const test = fixture({
      probe: async () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("connection reset");
        return probe();
      },
    });
    handleModelProviderAction(test.params, "test", "gateway");
    await vi.waitFor(() =>
      expect(test.controlClient.probeModelProvider).toHaveBeenCalledTimes(2),
    );
    expect(test.controlClient.probeModelProvider.mock.calls).toEqual([
      [{}, "same-user-action-key"],
      [{}, "same-user-action-key"],
    ]);
  });

  it("restores the previous default after a saved Provider fails its probe", async () => {
    const test = fixture({
      values: {
        [MODEL_PROVIDER_FIELD_IDS.id]: "candidate",
        [MODEL_PROVIDER_FIELD_IDS.modelId]: "candidate-model",
      },
      probe: async () => ({
        ...probe(),
        providerId: "candidate",
        status: "authenticationFailed",
        models: null,
        modelCount: null,
      }),
    });

    handleModelProviderAction(test.params, "test", null);

    await vi.waitFor(() => expect(test.store?.activate).toHaveBeenCalledOnce());
    expect(test.store?.activate).toHaveBeenCalledWith("gateway");
    expect(test.panel()?.body).toContain("Credential rejected");
    expect(test.panel()?.body).toContain("Restored default Provider: gateway");
  });

  it("rejects an unadvertised model alias and restores the previous default", async () => {
    const test = fixture({
      values: {
        [MODEL_PROVIDER_FIELD_IDS.id]: "candidate",
        [MODEL_PROVIDER_FIELD_IDS.modelId]: "missing-model",
      },
      probe: async () => ({
        ...probe(),
        providerId: "candidate",
      }),
    });

    handleModelProviderAction(test.params, "test", null);

    await vi.waitFor(() => expect(test.store?.activate).toHaveBeenCalledOnce());
    expect(test.store?.activate).toHaveBeenCalledWith("gateway");
    expect(test.panel()?.body).toContain("Model unavailable");
    expect(test.panel()?.body).toContain("Configured model: missing-model");
    expect(test.panel()?.body).not.toContain("Connected");
  });

  it("keeps a successfully tested default when the model alias is advertised", async () => {
    const test = fixture({
      values: {
        [MODEL_PROVIDER_FIELD_IDS.id]: "candidate",
        [MODEL_PROVIDER_FIELD_IDS.modelId]: "model-1",
      },
      probe: async () => ({
        ...probe(),
        providerId: "candidate",
      }),
    });

    handleModelProviderAction(test.params, "test", null);

    await vi.waitFor(() =>
      expect(test.controlClient.probeModelProvider).toHaveBeenCalledOnce(),
    );
    expect(test.store?.activate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(test.panel()?.body).toContain("Connected"));
    expect(test.panel()?.body).toContain("Configured model: model-1");
  });

  it("keeps typed fields but clears the secret after native failure", async () => {
    const test = fixture({
      store: {
        activate: vi.fn(async () => catalog),
        catalog: vi.fn(async () => catalog),
        delete: vi.fn(async () => catalog),
        modelCatalog: vi.fn(async () => ({ models: [], status: "ok" })),
        upsert: vi.fn(async () => {
          throw new Error("native_switch_failed");
        }),
      },
    });
    handleModelProviderAction(test.params, "save", null);
    await vi.waitFor(() =>
      expect(test.panel()?.error).toBe("native_switch_failed"),
    );
    const fields = Object.fromEntries(
      test.panel()?.fields?.map((field) => [field.id, field.value]) ?? [],
    );
    expect(fields[MODEL_PROVIDER_FIELD_IDS.baseUrl]).toBe(
      "https://api.example.com/v1",
    );
    expect(fields[MODEL_PROVIDER_FIELD_IDS.name]).toBe("Typed Gateway");
    expect(fields[MODEL_PROVIDER_FIELD_IDS.apiKey]).toBe("");
  });

  it("never restores a secret after asynchronous validation fails", async () => {
    const test = fixture();
    let releaseRead!: (value: { settings: typeof settings }) => void;
    test.controlClient.getModelProviderSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    );
    const originalFieldValue = test.params.fieldValue;
    test.params.fieldValue = (fieldId) =>
      fieldId === MODEL_PROVIDER_FIELD_IDS.id
        ? "Invalid Provider ID"
        : originalFieldValue(fieldId);
    test.params.setCapabilityPanel({
      title: "Model access",
      fields: [
        {
          id: MODEL_PROVIDER_FIELD_IDS.apiKey,
          label: "API key",
          value: "new-secret",
        },
      ],
    });
    const statesBeforeAction = test.states.length;

    handleModelProviderAction(test.params, "save", null);
    expect(test.panel()?.fields?.[0]?.value).toBe("");
    releaseRead({ settings });
    await vi.waitFor(() => expect(test.panel()?.error).toBeTruthy());

    expect(test.store?.upsert).not.toHaveBeenCalled();
    expect(
      test.states
        .slice(statesBeforeAction)
        .every((state) => !JSON.stringify(state).includes("new-secret")),
    ).toBe(true);
  });
});

describe("fetch-models action", () => {
  function formFixture(
    overrides: {
      modelCatalog?: Partial<ProviderModelCatalogResult>;
      values?: Record<string, string>;
    } = {},
  ) {
    const modelCatalogResult: ProviderModelCatalogResult = {
      models: ["gpt-5.6-sol", "claude-sonnet-4"],
      status: "ok",
      ...overrides.modelCatalog,
    };
    const store: ProviderCredentialStorePort = {
      activate: vi.fn(async () => catalog),
      catalog: vi.fn(async () => catalog),
      delete: vi.fn(async () => catalog),
      modelCatalog: vi.fn(async () => modelCatalogResult),
      upsert: vi.fn(async () => catalog),
    };
    const values: Record<string, string> = {
      [MODEL_PROVIDER_FIELD_IDS.vendor]: "custom",
      [MODEL_PROVIDER_FIELD_IDS.id]: "gateway",
      [MODEL_PROVIDER_FIELD_IDS.name]: "Gateway",
      [MODEL_PROVIDER_FIELD_IDS.modelId]: "gateway-model",
      [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "https://api.example.com/v1",
      [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "bearer-token",
      [MODEL_PROVIDER_FIELD_IDS.envKey]: "",
      [MODEL_PROVIDER_FIELD_IDS.apiKey]: "sk-test",
      [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
      ...overrides.values,
    };
    let panel: CapabilityPanel | null = modelProviderFormPanel({
      entry: {
        id: values[MODEL_PROVIDER_FIELD_IDS.id],
        name: values[MODEL_PROVIDER_FIELD_IDS.name],
        modelId: values[MODEL_PROVIDER_FIELD_IDS.modelId],
        baseUrl: values[MODEL_PROVIDER_FIELD_IDS.baseUrl],
        credentialKind: "bearer-token",
        envKey: "",
        hasStoredToken: false,
      },
      isSelected: true,
      locale: "en",
    });
    const states: CapabilityPanel[] = [];
    const params: ModelProviderActionParams = {
      client: null,
      controlClient: null,
      credentialStore: store,
      fieldValue: (fieldId) => values[fieldId] ?? "",
      locale: "en",
      setCapabilityPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
        if (panel !== null) states.push(panel);
      },
    };
    return { panel: () => panel, params, states, store };
  }

  it("fills the model field select with advertised models", async () => {
    const test = formFixture();

    handleModelProviderAction(test.params, "fetch-models", null);

    await vi.waitFor(() =>
      expect(test.store.modelCatalog).toHaveBeenCalledOnce(),
    );
    expect(test.store.modelCatalog).toHaveBeenCalledWith({
      apiKey: "sk-test",
      defaultModelId: "gateway-model",
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      providerId: "gateway",
    });
    const modelField = test
      .panel()
      ?.fields?.find((f) => f.id === MODEL_PROVIDER_FIELD_IDS.modelId);
    expect(modelField?.options?.map((o) => o.value)).toEqual([
      "gpt-5.6-sol",
      "claude-sonnet-4",
    ]);
    expect(modelField?.value).toBe("gpt-5.6-sol");
    expect(test.panel()?.body).toBeUndefined();
    expect(test.panel()?.error).toBeUndefined();
  });

  it("surfaces a readable error when the probe fails", async () => {
    const test = formFixture({
      modelCatalog: { models: [], status: "unreachable" },
    });

    handleModelProviderAction(test.params, "fetch-models", null);

    await vi.waitFor(() =>
      expect(test.store.modelCatalog).toHaveBeenCalledOnce(),
    );
    expect(test.panel()?.error).toContain("Could not connect");
  });

  it("rejects an invalid base URL before calling the probe", async () => {
    const test = formFixture({
      values: { [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "" },
    });

    handleModelProviderAction(test.params, "fetch-models", null);

    await vi.waitFor(() => expect(test.panel()?.error).toBeTruthy());
    expect(test.store.modelCatalog).not.toHaveBeenCalled();
  });
});
