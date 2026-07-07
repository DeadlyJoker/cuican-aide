import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { LibraryKind, LibraryPanelAction } from "../domain/crewonDomain";
import { handleLibrarySkillAction } from "./librarySkillActions";

type CapturedSkillState = {
  librariesOpened: LibraryKind[];
  notice: NoticeState | null;
  syncedConfigs: Array<{
    cwd: string;
    enabled: boolean;
    locale: string;
    skillName?: string | null;
  }>;
  writtenConfigs: Array<{
    enabled: boolean;
    name?: string | null;
    path?: string | null;
  }>;
};

async function handleAction(
  action: LibraryPanelAction,
  cwd: string | null = "/workspace",
): Promise<{ handled: boolean; state: CapturedSkillState }> {
  const state: CapturedSkillState = {
    librariesOpened: [],
    notice: null,
    syncedConfigs: [],
    writtenConfigs: [],
  };

  const handled = await handleLibrarySkillAction({
    action,
    locale: "en",
    openLibrary: async (kind) => {
      state.librariesOpened.push(kind);
    },
    resolveBackendCwd: async () => cwd,
    setNotice: (notice) => {
      state.notice = notice;
    },
    syncSkillToolConfig: async (resolvedCwd, skillAction, enabled, locale) => {
      state.syncedConfigs.push({
        cwd: resolvedCwd,
        enabled,
        locale,
        skillName: skillAction.skillName,
      });
      return { filePath: "/workspace/.crewon/tools/review.json" };
    },
    writeSkillConfig: async (params) => {
      state.writtenConfigs.push(params);
    },
  });

  return { handled, state };
}

describe("library skill actions", () => {
  it("toggles named skills and syncs tool config", async () => {
    const { handled, state } = await handleAction({
      id: "toggle-skill",
      label: "Toggle",
      skillEnabled: false,
      skillName: "Review",
    });

    expect(handled).toBe(true);
    expect(state.writtenConfigs).toEqual([
      {
        enabled: true,
        name: "Review",
        path: null,
      },
    ]);
    expect(state.syncedConfigs).toEqual([
      {
        cwd: "/workspace",
        enabled: true,
        locale: "en",
        skillName: "Review",
      },
    ]);
    expect(state.notice).toEqual({
      text: "Review enabled (tool record: /workspace/.crewon/tools/review.json)",
      tone: "success",
    });
    expect(state.librariesOpened).toEqual(["tools"]);
  });

  it("toggles skill paths without passing names to config write", async () => {
    const { handled, state } = await handleAction({
      id: "toggle-skill",
      label: "Toggle",
      skillEnabled: true,
      skillName: "Review",
      skillPath: "/workspace/skills/review/SKILL.md",
    });

    expect(handled).toBe(true);
    expect(state.writtenConfigs).toEqual([
      {
        enabled: false,
        name: null,
        path: "/workspace/skills/review/SKILL.md",
      },
    ]);
    expect(state.notice?.text).toBe(
      "Review disabled (tool record: /workspace/.crewon/tools/review.json)",
    );
  });

  it("skips tool config sync when cwd is unavailable", async () => {
    const { handled, state } = await handleAction(
      {
        id: "toggle-skill",
        label: "Toggle",
        skillEnabled: false,
        skillName: "Review",
      },
      null,
    );

    expect(handled).toBe(true);
    expect(state.syncedConfigs).toEqual([]);
    expect(state.notice).toEqual({
      text: "Review enabled",
      tone: "success",
    });
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.writtenConfigs).toEqual([]);
    expect(state.librariesOpened).toEqual([]);
  });
});
