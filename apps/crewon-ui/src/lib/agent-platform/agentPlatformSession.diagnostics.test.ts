import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentPlatformSession,
  hasAgentPlatformAccountCredentials,
} from "./agentPlatformClient";
import { AgentPlatformAccountRestoration } from "./agentPlatformAccountRestoration";
import {
  AGENT_PLATFORM_LOGIN_DIAGNOSTIC_EVENT,
  type AgentPlatformLoginDiagnostic,
} from "./agentPlatformLoginDiagnostics";
import { isAgentPlatformAuthTransientError } from "./agentPlatformAuthBootstrap";
import {
  completeWeComLogin,
  loginAgentPlatform,
  readAgentPlatformCurrentUser,
  registerAgentPlatform,
} from "./agentPlatformSession";

const USER = {
  id: 7,
  username: "private-username-fixture",
  email: "private-email@example.invalid",
  role: "user",
};
const PASSWORD = "PrivatePasswordFixture1";
const CREDENTIALS = {
  access_token: "private-access-fixture",
  refresh_token: "private-refresh-fixture",
};
const PRIVATE_DETAIL = "private-error-body-fixture";

function storage(): Storage {
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

function capturedDiagnostics(): AgentPlatformLoginDiagnostic[] {
  return vi
    .mocked(console.info)
    .mock.calls.filter(
      ([name]) => name === AGENT_PLATFORM_LOGIN_DIAGNOSTIC_EVENT,
    )
    .map(([, value]) => value as AgentPlatformLoginDiagnostic);
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
  vi.stubEnv("VITE_AGENT_PLATFORM_DEV_USERNAME", "");
  vi.stubEnv("VITE_AGENT_PLATFORM_DEV_PASSWORD", "");
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.spyOn(console, "info").mockImplementation(() => {});
  clearAgentPlatformSession();
});

afterEach(() => {
  clearAgentPlatformSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("password login phase diagnostics preserve account behavior", () => {
  it("distinguishes a first token network failure from a successful manual second login without replaying the POST", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/auth/login")) {
        if (fetchMock.mock.calls.length === 1)
          throw new TypeError(PRIVATE_DETAIL);
        return Response.json(CREDENTIALS);
      }
      return Response.json(USER);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(loginAgentPlatform(USER.username, PASSWORD)).rejects.toThrow(
      "账号服务暂时不可用",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(hasAgentPlatformAccountCredentials()).toBe(false);
    const first = capturedDiagnostics();
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({
      loginAttempt: expect.any(Number),
      stage: "token_request",
      requestAttempt: 1,
      durationMs: expect.any(Number),
      outcome: "network_error",
    });

    await expect(loginAgentPlatform(USER.username, PASSWORD)).resolves.toEqual(
      USER,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const second = capturedDiagnostics().slice(1);
    expect(second.map((event) => event.stage)).toEqual([
      "token_request",
      "token_response_body",
      "current_user",
    ]);
    expect(new Set(second.map((event) => event.loginAttempt)).size).toBe(1);
    expect(second[0]!.loginAttempt).toBeGreaterThan(first[0]!.loginAttempt);
    expect(second.every((event) => event.outcome === "success")).toBe(true);
    expect(second.every((event) => event.httpStatus === 200)).toBe(true);

    const serialized = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const privateValue of [
      USER.username,
      USER.email,
      PASSWORD,
      CREDENTIALS.access_token,
      CREDENTIALS.refresh_token,
      PRIVATE_DETAIL,
      "/auth/login",
      "/auth/me",
      "Bearer",
    ])
      expect(serialized).not.toContain(privateValue);
    for (const event of capturedDiagnostics())
      expect(Object.keys(event).sort()).toEqual(
        [
          "loginAttempt",
          "stage",
          "durationMs",
          "outcome",
          ...(event.requestAttempt === undefined ? [] : ["requestAttempt"]),
          ...(event.httpStatus === undefined ? [] : ["httpStatus"]),
        ].sort(),
      );
  });

  it("records a token HTTP rejection without logging its error body or retrying it", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ detail: PRIVATE_DETAIL }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(loginAgentPlatform(USER.username, PASSWORD)).rejects.toThrow(
      PRIVATE_DETAIL,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedDiagnostics()).toEqual([
      {
        loginAttempt: expect.any(Number),
        stage: "token_request",
        requestAttempt: 1,
        durationMs: expect.any(Number),
        outcome: "http_rejected",
        httpStatus: 401,
      },
      {
        loginAttempt: expect.any(Number),
        stage: "token_response_body",
        durationMs: expect.any(Number),
        outcome: "http_rejected",
        httpStatus: 401,
      },
    ]);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      PRIVATE_DETAIL,
    );
  });

  it("identifies a post-token account confirmation failure and preserves credentials for automatic recovery", async () => {
    vi.useFakeTimers();
    let accountReads = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/auth/login"))
        return Response.json(CREDENTIALS);
      accountReads++;
      return accountReads <= 3
        ? new Response(null, { status: 503 })
        : Response.json(USER);
    });
    vi.stubGlobal("fetch", fetchMock);
    const login = loginAgentPlatform(USER.username, PASSWORD);
    const rejected = expect(login).rejects.toThrow("账号服务暂时不可用");
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(hasAgentPlatformAccountCredentials()).toBe(true);
    const events = capturedDiagnostics();
    expect(events.map((event) => [event.stage, event.outcome])).toEqual([
      ["token_request", "success"],
      ["token_response_body", "success"],
      ["current_user", "http_rejected"],
    ]);
    expect(events[2]).toMatchObject({ httpStatus: 503, durationMs: 500 });

    const restoration = new AgentPlatformAccountRestoration({
      read: (signal) => readAgentPlatformCurrentUser({ signal }),
      hasCredentials: hasAgentPlatformAccountCredentials,
      isTransient: isAgentPlatformAuthTransientError,
      events: new EventTarget(),
    });
    const unsubscribe = restoration.subscribe(() => {});
    await flush();
    expect(restoration.state).toEqual({ status: "authenticated", user: USER });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/auth/login"),
      ),
    ).toHaveLength(1);
    expect(capturedDiagnostics()).toEqual(events);
    unsubscribe();
    await flush();
  });

  it("records a stalled token body as a timeout once and never logs late completion", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { cancel },
      { highWaterMark: 0 },
    );
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    const pending = loginAgentPlatform(USER.username, PASSWORD);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(hasAgentPlatformAccountCredentials()).toBe(false);
    expect(
      capturedDiagnostics().map((event) => [event.stage, event.outcome]),
    ).toEqual([
      ["token_request", "success"],
      ["token_response_body", "timeout"],
    ]);
    expect(capturedDiagnostics()[1]).toMatchObject({
      durationMs: 15_000,
      httpStatus: 200,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capturedDiagnostics()).toHaveLength(2);
  });

  it("a broken diagnostic sink cannot change successful login", async () => {
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error("fixture sink unavailable");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        Response.json(String(url).endsWith("/auth/login") ? CREDENTIALS : USER),
      ),
    );
    await expect(loginAgentPlatform(USER.username, PASSWORD)).resolves.toEqual(
      USER,
    );
  });

  it("does not expand diagnostics to registration or WeCom exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        Response.json(
          String(url).endsWith("/auth/me") ? USER : { ...USER, ...CREDENTIALS },
        ),
      ),
    );
    await registerAgentPlatform({
      username: USER.username,
      email: USER.email,
      password: PASSWORD,
    });
    await completeWeComLogin("private-wecom-ticket-fixture");
    expect(capturedDiagnostics()).toEqual([]);
  });
});
