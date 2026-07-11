import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServerClient, turnInputFromComposer } from "./appServer";
import type { OfficeConfig } from "../domain/crewonDomain";

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeFromServer();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  closeFromServer(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

async function connectFakeClient(
  client: AppServerClient,
): Promise<FakeWebSocket> {
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
  });
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);

  const connected = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const initializeRequest = JSON.parse(socket.sent[0] ?? "{}") as {
    id: number;
  };
  (
    client as unknown as {
      handleMessage: (rawData: string) => void;
    }
  ).handleMessage(JSON.stringify({ id: initializeRequest.id, result: {} }));
  await connected;
  return socket;
}

describe("app server composer input", () => {
  it("maps composer mentions to v2 turn input items", () => {
    expect(
      turnInputFromComposer("Use selected tools", [
        { name: "Browser", path: "app://browser" },
        { name: "github.search", path: "mcp://github" },
        {
          kind: "skill",
          name: "code-review",
          path: "/repo/.crewon/skills/code-review/SKILL.md",
        },
      ]),
    ).toEqual([
      { type: "text", text: "Use selected tools", text_elements: [] },
      { type: "mention", name: "Browser", path: "app://browser" },
      { type: "mention", name: "github.search", path: "mcp://github" },
      {
        type: "skill",
        name: "code-review",
        path: "/repo/.crewon/skills/code-review/SKILL.md",
      },
    ]);
  });
});

describe("app server client connection lifecycle", () => {
  it("does not report connection loss for an intentional close", async () => {
    const onClose = vi.fn();
    const client = new AppServerClient(
      "ws://app-server",
      () => undefined,
      onClose,
    );
    await connectFakeClient(client);

    client.close();

    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports connection loss when the socket closes unexpectedly", async () => {
    const onClose = vi.fn();
    const client = new AppServerClient(
      "ws://app-server",
      () => undefined,
      onClose,
    );
    const socket = await connectFakeClient(client);

    socket.closeFromServer();

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("app server execution intent", () => {
  it("sends plan collaboration mode for a plan turn", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);

    const turnPromise = client.startTurn("thread-1", "Plan this", [], {
      executionIntent: "plan",
      model: "gpt-5.6-sol",
    });
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };

    expect(request).toMatchObject({
      method: "turn/start",
      params: {
        collaborationMode: {
          mode: "plan",
          settings: {
            developer_instructions: null,
            model: "gpt-5.6-sol",
            reasoning_effort: null,
          },
        },
      },
    });

    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(JSON.stringify({ id: request.id, result: { turn: {} } }));
    await turnPromise;
  });
});

describe("app server notifications", () => {
  it("accepts reasoning delta notifications", () => {
    const notifications: unknown[] = [];
    const client = new AppServerClient("ws://app-server", (notification) => {
      notifications.push(notification);
    });

    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          summaryIndex: 0,
          delta: "Planning",
        },
      }),
    );

    expect(notifications).toEqual([
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          summaryIndex: 0,
          delta: "Planning",
        },
      },
    ]);
  });

  it("accepts office run updated notifications", () => {
    const notifications: unknown[] = [];
    const client = new AppServerClient("ws://app-server", (notification) => {
      notifications.push(notification);
    });

    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        method: "office/run/updated",
        params: {
          cwd: "/repo",
          filePath: "/repo/.crewon/offices/office.json",
          reason: "autoDispatchCompletion",
          sourceThreadId: "member-thread",
          sourceTurnId: "turn-member",
          config: {
            title: "Office",
            subtitle: "Runtime",
            workspace: {
              goal: "Ship",
              members: [],
              messages: [],
              tasks: [],
            },
          },
        },
      }),
    );

    expect(notifications).toEqual([
      expect.objectContaining({
        method: "office/run/updated",
        params: expect.objectContaining({
          reason: "autoDispatchCompletion",
          sourceTurnId: "turn-member",
        }),
      }),
    ]);
  });
});

describe("app server thread RPC", () => {
  it("lists threads through the state DB fast path", async () => {
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
    const sent: string[] = [];
    const client = new AppServerClient("ws://app-server", () => undefined);
    (
      client as unknown as {
        socket: Pick<WebSocket, "readyState" | "send">;
      }
    ).socket = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => {
        sent.push(payload);
      },
    };

    const pending = client.listThreads(false);
    const request = JSON.parse(sent[0] ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        },
      }),
    );

    await expect(pending).resolves.toEqual([]);
    expect(request).toMatchObject({
      method: "thread/list",
      params: {
        cursor: null,
        limit: 24,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: null,
        archived: false,
        useStateDbOnly: true,
      },
    });
  });
});

describe("app server automation RPC", () => {
  it("sends automation run start requests", async () => {
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
    const sent: string[] = [];
    const client = new AppServerClient("ws://app-server", () => undefined);
    (
      client as unknown as {
        socket: Pick<WebSocket, "readyState" | "send">;
      }
    ).socket = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => {
        sent.push(payload);
      },
    };

    const pending = client.startAutomationRunConfig(
      "/workspace",
      {
        title: "Nightly QA",
        subtitle: "Manual",
        body: "Run nightly QA",
        threadId: "automation-thread-123456789",
        prompt: "Run QA",
      },
      {
        note: "manual smoke",
        locale: "en",
        clientUserMessageId: "client-automation-1",
      },
    );
    const request = JSON.parse(sent[0] ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          filePath: "/workspace/.crewon/automation-runs/nightly.json",
          run: {
            runId: "run-1",
            automationTitle: "Nightly QA",
            threadId: "automation-thread-123456789",
            turnId: "turn-1",
            status: "running",
            startedAt: 1,
            completedAt: null,
            note: "manual smoke",
            config: {
              title: "Nightly QA",
              subtitle: "Manual",
              body: "Run nightly QA",
              threadId: "automation-thread-123456789",
              prompt: "Run QA",
            },
          },
          threadId: "automation-thread-123456789",
          turn: {
            id: "turn-1",
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      run: { runId: "run-1" },
      threadId: "automation-thread-123456789",
      turn: { id: "turn-1" },
    });
    expect(request).toMatchObject({
      method: "automation/run/start",
      params: {
        cwd: "/workspace",
        config: {
          title: "Nightly QA",
          subtitle: "Manual",
          body: "Run nightly QA",
          threadId: "automation-thread-123456789",
          prompt: "Run QA",
        },
        note: "manual smoke",
        locale: "en",
        clientUserMessageId: "client-automation-1",
      },
    });
  });

  it("sends office verification dispatch requests", async () => {
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
    const sent: string[] = [];
    const client = new AppServerClient("ws://app-server", () => undefined);
    (
      client as unknown as {
        socket: Pick<WebSocket, "readyState" | "send">;
      }
    ).socket = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => {
        sent.push(payload);
      },
    };

    const officeConfig: OfficeConfig = {
      title: "Platform Office",
      subtitle: "Release",
      workspace: {
        goal: "Ship safely",
        threadId: "office-thread-123456789",
        members: [],
        messages: [],
        tasks: [],
        activity: {
          runs: [
            {
              id: "office-run-1",
              title: "Release QA",
              status: "completed",
              verificationChecks: [
                {
                  check: "Run nightly QA",
                  status: "pending",
                  automationId: "Nightly QA",
                },
              ],
            },
          ],
        },
      },
    };
    const pending = client.dispatchNextOfficeVerificationConfig(
      "/workspace",
      officeConfig,
      "office-run-1",
      {
        locale: "en",
        clientUserMessageId: "client-verification-1",
      },
    );
    const request = JSON.parse(sent[0] ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: officeConfig,
          runId: "office-run-1",
          verificationCheckId: "check-1",
          automationId: "Nightly QA",
          automationRunFilePath: "/workspace/.crewon/automation-runs/run.json",
          automationRunId: "automation-run-1",
          threadId: "automation-thread-123456789",
          turn: {
            id: "automation-turn-1",
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      runId: "office-run-1",
      verificationCheckId: "check-1",
      automationRunId: "automation-run-1",
      turn: { id: "automation-turn-1" },
    });
    expect(request).toMatchObject({
      method: "office/verification/dispatch/next",
      params: {
        cwd: "/workspace",
        config: officeConfig,
        runId: "office-run-1",
        locale: "en",
        clientUserMessageId: "client-verification-1",
      },
    });
  });

  it("sends office child cancel requests", async () => {
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
    const sent: string[] = [];
    const client = new AppServerClient("ws://app-server", () => undefined);
    (
      client as unknown as {
        socket: Pick<WebSocket, "readyState" | "send">;
      }
    ).socket = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => {
        sent.push(payload);
      },
    };

    const officeConfig: OfficeConfig = {
      title: "Platform Office",
      subtitle: "Release",
      workspace: {
        goal: "Ship safely",
        threadId: "office-thread-123456789",
        members: [],
        messages: [],
        tasks: [],
      },
    };
    const delegationPending = client.cancelOfficeDelegationConfig(
      "/workspace",
      officeConfig,
      "office-run-1",
      "delegation-1",
      {
        locale: "en",
        threadId: "member-thread",
        turnId: "member-turn",
      },
    );
    const delegationRequest = JSON.parse(sent[0] ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: delegationRequest.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: officeConfig,
        },
      }),
    );

    await expect(delegationPending).resolves.toMatchObject({
      filePath: "/workspace/.crewon/offices/platform.json",
      config: officeConfig,
    });
    expect(delegationRequest).toMatchObject({
      method: "office/delegation/cancel",
      params: {
        cwd: "/workspace",
        config: officeConfig,
        runId: "office-run-1",
        delegationId: "delegation-1",
        locale: "en",
        threadId: "member-thread",
        turnId: "member-turn",
      },
    });

    const verificationPending = client.cancelOfficeVerificationConfig(
      "/workspace",
      officeConfig,
      "office-run-1",
      "smoke-automation",
      {
        locale: "en",
        threadId: "automation-thread",
        turnId: "automation-turn",
      },
    );
    const verificationRequest = JSON.parse(sent[1] ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: verificationRequest.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: officeConfig,
        },
      }),
    );

    await expect(verificationPending).resolves.toMatchObject({
      filePath: "/workspace/.crewon/offices/platform.json",
      config: officeConfig,
    });
    expect(verificationRequest).toMatchObject({
      method: "office/verification/cancel",
      params: {
        cwd: "/workspace",
        config: officeConfig,
        runId: "office-run-1",
        verificationCheckId: "smoke-automation",
        locale: "en",
        threadId: "automation-thread",
        turnId: "automation-turn",
      },
    });
  });

  it("sends office delegation retry requests", async () => {
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
    const sent: string[] = [];
    const client = new AppServerClient("ws://app-server", () => undefined);
    (
      client as unknown as {
        socket: Pick<WebSocket, "readyState" | "send">;
      }
    ).socket = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => {
        sent.push(payload);
      },
    };

    const officeConfig: OfficeConfig = {
      title: "Platform Office",
      subtitle: "Release",
      workspace: {
        goal: "Ship safely",
        threadId: "office-thread-123456789",
        members: [],
        messages: [],
        tasks: [],
      },
    };
    const pending = client.retryOfficeDelegationConfig(
      "/workspace",
      officeConfig,
      "office-run-1",
      "delegation-old",
      {
        locale: "en",
        clientUserMessageId: "client-delegation-retry-1",
      },
    );
    const request = JSON.parse(sent[0] ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: officeConfig,
          runId: "office-run-1",
          delegationId: "delegation-new",
          retryOfDelegationId: "delegation-old",
          threadId: "member-thread",
          turn: {
            id: "member-turn-2",
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      delegationId: "delegation-new",
      retryOfDelegationId: "delegation-old",
      turn: { id: "member-turn-2" },
    });
    expect(request).toMatchObject({
      method: "office/delegation/retry",
      params: {
        cwd: "/workspace",
        config: officeConfig,
        runId: "office-run-1",
        delegationId: "delegation-old",
        locale: "en",
        clientUserMessageId: "client-delegation-retry-1",
      },
    });
  });

  it("sends office verification retry requests", async () => {
    const sent: string[] = [];
    vi.stubGlobal("window", {
      WebSocket,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const client = new AppServerClient("ws://app-server", () => undefined);
    (
      client as unknown as {
        socket: Pick<WebSocket, "readyState" | "send">;
      }
    ).socket = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => {
        sent.push(payload);
      },
    };

    const officeConfig: OfficeConfig = {
      title: "Platform Office",
      subtitle: "Release",
      workspace: {
        goal: "Ship safely",
        threadId: "office-thread-123456789",
        members: [],
        messages: [],
        tasks: [],
      },
    };
    const pending = client.retryOfficeVerificationConfig(
      "/workspace",
      officeConfig,
      "office-run-1",
      "verification-nightly",
      {
        locale: "en",
        clientUserMessageId: "client-verification-retry-1",
      },
    );
    const request = JSON.parse(sent[0] ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: officeConfig,
          runId: "office-run-1",
          verificationCheckId: "verification-nightly",
          automationId: "nightly-smoke",
          automationRunFilePath:
            "/workspace/.crewon/automation-runs/nightly-smoke.json",
          automationRunId: "automation-run-retry",
          retryOfAutomationTurnId: "automation-turn-old",
          threadId: "automation-thread",
          turn: {
            id: "automation-turn-retry",
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      verificationCheckId: "verification-nightly",
      retryOfAutomationTurnId: "automation-turn-old",
      turn: { id: "automation-turn-retry" },
    });
    expect(request).toMatchObject({
      method: "office/verification/retry",
      params: {
        cwd: "/workspace",
        config: officeConfig,
        runId: "office-run-1",
        verificationCheckId: "verification-nightly",
        locale: "en",
        clientUserMessageId: "client-verification-retry-1",
      },
    });
  });
});
