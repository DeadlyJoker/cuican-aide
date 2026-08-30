import { describe, expect, it, vi } from "vitest";

import type { MessageView, ThreadView } from "@crewon/contracts";

import type { AgentConfig } from "../domain/crewonDomain";
import {
  ControlExpertRuntime,
  isControlExpertOfficeRecord,
  isInternalControlExpertThread,
  type ControlExpertRuntimeClient,
} from "./controlExpertRuntime";

const now = "2026-08-29T08:00:00.000Z";

describe("Control Expert Runtime", () => {
  it("persists a real three-member Office and reloadable expert metadata", async () => {
    const threads: ThreadView[] = [];
    const messages = new Map<string, MessageView[]>();
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
    const runtime = new ControlExpertRuntime({ client, locale: "zh" });

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
          { name: "数据专家", role: "核验指标", agentType: "explorer" },
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
    expect((await runtime.listExpertTeams())[0]).toEqual(created.record);
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
