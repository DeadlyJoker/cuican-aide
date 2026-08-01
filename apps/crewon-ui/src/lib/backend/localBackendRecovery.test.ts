import { describe, expect, it, vi } from "vitest";

import { requestLocalAppServerRestart } from "./localBackendRecovery";

describe("local backend recovery", () => {
  it("requests the supervised local app-server restart endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }));

    await expect(
      requestLocalAppServerRestart({ fetchImpl, hostname: "127.0.0.1" }),
    ).resolves.toBe("requested");
    expect(fetchImpl).toHaveBeenCalledWith("/__crewon/dev/restart-app-server", {
      headers: {
        "x-crewon-recovery-request": "office-catalog",
      },
      method: "POST",
    });
  });

  it("does not expose process recovery to non-local web hosts", async () => {
    const fetchImpl = vi.fn();

    await expect(
      requestLocalAppServerRestart({ fetchImpl, hostname: "crewon.example" }),
    ).resolves.toBe("unsupported");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("distinguishes unsupported and failed recovery endpoints", async () => {
    await expect(
      requestLocalAppServerRestart({
        fetchImpl: vi
          .fn()
          .mockResolvedValue(new Response(null, { status: 404 })),
        hostname: "localhost",
      }),
    ).resolves.toBe("unsupported");
    await expect(
      requestLocalAppServerRestart({
        fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
        hostname: "localhost",
      }),
    ).resolves.toBe("failed");
  });
});
