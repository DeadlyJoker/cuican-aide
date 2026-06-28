import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type { AgentConfig, OfficeConfig, OfficeMember } from "./crewonDomain";
import {
  listAppRecruitableAgentConfigs,
  readAppLatestOfficeConfig,
  readAppRecruitableAgentConfig,
} from "./domainCollaborationBackend";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Agent",
    glyph: "A",
    accent: "blue",
    role: "Build",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Work",
    mcp: [],
    skills: [],
    ...overrides,
  };
}

function officeConfig(overrides: Partial<OfficeConfig> = {}): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: {
      goal: "Ship",
      members: [],
      messages: [],
      tasks: [],
      threadId: "thread-1",
    },
    ...overrides,
  };
}

describe("domain collaboration backend app helpers", () => {
  it("skips recruitable agent reads while disconnected", async () => {
    let resolved = false;

    await expect(
      readAppRecruitableAgentConfig({
        client: client(),
        existingMembers: [],
        isConnected: false,
        resolveBackendCwd: async () => {
          resolved = true;
          return "/repo";
        },
      }),
    ).resolves.toBeNull();
    expect(resolved).toBe(false);
  });

  it("returns null for recruitable agent reads without a workspace", async () => {
    let listed = false;

    await expect(
      readAppRecruitableAgentConfig({
        client: client({
          async listRecruitableAgentConfigs() {
            listed = true;
            return { data: [], nextCursor: null };
          },
        }),
        existingMembers: [],
        isConnected: true,
        resolveBackendCwd: async () => "",
      }),
    ).resolves.toBeNull();
    expect(listed).toBe(false);
  });

  it("reads a recruitable agent through backend workspace access", async () => {
    const existingMembers: OfficeMember[] = [
      {
        name: "Existing",
        role: "Lead",
        glyph: "E",
        accent: "blue",
        status: "active",
        agentId: "agent-old",
      },
    ];
    const readParams: unknown[] = [];

    await expect(
      readAppRecruitableAgentConfig({
        client: client({
          async listRecruitableAgentConfigs(cwd, params) {
            readParams.push({ cwd, params });
            return {
              data: [
                {
                  filePath: "/repo/agent.json",
                  savedAt: "2026-06-17T00:00:00.000Z",
                  config: agentConfig({ agentId: "agent-new" }),
                },
              ],
              nextCursor: null,
            };
          },
        }),
        existingMembers,
        isConnected: true,
        resolveBackendCwd: async () => "/repo",
      }),
    ).resolves.toMatchObject({ agentId: "agent-new" });
    expect(readParams).toEqual([
      {
        cwd: "/repo",
        params: {
          cursor: null,
          existingAgentIds: ["agent-old"],
          existingNames: ["Existing"],
          limit: 24,
        },
      },
    ]);
  });

  it("lists recruitable agents through backend workspace access", async () => {
    const existingMembers: OfficeMember[] = [
      {
        name: "Existing",
        role: "Lead",
        glyph: "E",
        accent: "blue",
        status: "active",
        agentId: "agent-old",
      },
    ];
    const readParams: unknown[] = [];

    await expect(
      listAppRecruitableAgentConfigs({
        client: client({
          async listRecruitableAgentConfigs(cwd, params) {
            readParams.push({ cwd, params });
            return {
              data: [
                {
                  filePath: "/repo/planner.json",
                  savedAt: "2026-06-17T00:00:00.000Z",
                  config: agentConfig({ agentId: "agent-planner", name: "Planner" }),
                },
                {
                  filePath: "/repo/reviewer.json",
                  savedAt: "2026-06-17T00:00:00.000Z",
                  config: agentConfig({ agentId: "agent-reviewer", name: "Reviewer" }),
                },
              ],
              nextCursor: null,
            };
          },
        }),
        existingMembers,
        isConnected: true,
        resolveBackendCwd: async () => "/repo",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ agentId: "agent-planner", name: "Planner" }),
      expect.objectContaining({ agentId: "agent-reviewer", name: "Reviewer" }),
    ]);
    expect(readParams).toEqual([
      {
        cwd: "/repo",
        params: {
          cursor: null,
          existingAgentIds: ["agent-old"],
          existingNames: ["Existing"],
          limit: 24,
        },
      },
    ]);
  });

  it("skips latest office reads while disconnected", async () => {
    let resolved = false;

    await expect(
      readAppLatestOfficeConfig({
        client: client(),
        isConnected: false,
        resolveBackendCwd: async () => {
          resolved = true;
          return "/repo";
        },
      }),
    ).resolves.toBeNull();
    expect(resolved).toBe(false);
  });

  it("reads the latest office through backend workspace access", async () => {
    await expect(
      readAppLatestOfficeConfig({
        client: client({
          async listOfficeConfigs(cwd) {
            expect(cwd).toBe("/repo");
            return {
              data: [
                {
                  filePath: "/repo/old.json",
                  savedAt: "2026-06-16T00:00:00.000Z",
                  config: officeConfig({ title: "Old office" }),
                },
                {
                  filePath: "/repo/new.json",
                  savedAt: "2026-06-17T00:00:00.000Z",
                  config: officeConfig({ title: "New office" }),
                },
              ],
              nextCursor: null,
            };
          },
        }),
        isConnected: true,
        resolveBackendCwd: async () => "/repo",
      }),
    ).resolves.toMatchObject({ title: "New office" });
  });
});
