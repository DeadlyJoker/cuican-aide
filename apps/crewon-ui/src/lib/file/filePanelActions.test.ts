import type { FsGetMetadataResponse } from "@crewon-ui-model/v2/FsGetMetadataResponse";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createFilePanelActionHandlers,
  filePanelActionForActionId,
  type ActiveFileWatch,
  type FilePanelActionHandlersParams,
} from "./filePanelActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function metadata(
  overrides: Partial<FsGetMetadataResponse> = {},
): FsGetMetadataResponse {
  return {
    createdAtMs: 0,
    isDirectory: false,
    isFile: true,
    isSymlink: false,
    modifiedAtMs: 0,
    ...overrides,
  };
}

function baseParams(
  overrides: Partial<FilePanelActionHandlersParams> = {},
): FilePanelActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Files",
    subtitle: "/repo/src",
    body: "Ready",
  };
  let activeFileWatch: ActiveFileWatch | null = null;
  let notice: NoticeState | null = null;
  return {
    activeFileWatch,
    busyToolId: null,
    capabilityPanel: panel,
    client: {
      async copyPath() {},
      async createDirectory() {},
      async fuzzyFileSearch() {
        return {
          files: [{ match_type: "file", path: "src/App.tsx", root: "/repo" }],
        };
      },
      async getMetadata() {
        return metadata();
      },
      async readDirectory() {
        return { entries: [{ fileName: "App.tsx", isDirectory: false }] };
      },
      async unwatchPath() {},
      async watchPath(_watchId, path) {
        return { path };
      },
      async writeTextFile() {},
    },
    cwd: "/repo",
    fieldValue: () => "",
    isConnected: true,
    isDemo: false,
    locale: "en",
    readWorkspaceFiles: () => {},
    resolveBackendCwd: async () => "/repo",
    setActiveFileWatch: (watch) => {
      activeFileWatch = watch;
    },
    setBusyToolId: () => {},
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setNotice: (nextNotice) => {
      notice = nextNotice;
    },
    ...overrides,
  };
}

describe("file panel actions", () => {
  it("maps file panel action ids", () => {
    expect(filePanelActionForActionId("create-context-note")).toBe(
      "createContextNote",
    );
    expect(filePanelActionForActionId("watch-current-path")).toBe(
      "watchCurrentPath",
    );
    expect(filePanelActionForActionId("unwatch-current-path")).toBe(
      "unwatchCurrentPath",
    );
    expect(filePanelActionForActionId("copy-current-path")).toBe(
      "copyCurrentPath",
    );
    expect(filePanelActionForActionId("search-files")).toBe("searchFiles");
    expect(filePanelActionForActionId("clear-file-search")).toBe("clearSearch");
    expect(filePanelActionForActionId("save-thread-goal")).toBeNull();
  });

  it("creates a context note under the selected root", async () => {
    let panel: CapabilityPanel | null = {
      title: "Files",
      body: "Ready",
    };
    let notice: NoticeState | null = null;
    const createdDirectories: Array<{ path: string; recursive?: boolean }> = [];
    const writtenFiles: Array<{ path: string; text: string }> = [];
    const busyStates: Array<"files" | null> = [];
    const handlers = createFilePanelActionHandlers(
      baseParams({
        client: {
          async copyPath() {},
          async createDirectory(path, recursive) {
            createdDirectories.push({ path, recursive });
          },
          async fuzzyFileSearch() {
            return { files: [] };
          },
          async getMetadata() {
            return metadata();
          },
          async readDirectory() {
            return { entries: [] };
          },
          async unwatchPath() {},
          async watchPath(_watchId, path) {
            return { path };
          },
          async writeTextFile(path, text) {
            writtenFiles.push({ path, text });
          },
        },
        fieldValue: (fieldId) =>
          fieldId === "file-search-root" ? "/workspace" : "",
        nowIso: () => "2026-06-17T12:00:00.000Z",
        setBusyToolId: (toolId) => busyStates.push(toolId),
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
    );

    handlers.createContextNote();
    await flushAsyncAction();

    expect(createdDirectories).toEqual([
      { path: "/workspace/.crewon/context-notes", recursive: true },
    ]);
    expect(writtenFiles).toEqual([
      {
        path: "/workspace/.crewon/context-notes/note-2026-06-17T12-00-00-000Z.md",
        text: expect.stringContaining("# Context note"),
      },
    ]);
    expect(panel).toMatchObject({
      subtitle:
        "/workspace/.crewon/context-notes/note-2026-06-17T12-00-00-000Z.md",
    });
    expect(notice).toEqual({
      text: "Context note created: /workspace/.crewon/context-notes/note-2026-06-17T12-00-00-000Z.md",
      tone: "success",
    });
    expect(busyStates).toEqual(["files", null]);
  });

  it("starts watching the current path and replaces an existing watch", async () => {
    let activeFileWatch: ActiveFileWatch | null = {
      id: "old-watch",
      path: "/repo/old",
    };
    const unwatched: string[] = [];
    const watched: Array<{ path: string; watchId: string }> = [];
    const handlers = createFilePanelActionHandlers(
      baseParams({
        activeFileWatch,
        capabilityPanel: {
          title: "Files",
          subtitle: "/repo/src",
          body: "Ready",
        },
        client: {
          async copyPath() {},
          async createDirectory() {},
          async fuzzyFileSearch() {
            return { files: [] };
          },
          async getMetadata() {
            return metadata();
          },
          async readDirectory() {
            return { entries: [] };
          },
          async unwatchPath(watchId) {
            unwatched.push(watchId);
          },
          async watchPath(watchId, path) {
            watched.push({ path, watchId });
            return { path: `${path}/resolved` };
          },
          async writeTextFile() {},
        },
        setActiveFileWatch: (watch) => {
          activeFileWatch = watch;
        },
        watchId: () => "new-watch",
      }),
    );

    handlers.watchCurrentPath();
    await flushAsyncAction();

    expect(unwatched).toEqual(["old-watch"]);
    expect(watched).toEqual([{ path: "/repo/src", watchId: "new-watch" }]);
    expect(activeFileWatch).toEqual({
      id: "new-watch",
      path: "/repo/src/resolved",
    });
  });

  it("copies the current path and opens the parent directory", async () => {
    let panel: CapabilityPanel | null = {
      title: "Files",
      subtitle: "/repo/src/App.tsx",
      body: "Ready",
    };
    let notice: NoticeState | null = null;
    const copied: Array<{
      destinationPath: string;
      recursive?: boolean;
      sourcePath: string;
    }> = [];
    const handlers = createFilePanelActionHandlers(
      baseParams({
        capabilityPanel: panel,
        client: {
          async copyPath(sourcePath, destinationPath, recursive) {
            copied.push({ destinationPath, recursive, sourcePath });
          },
          async createDirectory() {},
          async fuzzyFileSearch() {
            return { files: [] };
          },
          async getMetadata(path) {
            return metadata({
              isDirectory: path === "/repo/src",
              isFile: path !== "/repo/src",
            });
          },
          async readDirectory(path) {
            expect(path).toBe("/repo/src");
            return { entries: [{ fileName: "App.tsx.copy", isDirectory: false }] };
          },
          async unwatchPath() {},
          async watchPath(_watchId, path) {
            return { path };
          },
          async writeTextFile() {},
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
    );

    handlers.copyCurrentPath();
    await flushAsyncAction();

    expect(copied).toEqual([
      {
        destinationPath: "/repo/src/App.tsx.copy",
        recursive: false,
        sourcePath: "/repo/src/App.tsx",
      },
    ]);
    expect(panel).toMatchObject({
      subtitle: "/repo/src",
      body: expect.stringContaining("Copied to: /repo/src/App.tsx.copy"),
    });
    expect(notice).toEqual({
      text: "Copied: /repo/src/App.tsx.copy",
      tone: "success",
    });
  });

  it("searches files from the field root", async () => {
    let panel: CapabilityPanel | null = {
      title: "Files",
      body: "Ready",
    };
    const queries: Array<{ query: string; roots: string[] }> = [];
    const handlers = createFilePanelActionHandlers(
      baseParams({
        client: {
          async copyPath() {},
          async createDirectory() {},
          async fuzzyFileSearch(query, roots) {
            queries.push({ query, roots });
            return {
              files: [{ match_type: "file", path: "src/App.tsx", root: roots[0] }],
            };
          },
          async getMetadata() {
            return metadata();
          },
          async readDirectory() {
            return { entries: [] };
          },
          async unwatchPath() {},
          async watchPath(_watchId, path) {
            return { path };
          },
          async writeTextFile() {},
        },
        fieldValue: (fieldId) => {
          if (fieldId === "file-search-root") {
            return "/workspace";
          }
          if (fieldId === "file-search") {
            return "App";
          }
          return "";
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.searchFiles();
    await flushAsyncAction();

    expect(queries).toEqual([{ query: "App", roots: ["/workspace"] }]);
    expect(panel).toMatchObject({
      body: "Search: App",
      subtitle: "/workspace",
    });
    expect(panel?.items?.[0]).toMatchObject({
      label: "  src/App.tsx",
      path: "/workspace/src/App.tsx",
    });
  });

  it("clears file search by reloading workspace files", () => {
    let reloaded = false;
    const handlers = createFilePanelActionHandlers(
      baseParams({
        readWorkspaceFiles: () => {
          reloaded = true;
        },
      }),
    );

    handlers.clearSearch();

    expect(reloaded).toBe(true);
  });
});
