// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentPlatformAccessTokenOwner,
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
} from "./agentPlatformAccessTokenOwner";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "./agentPlatformSessionEvents";
import { AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS } from "./agentPlatformTokenTransport";
import { AGENT_PLATFORM_RESPONSE_BODY_MAX_BYTES } from "./agentPlatformResponseBody";
import { waitForAgentPlatformRequest } from "./agentPlatformRequestWait";

type Mode = "refresh" | "sso" | "dev";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function jwt(subject: string, expiresIn = 3600): string {
  return `header.${btoa(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + expiresIn }))}.signature`;
}
function storage(values: Map<string, string>): Storage {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
function fixture(mode: Mode) {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", storage(values));
  const owner = new AgentPlatformAccessTokenOwner({
    baseUrl: () => "/agent-platform-api",
    envValue: (key) =>
      key === "VITE_AGENT_PLATFORM_DEV_USERNAME"
        ? "dev-user"
        : key === "VITE_AGENT_PLATFORM_DEV_PASSWORD"
          ? "dev-password"
          : undefined,
    unifiedSsoEnabled: () => mode === "sso",
    pimToken: () => null,
    unavailableError: (message) => new Error(message),
  });
  if (mode !== "dev")
    owner.store(jwt("A", -1), mode === "refresh" ? "refresh-A" : undefined);
  return { owner, values };
}
function result(mode: Mode, token: string) {
  return mode === "sso"
    ? { access_token: token, expires_in: 3600, user: { id: 1 } }
    : { access_token: token, refresh_token: "rotated-A" };
}
function delayedBody(body: unknown) {
  const reading = deferred<void>();
  const release = deferred<void>();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.resolve();
        await release.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(stream, {
      headers: { "Content-Type": "application/json" },
    }),
    reading,
    release,
  };
}

describe("Agent Platform automatic token ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const mode of ["refresh", "sso", "dev"] as const) {
    it(`${mode} owns a shared fetch deadline and releases only after abort settles`, async () => {
      vi.useFakeTimers();
      const { owner, values } = fixture(mode);
      const previous = owner.capture();
      const persisted = new Map(values);
      const entered = deferred<AbortSignal>();
      const token = jwt("recovered-A");
      let active = 0;
      let highestActive = 0;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          (_url: RequestInfo | URL, init?: RequestInit) => {
            const signal = init!.signal as AbortSignal;
            active++;
            highestActive = Math.max(highestActive, active);
            entered.resolve(signal);
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  active--;
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          },
        )
        .mockImplementationOnce(async () => {
          active++;
          highestActive = Math.max(highestActive, active);
          active--;
          return Response.json(result(mode, token));
        });
      vi.stubGlobal("fetch", fetchMock);
      const consumers = [owner.accessToken(), owner.accessSession()];
      const rejected = consumers.map((consumer) =>
        expect(consumer).rejects.toThrow("账号服务暂时不可用"),
      );
      const signal = await entered.promise;
      await vi.advanceTimersByTimeAsync(
        AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS - 1,
      );
      expect(signal.aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(rejected);
      expect(signal.aborted).toBe(true);
      expect(previous.signal.aborted).toBe(false);
      expect(() => owner.assertCurrent(previous)).not.toThrow();
      expect(values).toEqual(persisted);
      await expect(owner.accessToken()).resolves.toBe(token);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(highestActive).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`${mode} cancels a hung response body at the same total deadline`, async () => {
      vi.useFakeTimers();
      const { owner, values } = fixture(mode);
      const persisted = new Map(values);
      const entered = deferred<AbortSignal>();
      const reading = deferred<void>();
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              reading.resolve();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      );
      const token = jwt("recovered-A");
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            entered.resolve(init!.signal as AbortSignal);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            return response;
          },
        )
        .mockResolvedValueOnce(Response.json(result(mode, token)));
      vi.stubGlobal("fetch", fetchMock);
      const pending = owner.accessToken();
      const rejected = expect(pending).rejects.toThrow("账号服务暂时不可用");
      const signal = await entered.promise;
      await vi.advanceTimersByTimeAsync(2_000);
      await reading.promise;
      await vi.advanceTimersByTimeAsync(
        AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS - 2_001,
      );
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body!.locked).toBe(false);
      expect(values).toEqual(persisted);
      await expect(owner.accessToken()).resolves.toBe(token);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("an abort-ignoring fetch cannot publish late credentials or overlap a retry", async () => {
    vi.useFakeTimers();
    const { owner, values } = fixture("refresh");
    const persisted = new Map(values);
    const entered = deferred<AbortSignal>();
    const fetched = deferred<Response>();
    const recovered = jwt("recovered-A");
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: RequestInfo | URL, init?: RequestInit) => {
        entered.resolve(init!.signal as AbortSignal);
        return fetched.promise;
      })
      .mockResolvedValueOnce(Response.json({ access_token: recovered }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = owner.accessToken();
    const rejected = expect(pending).rejects.toThrow("账号服务暂时不可用");
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(
      AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS,
    );
    await rejected;
    expect(signal.aborted).toBe(true);
    for (let index = 0; index < 5; index++)
      await expect(owner.accessToken()).rejects.toThrow("账号服务暂时不可用");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values).toEqual(persisted);
    const lateBodyCancel = vi.fn();
    fetched.resolve(
      new Response(new ReadableStream({ cancel: lateBodyCancel })),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(lateBodyCancel).toHaveBeenCalledTimes(1);
    expect(values).toEqual(persisted);
    await expect(owner.accessToken()).resolves.toBe(recovered);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a body cancellation still settling retains the physical slot without blocking consumers", async () => {
    vi.useFakeTimers();
    const { owner, values } = fixture("refresh");
    const persisted = new Map(values);
    const reading = deferred<void>();
    const cancelled = deferred<void>();
    const cancellationFinished = deferred<void>();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve();
          },
          cancel() {
            cancelled.resolve();
            return cancellationFinished.promise;
          },
        },
        { highWaterMark: 0 },
      ),
    );
    const recovered = jwt("recovered-A");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(Response.json({ access_token: recovered }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = owner.accessToken();
    const rejected = expect(pending).rejects.toThrow("账号服务暂时不可用");
    await reading.promise;
    await vi.advanceTimersByTimeAsync(
      AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS,
    );
    await rejected;
    await cancelled.promise;
    await expect(owner.accessToken()).rejects.toThrow("账号服务暂时不可用");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values).toEqual(persisted);
    cancellationFinished.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(owner.accessToken()).resolves.toBe(recovered);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a successful token publication clears its transport deadline", async () => {
    vi.useFakeTimers();
    const { owner } = fixture("refresh");
    const expired = owner.capture();
    const token = jwt("fresh-A");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ access_token: token })),
    );
    const accepted = await owner.accessSession();
    expect(accepted.accessToken).toBe(token);
    expect(expired.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(
      AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS,
    );
    expect(accepted.session.signal.aborted).toBe(false);
    await expect(owner.accessToken()).resolves.toBe(token);
  });

  it("one withdrawn consumer cannot abort the shared refresh needed by another consumer", async () => {
    vi.useFakeTimers();
    const { owner } = fixture("refresh");
    const entered = deferred<AbortSignal>();
    const fetched = deferred<Response>();
    const token = jwt("fresh-A");
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      entered.resolve(init!.signal as AbortSignal);
      return fetched.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const consumer = new AbortController();
    const withdrawn = waitForAgentPlatformRequest({
      pending: owner.accessSession(),
      signal: consumer.signal,
    });
    const rejected = expect(withdrawn).rejects.toThrow("request withdrawn");
    const retained = owner.accessSession();
    const physicalSignal = await entered.promise;
    consumer.abort(new Error("request withdrawn"));
    await rejected;
    expect(physicalSignal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetched.resolve(Response.json({ access_token: token }));
    const accepted = await retained;
    expect(accepted.accessToken).toBe(token);
    expect(accepted.session.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("body ownership preserves UTF-8 JSON when code points cross stream chunks", async () => {
    const { owner } = fixture("sso");
    const token = jwt("SSO");
    const body = new TextEncoder().encode(
      JSON.stringify({
        access_token: token,
        expires_in: 3600,
        user: { id: 1, username: "测试用户" },
      }),
    );
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of body) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(owner.accessToken()).resolves.toBe(token);
    expect(owner.bffUser()).toEqual({ id: 1, username: "测试用户" });
    expect(response.body!.locked).toBe(false);
  });

  it("an oversized token body is canceled before it can publish any credential", async () => {
    const { owner, values } = fixture("refresh");
    const persisted = new Map(values);
    const previous = owner.capture();
    const tokenBody = new TextEncoder().encode(
      JSON.stringify({
        access_token: jwt("untrusted-large-A"),
        refresh_token: "untrusted-large-refresh-A",
      }),
    );
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(tokenBody);
          controller.enqueue(
            new Uint8Array(AGENT_PLATFORM_RESPONSE_BODY_MAX_BYTES),
          );
        },
        cancel,
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(owner.accessToken()).rejects.toThrow(
      "agent_platform_response_too_large",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(values).toEqual(persisted);
    expect(previous.signal.aborted).toBe(false);
    expect(() => owner.assertCurrent(previous)).not.toThrow();
  });

  it("a valid token body at the exact byte boundary remains compatible", async () => {
    const { owner } = fixture("refresh");
    const token = jwt("fresh-A");
    const json = JSON.stringify({ access_token: token });
    const body = new TextEncoder().encode(
      json.padEnd(AGENT_PLATFORM_RESPONSE_BODY_MAX_BYTES, " "),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(owner.accessToken()).resolves.toBe(token);
  });

  it("shared transport is reclaimed by its owner after all request consumers withdraw", async () => {
    vi.useFakeTimers();
    const { owner, values } = fixture("refresh");
    const persisted = new Map(values);
    const entered = deferred<AbortSignal>();
    const recovered = jwt("recovered-A");
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: RequestInfo | URL, init?: RequestInit) => {
        const signal = init!.signal as AbortSignal;
        entered.resolve(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      })
      .mockResolvedValueOnce(Response.json({ access_token: recovered }));
    vi.stubGlobal("fetch", fetchMock);
    const controllers = [new AbortController(), new AbortController()];
    const consumers = controllers.map((controller) =>
      waitForAgentPlatformRequest({
        pending: owner.accessSession(),
        signal: controller.signal,
      }),
    );
    const rejected = consumers.map((consumer) =>
      expect(consumer).rejects.toThrow("request withdrawn"),
    );
    const physicalSignal = await entered.promise;
    controllers.forEach((controller) =>
      controller.abort(new Error("request withdrawn")),
    );
    await Promise.all(rejected);
    expect(physicalSignal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(
      AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS,
    );
    expect(physicalSignal.aborted).toBe(true);
    expect(values).toEqual(persisted);
    expect(vi.getTimerCount()).toBe(0);
    await expect(owner.accessToken()).resolves.toBe(recovered);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["refresh", "sso", "dev"] as const)(
    "%s keeps an explicit 401 unauthenticated rather than classifying it as a deadline failure",
    async (mode) => {
      vi.useFakeTimers();
      const { owner } = fixture(mode);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(owner.accessToken()).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(
        AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS,
      );
      await expect(owner.accessToken()).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  for (const mode of ["refresh", "sso", "dev"] as const) {
    for (const phase of ["fetch", "body"] as const) {
      it(`${mode} cannot publish late ${phase} results over an explicit account switch`, async () => {
        const { owner, values } = fixture(mode);
        const entered = deferred<AbortSignal>();
        const fetched = deferred<Response>();
        const body = delayedBody(result(mode, jwt("late-A")));
        const fetchMock = vi.fn(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            entered.resolve(init!.signal as AbortSignal);
            return phase === "fetch" ? fetched.promise : body.response;
          },
        );
        vi.stubGlobal("fetch", fetchMock);
        const pendingA = owner.accessToken();
        const signalA = await entered.promise;
        if (phase === "body") await body.reading.promise;
        const tokenB = jwt("B");
        owner.store(tokenB, "refresh-B");
        expect(signalA.aborted).toBe(true);
        await expect(owner.accessToken()).resolves.toBe(tokenB);
        if (phase === "fetch")
          fetched.resolve(Response.json(result(mode, jwt("late-A"))));
        else body.release.resolve();
        await expect(pendingA).resolves.toBeNull();
        await expect(owner.accessToken()).resolves.toBe(tokenB);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (mode !== "sso") {
          expect(values.get(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(tokenB);
          expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
            "refresh-B",
          );
        }
      });

      it(`${mode} stays logged out after an ignored abort and late ${phase} success`, async () => {
        const { owner, values } = fixture(mode);
        const entered = deferred<AbortSignal>();
        const fetched = deferred<Response>();
        const body = delayedBody(result(mode, jwt("late-A")));
        const fetchMock = vi.fn(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            entered.resolve(init!.signal as AbortSignal);
            return phase === "fetch" ? fetched.promise : body.response;
          },
        );
        vi.stubGlobal("fetch", fetchMock);
        const pending = owner.accessToken();
        const signal = await entered.promise;
        if (phase === "body") await body.reading.promise;
        owner.clear();
        expect(signal.aborted).toBe(true);
        await expect(owner.accessToken()).resolves.toBeNull();
        if (phase === "fetch")
          fetched.resolve(Response.json(result(mode, jwt("late-A"))));
        else body.release.resolve();
        await expect(pending).resolves.toBeNull();
        await expect(owner.accessToken()).resolves.toBeNull();
        expect(values.size).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    }

    for (const outcome of ["401", "exception"] as const) {
      it(`${mode} late ${outcome} cannot clear B or start A's development fallback`, async () => {
        const { owner, values } = fixture(mode);
        const entered = deferred<AbortSignal>();
        const fetched = deferred<Response>();
        const fetchMock = vi.fn(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            entered.resolve(init!.signal as AbortSignal);
            return fetched.promise;
          },
        );
        vi.stubGlobal("fetch", fetchMock);
        const pendingA = owner.accessToken();
        const signalA = await entered.promise;
        const tokenB = jwt("B");
        owner.store(tokenB, "refresh-B");
        expect(signalA.aborted).toBe(true);
        if (outcome === "401")
          fetched.resolve(new Response(null, { status: 401 }));
        else fetched.reject(new Error("late network failure"));
        await expect(pendingA).resolves.toBeNull();
        await expect(owner.accessToken()).resolves.toBe(tokenB);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (mode !== "sso")
          expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
            "refresh-B",
          );
      });
    }

    it(`${mode} late response-body failure cannot affect a replacement account`, async () => {
      const { owner } = fixture(mode);
      const body = delayedBody(result(mode, jwt("late-A")));
      const fetchMock = vi.fn().mockResolvedValue(body.response);
      vi.stubGlobal("fetch", fetchMock);
      const pendingA = owner.accessToken();
      await body.reading.promise;
      const tokenB = jwt("B");
      owner.store(tokenB, "refresh-B");
      body.release.reject(new Error("late response-body failure"));
      await expect(pendingA).resolves.toBeNull();
      await expect(owner.accessToken()).resolves.toBe(tokenB);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("retains one physical slot until an aborted fetch actually completes", async () => {
    const { owner } = fixture("refresh");
    const entered = deferred<void>();
    const fetched = deferred<Response>();
    const freshB = jwt("fresh-B");
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        entered.resolve();
        return fetched.promise;
      })
      .mockResolvedValueOnce(Response.json({ access_token: freshB }));
    vi.stubGlobal("fetch", fetchMock);
    const pendingA = owner.accessToken();
    await entered.promise;
    for (let index = 0; index < 20; index++) {
      owner.store(jwt(`B-${index}`, -1), `refresh-B-${index}`);
      await expect(owner.accessToken()).rejects.toThrow("账号服务暂时不可用");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetched.resolve(Response.json({ access_token: jwt("late-A") }));
    await expect(pendingA).resolves.toBeNull();
    await expect(owner.accessToken()).resolves.toBe(freshB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains the physical slot while an aborted response body is still being read", async () => {
    const { owner } = fixture("refresh");
    const body = delayedBody({ access_token: jwt("late-A") });
    const freshB = jwt("fresh-B");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(body.response)
      .mockResolvedValueOnce(Response.json({ access_token: freshB }));
    vi.stubGlobal("fetch", fetchMock);
    const pendingA = owner.accessToken();
    await body.reading.promise;
    owner.store(jwt("B", -1), "refresh-B");
    await expect(owner.accessToken()).rejects.toThrow("账号服务暂时不可用");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    body.release.resolve();
    await expect(pendingA).resolves.toBeNull();
    await expect(owner.accessToken()).resolves.toBe(freshB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a replacement account blocked by an old transport remains unavailable with its own credentials intact", async () => {
    const { owner, values } = fixture("refresh");
    const entered = deferred<AbortSignal>();
    const fetched = deferred<Response>();
    const expiredB = jwt("B", -1);
    const freshB = jwt("fresh-B");
    let physical = 0;
    let highestPhysical = 0;
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        physical++;
        highestPhysical = Math.max(highestPhysical, physical);
        try {
          const refresh = new URLSearchParams(String(init?.body)).get(
            "refresh_token",
          );
          if (refresh === "refresh-A") {
            entered.resolve(init!.signal as AbortSignal);
            return await fetched.promise;
          }
          expect(refresh).toBe("refresh-B");
          return Response.json({
            access_token: freshB,
            refresh_token: "rotated-B",
          });
        } finally {
          physical--;
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const pendingA = owner.accessSession();
    const rejectedA = expect(pendingA).rejects.toThrow(
      "agent_platform_session_changed",
    );
    const signalA = await entered.promise;
    owner.store(expiredB, "refresh-B");
    const sessionB = owner.capture();
    expect(signalA.aborted).toBe(true);
    for (let index = 0; index < 3; index++) {
      await expect(owner.accessSession()).rejects.toThrow("账号服务暂时不可用");
      expect(values.get(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(expiredB);
      expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
        "refresh-B",
      );
      expect(() => owner.assertCurrent(sessionB)).not.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetched.resolve(
      Response.json({
        access_token: jwt("late-A"),
        refresh_token: "rotated-A",
      }),
    );
    await rejectedA;
    const recoveredB = await owner.accessSession();
    expect(recoveredB.accessToken).toBe(freshB);
    expect(() => owner.assertCurrent(recoveredB.session)).not.toThrow();
    expect(values.get(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(freshB);
    expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "rotated-B",
    );
    expect(highestPhysical).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("explicit login without refresh removes the previous account's refresh credential", () => {
    const { owner, values } = fixture("refresh");
    owner.store(jwt("B"));
    expect(values.has(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it.each(["replacement account", "logout"] as const)(
    "rejected-token refresh body cancellation reports the account fence after %s",
    async (boundary) => {
      const { owner, values } = fixture("refresh");
      const tokenA = jwt("A");
      owner.store(tokenA, "refresh-A");
      const body = delayedBody({
        access_token: jwt("fresh-A"),
        refresh_token: "rotated-A",
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(body.response));
      const pending = owner.retryRejectedToken(owner.capture(), tokenA);
      const rejected = expect(pending).rejects.toThrow(
        "agent_platform_session_changed",
      );
      await body.reading.promise;
      const tokenB = jwt("B");
      if (boundary === "replacement account") owner.store(tokenB, "refresh-B");
      else owner.clear();
      body.release.resolve();
      await rejected;
      if (boundary === "replacement account") {
        expect(values.get(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(tokenB);
        expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
          "refresh-B",
        );
      } else expect(values.size).toBe(0);
    },
  );

  it("rejected-token refresh retains the exact transport failure while its account is current", async () => {
    const { owner, values } = fixture("refresh");
    const tokenA = jwt("A");
    owner.store(tokenA, "refresh-A");
    const session = owner.capture();
    const failure = new TypeError("named current-account network failure");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    await expect(owner.retryRejectedToken(session, tokenA)).rejects.toBe(
      failure,
    );
    expect(() => owner.assertCurrent(session)).not.toThrow();
    expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "refresh-A",
    );
  });

  it("rejected-token refresh retains a current-account deadline as a transient failure", async () => {
    vi.useFakeTimers();
    const { owner, values } = fixture("refresh");
    const tokenA = jwt("A");
    owner.store(tokenA, "refresh-A");
    const session = owner.capture();
    const entered = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init!.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            entered.resolve();
          }),
      ),
    );
    const rejected = expect(
      owner.retryRejectedToken(session, tokenA),
    ).rejects.toThrow("账号服务暂时不可用");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(
      AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS,
    );
    await rejected;
    expect(() => owner.assertCurrent(session)).not.toThrow();
    expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "refresh-A",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("failed storage methods cannot replace explicit memory credentials or resurrect cleared ones", async () => {
    const values = new Map<string, string>([
      [AGENT_PLATFORM_TOKEN_STORAGE_KEY, "persisted-opaque-A"],
      [AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY, "persisted-refresh-A"],
    ]);
    const persisted = storage(values);
    const getItem = vi.fn(persisted.getItem);
    vi.stubGlobal("localStorage", {
      ...persisted,
      getItem,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("storage denied");
      },
    });
    const owner = new AgentPlatformAccessTokenOwner({
      baseUrl: () => "/agent-platform-api",
      envValue: () => undefined,
      unifiedSsoEnabled: () => false,
      pimToken: () => null,
      unavailableError: (message) => new Error(message),
    });
    await expect(owner.accessToken()).resolves.toBe("persisted-opaque-A");
    expect(() => owner.store("memory-opaque-B")).not.toThrow();
    await expect(owner.accessToken()).resolves.toBe("memory-opaque-B");
    await expect(
      owner.retryRejectedToken(owner.capture(), "memory-opaque-B"),
    ).resolves.toBeNull();
    const previous = owner.capture();
    expect(() => owner.clear()).not.toThrow();
    expect(previous.signal.aborted).toBe(true);
    await expect(owner.accessToken()).resolves.toBeNull();
    expect(values.get(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
      "persisted-opaque-A",
    );
    expect(getItem).toHaveBeenCalledTimes(2);
  });

  it("a throwing storage getter does not block explicit opaque login or synchronous withdrawal", async () => {
    const { owner } = fixture("refresh");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage getter denied");
      },
    });
    expect(() => owner.store("memory-opaque-B")).not.toThrow();
    await expect(owner.accessToken()).resolves.toBe("memory-opaque-B");
    const previous = owner.capture();
    expect(() => owner.clear()).not.toThrow();
    expect(previous.signal.aborted).toBe(true);
    await expect(owner.accessToken()).resolves.toBeNull();
  });

  it("normal refresh preserves an unrotated refresh credential and returns the new atomic epoch", async () => {
    const { owner, values } = fixture("refresh");
    const previous = owner.capture();
    const refreshed = jwt("fresh-A");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ access_token: refreshed })),
    );
    const access = await owner.accessSession();
    expect(access.accessToken).toBe(refreshed);
    expect(previous.signal.aborted).toBe(true);
    expect(access.session.signal.aborted).toBe(false);
    expect(access.session.generation).toBeGreaterThan(previous.generation);
    expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "refresh-A",
    );
    expect(() => owner.assertCurrent(access.session)).not.toThrow();
  });

  it.each([429, 500, 502, 503, 504])(
    "a transient refresh failure (%i) retains credentials for an authenticated retry",
    async (status) => {
      const { owner, values } = fixture("refresh");
      const previous = owner.capture();
      const persisted = new Map(values);
      const refreshed = jwt("fresh-A");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(Response.json({ access_token: refreshed }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(owner.accessToken()).rejects.toThrow("账号服务暂时不可用");
      expect(values).toEqual(persisted);
      expect(previous.signal.aborted).toBe(false);
      expect(() => owner.assertCurrent(previous)).not.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(owner.accessToken()).resolves.toBe(refreshed);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.every(([url]) => url.endsWith("/auth/refresh")),
      ).toBe(true);
      expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
        "refresh-A",
      );
    },
  );

  it("an invalid current refresh withdraws the account without falling back to a development login", async () => {
    const { owner, values } = fixture("refresh");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(owner.accessToken()).resolves.toBeNull();
    await expect(owner.accessToken()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values.size).toBe(0);
  });

  it("unchanged SSO credentials and user contents do not notify or replace the account epoch", async () => {
    const { owner } = fixture("sso");
    const token = jwt("SSO");
    const events = vi.fn();
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, events);
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            access_token: token,
            expires_in: 0,
            user: { id: 1, username: "a" },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            access_token: token,
            expires_in: 0,
            user: { username: "a", id: 1 },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const first = await owner.accessSession();
      const second = await owner.accessSession();
      expect(second.session.generation).toBe(first.session.generation);
      expect(first.session.signal.aborted).toBe(false);
      expect(events).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, events);
    }
  });

  it("a changed SSO user withdraws old scopes even when the opaque token is unchanged", async () => {
    const { owner } = fixture("sso");
    const token = jwt("SSO");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            access_token: token,
            expires_in: 0,
            user: { id: 1 },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            access_token: token,
            expires_in: 3600,
            user: { id: 2 },
          }),
        ),
    );
    const first = await owner.accessSession();
    const second = await owner.accessSession();
    expect(first.session.signal.aborted).toBe(true);
    expect(second.session.generation).toBeGreaterThan(first.session.generation);
    expect(owner.bffUser()).toEqual({ id: 2 });
  });

  it("a zero-expiry SSO publication exposes its exact accepted pair during the session event", async () => {
    const { owner } = fixture("sso");
    const token = jwt("SSO");
    let observed: ReturnType<
      AgentPlatformAccessTokenOwner["accessSession"]
    > | null = null;
    const reload = () => {
      observed = owner.accessSession();
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, reload);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ access_token: token, expires_in: 0, user: { id: 1 } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const accepted = await owner.accessSession();
      expect(observed).not.toBeNull();
      const reloaded = await observed!;
      expect(reloaded.accessToken).toBe(token);
      expect(reloaded.session.generation).toBe(accepted.session.generation);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, reload);
    }
  });

  it("a reentrant account switch cannot pair an automatic A token with B's snapshot", async () => {
    const { owner } = fixture("refresh");
    const tokenB = jwt("B");
    const switchAccount = () => {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        switchAccount,
      );
      owner.store(tokenB);
    };
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      switchAccount,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ access_token: jwt("fresh-A") })),
    );
    try {
      await expect(owner.accessSession()).rejects.toThrow(
        "agent_platform_session_changed",
      );
      await expect(owner.accessToken()).resolves.toBe(tokenB);
    } finally {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        switchAccount,
      );
    }
  });
});
