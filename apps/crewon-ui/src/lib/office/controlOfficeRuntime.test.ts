import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../domain/crewonDomain";
import {
  controlOfficeRecord,
  createControlOffice,
  listControlOfficeCatalog,
  refreshControlOfficeRuntimeRecord,
  type ControlOfficeClient,
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
  it("builds the catalog only from typed Control routes", async () => {
    const latestOffice = {
      ...office,
      officeVersionId: "office-version-2",
      revision: 2,
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    const catalog = await listControlOfficeCatalog({
      listOffices: vi
        .fn()
        .mockResolvedValue({ data: [office, latestOffice], nextCursor: null }),
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
    } as unknown as ControlOfficeClient);

    expect(catalog.offices).toEqual([controlOfficeRecord(latestOffice)]);
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

  it("creates an Office with published AgentVersion identities", async () => {
    const createOffice = vi
      .fn()
      .mockResolvedValue({ disposition: "created", office });
    const record = await createControlOffice({
      client: { createOffice } as unknown as ControlOfficeClient,
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

  it("reuses one local AgentVersion across distinct team roles", async () => {
    const teamOffice = {
      ...office,
      members: [
        {
          memberId: "member-1",
          displayName: "Release lead",
          agentVersionId: "agent-version-1",
        },
        {
          memberId: "member-2",
          displayName: "Security review",
          agentVersionId: "agent-version-1",
        },
      ],
      executionTargets: [
        { targetId: "target-1", agentVersionId: "agent-version-1" },
        { targetId: "target-2", agentVersionId: "agent-version-1" },
      ],
    };
    const createOffice = vi.fn().mockResolvedValue({
      disposition: "created",
      office: teamOffice,
    });
    const config: AgentConfig = {
      agentId: "agent-version-1",
      name: "Local agent",
      role: "Local runtime",
      glyph: "A",
      accent: "cyan",
      model: "gpt-5",
      models: ["gpt-5"],
      permission: "Control policy",
      permissions: ["Control policy"],
      systemPrompt: "",
      mcp: [],
      skills: [],
    };

    await createControlOffice({
      client: { createOffice } as unknown as ControlOfficeClient,
      locale: "en",
      members: [
        { config, displayName: "Release lead" },
        { config, displayName: "Security review" },
      ],
      title: "Multi-role office",
    });

    expect(createOffice).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargets: [
          { agentVersionId: "agent-version-1", targetId: "target-1" },
          { agentVersionId: "agent-version-1", targetId: "target-2" },
        ],
        members: [
          expect.objectContaining({ displayName: "Release lead" }),
          expect.objectContaining({ displayName: "Security review" }),
        ],
      }),
      expect.any(String),
    );
  });

  it("rebinds stale desktop Office roles to the current local runtime", async () => {
    const previous = {
      ...office,
      members: [
        {
          memberId: "member-1",
          displayName: "Release lead",
          agentVersionId: "local-desktop-old",
        },
        {
          memberId: "member-2",
          displayName: "Planning",
          agentVersionId: "local-desktop-old-planner",
        },
      ],
      executionTargets: [
        { targetId: "target-1", agentVersionId: "local-desktop-old" },
        {
          targetId: "target-2",
          agentVersionId: "local-desktop-old-planner",
        },
      ],
    };
    const rebound = {
      ...previous,
      officeVersionId: "office-version-2",
      revision: 2,
      members: previous.members.map((member, index) => ({
        ...member,
        agentVersionId:
          index === 0
            ? "local-desktop-current"
            : "local-desktop-current-planner",
      })),
      executionTargets: previous.executionTargets.map((target, index) => ({
        ...target,
        agentVersionId:
          index === 0
            ? "local-desktop-current"
            : "local-desktop-current-planner",
      })),
    };
    const createOffice = vi
      .fn()
      .mockResolvedValue({ disposition: "created", office: rebound });

    const result = await refreshControlOfficeRuntimeRecord({
      client: {
        createOffice,
        getOffice: vi.fn().mockResolvedValue({ office: previous }),
        listOffices: vi
          .fn()
          .mockResolvedValue({ data: [previous], nextCursor: null }),
        getActiveAgentVersionCatalog: vi.fn().mockResolvedValue({
          releaseId: "release-current",
          activatedAt: "2026-08-31T00:00:00.000Z",
          defaultAgentVersionId: "local-desktop-current",
          data: [
            { agentVersionId: "local-desktop-current" },
            { agentVersionId: "local-desktop-current-planner" },
          ],
        }),
      } as unknown as ControlOfficeClient,
      record: controlOfficeRecord(previous),
    });

    expect(createOffice).toHaveBeenCalledWith(
      {
        officeId: "office-1",
        expectedRevision: 1,
        title: "Release office",
        members: rebound.members,
        executionTargets: rebound.executionTargets,
      },
      expect.stringMatching(/^office\.runtime\.rebind:/u),
    );
    expect(result).toEqual(controlOfficeRecord(rebound));
  });

  it("keeps historical expert roles while switching every local role to the selected model", async () => {
    const previous = {
      ...office,
      members: [
        {
          memberId: "member-1",
          displayName: "Expert lead",
          agentVersionId: "local-desktop-old",
        },
        {
          memberId: "member-2",
          displayName: "Planning expert",
          agentVersionId: "local-desktop-old-planner",
        },
        {
          memberId: "member-3",
          displayName: "Verification expert",
          agentVersionId: "local-desktop-old-verifier",
        },
      ],
      executionTargets: [
        { targetId: "target-1", agentVersionId: "local-desktop-old" },
        {
          targetId: "target-2",
          agentVersionId: "local-desktop-old-planner",
        },
        {
          targetId: "target-3",
          agentVersionId: "local-desktop-old-verifier",
        },
      ],
    };
    const selectedIds = [
      "local-desktop-current:model-111111111111111111111111",
      "local-desktop-current-planner:model-222222222222222222222222",
      "local-desktop-current-verifier:model-333333333333333333333333",
    ];
    const rebound = {
      ...previous,
      officeVersionId: "office-version-2",
      revision: 2,
      members: previous.members.map((member, index) => ({
        ...member,
        agentVersionId: selectedIds[index]!,
      })),
      executionTargets: previous.executionTargets.map((target, index) => ({
        ...target,
        agentVersionId: selectedIds[index]!,
      })),
    };
    const baseVersion = (agentVersionId: string, modelId = "gpt-5.5") => ({
      agentVersionId,
      model: { modelId },
    });
    const createOffice = vi.fn().mockResolvedValue({
      disposition: "created",
      office: rebound,
    });

    const result = await refreshControlOfficeRuntimeRecord({
      client: {
        createOffice,
        getOffice: vi.fn().mockResolvedValue({ office: previous }),
        listOffices: vi
          .fn()
          .mockResolvedValue({ data: [previous], nextCursor: null }),
        getActiveAgentVersionCatalog: vi.fn().mockResolvedValue({
          releaseId: "release-current",
          activatedAt: "2026-09-01T00:00:00.000Z",
          defaultAgentVersionId: "local-desktop-current",
          data: [
            baseVersion("local-desktop-current"),
            baseVersion("local-desktop-current-planner"),
            baseVersion("local-desktop-current-verifier"),
            ...selectedIds.map((id) => baseVersion(id, "gpt-5.6-sol")),
          ],
        }),
      } as unknown as ControlOfficeClient,
      model: "gpt-5.6-sol",
      record: controlOfficeRecord(previous),
    });

    expect(createOffice).toHaveBeenCalledWith(
      expect.objectContaining({
        members: rebound.members,
        executionTargets: rebound.executionTargets,
      }),
      expect.stringMatching(/^office\.runtime\.rebind:/u),
    );
    expect(result).toEqual(controlOfficeRecord(rebound));
  });

  it("does not substitute inactive published AgentVersions", async () => {
    await expect(
      refreshControlOfficeRuntimeRecord({
        client: {
          createOffice: vi.fn(),
          getOffice: vi.fn().mockResolvedValue({ office }),
          listOffices: vi
            .fn()
            .mockResolvedValue({ data: [office], nextCursor: null }),
          getActiveAgentVersionCatalog: vi.fn().mockResolvedValue({
            releaseId: "release-current",
            activatedAt: "2026-08-31T00:00:00.000Z",
            defaultAgentVersionId: "local-desktop-current",
            data: [{ agentVersionId: "local-desktop-current" }],
          }),
        } as unknown as ControlOfficeClient,
        record: controlOfficeRecord(office),
      }),
    ).rejects.toThrow("control_office_agent_version_not_active");
  });

  it("passes connector presentation through while preserving AgentVersion identity", async () => {
    const catalog = await listControlOfficeCatalog(
      {
        listOffices: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
        getActiveAgentVersionCatalog: vi.fn().mockResolvedValue({
          releaseId: "release-1",
          activatedAt: "2026-08-13T00:00:00.000Z",
          defaultAgentVersionId: "agent-version-1",
          data: [
            {
              agentVersionId: "agent-version-1",
              contentDigest: `sha256:${"a".repeat(64)}`,
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
      } as unknown as ControlOfficeClient,
      "zh",
      [
        {
          id: "external-provider",
          matches: () => true,
          presentation: () => ({
            accent: "violet",
            glyph: "E",
            name: "外部 Agent",
            role: "通过接入适配器提供",
          }),
        },
      ],
    );

    expect(catalog.agents).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({
          agentId: "agent-version-1",
          model: "gpt-5",
          name: "外部 Agent",
        }),
      }),
    ]);
  });
});
