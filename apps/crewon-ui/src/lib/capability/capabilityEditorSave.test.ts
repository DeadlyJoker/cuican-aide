import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import { saveCapabilityEditorDraft } from "./capabilityEditorSave";

function client() {
  const calls = {
    createSkill: vi.fn(async (params) => ({
      skill: {
        name: params.name,
        description: params.description,
        path: `${params.cwd}/.crewon/skill/${params.name}/SKILL.md`,
        enabled: true,
      },
    })),
    listToolConfigs: vi.fn(async () => ({ data: [], nextCursor: null })),
    saveMcpServerConfig: vi.fn(async () => ({
      reloadError: null as string | null,
    })),
    saveToolConfig: vi.fn(async (cwd, config) => ({
      filePath: `${cwd}/.crewon/tools/${config.name}.json`,
    })),
    startMcpOauthLogin: vi.fn(async () => ({
      authorizationUrl: "https://github.com/login/oauth/authorize",
    })),
  };
  return { calls, value: calls as unknown as AppServerClient };
}

describe("capability editor save", () => {
  it("creates a Skill and its assignable tool record", async () => {
    const { calls, value } = client();
    const result = await saveCapabilityEditorDraft({
      client: value,
      cwd: "/repo",
      draft: {
        kind: "skill",
        name: "Spreadsheet Analysis",
        description: "Analyze tables.",
        workflow: "- Inspect columns.\n- Report findings.",
      },
      locale: "en",
    });

    expect(result).toEqual({ kind: "skill", name: "spreadsheet-analysis" });
    expect(calls.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "spreadsheet-analysis", cwd: "/repo" }),
    );
    expect(calls.saveToolConfig).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ kind: "skill", name: "spreadsheet-analysis" }),
    );
  });

  it("saves and reloads an MCP config plus its tool record", async () => {
    const { calls, value } = client();
    const result = await saveCapabilityEditorDraft({
      client: value,
      cwd: "/repo",
      draft: {
        kind: "mcp",
        name: "GitHub",
        presetId: "github",
        values: {},
      },
      locale: "en",
    });

    expect(result).toEqual({
      authorizationUrl: "https://github.com/login/oauth/authorize",
      kind: "mcp",
      name: "github",
    });
    expect(calls.saveMcpServerConfig).toHaveBeenCalledWith({
      name: "github",
      config: {
        url: "https://api.githubcopilot.com/mcp/",
        enabled: true,
      },
      reload: true,
    });
    expect(calls.startMcpOauthLogin).toHaveBeenCalledWith("github");
    expect(calls.saveToolConfig).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ kind: "mcp", name: "github" }),
    );
  });

  it("reports a real MCP reload failure after preserving the saved config", async () => {
    const { calls, value } = client();
    calls.saveMcpServerConfig.mockResolvedValueOnce({
      reloadError: "authentication required",
    });

    await expect(
      saveCapabilityEditorDraft({
        client: value,
        cwd: "/repo",
        draft: {
          kind: "mcp",
          name: "Playwright",
          presetId: "playwright",
          values: {},
        },
        locale: "en",
      }),
    ).rejects.toThrow("服务配置已保存，但连接失败：authentication required");
    expect(calls.saveToolConfig).toHaveBeenCalled();
  });
});
