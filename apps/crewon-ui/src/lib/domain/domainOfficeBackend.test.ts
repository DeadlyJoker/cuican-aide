import { describe, expect, it } from "vitest";

import { AppServerRpcError, type AppServerClient } from "../app-server/appServer";
import type {
  OfficeConfig,
  OfficeMember,
  OfficeMessage,
  OfficeRunActivity,
  OfficeWorkspace,
} from "./crewonDomain";
import {
  cancelAppOfficeDelegation,
  cancelAppOfficeRun,
  cancelAppOfficeVerification,
  decideAppOfficeApproval,
  decideAppOfficeMemory,
  dispatchAppOfficeDelegation,
  dispatchNextAppOfficeDelegation,
  listAppOfficeMemories,
  persistAppOfficeMember,
  persistAppOfficeMessage,
  persistAppOfficeWorkspace,
  previewAppOfficeMemberContext,
  retryAppOfficeDelegation,
  retryAppOfficeVerification,
  retryAppOfficeRun,
  runAppOfficeMessage,
  writeAppOfficeConfig,
} from "./domainOfficeBackend";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship the refactor",
    members: [],
    messages: [],
    tasks: [],
    threadId: "thread-1",
    ...overrides,
  };
}

function officeConfig(overrides: Partial<OfficeConfig> = {}): OfficeConfig {
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

  it("cancels an app office delegation through the backend workspace", async () => {
    const nextConfig = officeConfig();
    const captures: unknown[] = [];
    const result = await cancelAppOfficeDelegation({
      client: client({
        async cancelOfficeDelegationConfig(cwd, config, runId, delegationId, params) {
          captures.push({ cwd, config, runId, delegationId, params });
          return {
            config: nextConfig,
            filePath: ".crewon/offices/frontend.json",
          };
        },
      }),
      delegation: {
        id: "delegation-1",
        member: "Reviewer",
        status: "running",
        task: "Review",
        threadId: "member-thread",
        turnId: "member-turn",
      },
      locale: "en",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity(),
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        delegationId: "delegation-1",
        params: { locale: "en", threadId: "member-thread", turnId: "member-turn" },
        runId: "run-1",
      },
    ]);
    expect(result).toEqual({
      cwd: "/repo",
      response: {
        config: nextConfig,
        filePath: ".crewon/offices/frontend.json",
      },
    });
  });

  it("cancels an app office verification through the backend workspace", async () => {
    const nextConfig = officeConfig();
    const captures: unknown[] = [];
    const result = await cancelAppOfficeVerification({
      check: {
        check: "Run smoke",
        status: "pending",
        automationId: "smoke",
        automationThreadId: "automation-thread",
        automationTurnId: "automation-turn",
        dispatchStatus: "running",
      },
      client: client({
        async cancelOfficeVerificationConfig(
          cwd,
          config,
          runId,
          verificationCheckId,
          params,
        ) {
          captures.push({ cwd, config, runId, verificationCheckId, params });
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
        params: {
          locale: "en",
          threadId: "automation-thread",
          turnId: "automation-turn",
        },
        runId: "run-1",
        verificationCheckId: "smoke",
      },
    ]);
    expect(result).toEqual({
      cwd: "/repo",
      response: {
        config: nextConfig,
        filePath: ".crewon/offices/frontend.json",
      },
    });
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

  it("sends review-aware retry text to the backend", async () => {
    const captures: unknown[] = [];
    await retryAppOfficeRun({
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
      run: runActivity({
        requestText: "Ship release",
        loop: {
          review: {
            status: "blocked",
            nextAction: "repairFailedCriteria",
          },
        },
        acceptanceCriteria: [
          {
            criterion: "All checks pass",
            status: "failed",
            evidence: "Integration test failed",
          },
        ],
      }),
      workspace: workspace(),
    });

    expect(captures).toHaveLength(1);
    expect(
      (
        captures[0] as {
          params: { text: string };
        }
      ).params.text,
    ).toContain("Continue the previous Office Loop");
    expect(
      (
        captures[0] as {
          params: { text: string };
        }
      ).params.text,
    ).toContain("All checks pass");
  });

  it("dispatches an app office delegation through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await dispatchAppOfficeDelegation({
      agentId: "agent-reviewer",
      client: client({
        async dispatchOfficeDelegationConfig(cwd, config, runId, task, params) {
          captures.push({ cwd, config, runId, task, params });
          return {
            config: officeConfig(),
            delegationId: "delegation-1",
            filePath: ".crewon/offices/frontend.json",
            runId,
            threadId: "reviewer-thread",
            turn: { id: "turn-reviewer" },
          } as Awaited<
            ReturnType<AppServerClient["dispatchOfficeDelegationConfig"]>
          >;
        },
      }),
      clientUserMessageId: "delegate-1",
      locale: "en",
      member: "Reviewer",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity(),
      task: "Review the backend design",
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        params: {
          agentId: "agent-reviewer",
          clientUserMessageId: "delegate-1",
          locale: "en",
          member: "Reviewer",
        },
        runId: "run-1",
        task: "Review the backend design",
      },
    ]);
    expect(result).toMatchObject({
      cwd: "/repo",
      response: {
        delegationId: "delegation-1",
        threadId: "reviewer-thread",
      },
    });
  });

  it("retries an app office delegation through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await retryAppOfficeDelegation({
      client: client({
        async retryOfficeDelegationConfig(
          cwd,
          config,
          runId,
          delegationId,
          params,
        ) {
          captures.push({ cwd, config, runId, delegationId, params });
          return {
            config: officeConfig(),
            delegationId: "delegation-retry",
            filePath: ".crewon/offices/frontend.json",
            retryOfDelegationId: delegationId,
            runId,
            threadId: "reviewer-thread",
            turn: { id: "turn-reviewer-retry" },
          } as Awaited<
            ReturnType<AppServerClient["retryOfficeDelegationConfig"]>
          >;
        },
      }),
      clientUserMessageId: "delegate-retry-1",
      delegation: {
        id: "delegation-1",
        agentId: "agent-reviewer",
        member: "Reviewer",
        status: "failed",
        task: "Review the backend design",
      },
      locale: "en",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity(),
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        delegationId: "delegation-1",
        params: {
          clientUserMessageId: "delegate-retry-1",
          locale: "en",
        },
        runId: "run-1",
      },
    ]);
    expect(result).toMatchObject({
      cwd: "/repo",
      response: {
        delegationId: "delegation-retry",
        retryOfDelegationId: "delegation-1",
        threadId: "reviewer-thread",
      },
    });
  });

  it("retries an app office verification check through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await retryAppOfficeVerification({
      client: client({
        async retryOfficeVerificationConfig(
          cwd,
          config,
          runId,
          verificationCheckId,
          params,
        ) {
          captures.push({ cwd, config, runId, verificationCheckId, params });
          return {
            config: officeConfig(),
            filePath: ".crewon/offices/frontend.json",
            runId,
            verificationCheckId,
            automationId: "nightly-smoke",
            automationRunFilePath:
              ".crewon/automation-runs/nightly-smoke.json",
            automationRunId: "automation-run-retry",
            retryOfAutomationTurnId: "automation-turn-old",
            threadId: "automation-thread",
            turn: { id: "automation-turn-retry" },
          } as Awaited<
            ReturnType<AppServerClient["retryOfficeVerificationConfig"]>
          >;
        },
      }),
      check: {
        itemId: "verification-1",
        automationId: "nightly-smoke",
        check: "Run smoke automation",
        status: "failed",
      },
      clientUserMessageId: "verification-retry-1",
      locale: "en",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity(),
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        verificationCheckId: "verification-1",
        params: {
          clientUserMessageId: "verification-retry-1",
          locale: "en",
        },
        runId: "run-1",
      },
    ]);
    expect(result).toMatchObject({
      cwd: "/repo",
      response: {
        verificationCheckId: "verification-1",
        retryOfAutomationTurnId: "automation-turn-old",
        threadId: "automation-thread",
      },
    });
  });

  it("dispatches the next app office delegation through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await dispatchNextAppOfficeDelegation({
      client: client({
        async dispatchNextOfficeDelegationConfig(cwd, config, runId, params) {
          captures.push({ cwd, config, runId, params });
          return {
            config: officeConfig(),
            delegationId: "delegation-1",
            filePath: ".crewon/offices/frontend.json",
            runId,
            threadId: "reviewer-thread",
            turn: { id: "turn-reviewer" },
          } as Awaited<
            ReturnType<AppServerClient["dispatchNextOfficeDelegationConfig"]>
          >;
        },
      }),
      clientUserMessageId: "delegate-next-1",
      dispatchPolicy: "auto",
      locale: "en",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity(),
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        params: {
          clientUserMessageId: "delegate-next-1",
          dispatchPolicy: "auto",
          locale: "en",
        },
        runId: "run-1",
      },
    ]);
    expect(result).toMatchObject({
      cwd: "/repo",
      response: {
        delegationId: "delegation-1",
        threadId: "reviewer-thread",
      },
    });
  });

  it("previews app office member context through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await previewAppOfficeMemberContext({
      agentId: "agent-reviewer",
      client: client({
        async previewOfficeMemberContextConfig(cwd, config, runId, params) {
          captures.push({ cwd, config, runId, params });
          return {
            agentId: "agent-reviewer",
            agentProfile: "Review release readiness.",
            contextPolicy: "sharedDigest",
            memoryContext: "Member memories: no accepted memories.",
            memoryScope: "privateAndShared",
            member: "Reviewer",
            runId,
            sharedContext: "Shared Office digest",
            threadId: "reviewer-thread",
          };
        },
      }),
      locale: "en",
      member: "Reviewer",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      run: runActivity({ title: "Review launch" }),
      task: "Review launch",
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        params: {
          agentId: "agent-reviewer",
          locale: "en",
          member: "Reviewer",
          task: "Review launch",
        },
        runId: "run-1",
      },
    ]);
    expect(result).toMatchObject({
      cwd: "/repo",
      response: {
        contextPolicy: "sharedDigest",
        member: "Reviewer",
        threadId: "reviewer-thread",
      },
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

  it("lists app office memories through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await listAppOfficeMemories({
      client: client({
        async listOfficeMemories(cwd, config, params) {
          captures.push({ cwd, config, params });
          return {
            data: [
              {
                id: "memory-1",
                officeKey: "thread-1",
                scope: "office",
                member: null,
                agentId: null,
                kind: "decision",
                content: "Use the launch checklist",
                confidence: "medium",
                importance: "medium",
                status: "pending",
                evidenceRefs: [],
                keywords: ["launch"],
                createdAt: "2026-06-20T00:00:00Z",
                updatedAt: "2026-06-20T00:00:00Z",
                lastUsedAt: null,
                usageCount: 0,
              },
            ],
            nextCursor: null,
          };
        },
      }),
      cursor: "24",
      limit: 12,
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      status: "pending",
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
        params: { cursor: "24", limit: 12, status: "pending" },
      },
    ]);
    expect(result?.cwd).toBe("/repo");
    expect(result?.response?.data[0]?.content).toBe("Use the launch checklist");
  });

  it("decides an app office memory through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await decideAppOfficeMemory({
      client: client({
        async decideOfficeMemory(cwd, config, memoryId, status) {
          captures.push({ cwd, config, memoryId, status });
          return {
            memory: {
              id: memoryId,
              officeKey: "thread-1",
              scope: "office",
              member: null,
              agentId: null,
              kind: "decision",
              content: "Use the launch checklist",
              confidence: "medium",
              importance: "medium",
              status,
              evidenceRefs: [],
              keywords: ["launch"],
              createdAt: "2026-06-20T00:00:00Z",
              updatedAt: "2026-06-20T00:00:00Z",
              lastUsedAt: null,
              usageCount: 0,
            },
          };
        },
      }),
      memoryId: "memory-1",
      panel: { title: "Frontend Office", subtitle: "Architecture" },
      resolveBackendCwd: async () => "/repo",
      status: "accepted",
      threadId: "thread-1",
      workspace: workspace(),
    });

    expect(captures).toMatchObject([
      {
        cwd: "/repo",
        memoryId: "memory-1",
        status: "accepted",
      },
    ]);
    expect(result?.cwd).toBe("/repo");
    expect(result?.response?.memory.status).toBe("accepted");
  });

  it("skips office memory review calls when the backend RPCs are unavailable", async () => {
    await expect(
      listAppOfficeMemories({
        client: client({
          async listOfficeMemories() {
            throw new AppServerRpcError("unsupported", -32601);
          },
        }),
        panel: { title: "Frontend Office", subtitle: "Architecture" },
        resolveBackendCwd: async () => "/repo",
        status: "pending",
        threadId: "thread-1",
        workspace: workspace(),
      }),
    ).resolves.toEqual({ cwd: "/repo", response: null });

    await expect(
      decideAppOfficeMemory({
        client: client({
          async decideOfficeMemory() {
            throw new AppServerRpcError("unsupported", -32601);
          },
        }),
        memoryId: "memory-1",
        panel: { title: "Frontend Office", subtitle: "Architecture" },
        resolveBackendCwd: async () => "/repo",
        status: "rejected",
        threadId: "thread-1",
        workspace: workspace(),
      }),
    ).resolves.toEqual({ cwd: "/repo", response: null });
  });
});
