import type { ControlApiClient } from "@crewon/control-client";
import { describe, expect, it, vi } from "vitest";

import {
  controlOfficeRecord,
  createControlOffice,
  listControlOfficeCatalog,
  startControlOfficeDelegation,
} from "./controlOfficeRuntime";

const office = {
  schemaVersion: "crewon.office-definition.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Release office",
  members: [
    {
      memberId: "member-1",
      displayName: "Release agent",
      agentVersionId: "agent-version-1",
    },
  ],
  executionTargets: [
    { targetId: "target-1", agentVersionId: "agent-version-1" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-08-13T00:00:00.000Z",
};

describe("Control Office runtime", () => {
  it("builds the Office catalog only from typed Control routes", async () => {
    const catalog = await listControlOfficeCatalog({
      listOffices: vi
        .fn()
        .mockResolvedValue({ data: [office], nextCursor: null }),
      getActiveAgentVersionCatalog: vi.fn().mockResolvedValue({
        releaseId: "release-1",
        activatedAt: "2026-08-13T00:00:00.000Z",
        defaultAgentVersionId: "agent-version-1",
        data: [
          {
            agentVersionId: "agent-version-1",
            contentDigest: "sha256:agent",
            runtimeGeneration: "runtime-1",
            policySnapshotId: "policy-1",
            model: {
              adapterName: "openai",
              adapterVersion: "v1",
              modelId: "gpt-5",
            },
            createdAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      }),
    } as unknown as ControlApiClient);

    expect(catalog.offices).toEqual([controlOfficeRecord(office)]);
    expect(catalog.agents).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({
          agentId: "agent-version-1",
          model: "gpt-5",
        }),
      }),
    ]);
    expect(JSON.stringify(catalog.offices)).not.toMatch(
      /backendStatus|messages|tasks|threadId/u,
    );
  });

  it("creates an Office with real member and execution-target identities", async () => {
    const createOffice = vi
      .fn()
      .mockResolvedValue({ disposition: "created", office });
    const record = await createControlOffice({
      client: { createOffice } as unknown as ControlApiClient,
      locale: "en",
      members: [
        {
          config: {
            agentId: "agent-version-1",
            name: "Release agent",
            role: "Control AgentVersion",
            glyph: "A",
            accent: "cyan",
            model: "gpt-5",
            models: ["gpt-5"],
            permission: "Control policy",
            permissions: ["Control policy"],
            systemPrompt: "",
            mcp: [],
            skills: [],
          },
        },
      ],
      title: " Release office ",
    });

    expect(createOffice).toHaveBeenCalledWith(
      {
        expectedRevision: 0,
        executionTargets: [
          { agentVersionId: "agent-version-1", targetId: "target-1" },
        ],
        members: [
          {
            agentVersionId: "agent-version-1",
            displayName: "Release agent",
            memberId: "member-1",
          },
        ],
        title: "Release office",
      },
      expect.any(String),
    );
    expect(record).toEqual(controlOfficeRecord(office));
  });

  it("starts an explicit Workflow delegation on the active thread", async () => {
    const startOfficeDelegation = vi.fn().mockResolvedValue({
      disposition: "committed",
      run: { runId: "run-1" },
    });

    await startControlOfficeDelegation({
      client: { startOfficeDelegation } as unknown as ControlApiClient,
      officeVersionId: "office-version-1",
      workflowVersionId: "workflow-version-1",
      threadId: "thread-1",
      input: { topic: "release" },
    });

    expect(startOfficeDelegation).toHaveBeenCalledWith(
      "office-version-1",
      {
        workflowVersionId: "workflow-version-1",
        threadId: "thread-1",
        input: { topic: "release" },
      },
      expect.any(String),
    );
  });
});
