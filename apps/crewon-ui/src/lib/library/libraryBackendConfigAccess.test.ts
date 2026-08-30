import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type { BackendWorkspace } from "../backend/backendWorkspace";
import type { AgentConfig, AutomationConfig, OfficeConfig } from "../domain/crewonDomain";
import {
  createBackendAutomationConfig,
  createBackendOfficeConfig,
  listBackendAutomationRuns,
  listBackendAgentConfigs,
  listBackendOfficeConfigs,
  readBackendAgentConfig,
  readBackendAutomationConfig,
  readBackendOfficeConfig,
  updateBackendAutomationConfig,
  updateBackendAutomationConfigPath,
} from "./libraryBackendConfigAccess";

function workspace(client: Partial<AppServerClient>): BackendWorkspace {
  return {
    client: client as AppServerClient,
    cwd: "/repo",
  };
}

function officeConfig(title: string): OfficeConfig {
  return {
    title,
    subtitle: "Office",
    workspace: {
      goal: "Ship it",
      members: [],
      messages: [],
      tasks: [],
    },
  };
}

function automationConfig(title: string): AutomationConfig {
  return {
    title,
    subtitle: "Automation",
    body: "Run",
    prompt: "Run this",
  };
}

function agentConfig(name: string): AgentConfig {
  return {
    name,
    glyph: "A",
    accent: "blue",
    role: "Engineer",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Help",
    mcp: [],
    skills: [],
  };
}

describe("library backend config access", () => {
  it("creates office configs through an optional workspace", async () => {
    const config = officeConfig("Planning");
    const createOfficeConfig = vi.fn(async () => ({
      config,
      filePath: "/repo/.crewon/offices/planning.json",
    }));

    await expect(
      createBackendOfficeConfig(
        async () => workspace({ createOfficeConfig }),
        {
          title: "Planning",
          subtitle: "Office",
          threadId: "thread-1",
          goal: "Ship it",
        },
      ),
    ).resolves.toEqual({
      config,
      filePath: "/repo/.crewon/offices/planning.json",
    });
    expect(createOfficeConfig).toHaveBeenCalledWith("/repo", {
      title: "Planning",
      subtitle: "Office",
      threadId: "thread-1",
      goal: "Ship it",
    });

    await expect(
      createBackendOfficeConfig(async () => null, {
        title: "Planning",
        subtitle: "Office",
        threadId: "thread-1",
        goal: "Ship it",
      }),
    ).resolves.toBeNull();
  });

  it("creates automation configs with backend-enabled records", async () => {
    const config = automationConfig("Nightly");
    const createAutomationConfig = vi.fn(async () => ({
      config,
      filePath: "/repo/.crewon/automations/nightly.json",
    }));

    await expect(
      createBackendAutomationConfig(
        async () => workspace({ createAutomationConfig }),
        {
          title: "Nightly",
          threadId: "thread-1",
          targetOffice: officeConfig("Planning"),
          executionAgent: agentConfig("Runner"),
          prompt: "Run checks",
          status: "ready",
        },
      ),
    ).resolves.toEqual({
      config,
      filePath: "/repo/.crewon/automations/nightly.json",
    });
    expect(createAutomationConfig).toHaveBeenCalledWith("/repo", {
      title: "Nightly",
      threadId: "thread-1",
      targetOffice: officeConfig("Planning"),
      executionAgent: agentConfig("Runner"),
      prompt: "Run checks",
      status: "ready",
      enabled: true,
    });
  });

  it("lists agent and office config records through the workspace", async () => {
    const agent = agentConfig("Runner");
    const office = officeConfig("Planning");
    const listAgentConfigs = vi.fn(async () => ({
      data: [{ filePath: "/agents/runner.json", savedAt: "", config: agent }],
      nextCursor: null,
    }));
    const listOfficeConfigs = vi.fn(async () => ({
      data: [{ filePath: "/offices/planning.json", savedAt: "", config: office }],
      nextCursor: null,
    }));
    const backendWorkspace = workspace({ listAgentConfigs, listOfficeConfigs });

    await expect(
      listBackendAgentConfigs(async () => backendWorkspace),
    ).resolves.toEqual([
      { filePath: "/agents/runner.json", savedAt: "", config: agent },
    ]);
    await expect(
      listBackendOfficeConfigs(async () => backendWorkspace),
    ).resolves.toEqual([
      { filePath: "/offices/planning.json", savedAt: "", config: office },
    ]);
    expect(listAgentConfigs).toHaveBeenCalledWith("/repo");
    expect(listOfficeConfigs).toHaveBeenCalledWith("/repo");
  });

  it("updates automation config records through the workspace", async () => {
    const config = automationConfig("Nightly");
    const updateAutomationConfig = vi.fn(async () => ({
      config,
      filePath: "/automations/nightly.json",
    }));

    await expect(
      updateBackendAutomationConfig(
        async () => workspace({ updateAutomationConfig }),
        "/automations/nightly.json",
        config,
      ),
    ).resolves.toEqual({
      config,
      filePath: "/automations/nightly.json",
    });
    expect(updateAutomationConfig).toHaveBeenCalledWith(
      "/repo",
      "/automations/nightly.json",
      config,
    );
  });

  it("updates automation configs when only the persisted path is needed", async () => {
    const config = automationConfig("Nightly");
    const updateAutomationConfig = vi.fn(async () => ({
      config,
      filePath: "/automations/nightly-updated.json",
    }));

    await expect(
      updateBackendAutomationConfigPath(
        async () => workspace({ updateAutomationConfig }),
        "/automations/nightly.json",
        config,
      ),
    ).resolves.toBe("/automations/nightly-updated.json");
    expect(updateAutomationConfig).toHaveBeenCalledWith(
      "/repo",
      "/automations/nightly.json",
      config,
    );

    await expect(
      updateBackendAutomationConfigPath(
        async () => null,
        "/automations/nightly.json",
        config,
      ),
    ).resolves.toBeNull();
  });

  it("reads backend detail records through an optional workspace", async () => {
    const readAgentConfig = vi.fn(async () => ({ record: null }));
    const readAutomationConfig = vi.fn(async () => ({ record: null }));
    const readOfficeConfig = vi.fn(async () => ({ record: null }));
    const listAutomationRuns = vi.fn(async () => ({
      data: [],
      nextCursor: null,
    }));
    const backendWorkspace = workspace({
      listAutomationRuns,
      readAgentConfig,
      readAutomationConfig,
      readOfficeConfig,
    });

    await expect(
      readBackendAgentConfig(async () => backendWorkspace, {
        agentId: "agent-1",
        threadId: null,
        name: "Runner",
      }),
    ).resolves.toEqual({ record: null });
    await expect(
      readBackendAutomationConfig(async () => backendWorkspace, {
        filePath: "/automations/nightly.json",
        threadId: null,
        title: "Nightly",
      }),
    ).resolves.toEqual({ record: null });
    await expect(
      readBackendOfficeConfig(async () => backendWorkspace, {
        threadId: "thread-1",
        title: "Planning",
      }),
    ).resolves.toEqual({ record: null });
    await expect(
      listBackendAutomationRuns(async () => backendWorkspace, "thread-1"),
    ).resolves.toEqual({ data: [], nextCursor: null });

    expect(readAgentConfig).toHaveBeenCalledWith("/repo", {
      agentId: "agent-1",
      threadId: null,
      name: "Runner",
    });
    expect(readAutomationConfig).toHaveBeenCalledWith("/repo", {
      filePath: "/automations/nightly.json",
      threadId: null,
      title: "Nightly",
    });
    expect(readOfficeConfig).toHaveBeenCalledWith("/repo", {
      threadId: "thread-1",
      title: "Planning",
    });
    expect(listAutomationRuns).toHaveBeenCalledWith("/repo", "thread-1");

    await expect(
      readBackendAgentConfig(async () => null, {
        agentId: "agent-1",
        threadId: null,
        name: "Runner",
      }),
    ).resolves.toBeNull();
    await expect(
      readBackendAutomationConfig(async () => null, {
        filePath: "/automations/nightly.json",
        threadId: null,
        title: "Nightly",
      }),
    ).resolves.toBeNull();
    await expect(
      readBackendOfficeConfig(async () => null, {
        threadId: "thread-1",
        title: "Planning",
      }),
    ).resolves.toBeNull();
    await expect(
      listBackendAutomationRuns(async () => null, "thread-1"),
    ).resolves.toBeNull();
  });
});
