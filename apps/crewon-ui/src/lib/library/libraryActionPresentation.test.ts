import { describe, expect, it } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import {
  domainConfigDeletedNoticeState,
  isLibraryDraftAction,
  knowledgeFilePanel,
  knowledgeFilePanelActions,
  knowledgeFilePanelBody,
  libraryActionFailurePanel,
  libraryActionProgressPanel,
  libraryActionFallbackErrorText,
  libraryActionProgressText,
  libraryDemoBackendDeferredPanel,
  libraryDemoBackendDeferredPatch,
  libraryDraftActionPanel,
  libraryDraftActionPresentation,
  libraryOpenThreadFailureNotice,
  libraryOpenThreadOpenedNotice,
  libraryOpenThreadUnavailableNotice,
  mcpOauthLoginPanelBody,
  mcpOauthLoginPanel,
  mcpConfigDeletedNoticeState,
  pluginSkillDetailPanel,
  pluginSkillDetailPatch,
  pluginInstallPanelBody,
  pluginInstallResultPanel,
  skillDetailFailurePanel,
  skillDetailFailurePatch,
  skillDetailLoadingPanel,
  skillDetailLoadingPatch,
  skillFileDetailPanel,
  skillFileDetailPatch,
  skillToggleNoticeState,
  skillToggleNoticeText,
} from "./libraryActionPresentation";

function panel(): LibraryPanel {
  return {
    kind: "tools",
    title: "Tools",
    subtitle: "Library",
    body: "Existing body",
    items: [{ title: "Existing", meta: "old" }],
    error: "old error",
  };
}

describe("library action presentation", () => {
  it("classifies draft actions", () => {
    expect(isLibraryDraftAction("create-office")).toBe(true);
    expect(isLibraryDraftAction("recruit-agent")).toBe(true);
    expect(isLibraryDraftAction("reload-tools")).toBe(false);
  });

  it("builds demo draft presentations", () => {
    expect(libraryDraftActionPresentation("create-agent", "en")).toEqual({
      body: "New agent is now in draft state. Once the backend is connected, this opens the real creation flow; for the demo it shows entry, status, and next step.",
      item: {
        title: "New agent",
        meta: "Draft · waiting for backend save",
        description:
          "Configure role, model, permissions, default tools, and offices.",
      },
    });

    expect(libraryDraftActionPresentation("recruit-agent", "zh").item).toEqual({
      title: "招募智能体",
      meta: "待选择角色 · 可加入当前办公室",
      description: "选择智能体、分配职责和工具权限，然后加入群聊协作。",
    });
    expect(libraryDraftActionPanel(panel(), "create-mcp", "en")).toEqual({
      ...panel(),
      body: "New MCP is now in draft state. Once the backend is connected, this opens the real creation flow; for the demo it shows entry, status, and next step.",
      items: [
        {
          title: "New MCP",
          meta: "Draft · waiting for backend save",
          description:
            "Configure name, permissions, source, and visibility before saving.",
        },
        { title: "Existing", meta: "old" },
      ],
      error: undefined,
    });
    expect(libraryDraftActionPanel(null, "create-mcp", "en")).toBeNull();
  });

  it("builds demo backend-deferred action patches", () => {
    expect(libraryDemoBackendDeferredPatch("install-plugin", "en")).toEqual({
      body: "Demo mode: marketplace browse and install open once the backend is connected. Shown here are bundled MCP connectors and skills.",
      error: undefined,
    });
    expect(libraryDemoBackendDeferredPatch("reload-tools", "zh")).toEqual({
      body: "演示模式：工具列表为内置示例，接入 app-server 后会显示真实的运行态 MCP 和 Skill。",
      error: undefined,
    });
    expect(
      libraryDemoBackendDeferredPanel(panel(), "reload-tools", "zh"),
    ).toEqual({
      ...panel(),
      body: "演示模式：工具列表为内置示例，接入 app-server 后会显示真实的运行态 MCP 和 Skill。",
      error: undefined,
    });
    expect(
      libraryDemoBackendDeferredPanel(null, "install-plugin", "en"),
    ).toBeNull();
  });

  it("maps action progress text", () => {
    expect(libraryActionProgressText("run-automation", "en")).toBe(
      "Running automation...",
    );
    expect(libraryActionProgressText("delete-config-file", "zh")).toBe(
      "正在删除后端记录...",
    );
    expect(libraryActionProgressText("uninstall-plugin", "en")).toBe(
      "Uninstalling plugin...",
    );
    expect(libraryActionProgressPanel(panel(), "reload-tools", "zh")).toEqual({
      ...panel(),
      body: "正在刷新工具...",
      error: undefined,
    });
    expect(libraryActionProgressPanel(null, "reload-tools", "zh")).toBeNull();
  });

  it("maps fallback error text", () => {
    expect(libraryActionFallbackErrorText("install-plugin", "zh")).toBe(
      "安装插件失败",
    );
    expect(libraryActionFallbackErrorText("read-mcp-resource", "en")).toBe(
      "Unable to read MCP resource",
    );
    expect(libraryActionFallbackErrorText("uninstall-plugin", "en")).toBe(
      "Unable to uninstall plugin",
    );
    expect(
      libraryActionFailurePanel(panel(), null, "reload-tools", "zh"),
    ).toEqual({
      ...panel(),
      error: "刷新工具失败",
    });
    expect(
      libraryActionFailurePanel(panel(), new Error("denied"), "reload-tools", "en"),
    ).toEqual({
      ...panel(),
      error: "denied",
    });
    expect(
      libraryActionFailurePanel(null, null, "reload-tools", "en"),
    ).toBeNull();
  });

  it("builds library open-thread notices", () => {
    expect(libraryOpenThreadUnavailableNotice("en")).toEqual({
      text: "No backend thread is available to open",
      tone: "warning",
    });
    expect(libraryOpenThreadOpenedNotice("Agent run", "zh")).toEqual({
      text: "已打开后端线程：Agent run",
      tone: "success",
    });
    expect(libraryOpenThreadFailureNotice(null, "zh")).toEqual({
      text: "打开后端线程失败",
      tone: "warning",
    });
    expect(libraryOpenThreadFailureNotice(new Error("missing"), "en")).toEqual({
      text: "missing",
      tone: "warning",
    });
  });

  it("builds knowledge file panel content and actions", () => {
    const longText = "a".repeat(16001);

    expect(
      knowledgeFilePanelBody({
        metadata: null,
        text: longText,
        locale: "en",
      }),
    ).toBe(
      `Knowledge file loaded from the backend workspace.\n\n${"a".repeat(16000)}\n...`,
    );

    expect(knowledgeFilePanelActions("/workspace/notes.md", "zh")).toEqual([
      {
        id: "open-path",
        label: "右栏打开路径",
        pathToOpen: "/workspace/notes.md",
        pathKind: "file",
      },
      {
        id: "refresh-knowledge",
        label: "返回知识库",
      },
    ]);
    expect(
      knowledgeFilePanel(
        {
          ...panel(),
          kind: "knowledge",
          knowledge: { memories: [], sources: [] },
        },
        {
          metadata: null,
          path: "/workspace/notes.md",
          text: "hello",
          title: "notes.md",
          locale: "en",
        },
      ),
    ).toEqual({
      ...panel(),
      kind: "knowledge",
      knowledge: { memories: [], sources: [] },
      title: "notes.md",
      subtitle: "/workspace/notes.md",
      body: "Knowledge file loaded from the backend workspace.\n\nhello",
      actions: knowledgeFilePanelActions("/workspace/notes.md", "en"),
      error: undefined,
    });
    expect(
      knowledgeFilePanel(panel(), {
        metadata: null,
        path: "/workspace/notes.md",
        text: "hello",
        title: "notes.md",
        locale: "en",
      }),
    ).toEqual(panel());
  });

  it("builds MCP OAuth login result text", () => {
    expect(
      mcpOauthLoginPanelBody(
        { authorizationUrl: "https://example.test/oauth" },
        "en",
      ),
    ).toBe(
      "Open this URL to finish MCP authorization\nhttps://example.test/oauth",
    );

    expect(mcpOauthLoginPanelBody(null, "zh")).toBe("MCP 授权已启动");
    expect(
      mcpOauthLoginPanel(
        panel(),
        { authorizationUrl: "https://example.test/oauth" },
        "en",
      ),
    ).toEqual({
      ...panel(),
      body: "Open this URL to finish MCP authorization\nhttps://example.test/oauth",
      error: undefined,
    });
    expect(mcpOauthLoginPanel(null, null, "en")).toBeNull();
  });

  it("builds plugin install result text", () => {
    expect(
      pluginInstallPanelBody(
        {
          authPolicy: "on-request",
          appsNeedingAuth: ["browser", "documents"],
        },
        "en",
      ),
    ).toBe("Plugin installed\nAuth policy: on-request\nApps needing auth: 2");

    expect(pluginInstallPanelBody(undefined, "zh")).toBe("插件已安装");
    expect(
      pluginInstallResultPanel(
        panel(),
        {
          authPolicy: "on-request",
          appsNeedingAuth: ["browser"],
        },
        "en",
      ),
    ).toEqual({
      ...panel(),
      body: "Plugin installed\nAuth policy: on-request\nApps needing auth: 1",
      error: undefined,
    });
    expect(pluginInstallResultPanel(null, undefined, "en")).toBeNull();
  });

  it("builds skill toggle notices", () => {
    expect(
      skillToggleNoticeText({
        skillName: "docs",
        wasEnabled: true,
        syncedToolRecord: { filePath: "/workspace/.codex/tools/docs.json" },
        locale: "zh",
      }),
    ).toBe("docs 已停用（工具记录：/workspace/.codex/tools/docs.json）");

    expect(
      skillToggleNoticeText({
        skillName: null,
        wasEnabled: false,
        syncedToolRecord: null,
        locale: "en",
      }),
    ).toBe("Skill enabled");

    expect(
      skillToggleNoticeState({
        skillName: "docs",
        wasEnabled: false,
        syncedToolRecord: null,
        locale: "en",
      }),
    ).toEqual({
      text: "docs enabled",
      tone: "success",
    });
  });

  it("builds config deletion notices", () => {
    expect(
      domainConfigDeletedNoticeState("/repo/.crewon/tools/docs.json", "zh"),
    ).toEqual({
      text: "已删除后端记录：/repo/.crewon/tools/docs.json",
      tone: "success",
    });
    expect(
      mcpConfigDeletedNoticeState({
        deletedToolRecord: "/repo/.crewon/tools/github.json",
        locale: "en",
        serverName: "github",
      }),
    ).toEqual({
      text: "Deleted MCP config: github (tool-library record: /repo/.crewon/tools/github.json)",
      tone: "success",
    });
    expect(
      mcpConfigDeletedNoticeState({
        deletedToolRecord: null,
        locale: "zh",
        serverName: "github",
      }),
    ).toEqual({
      text: "已删除 MCP 配置：github",
      tone: "success",
    });
  });

  it("builds skill detail patches", () => {
    expect(skillDetailLoadingPatch("en")).toEqual({
      body: "Reading skill...",
      error: undefined,
    });
    expect(skillDetailLoadingPanel(panel(), "zh")).toEqual({
      ...panel(),
      body: "正在读取 Skill...",
      error: undefined,
    });
    expect(
      skillFileDetailPatch({
        action: {
          type: "skill-file",
          skillName: "docs",
          path: "/repo/.codex/skills/docs/SKILL.md",
          enabled: false,
          configPath: "/repo/.crewon/tools/docs.json",
        },
        body: "# Docs",
        locale: "zh",
      }),
    ).toEqual({
      title: "docs",
      subtitle: "/repo/.codex/skills/docs/SKILL.md",
      body: "# Docs",
      actions: [
        {
          id: "open-path",
          label: "右栏打开源文件",
          pathToOpen: "/repo/.codex/skills/docs/SKILL.md",
          pathKind: "file",
        },
        {
          id: "toggle-skill",
          label: "启用 Skill",
          skillEnabled: false,
          skillName: "docs",
          skillPath: "/repo/.codex/skills/docs/SKILL.md",
          skillConfigPath: "/repo/.crewon/tools/docs.json",
          tone: "primary",
        },
        {
          id: "open-path",
          label: "打开后端记录",
          pathToOpen: "/repo/.crewon/tools/docs.json",
          pathKind: "file",
        },
        {
          id: "delete-config-file",
          label: "删除后端记录",
          pathToOpen: "/repo/.crewon/tools/docs.json",
          pathKind: "file",
          domainConfigKind: "tool",
          tone: "danger",
        },
      ],
    });
    expect(
      skillFileDetailPanel(panel(), {
        action: {
          type: "skill-file",
          skillName: "docs",
          path: "/repo/.codex/skills/docs/SKILL.md",
        },
        body: "# Docs",
        locale: "en",
      }),
    ).toMatchObject({
      ...panel(),
      title: "docs",
      subtitle: "/repo/.codex/skills/docs/SKILL.md",
      body: "# Docs",
      error: "old error",
    });
    expect(
      pluginSkillDetailPatch({
        action: {
          type: "plugin-skill",
          skillName: "docs",
          remoteMarketplaceName: "shared",
          remotePluginId: "plugin-id",
        },
        contents: null,
        fallbackTitle: "Docs skill",
        locale: "en",
      }),
    ).toEqual({
      title: "Docs skill",
      subtitle: "Skill details",
      body: "No contents",
    });
    expect(
      pluginSkillDetailPanel(panel(), {
        action: {
          type: "plugin-skill",
          skillName: "docs",
          remoteMarketplaceName: "shared",
          remotePluginId: "plugin-id",
        },
        contents: "Skill body",
        fallbackTitle: "Docs skill",
        locale: "en",
      }),
    ).toEqual({
      ...panel(),
      title: "Docs skill",
      subtitle: "Skill details",
      body: "Skill body",
    });
    expect(skillDetailFailurePatch(null, "zh")).toEqual({
      error: "读取 Skill 失败",
    });
    expect(skillDetailFailurePatch(new Error("denied"), "en")).toEqual({
      error: "denied",
    });
    expect(skillDetailFailurePanel(null, null, "en")).toBeNull();
    expect(skillDetailFailurePanel(panel(), null, "en")).toEqual({
      ...panel(),
      error: "Unable to read skill",
    });
  });
});
