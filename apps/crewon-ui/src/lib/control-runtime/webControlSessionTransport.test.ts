import { describe, it, expect } from "vitest";
import { createWebControlSessionTransport } from "./webControlSessionTransport";
const origin = "https://crewon.example";
const session = (csrfToken = "first-csrf") =>
  Response.json({ baseUrl: "/", csrfToken });
const expired = () =>
  Response.json(
    { error: { code: "identity_session_required" } },
    { status: 401, headers: { "x-crewon-account-exchange": "required" } },
  );
const parseSession = (value: unknown) =>
  value as { baseUrl: string; csrfToken: string };
describe("Web Control account session transport", () => {
  it.each([undefined, "unknown", "entry-bytes.v1"])(
    "opts into cached code only for the exact verified capability header (%s)",
    async (mode) => {
      const t = createWebControlSessionTransport({
        pageOrigin: origin,
        parseSession,
        fetch: async () => {
          const response = session();
          if (mode) response.headers.set("x-crewon-plugin-ui-assets", mode);
          return response;
        },
      });
      expect((await t.bootstrap()).pluginUiAssets).toBe(
        mode === "entry-bytes.v1" ? mode : undefined,
      );
    },
  );
  it("bootstraps a PIM account with one POST, without a preliminary failing GET", async () => {
    const calls: RequestInit[] = [];
    const t = createWebControlSessionTransport({
      pageOrigin: origin,
      parseSession,
      bootstrapMethod: "account-exchange",
      fetch: async (_, init) => {
        calls.push(init!);
        return session();
      },
    });
    await t.bootstrap();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(new Headers(calls[0].headers).get("origin")).toBe(origin);
    expect(calls[0].body).toBeUndefined();
  });
  it("uses legacy cookie reading only for an explicitly unsupported exchange route", async () => {
    for (const status of [405, 401, 403, 503]) {
      const methods: string[] = [];
      const t = createWebControlSessionTransport({
        pageOrigin: origin,
        parseSession,
        bootstrapMethod: "account-exchange",
        fetch: async (_, init) => {
          methods.push(init?.method ?? "GET");
          return methods.length === 1
            ? new Response(null, { status })
            : session();
        },
      });
      if (status === 405) {
        await t.bootstrap();
        expect(methods).toEqual(["POST", "GET"]);
      } else {
        await expect(t.bootstrap()).rejects.toThrow("session_unavailable");
        expect(methods).toEqual(["POST"]);
      }
    }
  });
  it("synchronizes a marked CSRF rejection from another tab once before replaying the original mutation", async () => {
    const attempts: RequestInit[] = [];
    let bootstraps = 0;
    const t = createWebControlSessionTransport({
      pageOrigin: origin,
      parseSession,
      fetch: async (input, init) => {
        if (String(input).endsWith("/control-api/session"))
          return session(
            ++bootstraps === 1 ? "old-tab-csrf" : "current-cookie-csrf",
          );
        attempts.push(init!);
        if (attempts.length === 1)
          return Response.json(
            { error: { code: "browser_csrf_invalid" } },
            {
              status: 403,
              headers: { "x-crewon-account-exchange": "required" },
            },
          );
        return Response.json({ saved: true });
      },
    });
    await t.bootstrap();
    const response = await t.fetch(origin + "/api/v1/threads", {
      method: "POST",
      body: '{"request":"same"}',
      headers: {
        "x-csrf-token": "old-tab-csrf",
        "idempotency-key": "save-once",
      },
    });
    expect(response.status).toBe(200);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].body).toBe(attempts[0].body);
    expect(new Headers(attempts[1].headers).get("idempotency-key")).toBe(
      "save-once",
    );
    expect(new Headers(attempts[1].headers).get("x-csrf-token")).toBe(
      "current-cookie-csrf",
    );
  });
  it("keeps the existing successful bootstrap as one GET", async () => {
    const calls: RequestInit[] = [];
    const t = createWebControlSessionTransport({
      pageOrigin: origin,
      parseSession,
      fetch: async (_, init) => {
        calls.push(init!);
        return session();
      },
    });
    expect(await t.bootstrap()).toEqual({
      baseUrl: "/",
      csrfToken: "first-csrf",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBeUndefined();
  });
  it("exchanges only the explicit BFF pre-dispatch marker and does not reinterpret other 401s", async () => {
    const calls: RequestInit[] = [];
    const t = createWebControlSessionTransport({
      pageOrigin: origin,
      parseSession,
      fetch: async (_, init) => {
        calls.push(init!);
        return calls.length === 1 ? expired() : session();
      },
    });
    await t.bootstrap();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("POST");
    expect(new Headers(calls[1]!.headers).get("origin")).toBe(origin);
    let attempts = 0;
    const rejected = createWebControlSessionTransport({
      pageOrigin: origin,
      parseSession,
      fetch: async () => {
        attempts++;
        return Response.json(
          { error: { code: "identity_session_required" } },
          { status: 401 },
        );
      },
    });
    await expect(rejected.bootstrap()).rejects.toThrow("session_unavailable");
    expect(attempts).toBe(1);
  });
  it("replays an un-dispatched mutation once with renewed CSRF and identical idempotency and body", async () => {
    let bootstrapGets = 0;
    let runs = 0;
    const requests: RequestInit[] = [];
    const t = createWebControlSessionTransport({
      pageOrigin: origin,
      parseSession,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/control-api/session") {
          if (init?.method === "POST") return session("renewed-csrf");
          bootstrapGets++;
          return bootstrapGets === 1 ? session() : expired();
        }
        runs++;
        requests.push(init!);
        return runs === 1 ? expired() : Response.json({ accepted: true });
      },
    });
    await t.bootstrap();
    const init = {
      method: "POST",
      body: '{"prompt":"hello"}',
      headers: {
        "x-csrf-token": "first-csrf",
        "idempotency-key": "same-request",
      },
    };
    expect(
      (await t.fetch(origin + "/api/v1/threads/one/runs", init)).status,
    ).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests.map((x) => x.body)).toEqual([init.body, init.body]);
    expect(
      requests.map((x) => new Headers(x.headers).get("idempotency-key")),
    ).toEqual(["same-request", "same-request"]);
    expect(new Headers(requests[1]!.headers).get("x-csrf-token")).toBe(
      "renewed-csrf",
    );
  });
  it("never retries ordinary model/auth failures or another origin", async () => {
    for (const [url, response] of [
      [
        origin + "/api/v1/runs",
        Response.json({ error: { code: "model_failed" } }, { status: 401 }),
      ],
      ["https://other.example/api/v1/runs", expired()],
    ] as const) {
      let calls = 0;
      const t = createWebControlSessionTransport({
        pageOrigin: origin,
        parseSession,
        fetch: async () => {
          calls++;
          return response;
        },
      });
      expect((await t.fetch(url)).status).toBe(401);
      expect(calls).toBe(1);
    }
  });
});
