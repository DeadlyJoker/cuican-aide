import { describe, expect, it, vi } from "vitest";

import type { MessageView, ThreadView } from "@crewon/contracts";

import type { AgentConfig } from "../domain/crewonDomain";
import {
  officeMemberAgentProfileId,
  readOfficeMemberAgentProfile,
} from "../office/officeMemberAgentProfile";
import {
  ControlExpertRuntime,
  isControlExpertOfficeRecord,
  isInternalControlExpertThread,
  type ControlExpertRuntimeClient,
} from "./controlExpertRuntime";

const now = "2026-08-29T08:00:00.000Z";

describe("Control Expert Runtime", () => {
  it("persists expert metadata and materializes distinct agent-type runtime profiles", async () => {
    const threads: ThreadView[] = [];
    const messages = new Map<string, MessageView[]>();
    const profileStorage = memoryProfileStorage();
    const createOffice = vi.fn(async (body) => ({
      disposition: "committed" as const,
      office: {
        schemaVersion: "crewon.office-definition.v0" as const,
        tenantId: "tenant-1",
        spaceId: "space-1",
        officeId: "office-1",
        officeVersionId: "office-version-1",
        revision: 1,
        title: body.title,
        members: body.members,
        executionTargets: body.executionTargets,
        createdByActorId: "actor-1",
        createdAt: now,
      },
    }));
    const client = {
      createOffice,
      getActiveAgentVersionCatalog: vi.fn(),
      getOffice: vi.fn(),
      listOffices: vi.fn(),
      createThread: vi.fn(async (body) => {
        const created = thread(`thread-${threads.length + 1}`, body.title);
        threads.push(created);
        return { disposition: "committed" as const, thread: created };
      }),
      appendThreadMessage: vi.fn(async (threadId, body) => {
        const item: MessageView = {
          messageId: "message-1",
          threadId,
          sequence: 1,
          role: "user",
          content: body.content,
          proposedPlan: null,
          createdAt: now,
        };
        messages.set(threadId, [item]);
        return {
          disposition: "committed" as const,
          thread: { ...threads[0]!, revision: 2, lastMessageSequence: 1 },
          message: item,
        };
      }),
      listThreads: vi.fn(async () => ({ data: threads, nextCursor: null })),
      listThreadMessages: vi.fn(async (threadId) => ({
        data: messages.get(threadId) ?? [],
        nextCursor: null,
      })),
    } as unknown as ControlExpertRuntimeClient;
    const runtime = new ControlExpertRuntime({
      client,
      locale: "zh",
      profileStorage,
    });

    const created = await runtime.createExpertTeam({
      definition: {
        title: "上线评审专家团",
        goal: "从产品、数据和运维角度给出上线裁决",
        leader: {
          name: "评审组长",
          role: "统一裁决",
          agentType: "worker",
        },
        experts: [
          {
            name: "数据专家",
            role: "核验指标",
            agentType: "explorer",
            instructions: "只使用可追溯材料。".repeat(40),
          },
          { name: "运维专家", role: "评估回滚", agentType: "worker" },
        ],
      },
      agents: [
        {
          filePath: "control:agent:1",
          config: agent("agent-manager", "Manager"),
        },
        {
          filePath: "control:agent:2",
          config: agent("agent-data", "Data"),
        },
      ],
    });

    expect(createOffice).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "专家团 · 上线评审专家团",
        members: [
          expect.objectContaining({ agentVersionId: "agent-manager" }),
          expect.objectContaining({ agentVersionId: "agent-data" }),
          expect.objectContaining({ agentVersionId: "agent-manager" }),
        ],
      }),
      expect.any(String),
    );
    expect(isControlExpertOfficeRecord(created.office)).toBe(true);
    expect(isInternalControlExpertThread(threads[0]!)).toBe(true);
    expect(created.record.config.officeId).toBe("office-1");
    expect((await runtime.listExpertTeams())[0]).toEqual(created.record);

    const leaderProfile = readOfficeMemberAgentProfile(
      officeMemberAgentProfileId("office-version-1", "member-1"),
      profileStorage,
    );
    const explorerProfile = readOfficeMemberAgentProfile(
      officeMemberAgentProfileId("office-version-1", "member-2"),
      profileStorage,
    );
    const workerProfile = readOfficeMemberAgentProfile(
      officeMemberAgentProfileId("office-version-1", "member-3"),
      profileStorage,
    );
    expect(leaderProfile?.role).toContain("角色职责：统一裁决");
    expect(leaderProfile?.role).not.toContain("Manager");
    expect(leaderProfile?.systemPrompt).toContain("Worker：仅将已确认材料");
    expect(leaderProfile?.systemPrompt).toContain("唯一汇总出口");
    expect(leaderProfile?.systemPrompt).toContain("保留未解决分歧");
    expect(explorerProfile?.systemPrompt).toContain(
      "Explorer：枚举证据、冲突、假设和未知",
    );
    expect(explorerProfile?.systemPrompt).toContain("证据不足时不得收敛");
    expect(explorerProfile?.role).not.toContain("Data");
    expect(explorerProfile?.role.length).toBeLessThanOrEqual(240);
    expect(workerProfile?.systemPrompt).toContain(
      "Worker：仅将已确认材料转成可执行方案、验收动作和完成标准",
    );
    expect(workerProfile?.systemPrompt).toContain("不得补造事实或证据");
    expect(workerProfile?.systemPrompt).not.toBe(explorerProfile?.systemPrompt);
  });

  it("hydrates stable Office identity for a legacy Experts record", async () => {
    const expertsId = "office-version-legacy";
    const legacyConfig = {
      expertsId,
      title: "历史评审",
      goal: "恢复历史专家团",
      leader: { name: "组长", role: "裁决", agentType: "worker" },
      experts: [
        { name: "专家一", role: "核验", agentType: "explorer" },
        { name: "专家二", role: "执行", agentType: "worker" },
      ],
      recordRevision: now,
      workspaceKey: "control",
      ownerSubject: "control-session",
    };
    const marker = thread(
      "thread-legacy",
      `__crewon_experts_definition__:${encodeURIComponent(expertsId)}`,
    );
    const getOffice = vi.fn(async () => ({
      office: {
        schemaVersion: "crewon.office-definition.v0" as const,
        tenantId: "tenant-1",
        spaceId: "space-1",
        officeId: "office-stable-legacy",
        officeVersionId: expertsId,
        revision: 1,
        title: "专家团 · 历史评审",
        members: ["lead", "expert-1", "expert-2"].map((memberId) => ({
          memberId,
          displayName: memberId,
          agentVersionId: `agent-${memberId}`,
        })),
        executionTargets: ["lead", "expert-1", "expert-2"].map((memberId) => ({
          targetId: `target-${memberId}`,
          agentVersionId: `agent-${memberId}`,
        })),
        createdByActorId: "actor-1",
        createdAt: now,
      },
    }));
    const runtime = new ControlExpertRuntime({
      client: {
        getOffice,
        listThreads: vi.fn(async () => ({ data: [marker], nextCursor: null })),
        listThreadMessages: vi.fn(async () => ({
          data: [
            {
              messageId: "message-legacy",
              threadId: marker.threadId,
              sequence: 1,
              role: "user" as const,
              content: `[Control Experts · definition]\n${JSON.stringify(legacyConfig)}`,
              proposedPlan: null,
              createdAt: now,
            },
          ],
          nextCursor: null,
        })),
      } as unknown as ControlExpertRuntimeClient,
      locale: "zh",
    });

    expect((await runtime.listExpertTeams())[0]?.config).toEqual({
      ...legacyConfig,
      officeId: "office-stable-legacy",
    });
    expect(getOffice).toHaveBeenCalledWith(expertsId);
  });
});

function agent(agentId: string, name: string): AgentConfig {
  return {
    agentId,
    name,
    role: "Control AgentVersion",
    glyph: "A",
    accent: "cyan",
    model: "gpt-test",
    models: ["gpt-test"],
    permission: "Control policy",
    permissions: ["Control policy"],
    systemPrompt: "",
    mcp: [],
    skills: [],
  };
}

function thread(threadId: string, title: string | null): ThreadView {
  return {
    threadId,
    title,
    status: "active",
    revision: 1,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  };
}

function memoryProfileStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
