import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPlatformAccountRestoration,
  type AgentPlatformAccountState,
} from "./agentPlatformAccountRestoration";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "./agentPlatformSessionEvents";
import { isAgentPlatformAuthTransientError } from "./agentPlatformAuthBootstrap";
import type { AgentPlatformUser } from "./agentPlatformSession";

const USER_A: AgentPlatformUser = {
  id: 1,
  username: "A",
  email: "a@example.invalid",
  role: "user",
};
const USER_B: AgentPlatformUser = {
  id: 2,
  username: "B",
  email: "b@example.invalid",
  role: "admin",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function fixture() {
  const events = new EventTarget();
  const read =
    vi.fn<(signal: AbortSignal) => Promise<AgentPlatformUser | null>>();
  const owner = new AgentPlatformAccountRestoration({
    read,
    hasCredentials: () => true,
    isTransient: isAgentPlatformAuthTransientError,
    events,
  });
  const states: AgentPlatformAccountState[] = [];
  const listen = (state: AgentPlatformAccountState) => states.push(state);
  return { events, read, owner, states, listen };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("account restoration request owner", () => {
  it("shares one StrictMode initial read and cancels its physical request on final unmount", async () => {
    const { owner, read, listen, events } = fixture();
    read.mockImplementation(
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const firstRelease = owner.subscribe(listen);
    firstRelease();
    const finalRelease = owner.subscribe(listen);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    const signal = read.mock.calls[0]![0];
    expect(signal.aborted).toBe(false);
    finalRelease();
    await flush();
    expect(signal.aborted).toBe(true);
    events.dispatchEvent(new Event("online"));
    events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a later subscription must revalidate rather than reuse a detached authenticated user", async () => {
    const { owner, read, listen } = fixture();
    read.mockResolvedValueOnce(USER_A).mockResolvedValueOnce(null);
    const release = owner.subscribe(listen);
    await flush();
    expect(owner.state.status).toBe("authenticated");
    release();
    await flush();
    const releaseAgain = owner.subscribe(listen);
    expect(owner.state.status).toBe("restoring");
    await flush();
    expect(owner.state).toEqual({ status: "anonymous", error: null });
    expect(read).toHaveBeenCalledTimes(2);
    releaseAgain();
    await flush();
  });

  it("automatically restores preserved credentials after a transient failure with no additional login", async () => {
    const { owner, read, listen } = fixture();
    read
      .mockRejectedValueOnce(new TypeError("network failed"))
      .mockResolvedValueOnce(USER_A);
    const release = owner.subscribe(listen);
    await flush();
    expect(owner.state).toEqual({ status: "restoring", unavailable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(owner.state).toEqual({ status: "authenticated", user: USER_A });
    expect(read).toHaveBeenCalledTimes(2);
    release();
    await flush();
  });

  it("online and focus bypass backoff without duplicating the active request", async () => {
    const { owner, read, listen, events } = fixture();
    const next = deferred<AgentPlatformUser | null>();
    read
      .mockRejectedValueOnce(new TypeError("network failed"))
      .mockReturnValueOnce(next.promise);
    const release = owner.subscribe(listen);
    await flush();
    events.dispatchEvent(new Event("online"));
    events.dispatchEvent(new Event("focus"));
    expect(read).toHaveBeenCalledTimes(2);
    next.resolve(USER_A);
    await flush();
    expect(owner.state.status).toBe("authenticated");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    release();
    await flush();
  });

  it("aborts a stalled request after the deadline and retries only after it ends", async () => {
    const { owner, read, listen } = fixture();
    read
      .mockImplementationOnce(
        (signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      )
      .mockResolvedValueOnce(USER_A);
    const release = owner.subscribe(listen);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(owner.state).toEqual({ status: "restoring", unavailable: true });
    expect(read.mock.calls[0]![0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read.mock.calls[0]![0].aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(owner.state).toEqual({ status: "authenticated", user: USER_A });
    release();
    await flush();
  });

  it("does not free the physical slot when transport ignores abort", async () => {
    const { owner, read, listen, events } = fixture();
    const hung = deferred<AgentPlatformUser | null>();
    read.mockReturnValueOnce(hung.promise).mockResolvedValueOnce(USER_B);
    const release = owner.subscribe(listen);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    events.dispatchEvent(new Event("online"));
    expect(read).toHaveBeenCalledTimes(1);
    hung.resolve(USER_A);
    await flush();
    expect(owner.state.status).toBe("restoring");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(owner.state).toEqual({ status: "authenticated", user: USER_B });
    release();
    await flush();
  });

  it("account changes withdraw the old user immediately and fence late results", async () => {
    const { owner, read, listen, events } = fixture();
    const late = deferred<AgentPlatformUser | null>();
    read
      .mockResolvedValueOnce(USER_A)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(USER_B);
    const release = owner.subscribe(listen);
    await flush();
    expect(owner.state.status).toBe("authenticated");
    events.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    expect(owner.state.status).toBe("restoring");
    events.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    late.resolve(USER_A);
    await flush();
    expect(owner.state).toEqual({ status: "authenticated", user: USER_B });
    expect(read).toHaveBeenCalledTimes(3);
    release();
    await flush();
  });

  it("explicit login and logout supersede a late automatic account read", async () => {
    const { owner, read, listen, events } = fixture();
    const late = deferred<AgentPlatformUser | null>();
    read.mockReturnValue(late.promise);
    const release = owner.subscribe(listen);
    await flush();
    owner.suspend();
    events.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    owner.accept(USER_B);
    late.resolve(USER_A);
    await flush();
    expect(owner.state).toEqual({ status: "authenticated", user: USER_B });
    owner.suspend();
    owner.accept(null);
    events.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.state).toEqual({ status: "anonymous", error: null });
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });

  it("a confirmed anonymous session never receives an automatic login or retry", async () => {
    const { owner, read, listen, events } = fixture();
    read.mockResolvedValue(null);
    const release = owner.subscribe(listen);
    await flush();
    events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.state).toEqual({ status: "anonymous", error: null });
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });
});
