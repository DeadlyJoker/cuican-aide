// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_SESSION_CHANGED_EVENT,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  captureAgentPlatformSession,
  clearAgentPlatformSession,
  storeAgentPlatformSession,
} from "./agentPlatformClient";
import {
  completeWeComLogin,
  loginAgentPlatform,
  logoutAgentPlatform,
  readAgentPlatformCurrentUser,
  registerAgentPlatform,
  setAgentPlatformPassword,
} from "./agentPlatformSession";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function outcome<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

function delayedBody(status = 200, cancellable = false) {
  const body = deferred<unknown>();
  const entered = deferred<void>();
  if (cancellable) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          entered.resolve();
          try {
            const value = await body.promise;
            if (!cancelled) {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(value)),
              );
              controller.close();
            }
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { response: new Response(stream, { status }), body, entered };
  }
  const response = Response.json({}, { status });
  vi.spyOn(response, "json").mockImplementation(() => {
    entered.resolve();
    return body.promise;
  });
  return { response, body, entered };
}

const userA = {
  id: 1,
  username: "account-a",
  email: "a@example.com",
  role: "user",
};
const userB = {
  id: 2,
  username: "account-b",
  email: "b@example.com",
  role: "user",
};
const credentialsA = { access_token: "access-a", refresh_token: "refresh-a" };
const credentialsB = { access_token: "access-b", refresh_token: "refresh-b" };

function expectSessionB() {
  expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
    "access-b",
  );
  expect(localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
    "refresh-b",
  );
}

describe("interactive account session withdrawal", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    clearAgentPlatformSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAgentPlatformSession();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const interactive = [
    {
      name: "password login",
      call: () => loginAgentPlatform("account-a", "PasswordA1"),
      result: credentialsA,
    },
    {
      name: "registration",
      call: () =>
        registerAgentPlatform({
          username: "account-a",
          email: "a@example.com",
          password: "PasswordA1",
        }),
      result: { ...userA, ...credentialsA },
    },
    {
      name: "WeCom exchange",
      call: () => completeWeComLogin("one-time-a"),
      result: credentialsA,
    },
  ];

  for (const operation of interactive) {
    for (const replacement of ["account B", "logout"] as const) {
      it(`a late ${operation.name} body cannot replace ${replacement}`, async () => {
        storeAgentPlatformSession("previous-user", "previous-refresh");
        const previous = captureAgentPlatformSession();
        const delayed = delayedBody();
        let requestSignal: AbortSignal | null | undefined;
        const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
          requestSignal = init?.signal;
          return delayed.response;
        });
        vi.stubGlobal("fetch", fetchMock);

        const pending = operation.call();
        const rejection = outcome(pending);
        let physicallyFinished = false;
        void pending.then(
          () => {
            physicallyFinished = true;
          },
          () => {
            physicallyFinished = true;
          },
        );
        await delayed.entered.promise;
        expect(previous.signal.aborted).toBe(true);
        expect(
          localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY),
        ).toBeNull();
        if (replacement === "account B")
          storeAgentPlatformSession("access-b", "refresh-b");
        else await logoutAgentPlatform();

        expect(requestSignal?.aborted).toBe(true);
        expect(physicallyFinished).toBe(false);
        delayed.body.resolve(operation.result);
        expect(await rejection).toMatchObject({ status: "rejected" });
        if (replacement === "account B") expectSessionB();
        else {
          expect(
            localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY),
          ).toBeNull();
          expect(
            localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY),
          ).toBeNull();
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    }
  }

  it("a late login header response stays physically pending until the actual response arrives", async () => {
    const headers = deferred<Response>();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal;
      return headers.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = loginAgentPlatform("account-a", "PasswordA1");
    const rejection = outcome(pending);
    let finished = false;
    void pending.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );

    storeAgentPlatformSession("access-b", "refresh-b");
    await Promise.resolve();
    expect(requestSignal?.aborted).toBe(true);
    expect(finished).toBe(false);
    headers.resolve(Response.json(credentialsA));
    expect(await rejection).toMatchObject({ status: "rejected" });
    expectSessionB();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a late login network failure cannot retry against account B", async () => {
    const headers = deferred<Response>();
    const fetchMock = vi.fn(() => headers.promise);
    vi.stubGlobal("fetch", fetchMock);
    const pending = loginAgentPlatform("account-a", "PasswordA1");
    const rejection = outcome(pending);
    storeAgentPlatformSession("access-b", "refresh-b");
    headers.reject(new TypeError("supplier disconnected"));
    expect(await rejection).toMatchObject({ status: "rejected" });
    expectSessionB();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("withdrawal cancels the transient login retry delay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = loginAgentPlatform("account-a", "PasswordA1");
    const rejection = outcome(pending);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    storeAgentPlatformSession("access-b", "refresh-b");
    expect(await rejection).toMatchObject({ status: "rejected" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectSessionB();
  });

  it("the later password login completes while the earlier body remains in flight", async () => {
    const delayedA = delayedBody();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/auth/login")) {
        const form = init?.body as URLSearchParams;
        return form.get("username") === "account-a"
          ? delayedA.response
          : Response.json(credentialsB);
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer access-b",
      );
      return Response.json(userB);
    });
    vi.stubGlobal("fetch", fetchMock);
    const a = loginAgentPlatform("account-a", "PasswordA1");
    const rejectedA = outcome(a);
    await delayedA.entered.promise;
    await expect(
      loginAgentPlatform("account-b", "PasswordB1"),
    ).resolves.toEqual(userB);
    delayedA.body.resolve(credentialsA);
    expect(await rejectedA).toMatchObject({ status: "rejected" });
    expectSessionB();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a late current-user body cannot return the previous account", async () => {
    storeAgentPlatformSession("access-a");
    const delayed = delayedBody(200, true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => delayed.response),
    );
    const pending = readAgentPlatformCurrentUser();
    const rejection = outcome(pending);
    await delayed.entered.promise;
    storeAgentPlatformSession("access-b", "refresh-b");
    delayed.body.resolve(userA);
    expect(await rejection).toMatchObject({ status: "rejected" });
    expectSessionB();
  });

  it("a late current-user 401 cannot clear account B", async () => {
    storeAgentPlatformSession("access-a");
    const headers = deferred<Response>();
    const entered = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        entered.resolve();
        return headers.promise;
      }),
    );
    const pending = readAgentPlatformCurrentUser();
    const rejection = outcome(pending);
    await entered.promise;
    storeAgentPlatformSession("access-b", "refresh-b");
    headers.resolve(Response.json({}, { status: 401 }));
    expect(await rejection).toMatchObject({ status: "rejected" });
    expectSessionB();
  });

  for (const action of [
    { name: "current-user read", call: () => readAgentPlatformCurrentUser() },
    {
      name: "password setup",
      call: () => setAgentPlatformPassword("PasswordA1"),
    },
  ]) {
    it(`a delayed ${action.name} error body cannot fall back after withdrawal`, async () => {
      storeAgentPlatformSession("access-a");
      const delayed = delayedBody(400, action.name === "current-user read");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => delayed.response),
      );
      const pending = action.call();
      const rejection = outcome<unknown>(pending);
      await delayed.entered.promise;
      storeAgentPlatformSession("access-b", "refresh-b");
      delayed.body.reject(new SyntaxError("broken old error body"));
      expect(await rejection).toMatchObject({
        status: "rejected",
        error: { message: "agent_platform_session_changed" },
      });
      expectSessionB();
    });
  }

  it("a reentrant session listener cannot make login A capture account B's session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const replaceSession = () => {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        replaceSession,
      );
      storeAgentPlatformSession("access-b", "refresh-b");
    };
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      replaceSession,
    );
    try {
      await expect(
        loginAgentPlatform("account-a", "PasswordA1"),
      ).rejects.toThrow("agent_platform_session_changed");
      expectSessionB();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        replaceSession,
      );
    }
  });

  it("reentrant token publication cannot let login A read account B's user", async () => {
    const fetchMock = vi.fn(async () => Response.json(credentialsA));
    vi.stubGlobal("fetch", fetchMock);
    const replaceA = () => {
      if (localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY) !== "access-a")
        return;
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        replaceA,
      );
      storeAgentPlatformSession("access-b", "refresh-b");
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, replaceA);
    try {
      await expect(
        loginAgentPlatform("account-a", "PasswordA1"),
      ).rejects.toThrow("agent_platform_session_changed");
      expectSessionB();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        replaceA,
      );
    }
  });
});
