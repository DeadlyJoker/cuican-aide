import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ModelProviderProbeResponse } from "@crewon-protocol/v2/ModelProviderProbeResponse";
import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  handleModelProviderAction,
  modelProviderActionForActionId,
  modelProviderDraftFromFields,
  refreshModelProvidersPanelAction,
  type ModelProviderActionParams,
} from "./modelProviderActions";
import { MODEL_PROVIDER_FIELD_IDS } from "./modelProviderPanel";
import type {
  ProviderCredentialCatalog,
  ProviderCredentialStorePort,
  ProviderCredentialUpsert,
} from "./providerCredentialStore";

type Client = NonNullable<ModelProviderActionParams["client"]>;

function configRead(
  providers: Record<string, unknown> = {},
  selected = "",
): ConfigReadResponse {
  return {
    config: { model_provider: selected, model_providers: providers },
    origins: {},
    layers: null,
  } as unknown as ConfigReadResponse;
}

function probeResponse(
  overrides: Partial<ModelProviderProbeResponse> = {},
): ModelProviderProbeResponse {
  return {
    providerId: "gateway",
    endpoint: "https://api.example.com/v1/models",
    status: "ok",
    httpStatus: 200,
    modelCount: 12,
    authenticated: true,
    message: null,
    latencyMs: 42,
    ...overrides,
  } as ModelProviderProbeResponse;
}

function harness(
  options: {
    client?: Partial<Client> | null;
    credentialCatalog?: ProviderCredentialCatalog;
    credentialStore?: ProviderCredentialStorePort | null;
    fields?: Record<string, string>;
    isConnected?: boolean;
  } = {},
) {
  const panels: Array<CapabilityPanel | null> = [];
  let panel: CapabilityPanel | null = null;
  const writes: unknown[][] = [];
  const probed: Array<string | undefined> = [];
  const credentialCalls: Array<
    | { kind: "activate" | "delete"; providerId: string }
    | { kind: "upsert"; request: ProviderCredentialUpsert }
  > = [];
  const emptyCatalog: ProviderCredentialCatalog = options.credentialCatalog ?? {
    activeProviderId: null,
    bindings: [],
  };
  const defaultCredentialStore: ProviderCredentialStorePort = {
    async activate(providerId) {
      credentialCalls.push({ kind: "activate", providerId });
      return emptyCatalog;
    },
    async catalog() {
      return emptyCatalog;
    },
    async delete(providerId) {
      credentialCalls.push({ kind: "delete", providerId });
      return emptyCatalog;
    },
    async upsert(request) {
      credentialCalls.push({ kind: "upsert", request });
      return emptyCatalog;
    },
  };
  const credentialStore =
    options.credentialStore === undefined
      ? defaultCredentialStore
      : options.credentialStore;

  const client: Client | null =
    options.client === null
      ? null
      : {
          probeModelProvider: async (providerId) => {
            probed.push(providerId);
            return probeResponse();
          },
          readConfig: async () => configRead(),
          writeConfigBatch: async (edits) => {
            writes.push(edits);
            return {};
          },
          ...options.client,
        };

  const params: ModelProviderActionParams = {
    client,
    connectionHint: "127.0.0.1:1455",
    credentialStore,
    fieldValue: (fieldId) => options.fields?.[fieldId] ?? "",
    isConnected: options.isConnected ?? true,
    locale: "en",
    resolveBackendCwd: async () => "/Users/me/work",
    setCapabilityPanel: (panelOrUpdater) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
      panels.push(panel);
    },
  };

  return {
    params,
    credentialCalls,
    panels,
    probed,
    writes,
    get panel() {
      return panel;
    },
  };
}

const validFields = {
  [MODEL_PROVIDER_FIELD_IDS.id]: "gateway",
  [MODEL_PROVIDER_FIELD_IDS.name]: "My gateway",
  [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "https://api.example.com/v1",
  [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "bearer-token",
  [MODEL_PROVIDER_FIELD_IDS.apiKey]: "sk-secret",
  [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
};

describe("modelProviderActionForActionId", () => {
  it("resolves both plain and provider-targeted actions", () => {
    expect(modelProviderActionForActionId("model-provider-add")).toEqual({
      action: "add",
      providerId: null,
    });
    expect(
      modelProviderActionForActionId("model-provider-test:gateway"),
    ).toEqual({ action: "test", providerId: "gateway" });
    expect(modelProviderActionForActionId("refresh-config")).toBeNull();
  });
});

describe("modelProviderDraftFromFields", () => {
  it("reads the form, falling back to a bearer token for an unknown kind", () => {
    const draft = modelProviderDraftFromFields(
      (fieldId) =>
        ({ ...validFields, [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "??" })[
          fieldId
        ] ?? "",
    );

    expect(draft).toEqual({
      id: "gateway",
      name: "My gateway",
      baseUrl: "https://api.example.com/v1",
      credentialKind: "bearer-token",
      envKey: "",
      apiKey: "sk-secret",
      setAsDefault: true,
    });
  });

  it("fills the base URL, id, and env var from the picked vendor", () => {
    const draft = modelProviderDraftFromFields(
      (fieldId) =>
        ({
          [MODEL_PROVIDER_FIELD_IDS.vendor]: "moonshot",
          [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "bearer-token",
          [MODEL_PROVIDER_FIELD_IDS.apiKey]: "sk-secret",
          [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
        })[fieldId] ?? "",
    );

    expect(draft).toEqual({
      id: "moonshot",
      name: "",
      baseUrl: "https://api.moonshot.cn/v1",
      credentialKind: "bearer-token",
      envKey: "MOONSHOT_API_KEY",
      apiKey: "sk-secret",
      setAsDefault: true,
    });
  });

  it("keeps a typed base URL over the vendor preset", () => {
    // A user pointing at a proxy in front of the vendor must not have their
    // address replaced by the vendor's own.
    const draft = modelProviderDraftFromFields(
      (fieldId) =>
        ({
          [MODEL_PROVIDER_FIELD_IDS.vendor]: "moonshot",
          [MODEL_PROVIDER_FIELD_IDS.id]: "kimi-proxy",
          [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "https://proxy.internal/v1",
          [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "bearer-token",
        })[fieldId] ?? "",
    );

    expect(draft.baseUrl).toBe("https://proxy.internal/v1");
    expect(draft.id).toBe("kimi-proxy");
  });

  it("does not apply a preset for the custom vendor", () => {
    const draft = modelProviderDraftFromFields(
      (fieldId) =>
        ({
          [MODEL_PROVIDER_FIELD_IDS.vendor]: "custom",
          [MODEL_PROVIDER_FIELD_IDS.id]: "mine",
          [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "https://mine.example/v1",
          [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "bearer-token",
        })[fieldId] ?? "",
    );

    expect(draft.envKey).toBe("");
    expect(draft.baseUrl).toBe("https://mine.example/v1");
  });
});

describe("refreshModelProvidersPanelAction", () => {
  it("uses Control API as the packaged settings authority", async () => {
    const setCapabilityPanel = vi.fn();
    const readConfig = vi.fn(async () => {
      throw new Error("legacy client must not be called");
    });
    const getModelProviderSettings = vi.fn(async () => ({
      settings: {
        revision: 3,
        activeProviderId: "openai",
        providers: [
          {
            providerId: "openai",
            displayName: "OpenAI",
            endpoint: "https://api.openai.com/v1",
            credentialKind: "keychain" as const,
            environmentVariable: null,
            isActive: true,
          },
        ],
        runtimeAvailability: "available" as const,
        updatedAt: null,
      },
    }));

    await refreshModelProvidersPanelAction({
      client: { readConfig } as never,
      controlClient: { getModelProviderSettings },
      credentialStore: null,
      isConnected: true,
      locale: "en",
      resolveBackendCwd: async () => "/ignored",
      setCapabilityPanel,
    });

    expect(getModelProviderSettings).toHaveBeenCalledOnce();
    expect(readConfig).not.toHaveBeenCalled();
    expect(setCapabilityPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("openai"),
      }),
    );
  });
  it("does not read config when the app-server is not connected", async () => {
    const readConfig = vi.fn();
    const test = harness({
      client: { readConfig },
      credentialStore: null,
      isConnected: false,
    });

    await refreshModelProvidersPanelAction(test.params);

    expect(readConfig).not.toHaveBeenCalled();
    expect(test.panel?.error).toBe("Local app-server is not connected");
  });

  it("reports a failed read instead of an empty provider list", async () => {
    const test = harness({
      client: {
        readConfig: async () => {
          throw new Error("config.toml is not readable");
        },
      },
      credentialStore: null,
    });

    await refreshModelProvidersPanelAction(test.params);

    expect(test.panel?.error).toBe("config.toml is not readable");
  });

  it("loads the desktop catalog without reading legacy config", async () => {
    const readConfig = vi.fn();
    const test = harness({ client: { readConfig } });

    await refreshModelProvidersPanelAction(test.params);

    expect(readConfig).not.toHaveBeenCalled();
    expect(test.panel?.subtitle).toBe("Desktop credential catalog");
  });
});

describe("handleModelProviderAction", () => {
  it("writes the provider and points the default at it", async () => {
    const test = harness({ fields: validFields });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.writes.length > 0);

    expect(test.writes[0]).toEqual([
      {
        keyPath: "model_providers.gateway",
        value: {
          name: "My gateway",
          base_url: "https://api.example.com/v1",
          wire_api: "responses",
        },
        mergeStrategy: "replace",
      },
      {
        keyPath: "model_provider",
        value: "gateway",
        mergeStrategy: "replace",
      },
    ]);
    expect(test.credentialCalls).toEqual([
      {
        kind: "upsert",
        request: {
          activate: true,
          credentialKind: "keychain",
          endpoint: "https://api.example.com/v1",
          environmentVariable: null,
          providerId: "gateway",
          secret: "sk-secret",
        },
      },
    ]);
  });

  /*
   * The backend already defines the built-in vendors, and their ids are
   * reserved. Saving one has to select it rather than write a second definition
   * under the same id, which validation would reject anyway.
   */
  it("fails closed for the legacy account provider on desktop", async () => {
    const test = harness({
      fields: {
        [MODEL_PROVIDER_FIELD_IDS.vendor]: "openai",
        [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
      },
    });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.panel?.error !== undefined);

    expect(test.writes).toEqual([]);
    expect(test.credentialCalls).toEqual([]);
    expect(test.panel?.error).toBe(
      "model_provider_account_runtime_unavailable",
    );
  });

  it("activates a loopback built-in through the desktop authority", async () => {
    const test = harness({
      fields: {
        [MODEL_PROVIDER_FIELD_IDS.vendor]: "ollama",
        [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "none",
        [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
      },
    });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.writes.length > 0);

    expect(test.credentialCalls).toEqual([
      {
        kind: "upsert",
        request: {
          activate: true,
          credentialKind: "none",
          endpoint: "http://127.0.0.1:11434/v1",
          environmentVariable: null,
          providerId: "ollama",
          secret: null,
        },
      },
    ]);
    expect(test.writes).toEqual([
      [
        {
          keyPath: "model_provider",
          value: "ollama",
          mergeStrategy: "replace",
        },
      ],
    ]);
  });

  it("still writes a definition when a built-in vendor is pointed elsewhere", async () => {
    const test = harness({
      fields: {
        [MODEL_PROVIDER_FIELD_IDS.vendor]: "ollama",
        [MODEL_PROVIDER_FIELD_IDS.id]: "ollama-remote",
        [MODEL_PROVIDER_FIELD_IDS.baseUrl]:
          "https://ollama.internal.example/v1",
        [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "none",
      },
    });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(
      () => test.writes.length > 0 || test.panel?.error !== undefined,
    );

    expect(test.panel?.error).toBeUndefined();
    expect(test.writes).toEqual([
      [
        {
          keyPath: "model_providers.ollama-remote",
          value: {
            name: "ollama-remote",
            base_url: "https://ollama.internal.example/v1",
            wire_api: "responses",
          },
          mergeStrategy: "replace",
        },
      ],
    ]);
  });

  it("rejects an invalid draft without writing anything", async () => {
    const test = harness({
      fields: {
        ...validFields,
        [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "api.example.com",
      },
    });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.panel?.error !== undefined);

    expect(test.writes).toEqual([]);
    expect(test.panel?.error).toBe(
      "Base URL must be absolute, for example https://api.example.com/v1",
    );
  });

  it("marks desktop probe unavailable instead of using the legacy runtime probe", async () => {
    const test = harness({ fields: validFields });

    handleModelProviderAction(test.params, "test", null);
    await vi.waitUntil(
      () => test.panel?.body?.includes("legacy runtime probe") ?? false,
    );

    expect(test.writes).toHaveLength(1);
    expect(test.probed).toEqual([]);
    expect(test.panel?.body).toContain(
      "does not yet expose a dedicated connection probe",
    );
  });

  it("probes an already saved provider directly, without writing", async () => {
    const test = harness({ credentialStore: null });

    handleModelProviderAction(test.params, "test", "gateway");
    await vi.waitUntil(() => test.probed.length > 0);

    expect(test.writes).toEqual([]);
    expect(test.probed).toEqual(["gateway"]);
  });

  /*
   * A probe that never completes is not a failed save, so the list is restored
   * with the request error rather than replaced by an error page.
   */
  it("keeps the list visible when the probe request itself fails", async () => {
    const test = harness({
      credentialStore: null,
      client: {
        probeModelProvider: async () => {
          throw new Error("app-server closed the connection");
        },
      },
    });

    handleModelProviderAction(test.params, "test", "gateway");
    await vi.waitUntil(
      () =>
        test.panel?.body?.includes("app-server closed the connection") ?? false,
    );

    expect(test.panel?.title).toBe("Model access");
    expect(test.panel?.body).toContain("Connection test did not complete");
  });

  it("clears just the entry when deleting a provider that is not in use", async () => {
    const test = harness({
      credentialStore: null,
      client: {
        readConfig: async () => configRead({ gateway: {}, local: {} }, "local"),
      },
    });

    handleModelProviderAction(test.params, "delete", "gateway");
    await vi.waitUntil(() => test.writes.length > 0);

    expect(test.writes[0]).toEqual([
      {
        keyPath: "model_providers.gateway",
        value: null,
        mergeStrategy: "replace",
      },
    ]);
  });

  /*
   * `model_provider` naming a removed entry makes the backend fail to resolve
   * config at all, so every later config/read errors and the settings page that
   * would let the user recover becomes unreachable.
   */
  it("moves the default off a deleted provider that was in use", async () => {
    const test = harness({
      client: {
        readConfig: async () =>
          configRead({ gateway: {}, local: {} }, "gateway"),
      },
      credentialCatalog: {
        activeProviderId: "gateway",
        bindings: [
          {
            credentialAvailable: true,
            credentialKind: "keychain",
            endpoint: "https://gateway.example.com/v1",
            environmentVariable: null,
            isActive: true,
            providerId: "gateway",
          },
          {
            credentialAvailable: true,
            credentialKind: "none",
            endpoint: "http://127.0.0.1:11434/v1",
            environmentVariable: null,
            isActive: false,
            providerId: "local",
          },
        ],
      },
    });

    handleModelProviderAction(test.params, "delete", "gateway");
    await vi.waitUntil(() => test.writes.length > 0);

    expect(test.writes[0]).toEqual([
      {
        keyPath: "model_providers.gateway",
        value: null,
        mergeStrategy: "replace",
      },
      { keyPath: "model_provider", value: "local", mergeStrategy: "replace" },
    ]);
    expect(test.panel?.body).toContain("local is now the default");
    expect(test.credentialCalls).toEqual([
      { kind: "activate", providerId: "local" },
      { kind: "delete", providerId: "gateway" },
    ]);
  });

  it("unsets the default when the last provider is deleted", async () => {
    const test = harness({
      credentialStore: null,
      client: {
        readConfig: async () => configRead({ gateway: {} }, "gateway"),
      },
    });

    handleModelProviderAction(test.params, "delete", "gateway");
    await vi.waitUntil(() => test.writes.length > 0);

    expect(test.writes[0]).toEqual([
      {
        keyPath: "model_providers.gateway",
        value: null,
        mergeStrategy: "replace",
      },
      { keyPath: "model_provider", value: null, mergeStrategy: "replace" },
    ]);
    expect(test.panel?.body).toContain("the default is now unset");
  });

  it("only moves the default when selecting a provider", async () => {
    const test = harness();

    handleModelProviderAction(test.params, "select", "local");
    await vi.waitUntil(() => test.writes.length > 0);

    expect(test.writes[0]).toEqual([
      { keyPath: "model_provider", value: "local", mergeStrategy: "replace" },
    ]);
    expect(test.credentialCalls).toEqual([
      { kind: "activate", providerId: "local" },
    ]);
  });

  it("returns to the list when cancelling the form", async () => {
    const test = harness();

    handleModelProviderAction(test.params, "cancel", null);
    await vi.waitUntil(() => test.panel?.actions !== undefined);

    expect(test.panel?.actions?.map((action) => action.id)).toContain(
      "model-provider-add",
    );
  });

  it("opens an editable form for an existing provider", async () => {
    const test = harness({
      credentialStore: null,
      client: {
        readConfig: async () =>
          configRead(
            { gateway: { base_url: "https://api.example.com/v1" } },
            "gateway",
          ),
      },
    });

    handleModelProviderAction(test.params, "edit", "gateway");
    await vi.waitUntil(() => test.panel?.fields !== undefined);

    expect(
      test.panel?.fields?.find(
        (field) => field.id === MODEL_PROVIDER_FIELD_IDS.id,
      )?.value,
    ).toBe("gateway");
  });

  it("saves to the desktop credential authority without the legacy app-server", async () => {
    const test = harness({
      client: null,
      fields: validFields,
      isConnected: false,
    });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.credentialCalls.length > 0);

    expect(test.writes).toEqual([]);
    expect(test.credentialCalls[0]).toEqual({
      kind: "upsert",
      request: {
        activate: true,
        credentialKind: "keychain",
        endpoint: "https://api.example.com/v1",
        environmentVariable: null,
        providerId: "gateway",
        secret: "sk-secret",
      },
    });
    await vi.waitUntil(
      () => test.panel?.body?.includes("desktop runtime is active") ?? false,
    );
  });

  it("keeps config unchanged when an active run rejects the credential reload", async () => {
    const test = harness({
      credentialStore: {
        async activate() {
          throw new Error("unexpected activate");
        },
        async catalog() {
          return { activeProviderId: null, bindings: [] };
        },
        async delete() {
          throw new Error("unexpected delete");
        },
        async upsert() {
          throw new Error("control_runtime_active_run");
        },
      },
      fields: validFields,
    });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.panel?.error !== undefined);

    expect(test.writes).toEqual([]);
    expect(test.panel?.error).toBe("control_runtime_active_run");
  });

  it("treats a failed legacy config sync as compatibility-only after native commit", async () => {
    const test = harness({
      client: {
        writeConfigBatch: async () => {
          throw new Error("legacy config is read-only");
        },
      },
      fields: validFields,
    });

    handleModelProviderAction(test.params, "save", null);
    await vi.waitUntil(
      () => test.panel?.body?.includes("desktop runtime is active") ?? false,
    );

    expect(test.credentialCalls).toHaveLength(1);
    expect(test.panel?.error).toBeUndefined();
    expect(test.panel?.body).toContain(
      "Legacy app-server config was not synchronized",
    );
  });
});
