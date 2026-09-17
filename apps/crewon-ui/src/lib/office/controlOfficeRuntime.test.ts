import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../domain/crewonDomain";
import {
  controlOfficeRecord,
  createControlOffice,
  listControlOfficeCatalog,
  publishControlOfficeRevision,
  refreshControlOfficeRuntimeRecord,
  type ControlOfficeClient,
} from "./controlOfficeRuntime";
import {
  officeMemberAgentProfileId,
  readOfficeMemberAgentProfile,
  readOfficeMemberTeamCoordination,
  writeOfficeMemberAgentProfile,
} from "./officeMemberAgentProfile";

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
    expect(catalog.activeAgentVersions).toEqual([
      expect.objectContaining({
        agentVersionId: "agent-version-1",
        model: expect.objectContaining({ adapterName: "openai" }),
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
    const storage = memoryProfileStorage();
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
            systemPrompt: "Verify the release evidence independently.",
            mcp: [capability("mcp-1", "Release MCP")],
            skills: [capability("skill-1", "Release checklist")],
          },
          responsibility: "  Own the final go/no-go decision.  ",
        },
      ],
      storage,
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
            responsibility: "Own the final go/no-go decision.",
          },
        ],
        title: "Release office",
      },
      expect.any(String),
    );
    expect(record).toEqual(controlOfficeRecord(office));
    expect(
      readOfficeMemberAgentProfile(
        officeMemberAgentProfileId("office-version-1", "member-1"),
        storage,
      ),
    ).toEqual({
      agentId: "office-member:office-version-1:member-1",
      name: "Release agent",
      role: "Own the final go/no-go decision.",
      glyph: "A",
      accent: "cyan",
      model: "gpt-5",
      models: ["gpt-5"],
      permission: "Control policy",
      permissions: ["Control policy"],
      systemPrompt:
        "[Office responsibility]\nOwn the final go/no-go decision.\n\nVerify the release evidence independently.",
      mcp: [capability("mcp-1", "Release MCP")],
      skills: [capability("skill-1", "Release checklist")],
      knowledge: [],
    });
    expect(
      readOfficeMemberTeamCoordination(
        officeMemberAgentProfileId("office-version-1", "member-1"),
        storage,
      ),
    ).toEqual({
      assignmentMode: "roleDirected",
      responsibility: "Own the final go/no-go decision.",
      source: "officeDefinition",
    });
  });

  it("bounds the injected responsibility without truncating the original system prompt", async () => {
    const storage = memoryProfileStorage();
    const responsibility = "R".repeat(300);
    await createControlOffice({
      client: {
        createOffice: vi
          .fn()
          .mockResolvedValue({ disposition: "created", office }),
      } as unknown as ControlOfficeClient,
      locale: "zh",
      members: [
        {
          config: agentConfig({ systemPrompt: "原始系统提示必须完整保留。" }),
          responsibility,
        },
      ],
      storage,
      title: "发布办公室",
    });

    const profile = readOfficeMemberAgentProfile(
      officeMemberAgentProfileId("office-version-1", "member-1"),
      storage,
    );
    expect(profile?.role).toBe("R".repeat(240));
    expect(profile?.systemPrompt).toBe(
      `[办公室职责]\n${"R".repeat(240)}\n\n原始系统提示必须完整保留。`,
    );
  });

  it("bounds responsibilities by Unicode code point without splitting emoji", async () => {
    const storage = memoryProfileStorage();
    const createOffice = vi
      .fn()
      .mockResolvedValue({ disposition: "created", office });
    await createControlOffice({
      client: { createOffice } as unknown as ControlOfficeClient,
      locale: "zh",
      members: [
        {
          config: agentConfig(),
          responsibility: `e\u0301${"🚀".repeat(241)}`,
        },
      ],
      storage,
      title: "Unicode 职责",
    });

    const expected = `é${"🚀".repeat(239)}`;
    expect(createOffice.mock.calls[0]?.[0].members[0]?.responsibility).toBe(
      expected,
    );
    expect([...expected]).toHaveLength(240);
  });

  it("preserves member profiles and coordination across a reordered settings revision", async () => {
    const storage = memoryProfileStorage();
    const previous = {
      ...office,
      revision: 2,
      members: [
        {
          memberId: "member-lead",
          displayName: "Release lead",
          agentVersionId: "agent-version-shared",
        },
        {
          memberId: "member-review",
          displayName: "Review member",
          agentVersionId: "agent-version-shared",
        },
        {
          memberId: "member-removed",
          displayName: "Removed member",
          agentVersionId: "agent-version-removed",
        },
      ],
      executionTargets: [
        { targetId: "target-lead", agentVersionId: "agent-version-shared" },
        { targetId: "target-review", agentVersionId: "agent-version-shared" },
        {
          targetId: "target-removed",
          agentVersionId: "agent-version-removed",
        },
      ],
    };
    const current = {
      ...previous,
      officeVersionId: "office-version-2",
      revision: 3,
      members: [
        { ...previous.members[1]!, displayName: "Primary reviewer" },
        { ...previous.members[0]!, displayName: "Release owner" },
      ],
      executionTargets: [
        previous.executionTargets[1]!,
        previous.executionTargets[0]!,
      ],
    };
    writeStoredMemberProfile({
      storage,
      officeVersionId: previous.officeVersionId,
      memberId: "member-lead",
      name: "Release lead",
      role: "Make the final release decision",
    });
    writeStoredMemberProfile({
      storage,
      officeVersionId: previous.officeVersionId,
      memberId: "member-review",
      name: "Review member",
      role: "Verify release evidence independently",
    });
    writeStoredMemberProfile({
      storage,
      officeVersionId: previous.officeVersionId,
      memberId: "member-removed",
      name: "Removed member",
      role: "Retired responsibility",
    });
    const createOffice = vi.fn().mockResolvedValue({
      disposition: "created",
      office: current,
    });

    await publishControlOfficeRevision({
      client: { createOffice },
      office: previous,
      request: {
        officeId: previous.officeId,
        expectedRevision: previous.revision,
        title: previous.title,
        members: current.members,
        executionTargets: current.executionTargets,
      },
      storage,
    });

    expect(createOffice).toHaveBeenCalledWith(
      expect.objectContaining({
        officeId: previous.officeId,
        expectedRevision: 2,
        members: current.members,
      }),
      expect.stringMatching(/^office\.settings\.update:/u),
    );
    expect(
      readOfficeMemberAgentProfile(
        officeMemberAgentProfileId(current.officeVersionId, "member-review"),
        storage,
      ),
    ).toEqual(
      expect.objectContaining({
        name: "Primary reviewer",
        role: "Verify release evidence independently",
      }),
    );
    expect(
      readOfficeMemberTeamCoordination(
        officeMemberAgentProfileId(current.officeVersionId, "member-review"),
        storage,
      ),
    ).toEqual({
      assignmentMode: "roleDirected",
      responsibility: "Verify release evidence independently",
      source: "officeDefinition",
    });
    expect(
      readOfficeMemberAgentProfile(
        officeMemberAgentProfileId(current.officeVersionId, "member-lead"),
        storage,
      ),
    ).toEqual(
      expect.objectContaining({
        name: "Release owner",
        role: "Make the final release decision",
      }),
    );
    expect(
      readOfficeMemberAgentProfile(
        officeMemberAgentProfileId(current.officeVersionId, "member-removed"),
        storage,
      ),
    ).toBeNull();
  });

  it("uses a unique AgentVersion fallback and skips ambiguous revision mappings", async () => {
    const storage = memoryProfileStorage();
    const previous = {
      ...office,
      revision: 2,
      members: [
        {
          memberId: "old-unique",
          displayName: "Unique member",
          agentVersionId: "agent-version-unique",
        },
        {
          memberId: "old-shared-a",
          displayName: "Shared A",
          agentVersionId: "agent-version-shared",
        },
        {
          memberId: "old-shared-b",
          displayName: "Shared B",
          agentVersionId: "agent-version-shared",
        },
      ],
      executionTargets: [
        { targetId: "target-unique", agentVersionId: "agent-version-unique" },
        { targetId: "target-shared-a", agentVersionId: "agent-version-shared" },
        { targetId: "target-shared-b", agentVersionId: "agent-version-shared" },
      ],
    };
    const current = {
      ...previous,
      officeVersionId: "office-version-2",
      revision: 3,
      members: [
        {
          memberId: "new-unique",
          displayName: "Unique renamed",
          agentVersionId: "agent-version-unique",
        },
        {
          memberId: "new-shared",
          displayName: "Shared unknown",
          agentVersionId: "agent-version-shared",
        },
      ],
      executionTargets: [
        { targetId: "target-unique", agentVersionId: "agent-version-unique" },
        { targetId: "target-shared", agentVersionId: "agent-version-shared" },
      ],
    };
    for (const [memberId, name, role] of [
      ["old-unique", "Unique member", "Unique responsibility"],
      ["old-shared-a", "Shared A", "Responsibility A"],
      ["old-shared-b", "Shared B", "Responsibility B"],
    ] as const) {
      writeStoredMemberProfile({
        storage,
        officeVersionId: previous.officeVersionId,
        memberId,
        name,
        role,
      });
    }

    await publishControlOfficeRevision({
      client: {
        createOffice: vi.fn().mockResolvedValue({
          disposition: "created",
          office: current,
        }),
      },
      office: previous,
      request: {
        officeId: previous.officeId,
        expectedRevision: previous.revision,
        title: previous.title,
        members: current.members,
        executionTargets: current.executionTargets,
      },
      storage,
    });

    expect(
      readOfficeMemberAgentProfile(
        officeMemberAgentProfileId(current.officeVersionId, "new-unique"),
        storage,
      ),
    ).toEqual(
      expect.objectContaining({
        name: "Unique renamed",
        role: "Unique responsibility",
      }),
    );
    expect(
      readOfficeMemberAgentProfile(
        officeMemberAgentProfileId(current.officeVersionId, "new-shared"),
        storage,
      ),
    ).toBeNull();
    expect(
      readOfficeMemberTeamCoordination(
        officeMemberAgentProfileId(current.officeVersionId, "new-shared"),
        storage,
      ),
    ).toBeNull();
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

  it("rebinds stale web-development Office roles without rewriting history", async () => {
    const previous = {
      ...office,
      members: [
        {
          memberId: "member-1",
          displayName: "Release lead",
          agentVersionId: "local-web-old",
        },
        {
          memberId: "member-2",
          displayName: "Planning",
          agentVersionId: "local-web-old-planner",
        },
      ],
      executionTargets: [
        { targetId: "target-1", agentVersionId: "local-web-old" },
        {
          targetId: "target-2",
          agentVersionId: "local-web-old-planner",
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
          index === 0 ? "local-web-current" : "local-web-current-planner",
      })),
      executionTargets: previous.executionTargets.map((target, index) => ({
        ...target,
        agentVersionId:
          index === 0 ? "local-web-current" : "local-web-current-planner",
      })),
    };
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
          activatedAt: "2026-09-03T00:00:00.000Z",
          defaultAgentVersionId: "local-web-current",
          data: [
            { agentVersionId: "local-web-current" },
            { agentVersionId: "local-web-current-planner" },
          ],
        }),
      } as unknown as ControlOfficeClient,
      record: controlOfficeRecord(previous),
    });

    expect(createOffice).toHaveBeenCalledWith(
      expect.objectContaining({
        officeId: previous.officeId,
        expectedRevision: previous.revision,
        members: rebound.members,
        executionTargets: rebound.executionTargets,
      }),
      expect.stringMatching(/^office\.runtime\.rebind:/u),
    );
    expect(result).toEqual(controlOfficeRecord(rebound));
  });

  it("rebinds a historical platform Agent identity to its unique active cloud runtime", async () => {
    const logicalId = "agent-platform:112";
    const currentId = `${logicalId}:${"a".repeat(32)}`;
    const previous = {
      ...office,
      members: office.members.map((member) => ({
        ...member,
        agentVersionId: logicalId,
      })),
      executionTargets: office.executionTargets.map((target) => ({
        ...target,
        agentVersionId: logicalId,
      })),
    };
    const rebound = {
      ...previous,
      officeVersionId: "office-version-2",
      revision: 2,
      members: previous.members.map((member) => ({
        ...member,
        agentVersionId: currentId,
      })),
      executionTargets: previous.executionTargets.map((target) => ({
        ...target,
        agentVersionId: currentId,
      })),
    };
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
          activatedAt: "2026-09-04T00:00:00.000Z",
          defaultAgentVersionId: "local-desktop-current",
          data: [cloudVersion(currentId)],
        }),
      } as unknown as ControlOfficeClient,
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

  it.each([
    {
      name: "the adapter is not cloud-agent",
      versions: [
        cloudVersion(`agent-platform:112:${"a".repeat(32)}`, "responses"),
      ],
    },
    {
      name: "more than one active cloud runtime has the same logical ID",
      versions: [
        cloudVersion(`agent-platform:112:${"a".repeat(32)}`),
        cloudVersion(`agent-platform:112:${"b".repeat(32)}`),
      ],
    },
  ])("fails closed when $name", async ({ versions }) => {
    const previous = {
      ...office,
      members: office.members.map((member) => ({
        ...member,
        agentVersionId: "agent-platform:112",
      })),
      executionTargets: office.executionTargets.map((target) => ({
        ...target,
        agentVersionId: "agent-platform:112",
      })),
    };
    const createOffice = vi.fn();

    await expect(
      refreshControlOfficeRuntimeRecord({
        client: {
          createOffice,
          getOffice: vi.fn().mockResolvedValue({ office: previous }),
          listOffices: vi
            .fn()
            .mockResolvedValue({ data: [previous], nextCursor: null }),
          getActiveAgentVersionCatalog: vi.fn().mockResolvedValue({
            releaseId: "release-current",
            activatedAt: "2026-09-04T00:00:00.000Z",
            defaultAgentVersionId: "local-desktop-current",
            data: versions,
          }),
        } as unknown as ControlOfficeClient,
        record: controlOfficeRecord(previous),
      }),
    ).rejects.toThrow("control_office_agent_version_not_active");
    expect(createOffice).not.toHaveBeenCalled();
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

function capability(id: string, name: string) {
  return {
    id,
    name,
    glyph: "C",
    accent: "cyan" as const,
    description: `${name} description`,
    enabled: true,
  };
}

function cloudVersion(agentVersionId: string, adapterName = "cloud-agent") {
  return {
    agentVersionId,
    contentDigest: `sha256:${"a".repeat(64)}`,
    runtimeGeneration: "desktop-cloud-agent-runtime",
    policySnapshotId: "policy-cloud-agent-1",
    model: {
      adapterName,
      adapterVersion: "1",
      modelId: "cloud-agent",
    },
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
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
    ...overrides,
  };
}

function memoryProfileStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function writeStoredMemberProfile(input: {
  storage: Pick<Storage, "getItem" | "setItem">;
  officeVersionId: string;
  memberId: string;
  name: string;
  role: string;
}) {
  const agentId = officeMemberAgentProfileId(
    input.officeVersionId,
    input.memberId,
  );
  writeOfficeMemberAgentProfile(
    {
      ...agentConfig({ agentId, name: input.name, role: input.role }),
      knowledge: [],
    },
    input.storage,
    {
      assignmentMode: "roleDirected",
      responsibility: input.role,
      source: "officeDefinition",
    },
  );
}
