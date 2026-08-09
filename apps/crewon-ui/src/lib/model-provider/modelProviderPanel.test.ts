import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import { describe, expect, it } from "vitest";

import {
  MODEL_PROVIDER_FIELD_IDS,
  modelProviderFormPanel,
  modelProviderListPanel,
  modelProviderRowActionId,
  parseModelProviderRowActionId,
} from "./modelProviderPanel";
import { modelProviderEntry } from "./modelProviderConfig";

function configWith(config: Record<string, unknown>): ConfigReadResponse {
  return { config, origins: {}, layers: null } as unknown as ConfigReadResponse;
}

const twoProviders = configWith({
  model_provider: "gateway",
  model_providers: {
    gateway: {
      name: "My gateway",
      base_url: "https://api.example.com/v1",
      experimental_bearer_token: "stored-secret",
    },
    local: { base_url: "http://127.0.0.1:11434/v1" },
  },
});

describe("modelProviderRowActionId", () => {
  it("round-trips the targeted provider through the action id", () => {
    const actionId = modelProviderRowActionId("delete", "my-gateway");

    expect(parseModelProviderRowActionId(actionId)).toEqual({
      action: "delete",
      providerId: "my-gateway",
    });
  });

  it("ignores ids that do not target a provider", () => {
    expect(parseModelProviderRowActionId("model-provider-add")).toBeNull();
    expect(parseModelProviderRowActionId("refresh-config")).toBeNull();
  });
});

describe("modelProviderListPanel", () => {
  it("lists each provider with its address, credential, and selection", () => {
    const panel = modelProviderListPanel({
      configRead: twoProviders,
      cwd: "/Users/me/work",
      locale: "zh",
    });

    expect(panel.body).toContain(
      "- My gateway (gateway) · https://api.example.com/v1 · 已保存密钥 · 当前使用",
    );
    // A recognized address is labelled with its vendor, so the row is readable
    // without parsing the URL.
    expect(panel.body).toContain(
      "- local (local) · Ollama · http://127.0.0.1:11434/v1 · 无需密钥",
    );
  });

  /*
   * Both caveats have to be readable before a provider is saved: the key really
   * is written in cleartext, and a Chat Completions endpoint cannot work at all.
   */
  it("states the OS credential storage and supervised-reload caveats", () => {
    const panel = modelProviderListPanel({
      configRead: twoProviders,
      cwd: null,
      locale: "en",
    });

    expect(panel.body).toContain("Responses-compatible APIs only");
    expect(panel.body).toContain("stored only in the OS credential store");
    expect(panel.body).toContain("supervised Worker restart");
  });

  it("offers a per-provider action set, without re-selecting the current one", () => {
    const panel = modelProviderListPanel({
      configRead: twoProviders,
      cwd: null,
      locale: "en",
    });

    expect(panel.actions?.map((action) => action.id)).toEqual([
      "model-provider-add",
      "model-provider-test:gateway",
      "model-provider-edit:gateway",
      "model-provider-delete:gateway",
      "model-provider-test:local",
      "model-provider-edit:local",
      "model-provider-select:local",
      "model-provider-delete:local",
      "refresh-model-providers",
    ]);
  });

  it("points at the add action when nothing is configured", () => {
    const panel = modelProviderListPanel({
      configRead: configWith({}),
      cwd: null,
      locale: "zh",
    });

    expect(panel.body).toContain("还没有配置任何模型服务");
    expect(panel.actions?.map((action) => action.id)).toEqual([
      "model-provider-add",
      "refresh-model-providers",
    ]);
  });

  it("shows the probe result alongside the list", () => {
    const panel = modelProviderListPanel({
      configRead: twoProviders,
      cwd: null,
      locale: "zh",
      probeText: "连接正常：返回 12 个模型",
    });

    expect(panel.body).toContain("连接正常：返回 12 个模型");
  });
});

describe("modelProviderFormPanel", () => {
  it("prefills an existing provider without carrying its secret into a field", () => {
    const panel = modelProviderFormPanel({
      entry: modelProviderEntry(twoProviders, "gateway"),
      isSelected: true,
      locale: "en",
    });

    const fields = Object.fromEntries(
      (panel.fields ?? []).map((field) => [field.id, field.value]),
    );

    expect(fields[MODEL_PROVIDER_FIELD_IDS.id]).toBe("gateway");
    expect(fields[MODEL_PROVIDER_FIELD_IDS.baseUrl]).toBe(
      "https://api.example.com/v1",
    );
    expect(fields[MODEL_PROVIDER_FIELD_IDS.credentialKind]).toBe(
      "bearer-token",
    );
    expect(fields[MODEL_PROVIDER_FIELD_IDS.apiKey]).toBe("");
    expect(JSON.stringify(panel)).not.toContain("stored-secret");
  });

  it("marks the key field as secret so it is not rendered in the clear", () => {
    const panel = modelProviderFormPanel({
      entry: null,
      isSelected: false,
      locale: "en",
    });

    expect(
      panel.fields?.find(
        (field) => field.id === MODEL_PROVIDER_FIELD_IDS.apiKey,
      )?.secret,
    ).toBe(true);
  });

  /*
   * A first provider is useless unless it is also selected, so adding defaults
   * the toggle on rather than leaving the user with a saved but unused entry.
   */
  it("defaults a new provider to becoming the selected one", () => {
    const panel = modelProviderFormPanel({
      entry: null,
      isSelected: false,
      locale: "en",
    });

    expect(
      panel.fields?.find(
        (field) => field.id === MODEL_PROVIDER_FIELD_IDS.selected,
      )?.value,
    ).toBe("true");
  });

  it("omits the unsupported account provider from the desktop authority form", () => {
    const panel = modelProviderFormPanel({
      allowAccountProvider: false,
      entry: null,
      isSelected: false,
      locale: "en",
    });
    const vendor = panel.fields?.find(
      (field) => field.id === MODEL_PROVIDER_FIELD_IDS.vendor,
    );

    expect(vendor?.value).toBe("qwen");
    expect(vendor?.options?.map((option) => option.value)).not.toContain(
      "openai",
    );
  });

  it("surfaces a validation error on the form it came from", () => {
    const panel = modelProviderFormPanel({
      entry: null,
      error: "Base URL is required",
      isSelected: false,
      locale: "en",
    });

    expect(panel.error).toBe("Base URL is required");
  });
});
