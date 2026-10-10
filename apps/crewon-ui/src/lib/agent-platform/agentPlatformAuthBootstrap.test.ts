import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE,
  withAgentPlatformAuthBootstrapDeadline,
} from "./agentPlatformAuthBootstrap";

describe("agent-platform auth bootstrap deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a responsive account probe and clears its deadline", async () => {
    vi.useFakeTimers();
    await expect(
      withAgentPlatformAuthBootstrapDeadline(Promise.resolve("ready")),
    ).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a stalled read-only probe so the shell can show the restoration status", async () => {
    vi.useFakeTimers();
    const result = withAgentPlatformAuthBootstrapDeadline(
      new Promise<never>(() => undefined),
    );
    const rejection = expect(result).rejects.toThrow(
      AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE,
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
