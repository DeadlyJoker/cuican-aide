import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type {
  OfficeConfig,
  OfficeMember,
  OfficeMessage,
  OfficeRunActivity,
  OfficeWorkspace,
} from "./crewonDomain";
import {
  cancelAppOfficeRun,
  decideAppOfficeApproval,
  persistAppOfficeMember,
  persistAppOfficeMessage,
  persistAppOfficeWorkspace,
  retryAppOfficeRun,
  runAppOfficeMessage,
  writeAppOfficeConfig,
} from "./domainOfficeBackend";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function workspace(
  overrides: Partial<OfficeWorkspace> = {},
): OfficeWorkspace {
  return {
    goal: "Ship the refactor",
    members: [],
    messages: [],
    tasks: [],
    threadId: "thread-1",
    ...overrides,
  };
}

function officeConfig(
  overrides: Partial<OfficeConfig> = {},
): OfficeConfig {
  return {
    title: "Frontend Office",
    subtitle: "Architecture",
    workspace: workspace(),
    ...overrides,
  };
}

function message(overrides: Partial<OfficeMessage> = {}): OfficeMessage {
  return {
    accent: "blue",
    author: "Designer",
    glyph: "D",
    text: "Keep the UI clean",
    time: "now",
    ...overrides,
  };
}

function member(overrides: Partial<OfficeMember> = {}): OfficeMember {
  return {
    accent: "green",
    glyph: "A",
    name: "Reviewer",
    role: "Review architecture",
    status: "ready",
    ...overrides,
  };
}

function runActivity(
  overrides: Partial<OfficeRunActivity> = {},
): OfficeRunActivity {
  return {
    id: "run-1",
    status: "running",
    threadId: "thread-1",
    title: "Run automation",
    turnId: "turn-1",
    ...overrides,
  };
}

describe("domain office backend", () => {
  it("skips app office config writes when the backend workspace is unavailable", async () => {
    await expect(
      writeAppOfficeConfig({
        client: client({
          async saveOfficeConfig() {
            throw new Error("unexpected save");
          },
        }),
        config: officeConfig(),
        resolveBackendCwd: async () => "",
      }),
    ).resolves.toBeNull();
  });

  it("writes an app office config through the resolved backend workspace", async () => {
    const config = officeConfig();
    const captures: unknown[] = [];
    const result = await writeAppOfficeConfig({
      client: client({
        async saveOfficeConfig(cwd, nextConfig) {
          captures.push({ cwd, nextConfig });
          return { filePath: ".crewon/offices/frontend.json" };
        },
      }),
      config,
      resolveBackendCwd: async () => "/repo",
    });

    expect(captures).toEqual([{ cwd: "/repo", nextConfig: config }]);
    expect(result).toBe(".crewon/offices/frontend.json");
  });

  it("persists an app office workspace with the panel identity", async () => {
    const captures: unknown[] = [];
    const result = await persistAppOfficeWorkspace({
      client: client({
        async saveOfficeConfig(cwd, config) {
          captures.push({ cwd, config });
          return { filePath: ".crewon/offices/frontend.json" };
        },
      }),
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      threadId: "thread-1",
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        config: {
          subtitle: "Architecture",
          title: "Frontend Office",
          workspace: { threadId: "thread-1" },
        },
      },
    ]);
    expect(result).toBe(".crewon/offices/frontend.json");
  });

  it("persists an app office message through the backend workspace", async () => {
    const nextConfig = officeConfig({
      workspace: workspace({ messages: [message()] }),
    });
    const captures: unknown[] = [];
    const result = await persistAppOfficeMessage({
      client: client({
        async sendOfficeMessageConfig(cwd, config, nextMessage, text, locale) {
          captures.push({ cwd, config, nextMessage, text, locale });
          return {
            config: nextConfig,
            filePath: ".crewon/offices/frontend.json",
          };
        },
      }),
      fallbackWorkspace: workspace(),
      locale: "en",
      message: message(),
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      text: "Keep the UI clean",
      threadId: "thread-1",
      workspaceBeforeMessage: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        locale: "en",
        nextMessage: { text: "Keep the UI clean" },
        text: "Keep the UI clean",
      },
    ]);
    expect(result).toBe(nextConfig);
  });

  it("runs an app office message through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await runAppOfficeMessage({
      client: client({
        async runOfficeConfig(
          cwd,
          config,
          nextMessage,
          text,
          locale,
          threadId,
        ) {
          captures.push({ cwd, config, nextMessage, text, locale, threadId });
          return {
            config: officeConfig(),
            filePath: ".crewon/offices/frontend.json",
            runId: "run-1",
            threadId: "thread-1",
            turn: { id: "turn-1" },
          } as Awaited<ReturnType<AppServerClient["runOfficeConfig"]>>;
        },
      }),
      fallbackWorkspace: workspace(),
      locale: "en",
      message: message(),
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      text: "Keep the UI clean",
      threadId: "thread-1",
      workspaceBeforeMessage: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        locale: "en",
        nextMessage: { text: "Keep the UI clean" },
        text: "Keep the UI clean",
        threadId: "thread-1",
      },
    ]);
    expect(result).toMatchObject({
      cwd: "/repo",
      handled: true,
      response: { runId: "run-1", threadId: "thread-1" },
    });
  });

  it("cancels an app office run through the backend workspace", async () => {
    const nextConfig = officeConfig();
    const captures: unknown[] = [];
    const result = await cancelAppOfficeRun({
      client: client({
        async cancelOfficeRunConfig(cwd, config, runId, params) {
          captures.push({ cwd, config, runId, params });
          return {
            config: nextConfig,
            filePath: ".crewon/offices/frontend.json",
          };
        },
      }),
      locale: "en",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity(),
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        params: { locale: "en", threadId: "thread-1", turnId: "turn-1" },
        runId: "run-1",
      },
    ]);
    expect(result).toBe(nextConfig);
  });

  it("retries an app office run through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await retryAppOfficeRun({
      client: client({
        async retryOfficeRunConfig(cwd, config, runId, params) {
          captures.push({ cwd, config, runId, params });
          return {
            config: officeConfig(),
            filePath: ".crewon/offices/frontend.json",
            runId: "run-2",
            threadId: "thread-1",
            turn: { id: "turn-2" },
          } as Awaited<ReturnType<AppServerClient["retryOfficeRunConfig"]>>;
        },
      }),
      clientUserMessageId: "retry-1",
      locale: "en",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity({ requestText: "Try again" }),
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        params: {
          clientUserMessageId: "retry-1",
          locale: "en",
          text: "Try again",
        },
        runId: "run-1",
      },
    ]);
    expect(result).toMatchObject({
      cwd: "/repo",
      response: { runId: "run-2", threadId: "thread-1" },
    });
  });

  it("skips app office member persistence before resolving workspace when no agent id exists", async () => {
    await expect(
      persistAppOfficeMember({
        agentId: undefined,
        client: client(),
        member: member(),
        panel: { title: "Frontend Office", subtitle: "Architecture" },
        resolveBackendCwd: async () => {
          throw new Error("unexpected resolve");
        },
        threadId: "thread-1",
        workspaceBeforeMember: workspace(),
      }),
    ).resolves.toBeNull();
  });

  it("persists an app office member through the backend workspace", async () => {
    const nextConfig = officeConfig({
      workspace: workspace({ members: [member({ agentId: "agent-1" })] }),
    });
    const captures: unknown[] = [];
    const result = await persistAppOfficeMember({
      agentId: "agent-1",
      client: client({
        async addOfficeMemberConfig(cwd, config, agentId, nextMember) {
          captures.push({ cwd, config, agentId, nextMember });
          return {
            config: nextConfig,
            filePath: ".crewon/offices/frontend.json",
          };
        },
      }),
      member: member({ agentId: "agent-1" }),
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      threadId: "thread-1",
      workspaceBeforeMember: workspace(),
    });

    expect(captures).toMatchObject([
      {
        agentId: "agent-1",
        cwd: "/repo",
        nextMember: { agentId: "agent-1", name: "Reviewer" },
      },
    ]);
    expect(result).toBe(nextConfig);
  });

  it("decides an app office approval through the backend workspace", async () => {
    const nextConfig = officeConfig();
    const captures: unknown[] = [];
    const result = await decideAppOfficeApproval({
      approvalId: "approval-1",
      client: client({
        async decideOfficeApprovalConfig(
          cwd,
          config,
          approvalId,
          decision,
          nextMessage,
        ) {
          captures.push({ cwd, config, approvalId, decision, nextMessage });
          return {
            config: nextConfig,
            filePath: ".crewon/offices/frontend.json",
          };
        },
      }),
      decision: "approved",
      message: message({ text: "Approved" }),
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      threadId: "thread-1",
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        approvalId: "approval-1",
        cwd: "/repo",
        decision: "approved",
        nextMessage: { text: "Approved" },
      },
    ]);
    expect(result).toBe(nextConfig);
  });
});
