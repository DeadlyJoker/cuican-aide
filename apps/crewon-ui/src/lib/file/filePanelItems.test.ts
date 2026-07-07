import { describe, expect, it } from "vitest";

import {
  demoDirectoryPanel,
  demoFilePanel,
  directoryPanel,
  directoryEntriesToPanelItems,
  emptyDirectoryPanelItem,
  fileErrorPanel,
  fileLoadingPanel,
  fileReadPanel,
  searchFilesToPanelItems,
  searchResultsPanel,
} from "./filePanelItems";

describe("file panel item helpers", () => {
  it("sorts directories first, sorts by name, and applies a limit", () => {
    expect(
      directoryEntriesToPanelItems(
        [
          { fileName: "z.txt", isDirectory: false },
          { fileName: "src", isDirectory: true },
          { fileName: "README.md", isDirectory: false },
          { fileName: "apps", isDirectory: true },
        ],
        "/repo",
        3,
      ),
    ).toEqual([
      { label: "> apps", path: "/repo/apps", kind: "directory" },
      { label: "> src", path: "/repo/src", kind: "directory" },
      { label: "  README.md", path: "/repo/README.md", kind: "file" },
    ]);
  });

  it("handles missing entries and localized empty labels", () => {
    expect(directoryEntriesToPanelItems(undefined, "/repo")).toEqual([]);
    expect(emptyDirectoryPanelItem("en")).toEqual({ label: "Empty directory" });
    expect(emptyDirectoryPanelItem("zh")).toEqual({ label: "目录为空" });
  });

  it("builds file loading and error panels", () => {
    expect(fileLoadingPanel("/repo", "en")).toEqual({
      title: "Files",
      subtitle: "/repo",
      body: "Reading...",
    });
    expect(
      fileErrorPanel({
        error: null,
        fallback: "Unable to read",
        locale: "en",
        path: "/repo",
      }),
    ).toEqual({
      title: "Files",
      subtitle: "/repo",
      error: "Unable to read",
    });
  });

  it("builds demo file panels", () => {
    expect(
      demoDirectoryPanel({
        label: "workspace",
        locale: "en",
        path: "/repo",
      }),
    ).toEqual({
      title: "Files",
      subtitle: "/repo",
      body: "directory · demo data",
      items: [
        {
          label: "  (demo) crewon-ui",
          path: "/repo/crewon-ui",
          kind: "directory",
        },
        { label: "  (demo) README.md", path: "/repo/README.md", kind: "file" },
      ],
    });
    expect(
      demoFilePanel({
        label: " README.md ",
        locale: "zh",
        path: "/repo/README.md",
      }),
    ).toEqual({
      title: "README.md",
      subtitle: "/repo/README.md",
      body: "演示模式下展示的是示例文件内容。接入本地 app-server 后，这里会读取真实文件。",
    });
  });

  it("builds directory panels with controls and empty states", () => {
    expect(
      directoryPanel({
        bodyPrefix: "Copied to: /repo/file.copy",
        entries: [],
        includeCopyAction: true,
        locale: "en",
        metadataText: "Type: directory",
        path: "/repo",
      }),
    ).toEqual({
      title: "Files",
      subtitle: "/repo",
      body: "Copied to: /repo/file.copy\n\nType: directory",
      fields: [
        {
          id: "file-search",
          label: "Search files",
          placeholder: "File name or path",
          value: "",
        },
        {
          id: "file-search-root",
          label: "Search root",
          value: "/repo",
        },
      ],
      actions: [
        { id: "copy-current-path", label: "Copy to .copy" },
        { id: "create-context-note", label: "New context note" },
        { id: "search-files", label: "Search", tone: "primary" },
        { id: "watch-current-path", label: "Watch" },
        { id: "unwatch-current-path", label: "Unwatch" },
        { id: "clear-file-search", label: "Clear" },
      ],
      items: [{ label: "Empty directory" }],
    });
  });

  it("builds search panels", () => {
    const items = searchFilesToPanelItems([
      { root: "/repo", path: "src", match_type: "directory" },
      { root: "/repo", path: "README.md", match_type: "file" },
    ]);

    expect(items).toEqual([
      { label: "> src", path: "/repo/src", kind: "directory" },
      { label: "  README.md", path: "/repo/README.md", kind: "file" },
    ]);
    expect(
      searchResultsPanel({
        items: [],
        locale: "zh",
        query: "main",
        root: "/repo",
      }).items,
    ).toEqual([{ label: "没有匹配结果" }]);
  });

  it("builds file read panels", () => {
    expect(
      fileReadPanel({
        fileText: "hello",
        intent: "attach-context",
        label: "README.md",
        locale: "en",
        metadataText: "Type: file",
        path: "/repo/README.md",
      }),
    ).toEqual({
      title: "README.md",
      subtitle: "/repo/README.md",
      body: "Type: file\n\nAdded to the composer. It will be sent through backend turn/start.\n\nhello",
      actions: [
        {
          id: "send-context-to-thread",
          label: "Send to backend thread",
          tone: "primary",
        },
        { id: "copy-current-path", label: "Copy to .copy" },
        { id: "create-context-note", label: "New context note" },
        { id: "search-files", label: "Search", tone: "primary" },
        { id: "watch-current-path", label: "Watch" },
        { id: "unwatch-current-path", label: "Unwatch" },
        { id: "clear-file-search", label: "Clear" },
      ],
    });
  });

});
