import type { Thread } from "@crewon-ui-model/v2/Thread";
import { describe, expect, it, vi } from "vitest";

import {
  establishControlThreadConnection,
  type ControlThreadConnectionStatus,
} from "./useControlThreadRuntime";

describe("Control Thread connection", () => {
  it("keeps pending distinct from unavailable, then retries to connected", async () => {
    const pending = deferred<void>();
    const statuses: ControlThreadConnectionStatus[] = [];
    const thread = { id: "thread-1" } as Thread;
    const runtime = {
      connect: vi
        .fn<() => Promise<void>>()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(undefined),
      listThreads: vi.fn(async () => [thread]),
    };

    const first = establishControlThreadConnection({
      runtime,
      showArchived: false,
      onStatus: (status) => statuses.push(status),
    });
    expect(statuses).toEqual(["connecting"]);

    pending.reject(new Error("Control unavailable"));
    await expect(first).resolves.toBeNull();
    expect(statuses).toEqual(["connecting", "unavailable"]);

    await expect(
      establishControlThreadConnection({
        runtime,
        showArchived: false,
        onStatus: (status) => statuses.push(status),
      }),
    ).resolves.toEqual([thread]);
    expect(statuses).toEqual([
      "connecting",
      "unavailable",
      "connecting",
      "connected",
    ]);
    expect(runtime.connect).toHaveBeenCalledTimes(2);
    expect(runtime.listThreads).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}
