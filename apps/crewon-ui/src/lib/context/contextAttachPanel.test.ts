import { describe, expect, it } from "vitest";

import {
  ATTACH_CONTEXT_QUERIES,
  attachContextDemoPanel,
  attachContextErrorPanel,
  attachContextFallbackPaths,
  attachContextLoadingPanel,
  attachContextResultsPanel,
  buildAttachContextItems,
} from "./contextAttachPanel";

describe("context attach panel helpers", () => {
  it("builds attach context panels", () => {
    expect(ATTACH_CONTEXT_QUERIES).toEqual([
      "AGENTS.md",
      "README.md",
      "knowledge.md",
      "memory.md",
    ]);
    expect(attachContextDemoPanel("en")).toEqual({
      title: "Attach context",
      subtitle: "Demo mode",
      body: "Demo mode does not read real files. With app-server connected, this searches README, AGENTS, and knowledge files.",
    });
    expect(attachContextLoadingPanel("/repo", "zh")).toEqual({
      title: "添加上下文",
      subtitle: "/repo",
      body: "正在从工作区搜索可添加的上下文...",
    });
    expect(
      attachContextResultsPanel({
        contextCwd: "/repo",
        items: [],
        locale: "en",
      }),
    ).toMatchObject({
      title: "Attach context",
      subtitle: "/repo",
      fields: [
        {
          id: "file-search",
          label: "Search files",
          placeholder: "File name or path",
          value: "AGENTS.md README.md knowledge.md memory.md",
        },
        {
          id: "file-search-root",
          label: "Search root",
          value: "/repo",
        },
      ],
      items: [{ label: "No context files found" }],
    });
    expect(
      attachContextErrorPanel({
        contextCwd: "/repo",
        error: null,
        locale: "zh",
      }),
    ).toEqual({
      title: "添加上下文",
      subtitle: "/repo",
      error: "搜索上下文失败",
    });
  });

  it("builds attach context items from search results and fallback files", async () => {
    const metadataByPath = new Map([
      ["/repo/AGENTS.md", { isDirectory: false }],
      ["/repo/README.md", { isDirectory: false }],
      ["/repo/.crewon/knowledge.md", { isDirectory: true }],
    ]);

    await expect(
      buildAttachContextItems({
        contextCwd: "/repo",
        getMetadata: async (path) => metadataByPath.get(path) ?? null,
        searchFiles: async (query) =>
          query === "AGENTS.md"
            ? {
                files: [
                  {
                    root: "/repo",
                    path: "AGENTS.md",
                    match_type: "file",
                  },
                  {
                    root: "/repo",
                    path: "AGENTS.md",
                    match_type: "file",
                  },
                  {
                    root: "/repo",
                    path: "docs",
                    match_type: "directory",
                  },
                ],
              }
            : { files: [] },
      }),
    ).resolves.toEqual([
      {
        label: "  AGENTS.md",
        path: "/repo/AGENTS.md",
        kind: "file",
        intent: "attach-context",
      },
      {
        label: "> docs",
        path: "/repo/docs",
        kind: "directory",
        intent: "attach-context",
      },
      {
        label: "  README.md",
        path: "/repo/README.md",
        kind: "file",
        intent: "attach-context",
      },
    ]);
  });

  it("caps attach context items and exposes fallback paths", async () => {
    expect(attachContextFallbackPaths("/repo")).toEqual([
      "/repo/AGENTS.md",
      "/repo/README.md",
      "/repo/.crewon/knowledge.md",
      "/repo/.crewon/memory.md",
    ]);
    await expect(
      buildAttachContextItems({
        contextCwd: "/repo",
        getMetadata: async () => ({ isDirectory: false }),
        limit: 1,
        searchFiles: async () => ({
          files: [
            {
              root: "/repo",
              path: "README.md",
              match_type: "file",
            },
          ],
        }),
      }),
    ).resolves.toEqual([
      {
        label: "  README.md",
        path: "/repo/README.md",
        kind: "file",
        intent: "attach-context",
      },
    ]);
  });
});
