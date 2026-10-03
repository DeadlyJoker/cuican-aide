// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentPlatformSession,
  storeAgentPlatformSession,
} from "../agent-platform/agentPlatformClient";
import {
  PRINCIPAL_SESSION_SUBPROTOCOL,
  createPrincipalSessionProtocols,
} from "./principalSession";

const SERVER = "wss://crewon.example/app-server";
const BOOTSTRAP_A = { token: "bootstrap-a", expiresAt: 1_900_000_000 };
const BOOTSTRAP_B = { token: "bootstrap-b", expiresAt: 1_900_000_000 };
const SESSION_A = { token: "principal-a", expiresAt: 1_900_000_300 };
const SESSION_B = { token: "principal-b", expiresAt: 1_900_000_300 };

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

function delayedResponse(phase: "headers" | "body") {
  const entered = deferred<void>();
  const headers = deferred<Response>();
  const body = deferred<unknown>();
  const response = Response.json({});
  vi.spyOn(response, "json").mockImplementation(() => {
    entered.resolve();
    return body.promise;
  });
  return {
    entered,
    fetchResponse: () => {
      if (phase === "headers") {
        entered.resolve();
        return headers.promise;
      }
      return Promise.resolve(response);
    },
    deliver: (value: unknown) => {
      if (phase === "headers") headers.resolve(Response.json(value));
      else body.resolve(value);
    },
  };
}

function replaceSession(replacement: "account B" | "logout") {
  if (replacement === "account B")
    storeAgentPlatformSession("access-b", "refresh-b");
  else clearAgentPlatformSession();
}

describe("principal protocol account lifetime", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    clearAgentPlatformSession();
    storeAgentPlatformSession("access-a", "refresh-a");
  });

  afterEach(() => {
    clearAgentPlatformSession();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const phase of ["headers", "body"] as const) {
    for (const replacement of ["account B", "logout"] as const) {
      it(`a late bootstrap ${phase} after ${replacement} cannot send an exchange`, async () => {
        const delayed = delayedResponse(phase);
        let signal: AbortSignal | null | undefined;
        const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
          signal = init?.signal;
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer access-a",
          );
          return delayed.fetchResponse();
        });
        const pending = createPrincipalSessionProtocols(SERVER, { fetchImpl });
        const rejection = outcome(pending);
        await delayed.entered.promise;
        replaceSession(replacement);
        expect(signal?.aborted).toBe(true);
        delayed.deliver(BOOTSTRAP_A);
        expect(await rejection).toMatchObject({ status: "rejected" });
        expect(fetchImpl).toHaveBeenCalledOnce();
      });

      it(`a late exchange ${phase} after ${replacement} cannot publish WebSocket protocols`, async () => {
        const delayed = delayedResponse(phase);
        let exchangeSignal: AbortSignal | null | undefined;
        const fetchImpl = vi.fn<typeof fetch>((url, init) => {
          if (String(url).endsWith("principal-bootstrap:issue"))
            return Promise.resolve(Response.json(BOOTSTRAP_A));
          exchangeSignal = init?.signal;
          expect(init?.body).toBe(
            JSON.stringify({ bootstrapToken: BOOTSTRAP_A.token }),
          );
          return delayed.fetchResponse();
        });
        const pending = createPrincipalSessionProtocols(SERVER, { fetchImpl });
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
        await delayed.entered.promise;
        replaceSession(replacement);
        expect(exchangeSignal?.aborted).toBe(true);
        expect(finished).toBe(false);
        delayed.deliver(SESSION_A);
        expect(await rejection).toMatchObject({ status: "rejected" });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });
    }
  }

  it("the latest B session completes its actual bootstrap and exchange while A's body remains pending", async () => {
    const delayedA = delayedResponse("body");
    const fetchImpl = vi.fn<typeof fetch>((url, init) => {
      if (String(url).endsWith("principal-bootstrap:issue")) {
        const authorization = new Headers(init?.headers).get("authorization");
        return Promise.resolve(
          Response.json(
            authorization === "Bearer access-a" ? BOOTSTRAP_A : BOOTSTRAP_B,
          ),
        );
      }
      if (init?.body === JSON.stringify({ bootstrapToken: BOOTSTRAP_A.token }))
        return delayedA.fetchResponse();
      expect(init?.body).toBe(
        JSON.stringify({ bootstrapToken: BOOTSTRAP_B.token }),
      );
      return Promise.resolve(Response.json(SESSION_B));
    });
    const a = createPrincipalSessionProtocols(SERVER, { fetchImpl });
    const rejectedA = outcome(a);
    await delayedA.entered.promise;
    storeAgentPlatformSession("access-b", "refresh-b");
    await expect(
      createPrincipalSessionProtocols(SERVER, { fetchImpl }),
    ).resolves.toEqual([PRINCIPAL_SESSION_SUBPROTOCOL, SESSION_B.token]);
    delayedA.deliver(SESSION_A);
    expect(await rejectedA).toMatchObject({ status: "rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(
      new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer access-b");
  });

  it("withdrawal cancels the actual bootstrap fetch through its request signal", async () => {
    const entered = deferred<void>();
    let signal: AbortSignal | null | undefined;
    let physicallyAborted = false;
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            physicallyAborted = true;
            reject(new DOMException("request aborted", "AbortError"));
          },
          { once: true },
        );
        entered.resolve();
      });
    });
    const pending = createPrincipalSessionProtocols(SERVER, { fetchImpl });
    const rejection = outcome(pending);
    await entered.promise;
    clearAgentPlatformSession();
    expect(await rejection).toMatchObject({ status: "rejected" });
    expect(signal?.aborted).toBe(true);
    expect(physicallyAborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
