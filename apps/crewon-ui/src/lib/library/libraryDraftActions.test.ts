import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  LibraryPanelAction,
  ToolConfig,
} from "../domain/crewonDomain";
import { handleLibraryDraftAction } from "./libraryDraftActions";

type CapturedDraftActionState = {
  createdSkills: Array<{
    body: string;
    cwd: string;
    description: string;
    name: string;
  }>;
  libraryOpened: number;
  mcpSaves: Array<{ name: string }>;
  notice: NoticeState | null;
  panel: LibraryPanel | null;
  savedTools: Array<{ cwd: string; record: ToolConfig }>;
  skillWrites: Array<{ body: string; path: string }>;
};

function panel(fields: LibraryPanel["fields"] = []): LibraryPanel {
  return {
    kind: "tools",
    title: "Tools",
    subtitle: "Connectors",
    body: "Existing",
    items: [],
    fields,
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    cwd?: string | null;
    fields?: LibraryPanel["fields"];
  } = {},
): Promise<{ handled: boolean; state: CapturedDraftActionState }> {
  const state: CapturedDraftActionState = {
    createdSkills: [],
    libraryOpened: 0,
    mcpSaves: [],
    notice: null,
    panel: panel(options.fields),
    savedTools: [],
    skillWrites: [],
  };

  const handled = await handleLibraryDraftAction({
    action,
    createSkill: async (params) => {
      state.createdSkills.push(params);
      return {
        skill: {
          description: params.description,
          enabled: true,
          name: params.name,
          path: `${params.cwd}/.crewon/skills/${params.name}/SKILL.md`,
        },
      };
    },
    fields: state.panel?.fields,
    locale: "en",
    now: () => new Date("2026-06-17T14:30:00.000Z"),
    openToolsLibrary: async () => {
      state.libraryOpened += 1;
    },
    reloadMcpServerConfig: async ({ name }) => {
      state.mcpSaves.push({ name });
    },
    resolveBackendCwd: async () =>
      Object.hasOwn(options, "cwd") ? (options.cwd ?? null) : "/repo",
    saveOrUpdateToolConfig: async (cwd, toolRecord) => {
      state.savedTools.push({ cwd, record: toolRecord });
      return {
        filePath: `${cwd}/.crewon/tools/${toolRecord.name}.json`,
        operation: "created",
      };
    },
    setLibraryPanel: (updater) => {
      state.panel = updater(state.panel);
    },
    setNotice: (notice) => {
      state.notice = notice;
    },
    writeSkillFile: async (path, body) => {
      state.skillWrites.push({ body, path });
    },
  });

  return { handled, state };
}

describe("library draft actions", () => {
  it("creates MCP draft panels with timestamped names", async () => {
    const { handled, state } = await handleAction({
      id: "create-mcp",
      label: "New MCP",
    });

    expect(handled).toBe(true);
    expect(state.panel?.title).toBe("Add MCP service");
    expect(state.panel?.fields?.[0]).toMatchObject({
      id: "mcp-draft-name",
      value: "workspace-mcp-202606171430",
    });
  });

  it("shows missing workspace when creating skill drafts without cwd", async () => {
    const { handled, state } = await handleAction(
      { id: "create-skill", label: "New Skill" },
      { cwd: null },
    );

    expect(handled).toBe(true);
    expect(state.panel?.error).toBe(
      "No workspace path is available for creating a skill",
    );
  });

  it("saves MCP drafts and reloads the tools library", async () => {
    const { handled, state } = await handleAction(
      { id: "save-mcp-draft", label: "Save MCP" },
      {
        fields: [
          { id: "mcp-draft-name", label: "Name", value: "github" },
          {
            id: "mcp-draft-config",
            label: "Config",
            value:
              '{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"enabled":false}',
          },
        ],
      },
    );

    expect(handled).toBe(true);
    expect(state.mcpSaves).toEqual([{ name: "github" }]);
    expect(state.savedTools[0]).toMatchObject({
      cwd: "/repo",
      record: { kind: "mcp", name: "github" },
    });
    expect(state.libraryOpened).toBe(1);
    expect(state.notice).toEqual({
      text: "Added MCP: github (config record: /repo/.crewon/tools/github.json)",
      tone: "success",
    });
  });

  it("shows payload errors for invalid skill drafts", async () => {
    const { handled, state } = await handleAction({
      id: "save-skill-draft",
      label: "Save Skill",
    });

    expect(handled).toBe(true);
    expect(state.createdSkills).toEqual([]);
    expect(state.panel?.error).toBe(
      "Workspace, name, description, and workflow steps are required",
    );
  });

  it("writes edited Skill contents back to the original SKILL.md", async () => {
    const { handled, state } = await handleAction(
      {
        id: "save-skill-edit",
        label: "Save changes",
        skillName: "docs",
        skillPath: "/repo/.crewon/skill/docs/SKILL.md",
      },
      {
        fields: [
          {
            id: "skill-edit-body",
            label: "SKILL.md",
            value: "# Docs\n\nUpdated workflow.",
          },
        ],
      },
    );

    expect(handled).toBe(true);
    expect(state.skillWrites).toEqual([
      {
        path: "/repo/.crewon/skill/docs/SKILL.md",
        body: "# Docs\n\nUpdated workflow.\n",
      },
    ]);
    expect(state.libraryOpened).toBe(1);
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled } = await handleAction({
      id: "open-thread",
      label: "Open",
      threadId: "thread-1",
    });

    expect(handled).toBe(false);
  });
});
