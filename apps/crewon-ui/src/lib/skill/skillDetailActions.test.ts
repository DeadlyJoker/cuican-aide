import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import {
  openPluginSkillDetailAction,
  openSkillFileDetailAction,
} from "./skillDetailActions";

function panel(): LibraryPanel {
  return {
    kind: "tools",
    title: "Tools",
    subtitle: "Library",
    body: "Existing",
    items: [],
  };
}

describe("skill detail actions", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { atob });
  });

  it("loads local skill file details", async () => {
    let currentPanel: LibraryPanel | null = panel();
    const reads: string[] = [];

    const handled = await openSkillFileDetailAction({
      action: {
        type: "skill-file",
        skillName: "demo-skill",
        path: "/repo/.codex/skills/demo/SKILL.md",
        enabled: true,
        configPath: "/repo/.codex/config.toml",
      },
      locale: "en",
      readFile: async (path) => {
        reads.push(path);
        return { dataBase64: btoa("# Demo skill") };
      },
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(reads).toEqual(["/repo/.codex/skills/demo/SKILL.md"]);
    expect(currentPanel).toMatchObject({
      title: "demo-skill",
      subtitle: "/repo/.codex/skills/demo/SKILL.md",
      body: "# Demo skill",
    });
    expect(currentPanel?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "toggle-skill",
          label: "Disable skill",
          skillEnabled: true,
        }),
        expect.objectContaining({
          id: "open-path",
          label: "Open source in sidebar",
        }),
      ]),
    );
  });

  it("leaves local skill detail loading when no file response is returned", async () => {
    let currentPanel: LibraryPanel | null = panel();

    const handled = await openSkillFileDetailAction({
      action: {
        type: "skill-file",
        skillName: "demo-skill",
        path: "/repo/SKILL.md",
      },
      locale: "en",
      readFile: async () => null,
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      body: "Reading skill...",
      error: undefined,
    });
  });

  it("shows local skill file failures", async () => {
    let currentPanel: LibraryPanel | null = panel();

    const handled = await openSkillFileDetailAction({
      action: {
        type: "skill-file",
        skillName: "demo-skill",
        path: "/repo/SKILL.md",
      },
      locale: "en",
      readFile: async () => {
        throw new Error("read failed");
      },
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      body: "Reading skill...",
      error: "read failed",
    });
  });

  it("loads plugin skill details", async () => {
    let currentPanel: LibraryPanel | null = panel();
    const reads: Array<{
      remoteMarketplaceName: string;
      remotePluginId: string;
      skillName: string;
    }> = [];

    const handled = await openPluginSkillDetailAction({
      action: {
        type: "plugin-skill",
        remoteMarketplaceName: "shared",
        remotePluginId: "plugin-1",
        skillName: "browser",
      },
      fallbackTitle: "Browser skill",
      locale: "en",
      readPluginSkill: async (
        remoteMarketplaceName,
        remotePluginId,
        skillName,
      ) => {
        reads.push({ remoteMarketplaceName, remotePluginId, skillName });
        return { contents: "Plugin skill body" };
      },
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(reads).toEqual([
      {
        remoteMarketplaceName: "shared",
        remotePluginId: "plugin-1",
        skillName: "browser",
      },
    ]);
    expect(currentPanel).toMatchObject({
      title: "Browser skill",
      subtitle: "Skill details",
      body: "Plugin skill body",
    });
  });

  it("shows plugin skill failures", async () => {
    let currentPanel: LibraryPanel | null = panel();

    const handled = await openPluginSkillDetailAction({
      action: {
        type: "plugin-skill",
        remoteMarketplaceName: "shared",
        remotePluginId: "plugin-1",
        skillName: "browser",
      },
      fallbackTitle: "Browser skill",
      locale: "en",
      readPluginSkill: async () => {
        throw new Error("plugin skill failed");
      },
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      body: "Reading skill...",
      error: "plugin skill failed",
    });
  });
});
