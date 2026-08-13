import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppServerClient,
  parseOfficeMessageSubmitResponse,
  turnInputFromComposer,
} from "./appServer";
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

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
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
  it("obtains fresh principal session protocols before opening a websocket", async () => {
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const protocols = vi.fn(async () => [
      "crewon.principal-session.v1",
      "session.jwt",
    ]);
    const client = new AppServerClient(
      "ws://app-server",
      () => undefined,
      undefined,
      undefined,
      { protocols },
    );

    const connected = client.connect();
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    expect(socket.protocols).toEqual([
      "crewon.principal-session.v1",
      "session.jwt",
    ]);
    socket.open();
    const initializeRequest = JSON.parse(socket.sent[0] ?? "{}") as {
      id: number;
    };
    (
      client as unknown as { handleMessage: (rawData: string) => void }
    ).handleMessage(JSON.stringify({ id: initializeRequest.id, result: {} }));
    await connected;
    expect(protocols).toHaveBeenCalledOnce();
  });

  it("routes generated Provider and Resource RPCs over the initialized websocket", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);
    const calls = [
      () =>
        client.providerResources.listWorkspaces({ cursor: null, limit: 10 }),
      () =>
        client.providerResources.bindWorkspace({
          workspaceKey: "workspace-1",
          scope: "conversation",
          scopeId: "thread-1",
        }),
      () =>
        client.providerResources.connectProvider({
          providerId: "agent-platform",
        }),
      () =>
        client.providerResources.readProvider({ connectionId: "connection-1" }),
      () =>
        client.providerResources.listResources({
          connectionId: "connection-1",
          cursor: null,
          limit: 10,
          resourceType: "skill",
        }),
      () =>
        client.providerResources.readResource({
          connectionId: "connection-1",
          resource: {
            providerId: "agent-platform",
            resourceId: "skill-1",
            revision: "r1",
            resourceType: "skill",
          },
        }),
      () =>
        client.providerResources.bindResource({
          connectionId: "connection-1",
          workspaceBindingId: "workspace-binding-1",
          resource: {
            providerId: "agent-platform",
            resourceId: "skill-1",
            revision: "r1",
            resourceType: "skill",
          },
          mode: "remoteReference",
        }),
      () =>
        client.providerResources.unbindResource({
          bindingId: "resource-binding-1",
        }),
      () =>
        client.providerResources.updateThreadExecutionContext({
          threadId: "thread-1",
          workspaceBindingId: "workspace-binding-1",
          resourceBindingIds: ["resource-binding-1"],
          executionBindingId: "resource-binding-1",
          expectedRevision: 1 as unknown as bigint,
        }),
    ];

    for (const [index, call] of calls.entries()) {
      const pending = call();
      const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
        id: number;
        method: string;
        params: unknown;
      };
      expect(request.method).toBe(
        [
          "workspace/list",
          "workspace/bind",
          "provider/connect",
          "provider/read",
          "resource/list",
          "resource/read",
          "resource/bind",
          "resource/unbind",
          "threadExecutionContext/update",
        ][index],
      );
      expect(JSON.stringify(request.params)).not.toMatch(
        /actorId|tenantId|spaceId|credential|endpoint|rootPath|token|secret/i,
      );
      (
        client as unknown as {
          handleMessage: (rawData: string) => void;
        }
      ).handleMessage(JSON.stringify({ id: request.id, result: {} }));
      await pending;
    }
  });

  it("does not expose removed Agent Platform chat notifications to the UI", async () => {
    const onNotification = vi.fn();
    const client = new AppServerClient("ws://app-server", onNotification);
    await connectFakeClient(client);

    (
      client as unknown as { handleMessage: (rawData: string) => void }
    ).handleMessage(
      JSON.stringify({
        method: "agentPlatform/chat/completed",
        params: {
          runId: "legacy-run",
          threadId: "thread-1",
          agentId: "7",
          message: "legacy result",
        },
      }),
    );

    expect(onNotification).not.toHaveBeenCalled();
  });

  it("routes local Workflow gate decisions and cancellation without credentials", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);
    const calls = [
      {
        method: "workflow/gate/resolve",
        run: () =>
          client.resolveWorkflowGate(
            "/repo",
            "workflow-1",
            "run-1",
            "node-2",
            "approve",
            "范围已确认",
          ),
      },
      {
        method: "workflow/run/cancel",
        run: () => client.cancelWorkflowRun("/repo", "workflow-1", "run-1"),
      },
    ];

    for (const call of calls) {
      const pending = call.run();
      const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
        id: number;
        method: string;
        params: unknown;
      };
      expect(request.method).toBe(call.method);
      expect(JSON.stringify(request.params)).not.toMatch(
        /accessToken|apiKey|credential|pim/i,
      );
      (
        client as unknown as {
          handleMessage: (rawData: string) => void;
        }
      ).handleMessage(
        JSON.stringify({
          id: request.id,
          result: {
            executionId: "run-1",
            workflowId: "workflow-1",
            status: "completed",
            output: "done",
            executedNodes: [],
            error: null,
          },
        }),
      );
      await expect(pending).resolves.toMatchObject({ executionId: "run-1" });
    }
  });

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

describe("app server file writes", () => {
  it("writes browser-selected binary content without converting it to text", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);

    const writePromise = client.writeFile("/repo/image.png", "AAEC");
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(request).toMatchObject({
      method: "fs/writeFile",
      params: {
        path: "/repo/image.png",
        dataBase64: "AAEC",
      },
    });
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(JSON.stringify({ id: request.id, result: {} }));

    await expect(writePromise).resolves.toEqual({});
  });
});

describe("app server Office revisions", () => {
  it("ensures the server-owned manager by canonical Office identity", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);

    const ensurePromise = client.ensureOfficeManagerConfig(
      "/workspace",
      "office-record-1",
      "revision-1",
    );
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(request).toMatchObject({
      method: "office/manager/ensure",
      params: {
        cwd: "/workspace",
        officeRecordId: "office-record-1",
        expectedRecordRevision: "revision-1",
      },
    });
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: {
            title: "Platform Office",
            workspace: {
              goal: "Ship safely",
              members: [],
              messages: [],
              tasks: [],
              recordId: "office-record-1",
              recordRevision: "revision-2",
              threadId: "office-manager-1",
            },
          },
          threadId: "office-manager-1",
          status: "created",
        },
      }),
    );

    await expect(ensurePromise).resolves.toMatchObject({
      threadId: "office-manager-1",
      status: "created",
      config: {
        workspace: { recordRevision: "revision-2" },
      },
    });
  });

  it("uses only the canonical revision supplied by the caller", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);
    const config: OfficeConfig = {
      title: "Platform Office",
      subtitle: "Team workspace",
      workspace: {
        goal: "Ship safely",
        threadId: "office-thread-1",
        members: [],
        messages: [],
        tasks: [],
      },
    };

    const savePromise = client.saveOfficeConfig("/workspace", config);
    const saveRequest = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      params: { config: OfficeConfig };
    };
    expect(saveRequest.params.config.workspace.recordRevision).toBeUndefined();
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: saveRequest.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: {
            ...config,
            workspace: {
              ...config.workspace,
              recordRevision: "revision-1",
            },
          },
        },
      }),
    );
    const saved = await savePromise;

    const staleMessagePromise = client.sendOfficeMessageConfig(
      "/workspace",
      config,
      {
        author: "User",
        glyph: "@",
        accent: "slate",
        time: "09:10",
        text: "Continue",
      },
    );
    const messageRequest = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      params: { config: OfficeConfig };
    };
    expect(
      messageRequest.params.config.workspace.recordRevision,
    ).toBeUndefined();
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: messageRequest.id,
        error: {
          code: -32602,
          message: "office config is stale",
        },
      }),
    );
    await expect(staleMessagePromise).rejects.toMatchObject({
      message: "office config is stale",
    });

    const canonicalMessagePromise = client.sendOfficeMessageConfig(
      "/workspace",
      saved.config,
      {
        author: "User",
        glyph: "@",
        accent: "slate",
        time: "09:11",
        text: "Continue safely",
      },
    );
    const canonicalMessageRequest = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      params: { config: OfficeConfig };
    };
    expect(canonicalMessageRequest.params.config.workspace.recordRevision).toBe(
      "revision-1",
    );
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: canonicalMessageRequest.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config: {
            ...saved.config,
            workspace: {
              ...saved.config.workspace,
              recordRevision: "revision-2",
            },
          },
        },
      }),
    );
    await canonicalMessagePromise;
  });
});

describe("app server Office message submit", () => {
  const config: OfficeConfig = {
    title: "Platform Office",
    subtitle: "Team workspace",
    workspace: {
      goal: "Ship safely",
      threadId: "office-thread-1",
      members: [],
      messages: [],
      tasks: [],
    },
  };

  it("sends the stable message receipt inputs and parses queued delivery", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);

    const submitPromise = client.submitOfficeMessageConfig(
      "/workspace",
      config,
      "Continue safely",
      "message-1",
      {
        locale: "en",
        threadId: "office-thread-1",
        mentions: [{ memberId: "reviewer" }],
      },
    );
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };
    expect(request).toMatchObject({
      method: "office/message/submit",
      params: {
        cwd: "/workspace",
        config,
        text: "Continue safely",
        clientUserMessageId: "message-1",
        locale: "en",
        threadId: "office-thread-1",
        mentions: [{ memberId: "reviewer" }],
      },
    });

    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          filePath: "/workspace/.crewon/offices/platform.json",
          config,
          receiptId: "receipt-1",
          clientUserMessageId: "message-1",
          replayed: false,
          delivery: {
            type: "queued",
            afterRunId: "run-active",
            position: 2,
          },
        },
      }),
    );

    await expect(submitPromise).resolves.toMatchObject({
      receiptId: "receipt-1",
      clientUserMessageId: "message-1",
      delivery: { type: "queued", position: 2 },
    });
  });

  it("fails closed for an unknown delivery type", () => {
    expect(() =>
      parseOfficeMessageSubmitResponse({
        filePath: "/workspace/.crewon/offices/platform.json",
        config,
        receiptId: "receipt-1",
        clientUserMessageId: "message-1",
        replayed: false,
        delivery: { type: "directMemberSteer" },
      }),
    ).toThrow("unsupported delivery type directMemberSteer");
  });

  it("parses the exact processing, interaction, answered, and failed wire shapes", () => {
    const base = {
      filePath: "/workspace/.crewon/offices/platform.json",
      config,
      receiptId: "receipt-1",
      clientUserMessageId: "message-1",
      replayed: false,
    };
    const interactionTurn = {
      id: "interaction-turn",
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    };

    expect(
      parseOfficeMessageSubmitResponse({
        ...base,
        delivery: {
          type: "processing",
          phase: "recovering",
          retryAfterMs: 250,
        },
      }).delivery,
    ).toEqual({ type: "processing", phase: "recovering", retryAfterMs: 250 });
    expect(
      parseOfficeMessageSubmitResponse({
        ...base,
        delivery: {
          type: "interactionStarted",
          interactionId: "interaction-1",
          threadId: "office-thread-1",
          turn: interactionTurn,
        },
      }).delivery,
    ).toEqual({
      type: "interactionStarted",
      interactionId: "interaction-1",
      threadId: "office-thread-1",
      turn: interactionTurn,
    });
    expect(
      parseOfficeMessageSubmitResponse({
        ...base,
        delivery: {
          type: "answered",
          interactionId: "interaction-1",
          threadId: "office-thread-1",
          turnId: "interaction-turn",
        },
      }).delivery,
    ).toEqual({
      type: "answered",
      interactionId: "interaction-1",
      threadId: "office-thread-1",
      turnId: "interaction-turn",
    });
    expect(
      parseOfficeMessageSubmitResponse({
        ...base,
        delivery: {
          type: "failed",
          code: "officeMessageDispatchFailed",
          message: "Dispatch failed",
          retryable: false,
        },
      }).delivery,
    ).toEqual({
      type: "failed",
      code: "officeMessageDispatchFailed",
      message: "Dispatch failed",
      retryable: false,
    });
  });

  it("rejects malformed processing and failed deliveries", () => {
    const base = {
      filePath: "/workspace/.crewon/offices/platform.json",
      config,
      receiptId: "receipt-1",
      clientUserMessageId: "message-1",
      replayed: false,
    };
    expect(() =>
      parseOfficeMessageSubmitResponse({
        ...base,
        delivery: { type: "processing", phase: "dispatching" },
      }),
    ).toThrow("delivery.retryAfterMs");
    expect(() =>
      parseOfficeMessageSubmitResponse({
        ...base,
        delivery: {
          type: "failed",
          code: "failed",
          message: "Failed",
          retryable: "no",
        },
      }),
    ).toThrow("delivery.retryable");
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

describe("app server Experts RPC contracts", () => {
  it("lists Experts by workspace key without leaking local path fields", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);

    const pending = client.listExpertTeams("workspace-key-1");
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };

    expect(request).toEqual({
      id: request.id,
      method: "expertTeam/list",
      params: {
        workspaceKey: "workspace-key-1",
        cursor: null,
        limit: 100,
      },
    });
    expect(JSON.stringify(request.params)).not.toMatch(/cwd|filePath|kind/);
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: { data: [], nextCursor: null },
      }),
    );

    await pending;
  });

  it("resolves the Experts workspace through the registered workspace API", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);

    const pending = client.listRegisteredWorkspaces();
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };

    expect(request).toEqual({
      id: request.id,
      method: "workspace/list",
      params: { cursor: null, limit: 100 },
    });
    expect(JSON.stringify(request.params)).not.toMatch(/cwd|rootPath/);
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: {
          data: [
            { workspaceKey: "workspace-key-1", displayName: "cuican-aide" },
          ],
          nextCursor: null,
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      data: [{ workspaceKey: "workspace-key-1", displayName: "cuican-aide" }],
    });
  });

  it("creates Experts with the exact server DTO and drops UI-only fields", async () => {
    const client = new AppServerClient("ws://app-server", () => undefined);
    const socket = await connectFakeClient(client);
    const input = {
      kind: "experts",
      cwd: "/repo/private",
      filePath: "/repo/.crewon/experts/review.json",
      title: "代码审阅专家团",
      goal: "审阅改动并汇总结论",
      leader: {
        name: "审阅团长",
        role: "分派任务并汇总结论",
        agentType: "worker" as const,
      },
      experts: [
        {
          name: "风险专家",
          role: "定位逻辑与安全风险",
          agentType: "explorer" as const,
        },
      ],
    };

    const pending = client.createExpertTeam("workspace-key-1", input);
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      id: number;
      method: string;
      params: unknown;
    };

    expect(request).toEqual({
      id: request.id,
      method: "expertTeam/create",
      params: {
        workspaceKey: "workspace-key-1",
        title: "代码审阅专家团",
        goal: "审阅改动并汇总结论",
        leader: {
          name: "审阅团长",
          role: "分派任务并汇总结论",
          agentType: "worker",
        },
        experts: [
          {
            name: "风险专家",
            role: "定位逻辑与安全风险",
            agentType: "explorer",
          },
        ],
      },
    });
    expect(JSON.stringify(request.params)).not.toMatch(/cwd|filePath|kind/);
    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        id: request.id,
        result: { record: null },
      }),
    );

    await pending;
  });
});

describe("app server notifications", () => {
  it("forwards the experimental resource binding projection notification", () => {
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
        method: "resource/binding/updated",
        params: {
          binding: {
            connectionId: "connection-1",
            binding: {
              bindingId: "binding-1",
              workspaceKey: "workspace-1",
              resource: {
                providerId: "agent-platform",
                resourceId: "skill-1",
                revision: "r1",
                resourceType: "skill",
              },
              mode: "remoteReference",
              executionLocation: "provider",
            },
            workspaceScope: "conversation",
            workspaceScopeId: "thread-1",
            status: "active",
            revision: 1,
            updatedAt: 2,
          },
        },
      }),
    );

    expect(notifications).toEqual([
      expect.objectContaining({ method: "resource/binding/updated" }),
    ]);
  });

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

  it("publishes workflow run updates to local subscribers", () => {
    const notifications: unknown[] = [];
    const workflowUpdates: unknown[] = [];
    const client = new AppServerClient("ws://app-server", (notification) => {
      notifications.push(notification);
    });
    const unsubscribe = client.subscribeWorkflowRunUpdates((notification) => {
      workflowUpdates.push(notification);
    });

    (
      client as unknown as {
        handleMessage: (rawData: string) => void;
      }
    ).handleMessage(
      JSON.stringify({
        method: "workflow/run/updated",
        params: {
          cwd: "/repo",
          filePath: "/repo/.crewon/workflows/workflow.json",
          reason: "terminalTurnSynced",
          sourceThreadId: "agent-thread",
          sourceTurnId: "turn-agent",
          config: {
            workflowId: "workflow-1",
            status: "ready",
          },
        },
      }),
    );
    unsubscribe();

    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        reason: "terminalTurnSynced",
        sourceTurnId: "turn-agent",
      }),
    ]);
    expect(notifications).toEqual([
      expect.objectContaining({ method: "workflow/run/updated" }),
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
