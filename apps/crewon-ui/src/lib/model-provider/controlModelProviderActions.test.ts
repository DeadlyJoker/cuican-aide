import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  controlModelProviderActionForActionId,
  handleControlModelProviderAction,
  refreshControlModelProvidersPanel,
  type ControlModelProviderParams,
} from "./controlModelProviderActions";
import { MODEL_PROVIDER_FIELD_IDS } from "./modelProviderPanel";
import type {
  ProviderCredentialStorePort,
  ProviderCredentialUpsert,
} from "./providerCredentialStore";

type Client = ControlModelProviderParams["client"];

const gateway = {
  credentialKind: "keychain" as const,
  displayName: "Gateway",
  endpoint: "https://api.example.com/v1",
  environmentVariable: null,
  isActive: true,
  providerId: "gateway",
};

function settings(activeProviderId: string | null = "gateway") {
  return {
    settings: {
      activeProviderId,
      providers: [{ ...gateway, isActive: activeProviderId === "gateway" }],
      revision: 3,
      runtimeAvailability: "available" as const,
      updatedAt: null,
    },
  };
}

function harness(
  options: {
    activeProviderId?: string | null;
    credentialStore?: ProviderCredentialStorePort | null;
    fields?: Record<string, string>;
    probeProviderId?: string;
  } = {},
) {
  let panel: CapabilityPanel | null = null;
  const upserts: ProviderCredentialUpsert[] = [];
  const activations: string[] = [];
  const deletions: string[] = [];
  const getModelProviderSettings = vi.fn(async () =>
    settings(
      options.activeProviderId === undefined
        ? "gateway"
        : options.activeProviderId,
    ),
  );
  const probeModelProvider = vi.fn(async () => ({
    catalogRevision: 3,
    disposition: "completed" as const,
    latencyMs: 12,
    modelCount: 2,
    models: [],
    providerId: options.probeProviderId ?? "gateway",
    retryAfterMs: null,
    retryable: false,
    status: "ok" as const,
  }));
  const client: Client = { getModelProviderSettings, probeModelProvider };
  const store: ProviderCredentialStorePort | null =
    options.credentialStore === undefined
      ? {
          async activate(providerId) {
            activations.push(providerId);
            return { activeProviderId: providerId, bindings: [] };
          },
          async catalog() {
            return { activeProviderId: "gateway", bindings: [] };
          },
          async delete(providerId) {
            deletions.push(providerId);
            return { activeProviderId: null, bindings: [] };
          },
          async upsert(request) {
            upserts.push(request);
            return { activeProviderId: request.providerId, bindings: [] };
          },
        }
      : options.credentialStore;
  const params: ControlModelProviderParams = {
    client,
    credentialStore: store,
    fieldValue: (fieldId) => options.fields?.[fieldId] ?? "",
    locale: "en",
    setCapabilityPanel: (next) => {
      panel = typeof next === "function" ? next(panel) : next;
    },
  };
  return {
    activations,
    client,
    deletions,
    panel: () => panel,
    params,
    probeModelProvider,
    upserts,
  };
}

const validFields = {
  [MODEL_PROVIDER_FIELD_IDS.apiKey]: "sk-secret",
  [MODEL_PROVIDER_FIELD_IDS.baseUrl]: "https://api.example.com/v1",
  [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "bearer-token",
  [MODEL_PROVIDER_FIELD_IDS.id]: "gateway",
  [MODEL_PROVIDER_FIELD_IDS.name]: "Gateway",
  [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
  [MODEL_PROVIDER_FIELD_IDS.vendor]: "custom",
};

describe("Control model provider actions", () => {
  it("reads the provider list only from Control", async () => {
    const test = harness();

    await refreshControlModelProvidersPanel(test.params);

    expect(test.client.getModelProviderSettings).toHaveBeenCalledOnce();
    expect(test.panel()).toMatchObject({
      body: expect.stringContaining("gateway"),
      title: "Model access",
    });
  });

  it("writes provider credentials through the desktop authority", async () => {
    const test = harness({ fields: validFields });

    handleControlModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.upserts.length === 1);

    expect(test.upserts).toEqual([
      {
        activate: true,
        credentialKind: "keychain",
        endpoint: "https://api.example.com/v1",
        environmentVariable: null,
        providerId: "gateway",
        secret: "sk-secret",
      },
    ]);
  });

  it("allows supported loopback built-ins without a legacy config write", async () => {
    const test = harness({
      fields: {
        [MODEL_PROVIDER_FIELD_IDS.credentialKind]: "none",
        [MODEL_PROVIDER_FIELD_IDS.selected]: "true",
        [MODEL_PROVIDER_FIELD_IDS.vendor]: "ollama",
      },
    });

    handleControlModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.upserts.length === 1);

    expect(test.upserts[0]).toEqual({
      activate: true,
      credentialKind: "none",
      endpoint: "http://127.0.0.1:11434/v1",
      environmentVariable: null,
      providerId: "ollama",
      secret: null,
    });
  });

  it("fails closed when native credential storage is unavailable", async () => {
    const test = harness({ credentialStore: null, fields: validFields });

    handleControlModelProviderAction(test.params, "save", null);
    await vi.waitUntil(() => test.panel()?.error !== undefined);

    expect(test.panel()?.error).toBe("provider_credential_store_unavailable");
  });

  it("probes the active binding through Control with an idempotency key", async () => {
    const test = harness();

    handleControlModelProviderAction(test.params, "test", "gateway");
    await vi.waitUntil(() => test.probeModelProvider.mock.calls.length === 1);

    expect(test.probeModelProvider).toHaveBeenCalledWith(
      expect.stringMatching(/^settings\.provider-probe:/u),
    );
  });

  it("does not report a probe for a different active binding", async () => {
    const test = harness({ activeProviderId: "other" });

    handleControlModelProviderAction(test.params, "test", "gateway");
    await vi.waitUntil(() => test.panel()?.error !== undefined);

    expect(test.probeModelProvider).not.toHaveBeenCalled();
    expect(test.panel()?.error).toBe(
      "model_provider_probe_requires_active_provider",
    );
  });

  it("routes only current model provider actions", () => {
    expect(
      controlModelProviderActionForActionId("model-provider-select:gateway"),
    ).toEqual({ action: "select", providerId: "gateway" });
    expect(controlModelProviderActionForActionId("save-config")).toBeNull();
  });
});
