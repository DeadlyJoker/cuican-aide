import { describe, expect, it } from "vitest";

import {
  executionTargetOptions,
  executionTargetOptionsFromDomain,
  modeMayWrite,
  scenePresets,
} from "./sceneCatalog";

describe("sceneCatalog", () => {
  it("defines distinct modes, context, deliverables, and quick actions", () => {
    expect(scenePresets.office).not.toEqual(scenePresets.code);
    expect(scenePresets.code).not.toEqual(scenePresets.design);
    expect(scenePresets.office.modes.map((mode) => mode.value)).toEqual([
      "auto",
      "organize",
      "write",
      "analyze",
      "coordinate",
    ]);
    expect(scenePresets.code.modes.map((mode) => mode.value)).toEqual([
      "auto",
      "ask",
      "plan",
      "implement",
      "review",
    ]);
    expect(scenePresets.design.modes.map((mode) => mode.value)).toEqual([
      "auto",
      "explore",
      "refine",
      "produce",
      "inspect",
    ]);
  });

  it("exposes persisted Agents and only ready Teams as execution targets", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [{
        filePath: "/repo/.crewon/agents/reviewer.json",
        config: {
          agentId: "agent-reviewer",
          name: "审阅智能体",
          role: "检查实现风险",
        } as never,
      }],
      offices: [
        {
          filePath: "/repo/.crewon/offices/delivery.json",
          config: {
            title: "交付小队",
            workspace: { members: [{ name: "Builder" }] },
          } as never,
        },
        {
          filePath: "/repo/.crewon/offices/empty.json",
          config: {
            title: "空小队",
            workspace: { members: [] },
          } as never,
        },
      ],
      status: "ready",
    });

    expect(options).toMatchObject([
      { value: "crewon", strategy: "single" },
      { value: "agent:agent-reviewer", strategy: "single" },
      { value: "team:交付小队", strategy: "team" },
      { value: "team:空小队", strategy: "team", disabled: true },
    ]);
  });

  it("deduplicates offices with the same execution target value", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [],
      offices: [
        {
          filePath: "/repo/.crewon/offices/a.json",
          config: {
            title: "重复小队",
            workspace: { members: [{ name: "Agent A" }] },
          } as never,
        },
        {
          filePath: "/repo/.crewon/offices/b.json",
          config: {
            title: "重复小队",
            workspace: { members: [{ name: "Agent B" }] },
          } as never,
        },
      ],
      status: "ready",
    });

    expect(options.filter((option) => option.value === "team:重复小队")).toHaveLength(1);
  });

  it("defaults to CrewON and exposes only real active agents", () => {
    const options = executionTargetOptions({
      agents: [
        {
          id: 1,
          api_enabled: true,
          is_active: true,
          name: "产品审阅",
          resource_source: "catalog",
        },
        { id: 2, is_active: false, name: "已停用" },
      ],
      knowledgeBases: [],
      mcpServers: [],
      mcpTools: [],
      skills: [],
      workflows: [],
    });

    expect(options).toEqual([
      {
        detail: "本地 Agent，独立完成任务",
        kind: "crewon",
        label: "CrewON",
        strategy: "single",
        value: "crewon",
      },
      {
        detail: "智能体定义已同步，Execution Target Runtime 尚未接入",
        disabled: true,
        kind: "agent",
        label: "产品审阅 · 单 Agent",
        strategy: "single",
        value: "agent:1",
      },
      {
        detail: "服务端 Team Runtime 与小队目录尚未接入",
        disabled: true,
        kind: "team",
        label: "选择已有小队 · 暂不可用",
        strategy: "team",
        value: "team:unavailable",
      },
    ]);
    expect(
      executionTargetOptions(
        {
          agents: [
            {
              id: 1,
              api_enabled: true,
              is_active: true,
              name: "产品审阅",
              resource_source: "catalog",
            },
          ],
          knowledgeBases: [],
          mcpServers: [],
          mcpTools: [],
          skills: [],
          workflows: [],
        },
        { agent: true, team: false },
      )[1],
    ).toMatchObject({ disabled: false, value: "agent:1" });
  });

  it("enables active API-enabled platform Agents without requiring a download", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [],
      offices: [],
      platformAgents: [
        {
          id: 1,
          name: "Local Agent",
          api_enabled: true,
          is_active: true,
          resource_source: "local",
        },
        {
          id: 2,
          name: "Catalog Agent",
          api_enabled: true,
          is_active: true,
          resource_source: "catalog",
        },
        {
          id: 3,
          name: "Closed Agent",
          api_enabled: false,
          is_active: true,
          resource_source: "local",
        },
        {
          id: 4,
          name: "Unknown Agent",
          resource_source: "local",
        },
      ],
      status: "ready",
    });

    expect(options.slice(1)).toMatchObject([
      {
        detail: "通过 Agent Platform Open API 执行",
        value: "agent-platform:agents:1",
      },
      {
        detail: "通过 Agent Platform Open API 执行",
        value: "agent-platform:agents:2",
      },
    ]);
    expect(options).not.toContainEqual(
      expect.objectContaining({ value: "agent-platform:agents:3" }),
    );
    expect(options).not.toContainEqual(
      expect.objectContaining({ value: "agent-platform:agents:4" }),
    );
  });

  it("marks only write-capable modes for the draft-only risk notice", () => {
    expect(modeMayWrite("implement")).toBe(true);
    expect(modeMayWrite("produce")).toBe(true);
    expect(modeMayWrite("review")).toBe(false);
    expect(modeMayWrite("auto")).toBe(false);
  });
});
