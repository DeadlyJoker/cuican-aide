import { describe, expect, it } from "vitest";

import { AppServerRpcError } from "./appServer";
import { listAppsForThreadOrGlobal } from "./appServerRequests";

describe("app server request helpers", () => {
  it("lists apps for the provided thread", async () => {
    const calls: Array<string | undefined> = [];
    const response = { data: [], nextCursor: null };
    const client = {
      async listApps(threadId?: string) {
        calls.push(threadId);
        return response;
      },
    };

    await expect(listAppsForThreadOrGlobal(client, "thread-1")).resolves.toBe(
      response,
    );
    expect(calls).toEqual(["thread-1"]);
  });

  it("falls back to global apps when the thread is missing", async () => {
    const calls: Array<string | undefined> = [];
    const response = { data: [], nextCursor: null };
    const client = {
      async listApps(threadId?: string) {
        calls.push(threadId);
        if (threadId) {
          throw new AppServerRpcError("thread not found", -32000);
        }
        return response;
      },
    };

    await expect(listAppsForThreadOrGlobal(client, "thread-1")).resolves.toBe(
      response,
    );
    expect(calls).toEqual(["thread-1", undefined]);
  });

  it("rethrows non-missing-thread errors", async () => {
    const error = new Error("network offline");
    const client = {
      async listApps() {
        throw error;
      },
    };

    await expect(listAppsForThreadOrGlobal(client, "thread-1")).rejects.toBe(
      error,
    );
  });

  it("preserves optional client behavior", async () => {
    await expect(
      listAppsForThreadOrGlobal(null, "thread-1"),
    ).resolves.toBeUndefined();
  });
});
