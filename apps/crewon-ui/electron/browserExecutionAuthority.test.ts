import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlRuntimeSession } from "./runtimeSupervisor.ts";
import { createBrowserExecutionAuthority } from "./browserExecutionAuthority.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const ref = {
  skillId: "skill-1",
  versionId: "version-1",
  contentDigest: `sha256:${"a".repeat(64)}`,
};
const facts = {
  schemaVersion: "crewon.browser-execution-authority.v1",
  runId: "run-1",
  threadId: "thread-1",
  workspaceBindingId: "workspace-1",
  status: "running",
  cancelRequested: false,
  revision: 2,
};

describe("BrowserExecutionAuthority", () => {
  it("reads current authenticated Control facts, Thread and pinned Skill without accepting caller authority", async () => {
    const calls: string[] = [];
    let canceled = false;
    const session = await control((request, response) => {
      calls.push(request.url!);
      expect(request.headers.authorization).toBe(
        `Bearer ${session.sessionToken}`,
      );
      expect(request.headers.origin).toBe(session.origin);
      expect(request.method).toBe("GET");
      expect(request.headers["cache-control"]).toContain("no-cache");
      if (request.url!.endsWith("browser-execution-authority"))
        json(response, { ...facts, cancelRequested: canceled });
      else if (request.url!.endsWith("skill-invocation"))
        json(response, {
          threadId: "thread-1",
          skillVersionRef: ref,
          parameters: { date: "2026-09-14" },
        });
      else json(response, thread());
    });
    const authority = createBrowserExecutionAuthority(() => session);
    expect(await authority.resolveRun("run-1")).toEqual({
      runId: "run-1",
      threadId: "thread-1",
      active: true,
      workspaceBindingId: "workspace-1",
      skill: { ref, parameters: { date: "2026-09-14" } },
    });
    canceled = true;
    expect((await authority.resolveRun("run-1")).active).toBe(false);
    expect(
      calls.filter((path) => path.endsWith("browser-execution-authority")),
    ).toHaveLength(2);
    expect(
      calls.filter((path) => path.endsWith("skill-invocation")),
    ).toHaveLength(2);
    expect(
      calls.filter((path) => path === "/api/v1/threads/thread-1"),
    ).toHaveLength(2);
  });

  it("accepts a literal null binding and only absent Skill endpoint 404/null as an unscoped Run", async () => {
    let skillStatus = 404;
    const session = await control((request, response) => {
      if (request.url!.endsWith("browser-execution-authority"))
        json(response, { ...facts, workspaceBindingId: null });
      else if (request.url!.endsWith("skill-invocation")) {
        response.statusCode = skillStatus;
        json(response, null);
      } else json(response, thread());
    });
    const authority = createBrowserExecutionAuthority(() => session);
    expect(await authority.resolveRun("run-1")).toMatchObject({
      workspaceBindingId: null,
      skill: null,
    });
    skillStatus = 200;
    expect((await authority.resolveRun("run-1")).skill).toBeNull();
    for (const status of [401, 403, 500]) {
      skillStatus = status;
      await expect(authority.resolveRun("run-1")).rejects.toThrow(
        `browser_control_http_${status}`,
      );
    }
  });

  it("rejects missing bindings, substituted identities and malformed Skill references before granting scope", async () => {
    let current: unknown = { ...facts, workspaceBindingId: undefined };
    let skill: unknown = null;
    let currentThread = thread();
    const session = await control((request, response) => {
      if (request.url!.endsWith("browser-execution-authority"))
        json(response, current);
      else if (request.url!.endsWith("skill-invocation")) json(response, skill);
      else json(response, currentThread);
    });
    const authority = createBrowserExecutionAuthority(() => session);
    for (const value of [
      current,
      { ...facts, runId: "other" },
      { ...facts, status: "maybe" },
      { ...facts, grant: true },
    ]) {
      current = value;
      await expect(authority.resolveRun("run-1")).rejects.toThrow();
    }
    current = facts;
    currentThread = {
      ...thread(),
      thread: { ...thread().thread, threadId: "other-thread" },
    };
    await expect(authority.resolveRun("run-1")).rejects.toThrow(
      "browser_control_thread_invalid",
    );
    currentThread = thread();
    for (const value of [
      { threadId: "other", skillVersionRef: ref, parameters: {} },
      {
        threadId: "thread-1",
        skillVersionRef: { ...ref, contentDigest: "latest" },
        parameters: {},
      },
      {
        threadId: "thread-1",
        skillVersionRef: ref,
        parameters: {},
        grant: true,
      },
    ]) {
      skill = value;
      await expect(authority.resolveRun("run-1")).rejects.toThrow(
        "browser_control_skill_invalid",
      );
    }
  });

  it("fails closed on lost sessions, authorization rejection, redirected endpoints and oversized responses", async () => {
    const missing = createBrowserExecutionAuthority(() => {
      throw new Error("control_runtime_unavailable");
    });
    await expect(missing.checkThread("thread-1")).rejects.toThrow(
      "control_runtime_unavailable",
    );
    let mode = "denied";
    const session = await control((_request, response) => {
      if (mode === "denied") {
        response.statusCode = 403;
        json(response, { private: "must not leak" });
      } else if (mode === "redirect") {
        response.writeHead(302, { location: "/secret" });
        response.end();
      } else json(response, { content: "x".repeat(1048576) });
    });
    const authority = createBrowserExecutionAuthority(() => session);
    await expect(authority.checkThread("thread-1")).rejects.toThrow(
      "browser_control_http_403",
    );
    mode = "redirect";
    await expect(authority.resolveRun("run-1")).rejects.toThrow();
    mode = "oversized";
    await expect(authority.resolveRun("run-1")).rejects.toThrow(
      "browser_control_response_limit",
    );
  });

  it("aborts a Control read within three seconds even when the response body never completes", async () => {
    const session = await control((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    const authority = createBrowserExecutionAuthority(() => session);
    const began = Date.now();
    await expect(authority.resolveRun("run-1")).rejects.toThrow();
    expect(Date.now() - began).toBeLessThan(4500);
  });
});

async function control(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<ControlRuntimeSession> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    origin: "http://crewon.localhost",
    sessionToken: "t".repeat(64),
    csrfToken: "c".repeat(64),
  };
}
function json(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
function thread() {
  return {
    thread: {
      threadId: "thread-1",
      status: "active",
      revision: 1,
      title: null,
      lastMessageSequence: 0,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: "2026-09-14T00:00:00Z",
      updatedAt: "2026-09-14T00:00:00Z",
      archivedAt: null,
      deletedAt: null,
    },
    eventSequence: 1,
  };
}
