import { describe, expect, it, vi } from "vitest";

import type { ControlApiClient } from "@crewon/control-client";
import type { LibraryPanel } from "../domain/crewonDomain";
import { openControlLibraryAction } from "./controlLibraryActions";

function capability(name: string) {
  return {
    agentVersionId: "agent-v1",
    agentVersionDigest: "sha256:agent",
    kind: "function" as const,
    name,
    description: `Capability ${name}`,
    execution: "parallel" as const,
    inputFormat: "jsonSchema" as const,
  };
}

describe("openControlLibraryAction", () => {
  it("loads active Agent versions from Control API", async () => {
    let panel: LibraryPanel | null = null;
    const getActiveAgentVersionCatalog = vi.fn(async () => ({
      releaseId: "release-1",
      activatedAt: "2026-08-13T00:00:00.000Z",
      defaultAgentVersionId: "agent-v1",
      data: [
        {
          agentVersionId: "agent-v1",
          contentDigest: "sha256:digest",
          runtimeGeneration: "runtime-1",
          policySnapshotId: "policy-1",
          model: {
            adapterName: "openai",
            adapterVersion: "1",
            modelId: "gpt-5",
          },
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    }));

    await openControlLibraryAction({
      client: { getActiveAgentVersionCatalog } as unknown as ControlApiClient,
      kind: "agents",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(getActiveAgentVersionCatalog).toHaveBeenCalledOnce();
    expect(panel).toMatchObject({
      kind: "agents",
      items: [
        {
          title: "agent-v1",
          meta: "Control default version",
          description: "openai · gpt-5",
        },
      ],
    });
  });

  it("loads the paginated released Tool catalog without legacy Skill or MCP data", async () => {
    let panel: LibraryPanel | null = null;
    const listActiveCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        releaseId: "release-1",
        activatedAt: "2026-08-13T00:00:00.000Z",
        data: [
          {
            agentVersionId: "agent-v1",
            agentVersionDigest: "sha256:agent",
            kind: "function",
            name: "search_workspace",
            description: "Search released workspace metadata",
            execution: "parallel",
            inputFormat: "jsonSchema",
          },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        releaseId: "release-1",
        activatedAt: "2026-08-13T00:00:00.000Z",
        data: [
          {
            agentVersionId: "agent-v2",
            agentVersionDigest: "sha256:agent-2",
            kind: "custom",
            name: "render_report",
            description: "Render a report",
            execution: "serial",
            inputFormat: "text",
          },
        ],
        nextCursor: null,
      });

    await openControlLibraryAction({
      client: { listActiveCapabilities } as unknown as ControlApiClient,
      kind: "tools",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listActiveCapabilities).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(listActiveCapabilities).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
      limit: 100,
    });
    expect(panel).toMatchObject({
      kind: "tools",
      catalogMode: "controlCapabilities",
      actions: [
        { id: "create-skill", disabled: true },
        { id: "create-mcp", disabled: true },
      ],
      items: [
        {
          title: "search_workspace",
          meta: "function · parallel · jsonSchema",
          description: "Search released workspace metadata",
          tags: ["agent-v1"],
        },
        { title: "render_report", tags: ["agent-v2"] },
      ],
    });
    expect(JSON.stringify(panel)).not.toContain("sha256:agent");
  });

  it("fails closed when Control repeats a capability cursor", async () => {
    let panel: LibraryPanel | null = null;
    const listActiveCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        releaseId: "release-1",
        activatedAt: "2026-08-13T00:00:00.000Z",
        data: [capability("first")],
        nextCursor: "repeat",
      })
      .mockResolvedValueOnce({
        releaseId: "release-1",
        activatedAt: "2026-08-13T00:00:00.000Z",
        data: [capability("second")],
        nextCursor: "repeat",
      });

    await openControlLibraryAction({
      client: { listActiveCapabilities } as unknown as ControlApiClient,
      kind: "tools",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listActiveCapabilities).toHaveBeenCalledTimes(2);
    expect(panel).toMatchObject({
      kind: "tools",
      items: [],
      error: "Control capability cursor repeated during pagination",
    });
  });

  it("fails closed when the capability release changes between pages", async () => {
    let panel: LibraryPanel | null = null;
    const listActiveCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        releaseId: "release-1",
        activatedAt: "2026-08-13T00:00:00.000Z",
        data: [capability("first")],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        releaseId: "release-2",
        activatedAt: "2026-08-13T00:01:00.000Z",
        data: [capability("second")],
        nextCursor: null,
      });

    await openControlLibraryAction({
      client: { listActiveCapabilities } as unknown as ControlApiClient,
      kind: "tools",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(panel).toMatchObject({
      kind: "tools",
      items: [],
      error: "Control capability release changed during pagination",
    });
  });

  it("stops after five pages and labels the bounded catalog as truncated", async () => {
    let panel: LibraryPanel | null = null;
    const listActiveCapabilities = vi.fn(
      async ({ cursor }: { cursor?: string | null }) => {
        const pageNumber = cursor == null ? 1 : Number(cursor.slice(5));
        return {
          releaseId: "release-1",
          activatedAt: "2026-08-13T00:00:00.000Z",
          data: Array.from({ length: 100 }, (_, index) =>
            capability(`page-${pageNumber}-item-${index}`),
          ),
          nextCursor: `page-${pageNumber + 1}`,
        };
      },
    );

    await openControlLibraryAction({
      client: { listActiveCapabilities } as unknown as ControlApiClient,
      kind: "tools",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listActiveCapabilities).toHaveBeenCalledTimes(5);
    expect(panel).toMatchObject({
      kind: "tools",
      subtitle:
        "500 released capabilities (truncated) · Control release release-1",
      body: expect.stringContaining("first 500 entries"),
    });
    expect((panel as LibraryPanel | null)?.items).toHaveLength(500);
  });

  it("maps Control Knowledge memory and source records into the existing Knowledge view", async () => {
    let panel: LibraryPanel | null = null;
    const listKnowledge = vi.fn(async () => ({
      data: [
        {
          schemaVersion: "crewon.knowledge.v0" as const,
          knowledgeId: "knowledge-1",
          kind: "memory" as const,
          sourceId: "thread:1",
          title: "Decision",
          content: "Ship Control only",
          contentDigest: "sha256:1",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        {
          schemaVersion: "crewon.knowledge.v0" as const,
          knowledgeId: "knowledge-2",
          kind: "source" as const,
          sourceId: "source:handbook",
          title: "Handbook",
          content: "Reference",
          contentDigest: "sha256:2",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    }));

    await openControlLibraryAction({
      client: { listKnowledge } as unknown as ControlApiClient,
      kind: "knowledge",
      locale: "en",
      selectedThreadId: "thread-1",
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listKnowledge).toHaveBeenCalledWith({ limit: 100 });
    expect(panel).toMatchObject({
      kind: "knowledge",
      items: [],
      knowledge: {
        memories: [
          {
            title: "Decision",
            preview: "Ship Control only",
            kind: "Control memory",
          },
        ],
        sources: [
          { name: "Handbook", meta: "source:handbook", status: "indexed" },
        ],
      },
    });
  });

  it("loads all bounded Control Knowledge pages", async () => {
    let panel: LibraryPanel | null = null;
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ data: [], nextCursor: "page-2" })
      .mockResolvedValueOnce({
        data: [
          {
            schemaVersion: "crewon.knowledge.v0",
            knowledgeId: "knowledge-2",
            kind: "memory",
            sourceId: "thread:2",
            title: "Second page",
            content: "Loaded through the cursor",
            contentDigest: "sha256:2",
            createdAt: "2026-08-13T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      });

    await openControlLibraryAction({
      client: { listKnowledge } as unknown as ControlApiClient,
      kind: "knowledge",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listKnowledge.mock.calls).toEqual([
      [{ limit: 100 }],
      [{ cursor: "page-2", limit: 100 }],
    ]);
    expect(panel).toMatchObject({
      subtitle: "1 memories · 0 sources",
      knowledge: { memories: [{ title: "Second page" }] },
    });
  });

  it("maps Control Office definitions into existing library cards", async () => {
    let panel: LibraryPanel | null = null;
    const listOffices = vi.fn(async () => ({
      data: [
        {
          schemaVersion: "crewon.office-definition.v0" as const,
          tenantId: "tenant-1",
          spaceId: "space-1",
          officeId: "office-1",
          officeVersionId: "office-v1",
          revision: 2,
          title: "Delivery office",
          members: [
            {
              memberId: "member-1",
              displayName: "Reviewer",
              agentVersionId: "agent-v1",
            },
          ],
          executionTargets: [
            { targetId: "review", agentVersionId: "agent-v1" },
          ],
          createdByActorId: "actor-1",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    }));

    await openControlLibraryAction({
      client: { listOffices } as unknown as ControlApiClient,
      kind: "office",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listOffices).toHaveBeenCalledWith({ limit: 100 });
    expect(panel).toMatchObject({
      kind: "office",
      items: [
        {
          title: "Delivery office",
          meta: "1 members · r2",
          description: "1 Control execution targets",
        },
      ],
      actions: [],
    });
    expect((panel as LibraryPanel | null)?.body).toContain(
      "Create an office from published AgentVersions",
    );
    expect((panel as LibraryPanel | null)?.body).toContain(
      "explicit Workflow delegation",
    );
  });

  it("loads bounded Control Office pages without silently dropping later definitions", async () => {
    let panel: LibraryPanel | null = null;
    const office = (officeVersionId: string) => ({
      schemaVersion: "crewon.office-definition.v0" as const,
      tenantId: "tenant-1",
      spaceId: "space-1",
      officeId: `office-${officeVersionId}`,
      officeVersionId,
      revision: 1,
      title: officeVersionId,
      members: [],
      executionTargets: [{ targetId: "default", agentVersionId: "agent-v1" }],
      createdByActorId: "actor-1",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    const listOffices = vi
      .fn()
      .mockResolvedValueOnce({
        data: [office("office-v1")],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [office("office-v2")],
        nextCursor: null,
      });

    await openControlLibraryAction({
      client: { listOffices } as unknown as ControlApiClient,
      kind: "office",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listOffices.mock.calls).toEqual([
      [{ limit: 100 }],
      [{ cursor: "page-2", limit: 100 }],
    ]);
    expect(
      (panel as LibraryPanel | null)?.items.map((item) => item.title),
    ).toEqual(["office-v1", "office-v2"]);
  });

  it("fails closed when Control repeats an Office cursor", async () => {
    let panel: LibraryPanel | null = null;
    const listOffices = vi
      .fn()
      .mockResolvedValueOnce({ data: [], nextCursor: "repeat" })
      .mockResolvedValueOnce({ data: [], nextCursor: "repeat" });

    await openControlLibraryAction({
      client: { listOffices } as unknown as ControlApiClient,
      kind: "office",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listOffices).toHaveBeenCalledTimes(2);
    expect(panel).toMatchObject({
      kind: "office",
      items: [],
      error: "Control Office cursor repeated during pagination",
    });
  });

  it("labels the Office catalog when its five-page read bound is reached", async () => {
    let panel: LibraryPanel | null = null;
    const listOffices = vi.fn(async ({ cursor }: { cursor?: string }) => ({
      data: [],
      nextCursor: `page-${cursor ? Number(cursor.slice(5)) + 1 : 2}`,
    }));

    await openControlLibraryAction({
      client: { listOffices } as unknown as ControlApiClient,
      kind: "office",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listOffices).toHaveBeenCalledTimes(5);
    expect(panel).toMatchObject({
      kind: "office",
      subtitle: "0 offices (truncated)",
    });
  });

  it("does not let an obsolete Library request replace the current panel", async () => {
    const panels: LibraryPanel[] = [];

    await openControlLibraryAction({
      client: {
        getActiveAgentVersionCatalog: vi.fn(async () => ({
          releaseId: "release-1",
          defaultAgentVersionId: "agent-v1",
          data: [],
        })),
      } as unknown as ControlApiClient,
      isCurrent: () => false,
      kind: "agents",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        if (typeof next !== "function" && next !== null) panels.push(next);
      },
    });

    expect(panels).toEqual([]);
  });

  it("keeps the newer Library result when an older request finishes last", async () => {
    let currentRequest = 1;
    let finishOlderRequest!: (value: unknown) => void;
    let panel: LibraryPanel | null = null;
    const olderRequest = openControlLibraryAction({
      client: {
        getActiveAgentVersionCatalog: vi.fn(
          () =>
            new Promise((resolve) => {
              finishOlderRequest = resolve;
            }),
        ),
      } as unknown as ControlApiClient,
      isCurrent: () => currentRequest === 1,
      kind: "agents",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    currentRequest = 2;
    await openControlLibraryAction({
      client: {
        listOffices: vi.fn(async () => ({ data: [], nextCursor: null })),
      } as unknown as ControlApiClient,
      isCurrent: () => currentRequest === 2,
      kind: "office",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });
    finishOlderRequest({
      releaseId: "release-1",
      defaultAgentVersionId: null,
      data: [],
    });
    await olderRequest;

    expect(panel).toMatchObject({ kind: "office", subtitle: "0 offices" });
  });

  it("loads Control automations with runnable detail actions", async () => {
    let panel: LibraryPanel | null = null;
    const listAutomations = vi.fn(async () => ({
      data: [
        {
          automationId: "automation-1",
          revision: 1 as const,
          threadId: "thread-1",
          agentVersionId: null,
          title: "Daily summary",
          prompt: "Summarize the current task",
          schedule: {
            kind: "daily" as const,
            localTime: "18:00",
            timezone: "Asia/Shanghai",
          },
          misfirePolicy: "coalesceLatest" as const,
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    }));

    await openControlLibraryAction({
      client: { listAutomations } as unknown as ControlApiClient,
      kind: "automation",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listAutomations).toHaveBeenCalledWith({ limit: 100 });
    expect(panel).toMatchObject({
      kind: "automation",
      actions: [{ id: "prepare-control-automation" }],
      items: [
        { section: true },
        {
          title: "Daily summary",
          action: {
            type: "automation-detail",
            controlAutomationId: "automation-1",
            controlAutomationRevision: 1,
          },
        },
      ],
    });
  });
});
