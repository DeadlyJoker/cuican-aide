import type { ExternalAgentConfigMigrationItem } from "@crewon-ui-model/v2/ExternalAgentConfigMigrationItem";
import { describe, expect, it } from "vitest";

import type { LibraryItem } from "../domain/crewonDomain";
import {
  backendAgentCollectionContent,
  backendAutomationCollectionContent,
  backendOfficeCollectionContent,
  controlAutomationCollectionContent,
  knowledgeLibraryPanel,
  libraryCollectionPanel,
  libraryDisconnectedPanel,
  libraryLoadFailurePanel,
  libraryLoadingPanel,
} from "./libraryCollectionPanels";

function item(title: string): LibraryItem {
  return {
    title,
    meta: "record",
    description: "Saved record",
  };
}

function migrationItem(
  overrides: Partial<ExternalAgentConfigMigrationItem> = {},
): ExternalAgentConfigMigrationItem {
  return {
    itemType: "AGENTS_MD",
    description: "Repo instructions",
    cwd: "/repo",
    details: null,
    ...overrides,
  };
}

describe("library collection panel helpers", () => {
  it("builds shared library load panels", () => {
    expect(libraryLoadingPanel("tools", "en")).toEqual({
      kind: "tools",
      title: "Capabilities",
      subtitle: "Reading from local app-server...",
      items: [],
    });
    expect(libraryDisconnectedPanel("plugins", "Disconnected", "zh")).toEqual({
      kind: "plugins",
      title: "插件",
      subtitle: "Disconnected",
      items: [],
      error: "未连接本地 app-server",
    });
    expect(
      libraryCollectionPanel(
        "office",
        {
          subtitle: "1 backend offices",
          body: "Body",
          actions: [{ id: "create-office", label: "New office" }],
          items: [item("Planning Office")],
          error: undefined,
        },
        "en",
      ),
    ).toEqual({
      kind: "office",
      title: "Office",
      subtitle: "1 backend offices",
      body: "Body",
      actions: [{ id: "create-office", label: "New office" }],
      items: [item("Planning Office")],
      error: undefined,
    });
    expect(libraryLoadFailurePanel("automation", null, "en")).toEqual({
      kind: "automation",
      title: "Automations",
      subtitle: "Unable to load",
      items: [],
      error: "Unable to load",
    });
    expect(
      libraryLoadFailurePanel("automation", new Error("denied"), "zh"),
    ).toEqual({
      kind: "automation",
      title: "自动化",
      subtitle: "读取失败",
      items: [],
      error: "denied",
    });
  });

  it("builds knowledge library panels", () => {
    expect(
      knowledgeLibraryPanel(
        {
          memories: [],
          sources: [],
        },
        "zh",
      ),
    ).toEqual({
      kind: "knowledge",
      title: "知识库",
      subtitle: "0 条记忆 · 0 个知识源",
      items: [],
      knowledge: {
        memories: [],
        sources: [],
      },
      error: "当前没有工作区路径，无法读取知识库。",
    });
    expect(
      knowledgeLibraryPanel(
        {
          memories: [
            {
              title: "Memory",
              glyph: "M",
              accent: "blue",
              kind: "memory",
              preview: "Remember this",
              meta: "thread",
            },
          ],
          sources: [],
        },
        "en",
      ),
    ).toMatchObject({
      kind: "knowledge",
      title: "Knowledge",
      subtitle: "1 memories · 0 sources",
      error: undefined,
    });
  });

  it("builds backend office collection content", () => {
    expect(
      backendOfficeCollectionContent({
        items: [item("Planning Office")],
        listUnsupported: false,
        locale: "en",
      }),
    ).toEqual({
      subtitle: "1 office",
      body: "Saved offices in the current workspace appear here. Create one from Team after defining its name, goal, and real members.",
      actions: [],
      items: [
        {
          title: "Offices",
          meta: "1 created",
          description: "Open an office to continue group-chat work.",
          section: true,
        },
        item("Planning Office"),
      ],
      error: undefined,
    });
  });

  it("builds backend office empty and unsupported states", () => {
    expect(
      backendOfficeCollectionContent({
        items: [],
        listUnsupported: true,
        locale: "zh",
      }),
    ).toMatchObject({
      subtitle: "0 个办公室",
      error: "当前版本暂时无法读取办公室，请升级后重试。",
      items: [
        {
          title: "暂无办公室",
          meta: "当前工作空间",
          glyph: "◷",
          accent: "slate",
        },
      ],
    });
  });

  it("builds backend automation collection content", () => {
    expect(
      backendAutomationCollectionContent({
        items: [item("Nightly Audit")],
        listUnsupported: false,
        locale: "zh",
      }),
    ).toMatchObject({
      subtitle: "1 条后端自动化",
      actions: [
        { id: "create-automation", label: "新建自动化", tone: "primary" },
      ],
      items: [
        {
          title: "后端自动化",
          meta: "1 条记录",
          section: true,
        },
        item("Nightly Audit"),
      ],
      error: undefined,
    });
  });

  it("builds backend automation empty and unsupported states", () => {
    expect(
      backendAutomationCollectionContent({
        items: [],
        listUnsupported: true,
        locale: "en",
      }),
    ).toMatchObject({
      subtitle: "0 backend automations",
      error: "The current app-server does not support automation/list.",
      items: [
        {
          title: "No backend automations",
          meta: "automation/list",
          glyph: "◷",
          accent: "slate",
        },
      ],
    });
  });

  it("snapshots the Control scheduled Automation collection", () => {
    expect(
      controlAutomationCollectionContent({
        items: [
          {
            title: "Daily audit",
            meta: "Scheduled automation · daily 09:00 · Asia/Shanghai",
            description: "Review the daily queue",
          },
        ],
        locale: "en",
      }),
    ).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "id": "prepare-control-automation",
            "label": "New automation",
          },
        ],
        "body": "Automations are durably scheduled by Control. The current form creates daily schedules, which can also run immediately. Toggles and in-place edits are not offered here.",
        "items": [
          {
            "description": "Open an automation to inspect its durable schedule or run it through Control authority.",
            "meta": "1 immutable definition",
            "section": true,
            "title": "Control automations",
          },
          {
            "description": "Review the daily queue",
            "meta": "Scheduled automation · daily 09:00 · Asia/Shanghai",
            "title": "Daily audit",
          },
        ],
        "subtitle": "1 Control automation",
      }
    `);
  });

  it("builds backend agent collection content", () => {
    expect(
      backendAgentCollectionContent({
        storedItems: [item("Reviewer")],
        detectedItems: [migrationItem()],
        locale: "en",
      }),
    ).toEqual({
      subtitle: "1 backend agents · 1 importable items",
      body: "Agents are loaded from app-server agent/list. Creating one opens a draft; the backend is written only after a real name and role are saved.",
      actions: [{ id: "create-agent", label: "New agent", tone: "primary" }],
      items: [
        {
          title: "Backend agents",
          meta: "1 saved",
          description:
            "These agents come from app-server agent/list and can be adjusted.",
          section: true,
        },
        item("Reviewer"),
        {
          title: "External configs",
          meta: "1 importable items",
          description: "Migrate existing agent configs into the agent library.",
          section: true,
        },
        {
          title: "Repo instructions",
          meta: "AGENTS_MD",
          description: "Scope: /repo",
          action: {
            type: "external-agent-import",
            item: migrationItem(),
          },
        },
      ],
    });
  });

  it("builds backend agent empty state", () => {
    expect(
      backendAgentCollectionContent({
        storedItems: [],
        detectedItems: [],
        locale: "zh",
      }),
    ).toMatchObject({
      subtitle: "0 个后端智能体 · 0 个可导入项",
      items: [
        {
          title: "暂无后端智能体",
          meta: "agent/list",
          glyph: "◷",
          accent: "slate",
        },
      ],
    });
  });
});
