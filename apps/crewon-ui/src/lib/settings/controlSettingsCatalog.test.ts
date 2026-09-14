import type { ActiveAgentVersionCatalogResponse } from "@crewon/contracts";
import { describe, expect, it, vi } from "vitest";
import { readControlSettingsCatalog } from "./controlSettingsCatalog";
import { controlSettingsPanel } from "./controlSettingsPanels";

const catalog: ActiveAgentVersionCatalogResponse = {
  releaseId: "release-1",
  activatedAt: "2026-09-08T00:00:00Z",
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
        modelId: "real-model",
      },
      createdAt: "2026-09-08T00:00:00Z",
    },
  ],
};

describe("Control settings authority", () => {
  it("reads the active version without duplicating model configuration on General", async () => {
    const onState = vi.fn();
    await readControlSettingsCatalog({
      client: { getActiveAgentVersionCatalog: vi.fn(async () => catalog) },
      signal: new AbortController().signal,
      onState,
    });
    expect(onState.mock.calls.map((call) => call[0].status)).toEqual([
      "loading",
      "ready",
    ]);
    expect(onState).toHaveBeenLastCalledWith({ status: "ready", catalog });
    const panel = controlSettingsPanel({
      section: "config",
      locale: "zh",
      platformUser: null,
      surface: "web",
      state: { status: "ready", catalog },
    });
    expect(panel.rows?.some(({ id }) => id === "model")).toBe(false);
    expect(panel.actions).toContainEqual({
      id: "settings-open:model-providers",
      label: "查看 AI 模型",
    });
    expect(JSON.stringify(panel)).not.toContain("policy-1");
    expect(JSON.stringify(panel)).not.toContain("CrewON Control");
    expect(panel.fields).toBeUndefined();
  });

  it("discards late reads after navigation", async () => {
    let resolve!: (value: ActiveAgentVersionCatalogResponse) => void;
    const controller = new AbortController();
    const onState = vi.fn();
    const read = readControlSettingsCatalog({
      client: {
        getActiveAgentVersionCatalog: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
      signal: controller.signal,
      onState,
    });
    controller.abort();
    resolve(catalog);
    await read;
    expect(onState.mock.calls).toEqual([[{ status: "loading" }]]);
  });

  it("fails closed on an invalid default or unavailable service", async () => {
    for (const getActiveAgentVersionCatalog of [
      async () => ({ ...catalog, data: [] }),
      async () => {
        throw new Error("secret internal connection details");
      },
    ]) {
      const onState = vi.fn();
      await readControlSettingsCatalog({
        client: { getActiveAgentVersionCatalog },
        signal: new AbortController().signal,
        onState,
      });
      expect(onState).toHaveBeenLastCalledWith({ status: "error" });
    }
    const panel = controlSettingsPanel({
      section: "connections",
      locale: "zh",
      platformUser: null,
      surface: "web",
      state: { status: "error" },
    });
    expect(panel.error).toContain("无法读取");
    expect(panel.rows).toBeUndefined();
    expect(panel.actions).toEqual([
      { id: "settings-refresh", label: "刷新状态" },
    ]);
  });

  it.each([
    "account",
    "mcp-servers",
    "browser",
    "computer-control",
    "environment",
  ] as const)(
    "does not invent actionable legacy capabilities for %s",
    (section) => {
      const panel = controlSettingsPanel({
        section,
        locale: "zh",
        platformUser: null,
        surface: "web",
        state: { status: "loading" },
      });
      expect(panel.fields).toBeUndefined();
      expect(
        panel.actions?.every((action) =>
          action.id.startsWith("settings-open:"),
        ) ?? true,
      ).toBe(true);
      expect(
        panel.rows?.every((row) => row.actions === undefined) ?? true,
      ).toBe(true);
      expect(panel.error).toBeUndefined();
    },
  );
});
