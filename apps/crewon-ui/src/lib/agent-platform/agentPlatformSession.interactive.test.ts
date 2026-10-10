// @ts-expect-error Vitest exercises actual Node HTTP sockets; the browser bundle excludes Node types.
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  captureAgentPlatformSession,
  clearAgentPlatformSession,
  hasAgentPlatformAccountCredentials,
  storeAgentPlatformSession,
} from "./agentPlatformClient";
import {
  completeWeComLogin,
  loginAgentPlatform,
  logoutAgentPlatform,
  readAgentPlatformCurrentUser,
  registerAgentPlatform,
} from "./agentPlatformSession";
import { AGENT_PLATFORM_INTERACTIVE_REQUEST_TIMEOUT_MS } from "./agentPlatformInteractiveRequest";

type LocalHttpFixtureServer = {
  address(): { port: number } | string | null;
  close(listener: () => void): void;
  closeAllConnections(): void;
  listen(port: number, host: string, listener: () => void): void;
};
type LocalHttpFixtureRequest = { resume(): void };
type LocalHttpFixtureResponse = {
  on(name: "close", listener: () => void): void;
  writeHead(status: number, headers: Record<string, string>): void;
  write(body: string): void;
};

const USER = {
  id: 7,
  username: "fixture-user",
  email: "fixture@example.invalid",
  role: "user",
};
const CREDENTIALS = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
};
function memoryStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
const OPERATIONS = [
  {
    name: "password login",
    call: () => loginAgentPlatform("fixture-user", "FixturePassword1"),
  },
  {
    name: "registration",
    call: () =>
      registerAgentPlatform({
        username: "fixture-user",
        email: "fixture@example.invalid",
        password: "FixturePassword1",
      }),
  },
  {
    name: "WeCom exchange",
    call: () => completeWeComLogin("fixture-one-time-ticket"),
  },
] as const;

beforeEach(() => {
  vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
  vi.stubEnv("VITE_AGENT_PLATFORM_DEV_USERNAME", "");
  vi.stubEnv("VITE_AGENT_PLATFORM_DEV_PASSWORD", "");
  vi.stubGlobal("localStorage", memoryStorage().storage);
  vi.stubGlobal("sessionStorage", memoryStorage().storage);
  clearAgentPlatformSession();
});
afterEach(() => {
  clearAgentPlatformSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("interactive account request and JSON ownership", () => {
  for (const operation of OPERATIONS) {
    it(`${operation.name} aborts its actual stalled POST once and does not resend it`, async () => {
      vi.useFakeTimers();
      let requestSignal: AbortSignal | null | undefined;
      const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal!.addEventListener(
            "abort",
            () => reject(requestSignal!.reason),
            { once: true },
          );
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const pending = operation.call();
      const rejected = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await vi.advanceTimersByTimeAsync(
        AGENT_PLATFORM_INTERACTIVE_REQUEST_TIMEOUT_MS - 1,
      );
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(requestSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(hasAgentPlatformAccountCredentials()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    for (const status of [200, 422]) {
      it(`${operation.name} cancels a stalled ${status} JSON body without publishing or resending`, async () => {
        vi.useFakeTimers();
        const entered = deferred<void>();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>(
          {
            pull() {
              entered.resolve();
            },
            cancel,
          },
          { highWaterMark: 0 },
        );
        const fetchMock = vi.fn(async () => new Response(body, { status }));
        vi.stubGlobal("fetch", fetchMock);
        const pending = operation.call();
        const rejected = expect(pending).rejects.toMatchObject({
          name: "TimeoutError",
        });
        await entered.promise;
        expect(body.locked).toBe(true);
        await vi.advanceTimersByTimeAsync(
          AGENT_PLATFORM_INTERACTIVE_REQUEST_TIMEOUT_MS,
        );
        await rejected;
        await flush();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(hasAgentPlatformAccountCredentials()).toBe(false);
      });
    }
  }

  it("an uncertain login connection failure never resends the POST", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("fixture connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(OPERATIONS[0].call()).rejects.toThrow("账号服务暂时不可用");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 422])(
    "keeps a confirmed login %i response detail and does not retry it",
    async (status) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ detail: `fixture-rejection-${status}` }, { status }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(OPERATIONS[0].call()).rejects.toThrow(
        `fixture-rejection-${status}`,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("registration does not retry a confirmed temporary failure", async () => {
    const fetchMock = vi.fn(async () => Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(OPERATIONS[1].call()).rejects.toThrow("账号服务暂时不可用");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("token POST/body and the new account verification have independent deadlines", async () => {
    vi.useFakeTimers();
    const credentials = deferred<Response>();
    let accountSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/auth/login")) return credentials.promise;
      accountSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        accountSignal!.addEventListener(
          "abort",
          () => reject(accountSignal!.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = OPERATIONS[0].call();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(14_000);
    credentials.resolve(Response.json(CREDENTIALS));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasAgentPlatformAccountCredentials()).toBe(true);
    const accepted = captureAgentPlatformSession();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(accountSignal?.aborted).toBe(false);
    expect(accepted.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(accountSignal?.aborted).toBe(true);
    expect(accepted.signal.aborted).toBe(false);
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      CREDENTIALS.access_token,
    );
    expect(localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      CREDENTIALS.refresh_token,
    );
    fetchMock.mockResolvedValueOnce(Response.json(USER));
    await expect(readAgentPlatformCurrentUser()).resolves.toEqual(USER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a token body that settles after the deadline cannot publish over a later account", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const cancellation = deferred<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          entered.resolve();
        },
        cancel() {
          return cancellation.promise;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    const pending = OPERATIONS[0].call();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(
      AGENT_PLATFORM_INTERACTIVE_REQUEST_TIMEOUT_MS,
    );
    await rejected;
    storeAgentPlatformSession("fixture-account-B", "fixture-refresh-B");
    cancellation.resolve();
    await flush();
    expect(localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      "fixture-account-B",
    );
    expect(localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "fixture-refresh-B",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});

describe("memory credentials still require authenticated verification", () => {
  for (const failure of ["setItem", "getter"] as const) {
    it(`login verifies its accepted memory token after a storage ${failure} failure`, async () => {
      const { storage } = memoryStorage();
      if (failure === "setItem") {
        storage.setItem = () => {
          throw new Error("fixture persistence denied");
        };
        vi.stubGlobal("localStorage", storage);
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          get: () => {
            throw new Error("fixture storage denied");
          },
        });
      }
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith("/auth/login"))
          return Response.json(CREDENTIALS);
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${CREDENTIALS.access_token}`,
        );
        return Response.json(USER);
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(OPERATIONS[0].call()).resolves.toEqual(USER);
      expect(hasAgentPlatformAccountCredentials()).toBe(true);
      await expect(readAgentPlatformCurrentUser()).resolves.toEqual(USER);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await logoutAgentPlatform();
      expect(hasAgentPlatformAccountCredentials()).toBe(false);
      await expect(readAgentPlatformCurrentUser()).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  }

  it("logout ignores persisted remnants when credential removal fails", async () => {
    const { storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storeAgentPlatformSession("fixture-old-token", "fixture-old-refresh");
    storage.removeItem = () => {
      throw new Error("fixture removal denied");
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await logoutAgentPlatform();
    expect(storage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      "fixture-old-token",
    );
    expect(hasAgentPlatformAccountCredentials()).toBe(false);
    await expect(readAgentPlatformCurrentUser()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("interactive session against actual local HTTP sockets", () => {
  let server: LocalHttpFixtureServer | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  for (const phase of ["headers", "body"] as const) {
    it(`registration deadline closes a real stalled ${phase} socket without resending`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const entered = deferred<void>();
      const closed = deferred<void>();
      const headers = deferred<Response>();
      let requests = 0;
      server = createServer(
        (
          request: LocalHttpFixtureRequest,
          response: LocalHttpFixtureResponse,
        ) => {
          requests++;
          request.resume();
          response.on("close", () => closed.resolve());
          if (phase === "body") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.write('{"access_token":"fixture-incomplete');
          }
          entered.resolve();
        },
      );
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const address = server!.address();
      if (!address || typeof address === "string")
        throw new Error("fixture_http_address_missing");
      vi.stubEnv(
        "VITE_AGENT_PLATFORM_BASE_URL",
        `http://127.0.0.1:${address.port}`,
      );
      const nativeFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await nativeFetch(input, init);
          headers.resolve(response);
          return response;
        },
      );
      const pending = OPERATIONS[1].call();
      const rejected = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await entered.promise;
      let response: Response | undefined;
      if (phase === "body") {
        response = await headers.promise;
        await flush();
        expect(response.body?.locked).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(
        AGENT_PLATFORM_INTERACTIVE_REQUEST_TIMEOUT_MS,
      );
      await rejected;
      await closed.promise;
      await flush();
      expect(requests).toBe(1);
      expect(hasAgentPlatformAccountCredentials()).toBe(false);
      if (response) expect(response.body?.locked).toBe(false);
    });
  }
});
