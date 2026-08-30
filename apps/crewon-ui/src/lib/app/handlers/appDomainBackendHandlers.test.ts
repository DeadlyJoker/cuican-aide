import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../../app-server/appServer";
import { createAppDomainBackendHandlers } from "./appDomainBackendHandlers";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    name: "Backend thread",
    cwd: "/repo",
    ...overrides,
  } as Thread;
}

describe("app domain backend handlers", () => {
  it("resolves the current cwd without listing backend threads", async () => {
    const handlers = createAppDomainBackendHandlers({
      client: client({
        async listThreads() {
          throw new Error("unexpected list");
        },
      }),
      currentCwd: "/repo/current",
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      platformResourcesEnabled: false,
      selectedThreadId: "thread-1",
      threads: [],
    });

    await expect(handlers.resolveBackendCwd()).resolves.toBe("/repo/current");
  });

  it("falls back to backend thread cwd for placeholder current cwd", async () => {
    const handlers = createAppDomainBackendHandlers({
      client: client({
        async listThreads() {
          return [thread({ cwd: "/repo/from-thread" })];
        },
      }),
      currentCwd: "/Users/me/project",
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      platformResourcesEnabled: false,
      selectedThreadId: "thread-1",
      threads: [],
    });

    await expect(handlers.resolveBackendCwd()).resolves.toBe(
      "/repo/from-thread",
    );
  });

  it("writes knowledge memory with selected backend thread context", async () => {
    const requests: unknown[] = [];
    const handlers = createAppDomainBackendHandlers({
      client: client({
        async writeKnowledgeMemory(params) {
          requests.push(params);
          return {
            data: { memories: [], sources: [] },
            filePath: "/repo/.crewon/knowledge/memory.md",
          };
        },
      }),
      currentCwd: "/repo",
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      platformResourcesEnabled: false,
      selectedThreadId: "thread-1",
      threads: [thread({ name: "Selected work" })],
    });

    await expect(handlers.writeKnowledgeMemory()).resolves.toBe(
      "/repo/.crewon/knowledge/memory.md",
    );
    expect(requests).toEqual([
      {
        cwd: "/repo",
        note: "Backend-connected knowledge memory can be reused by agents, offices, and automations.",
        threadId: "thread-1",
        title: "Selected work",
      },
    ]);
  });

  it("reads agents, tools, and knowledge from the platform without App Server", async () => {
    const handlers = createAppDomainBackendHandlers({
      client: null,
      currentCwd: "/repo",
      isConnected: false,
      isDemoPreview: false,
      locale: "en",
      platformResourceReaders: {
        readAgents: async () => [
          { meta: "online", title: "Research agent" },
        ],
        readKnowledge: async () => ({ memories: [], sources: [] }),
        readTools: async () => [{ meta: "online", title: "Browser" }],
      },
      platformResourcesEnabled: true,
      selectedThreadId: "thread-1",
      threads: [],
    });

    await expect(handlers.loadAgentLibraryItems("/ignored")).resolves.toEqual({
      items: [{ meta: "online", title: "Research agent" }],
    });
    await expect(handlers.loadToolLibraryItems("/ignored")).resolves.toEqual([
      { meta: "online", title: "Browser" },
    ]);
    await expect(handlers.createBackendKnowledgeData()).resolves.toEqual({
      memories: [],
      sources: [],
    });
  });
});
