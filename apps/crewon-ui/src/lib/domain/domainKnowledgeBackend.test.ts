import { describe, expect, it } from "vitest";

import { AppServerRpcError, type AppServerClient } from "../app-server/appServer";
import {
  knowledgeReadUnavailableMessage,
  readBackendKnowledgeData,
  readKnowledgeData,
  writeBackendKnowledgeMemory,
} from "./domainKnowledgeBackend";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

describe("domain knowledge backend", () => {
  it("formats knowledge read unavailable messages", () => {
    expect(knowledgeReadUnavailableMessage("en")).toBe(
      "Local app-server is not connected; unable to read knowledge.",
    );
    expect(knowledgeReadUnavailableMessage("zh")).toBe(
      "未连接本地 app-server，无法读取知识库。",
    );
  });

  it("requires a client before reading backend knowledge data", async () => {
    await expect(
      readBackendKnowledgeData({
        client: null,
        locale: "en",
        resolveBackendCwd: async () => "/repo",
      }),
    ).rejects.toThrow(
      "Local app-server is not connected; unable to read knowledge.",
    );
  });

  it("returns empty knowledge data when no backend workspace is available", async () => {
    let listed = false;

    await expect(
      readBackendKnowledgeData({
        client: client({
          async listKnowledge() {
            listed = true;
            return { data: { memories: [], sources: [] } };
          },
        }),
        locale: "en",
        resolveBackendCwd: async () => "",
      }),
    ).resolves.toEqual({ memories: [], sources: [] });
    expect(listed).toBe(false);
  });

  it("reads and normalizes backend knowledge data", async () => {
    const requestedCwds: string[] = [];

    await expect(
      readBackendKnowledgeData({
        client: client({
          async listKnowledge(cwd) {
            requestedCwds.push(cwd);
          return {
            data: {
              memories: [
                {
                  title: "Memory",
                    preview: "Reusable context",
                    path: "/repo/memory.md",
                  },
                ],
                sources: [
                  {
                    name: "Docs",
                    path: "/repo/docs",
                    status: "indexed",
                  },
                ],
              },
            } as unknown as Awaited<
              ReturnType<AppServerClient["listKnowledge"]>
            >;
          },
        }),
        locale: "en",
        resolveBackendCwd: async () => "/repo",
      }),
    ).resolves.toEqual({
      memories: [
        {
          title: "Memory",
          glyph: "◆",
          accent: "blue",
          kind: "Workspace memory",
          preview: "Reusable context",
          meta: "",
          path: "/repo/memory.md",
          threadId: undefined,
          pinned: false,
        },
      ],
      sources: [
        {
          name: "Docs",
          glyph: "▦",
          accent: "cyan",
          status: "indexed",
          meta: "",
          path: "/repo/docs",
          isDirectory: false,
        },
      ],
    });
    expect(requestedCwds).toEqual(["/repo"]);
  });

  it("wraps unsupported knowledge list errors", async () => {
    await expect(
      readKnowledgeData(
        client({
          async listKnowledge() {
            throw new AppServerRpcError("missing method", -32601);
          },
        }),
        "/repo",
        "en",
      ),
    ).rejects.toThrow(
      "The current app-server does not support knowledge/list. Update the backend before using Knowledge.",
    );
  });

  it("skips backend knowledge memory writes when no backend workspace is available", async () => {
    let wrote = false;

    await expect(
      writeBackendKnowledgeMemory({
        client: client({
          async writeKnowledgeMemory() {
            wrote = true;
            return {
              data: { memories: [], sources: [] },
              filePath: "/repo/.crewon/knowledge/memory.md",
            };
          },
        }),
        locale: "en",
        resolveBackendCwd: async () => "",
        selectedThreadId: "thread-1",
        selectedThreadTitle: "Thread title",
      }),
    ).resolves.toBeNull();
    expect(wrote).toBe(false);
  });

  it("writes backend knowledge memory with selected thread context", async () => {
    const requests: unknown[] = [];

    await expect(
      writeBackendKnowledgeMemory({
        client: client({
          async writeKnowledgeMemory(params) {
            requests.push(params);
            return {
              data: { memories: [], sources: [] },
              filePath: "/repo/.crewon/knowledge/memory.md",
            };
          },
        }),
        locale: "en",
        resolveBackendCwd: async () => "/repo",
        selectedThreadId: "thread-1",
        selectedThreadTitle: "Thread title",
      }),
    ).resolves.toBe("/repo/.crewon/knowledge/memory.md");
    expect(requests).toEqual([
      {
        cwd: "/repo",
        note: "Backend-connected knowledge memory can be reused by agents, offices, and automations.",
        threadId: "thread-1",
        title: "Thread title",
      },
    ]);
  });
});
