import { describe, expect, it, vi } from "vitest";
import { waitForAgentPlatformRequest } from "./agentPlatformRequestWait";

describe("request-owned account token wait", () => {
  it("withdraws one caller while the shared token operation can satisfy another caller", async () => {
    let resolve!: (value: string) => void;
    const shared = new Promise<string>((done) => {
      resolve = done;
    });
    const canceled = new AbortController();
    const remove = vi.spyOn(canceled.signal, "removeEventListener");
    const withdrawn = waitForAgentPlatformRequest({
      pending: shared,
      signal: canceled.signal,
    });
    const rejected = expect(withdrawn).rejects.toThrow("caller deadline");
    const current = waitForAgentPlatformRequest({
      pending: shared,
      signal: new AbortController().signal,
    });
    canceled.abort(new Error("caller deadline"));
    await rejected;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    resolve("same-account-token");
    expect(await current).toBe("same-account-token");
  });

  it("fences a result after cancellation even if the shared operation completes in the same tick", async () => {
    const controller = new AbortController();
    const pending = waitForAgentPlatformRequest({
      pending: Promise.resolve("late"),
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow("stale request");
    controller.abort(new Error("stale request"));
    await rejected;
  });
});
