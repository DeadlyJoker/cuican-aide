import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import { createAppDomainBackendCoordinator } from "./appDomainBackendCoordinator";

describe("app domain backend coordinator", () => {
  it("shares resolved backend cwd across workspace helpers", async () => {
    const startedThreads: Array<{ cwd: string; source: string }> = [];
    const client = {
      async listThreads() {
        return [{ id: "thread-1", cwd: "/repo" }];
      },
      async startThread(cwd: string, source: string) {
        startedThreads.push({ cwd, source });
        return { id: "thread-2", cwd } as Thread;
      },
    } as AppServerClient;

    const coordinator = createAppDomainBackendCoordinator({
      client,
      currentCwd: "",
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      selectedThreadId: null,
      threads: [],
    });

    await expect(coordinator.resolveBackendCwd()).resolves.toBe("/repo");
    await expect(coordinator.optionalBackendWorkspace()).resolves.toEqual({
      client,
      cwd: "/repo",
    });
    await expect(coordinator.startBackendDomainThread("agent")).resolves.toEqual(
      {
        id: "thread-2",
        cwd: "/repo",
      },
    );
    expect(startedThreads).toEqual([{ cwd: "/repo", source: "agent" }]);
  });
});
