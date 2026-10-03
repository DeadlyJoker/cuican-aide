import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureAgentPlatformSession,
  clearAgentPlatformSession,
  storeAgentPlatformSession,
} from "../agent-platform/agentPlatformClient";
import { AgentPlatformSessionResponse } from "./agentPlatformSessionResponse";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delayedResponse() {
  const reading = deferred<void>();
  const release = deferred<void>();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await release.promise;
          controller.enqueue(new TextEncoder().encode('{"account":"A"}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Type": "application/json" } },
  );
  return { response, reading, release };
}

describe("Web response account lifetime", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
    storeAgentPlatformSession("account-a");
  });
  afterEach(() => {
    clearAgentPlatformSession();
    vi.unstubAllEnvs();
  });

  it.each(["json", "text", "arrayBuffer", "blob"] as const)(
    "rejects a late A %s body after switching accounts",
    async (method) => {
      const delayed = delayedResponse();
      const scoped = new AgentPlatformSessionResponse({
        response: delayed.response,
        session: captureAgentPlatformSession(),
      });
      const result = scoped[method]().then(
        (value) => ({ value, error: null }),
        (error: Error) => ({ value: null, error }),
      );
      await delayed.reading.promise;
      storeAgentPlatformSession("account-b");
      delayed.release.resolve();
      expect((await result).error?.message).toBe(
        "agent_platform_session_changed",
      );
    },
  );

  it("fences the raw stream used by bounded Control response readers", async () => {
    const delayed = delayedResponse();
    const scoped = new AgentPlatformSessionResponse({
      response: delayed.response,
      session: captureAgentPlatformSession(),
    });
    const result = scoped
      .body!.getReader()
      .read()
      .then(
        (value) => ({ value, error: null }),
        (error: Error) => ({ value: null, error }),
      );
    await delayed.reading.promise;
    clearAgentPlatformSession();
    delayed.release.resolve();
    expect((await result).error?.message).toBe(
      "agent_platform_session_changed",
    );
  });

  it("retains normal response metadata and cloned-body behavior", async () => {
    const original = Response.json(
      { account: "A" },
      { status: 201, statusText: "Created", headers: { "X-Proof": "kept" } },
    );
    Object.defineProperties(original, {
      url: { value: "https://crewon.example/control-api/threads" },
      redirected: { value: true },
    });
    const scoped = new AgentPlatformSessionResponse({
      response: original,
      session: captureAgentPlatformSession(),
    });
    const clone = scoped.clone();
    expect(scoped).toBeInstanceOf(Response);
    expect(clone.url).toBe(original.url);
    expect(clone.redirected).toBe(true);
    expect(clone.type).toBe(original.type);
    expect(scoped.status).toBe(201);
    expect(scoped.statusText).toBe("Created");
    expect(scoped.headers.get("X-Proof")).toBe("kept");
    await expect(scoped.json()).resolves.toEqual({ account: "A" });
    await expect(clone.json()).resolves.toEqual({ account: "A" });
    expect(scoped.bodyUsed).toBe(true);
    storeAgentPlatformSession("account-b");
    expect(() => scoped.clone()).toThrow("agent_platform_session_changed");
  });
});
