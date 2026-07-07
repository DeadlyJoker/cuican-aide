import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import {
  automationWorkspaceUnavailableMessage,
  boundThreadWorkspaceUnavailableMessage,
  createBackendWorkspaceAccess,
  isPlaceholderBackendCwd,
  localAppServerUnavailableMessage,
  preferredBackendCwd,
  requireAppServerClient,
  requireBackendWorkspace,
  resolveBackendWorkspace,
  resolvePreferredBackendCwd,
  startBackendDomainThread,
  withBackendWorkspace,
} from "./backendWorkspace";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

describe("backend workspace helpers", () => {
  it("identifies placeholder demo cwd values", () => {
    expect(isPlaceholderBackendCwd("/Users/me/work/crewon")).toBe(true);
    expect(isPlaceholderBackendCwd("/repo")).toBe(false);
    expect(isPlaceholderBackendCwd("")).toBe(false);
    expect(isPlaceholderBackendCwd(null)).toBe(false);
  });

  it("formats local app-server unavailable messages", () => {
    expect(localAppServerUnavailableMessage("en")).toBe(
      "Local app-server is not connected",
    );
    expect(localAppServerUnavailableMessage("zh")).toBe("未连接本地 app-server");
  });

  it("formats backend workspace unavailable messages", () => {
    expect(automationWorkspaceUnavailableMessage("en")).toBe(
      "Creating an automation requires an available backend workspace.",
    );
    expect(automationWorkspaceUnavailableMessage("zh")).toBe(
      "创建自动化需要可用的后端工作区。",
    );
    expect(boundThreadWorkspaceUnavailableMessage("en")).toBe(
      "No backend workspace is available for the bound thread.",
    );
    expect(boundThreadWorkspaceUnavailableMessage("zh")).toBe(
      "缺少后端工作区，无法创建绑定线程。",
    );
  });

  it("requires an app-server client", () => {
    const appClient = client();

    expect(requireAppServerClient(appClient, "en")).toBe(appClient);
    expect(() => requireAppServerClient(null, "en")).toThrow(
      "Local app-server is not connected",
    );
    expect(() => requireAppServerClient(undefined, "zh")).toThrow(
      "未连接本地 app-server",
    );
  });

  it("prefers a real current cwd over backend thread cwd values", () => {
    expect(
      preferredBackendCwd(" /repo/current ", [
        { cwd: "/repo/other" },
      ] as Array<{ cwd: string | null }>),
    ).toBe("/repo/current");
  });

  it("falls back to the first real backend thread cwd", () => {
    expect(
      preferredBackendCwd("/Users/me/work/crewon", [
        { cwd: "/Users/me/demo" },
        { cwd: "/repo/backend" },
      ] as Array<{ cwd: string | null }>),
    ).toBe("/repo/backend");
  });

  it("resolves preferred backend cwd without listing threads when current cwd is real", async () => {
    let listed = false;

    await expect(
      resolvePreferredBackendCwd({
        currentCwd: "/repo/current",
        listThreads: async () => {
          listed = true;
          return [{ cwd: "/repo/other" }];
        },
      }),
    ).resolves.toBe("/repo/current");
    expect(listed).toBe(false);
  });

  it("lists threads when current cwd is missing or placeholder", async () => {
    await expect(
      resolvePreferredBackendCwd({
        currentCwd: "/Users/me/work/crewon",
        listThreads: async () => [
          { cwd: "/Users/me/demo" },
          { cwd: "/repo/from-thread" },
        ],
      }),
    ).resolves.toBe("/repo/from-thread");
  });

  it("resolves a backend workspace when both client and cwd exist", async () => {
    const appClient = client();

    await expect(
      resolveBackendWorkspace(appClient, async () => "/repo"),
    ).resolves.toEqual({
      client: appClient,
      cwd: "/repo",
    });
  });

  it("returns null when client or cwd is unavailable", async () => {
    await expect(
      resolveBackendWorkspace(null, async () => "/repo"),
    ).resolves.toBeNull();
    await expect(
      resolveBackendWorkspace(client(), async () => ""),
    ).resolves.toBeNull();
  });

  it("runs with a backend workspace", async () => {
    await expect(
      withBackendWorkspace({
        client: client(),
        fallback: "fallback",
        resolveBackendCwd: async () => "/repo",
        run: async ({ cwd }) => `cwd:${cwd}`,
      }),
    ).resolves.toBe("cwd:/repo");
  });

  it("returns the fallback when a backend workspace is unavailable", async () => {
    let ran = false;

    await expect(
      withBackendWorkspace({
        client: null,
        fallback: "fallback",
        resolveBackendCwd: async () => "/repo",
        run: async () => {
          ran = true;
          return "ran";
        },
      }),
    ).resolves.toBe("fallback");
    expect(ran).toBe(false);
  });

  it("requires an available backend workspace", async () => {
    const appClient = client();

    await expect(
      requireBackendWorkspace({
        client: appClient,
        errorMessage: "missing workspace",
        resolveBackendCwd: async () => "/repo",
      }),
    ).resolves.toEqual({ client: appClient, cwd: "/repo" });

    await expect(
      requireBackendWorkspace({
        client: null,
        errorMessage: "missing workspace",
        resolveBackendCwd: async () => "/repo",
      }),
    ).rejects.toThrow("missing workspace");
  });

  it("starts a backend domain thread", async () => {
    const started: Array<{ cwd: string | undefined; source: string | undefined }> =
      [];

    const thread = await startBackendDomainThread({
      client: client({
        async startThread(cwd, source) {
          started.push({ cwd, source });
          return { id: "thread-1" } as Awaited<
            ReturnType<AppServerClient["startThread"]>
          >;
        },
      }),
      missingWorkspaceMessage: "missing workspace",
      resolveBackendCwd: async () => "/repo",
      threadSource: "automation",
    });

    expect(started).toEqual([{ cwd: "/repo", source: "automation" }]);
    expect(thread?.id).toBe("thread-1");
  });

  it("returns null when starting a backend domain thread without a client", async () => {
    await expect(
      startBackendDomainThread({
        client: null,
        missingWorkspaceMessage: "missing workspace",
        resolveBackendCwd: async () => "/repo",
        threadSource: "office",
      }),
    ).resolves.toBeNull();
  });

  it("throws when starting a backend domain thread without a workspace", async () => {
    await expect(
      startBackendDomainThread({
        client: client(),
        missingWorkspaceMessage: "missing workspace",
        resolveBackendCwd: async () => "",
        threadSource: "agent",
      }),
    ).rejects.toThrow("missing workspace");
  });

  it("creates app-facing backend workspace accessors", async () => {
    const appClient = client({
      async startThread(cwd, source) {
        return { cwd, id: `thread-${source}` } as Awaited<
          ReturnType<AppServerClient["startThread"]>
        >;
      },
    });
    let currentClient: AppServerClient | null = appClient;
    const access = createBackendWorkspaceAccess({
      getClient: () => currentClient,
      locale: "en",
      resolveBackendCwd: async () => "/repo",
    });

    await expect(access.optionalWorkspace()).resolves.toEqual({
      client: appClient,
      cwd: "/repo",
    });
    await expect(access.requireWorkspace("missing workspace")).resolves.toEqual({
      client: appClient,
      cwd: "/repo",
    });
    await expect(access.startDomainThread("office")).resolves.toMatchObject({
      cwd: "/repo",
      id: "thread-office",
    });

    currentClient = null;
    await expect(access.optionalWorkspace()).resolves.toBeNull();
    await expect(access.requireWorkspace("missing workspace")).rejects.toThrow(
      "missing workspace",
    );
  });

  it("uses localized bound-thread errors from backend workspace accessors", async () => {
    const access = createBackendWorkspaceAccess({
      getClient: () => client(),
      locale: "zh",
      resolveBackendCwd: async () => "",
    });

    await expect(access.startDomainThread("agent")).rejects.toThrow(
      "缺少后端工作区，无法创建绑定线程。",
    );
  });
});
