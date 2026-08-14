import { describe, expect, it, vi } from "vitest";
import type { ControlApiClient } from "@crewon/control-client";
import { discoverControlComposerResources } from "./controlComposerResourceDiscovery";

const activeCatalog = {
  releaseId: "release-1",
  activatedAt: "2026-08-13T00:00:00.000Z",
  defaultAgentVersionId: "agent-v1",
  data: [
    {
      agentVersionId: "agent-v1",
      contentDigest: "sha256:agent-v1",
      runtimeGeneration: "runtime-1",
      policySnapshotId: "policy-1",
      model: { adapterName: "openai", adapterVersion: "1", modelId: "gpt-5" },
      createdAt: "2026-08-13T00:00:00.000Z",
    },
  ],
} as const;
const knowledgeDigest = `sha256:${"a".repeat(64)}`;

function client(overrides: Partial<ControlApiClient> = {}): ControlApiClient {
  return {
    getActiveAgentVersionCatalog: vi.fn(async () => activeCatalog),
    listActiveCapabilities: vi.fn(async () => ({
      releaseId: "release-1",
      activatedAt: "2026-08-13T00:00:00.000Z",
      data: [
        {
          agentVersionId: "agent-v1",
          agentVersionDigest: "sha256:agent-v1",
          kind: "function" as const,
          name: "mcp__github__search",
          description: "Search GitHub metadata",
          execution: "parallel" as const,
          inputFormat: "jsonSchema" as const,
        },
        {
          agentVersionId: "agent-v1",
          agentVersionDigest: "sha256:agent-v1",
          kind: "custom" as const,
          name: "render_report",
          description: "Render a report",
          execution: "serial" as const,
          inputFormat: "text" as const,
        },
      ],
      nextCursor: null,
    })),
    listKnowledge: vi.fn(async () => ({
      data: [
        {
          schemaVersion: "crewon.knowledge.v0" as const,
          knowledgeId: "knowledge-1",
          kind: "memory" as const,
          sourceId: "thread:thread-1",
          title: "Launch decision",
          content: "Ship after accessibility review.",
          contentDigest: knowledgeDigest,
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    })),
    ...overrides,
  } as unknown as ControlApiClient;
}

describe("discoverControlComposerResources", () => {
  it("projects active capabilities as prompt tokens without execution bindings or mentions", async () => {
    const discovery = await discoverControlComposerResources(client());

    expect(discovery).toEqual({
      releaseId: "release-1",
      knowledgeSelections: [
        {
          reference: {
            contentDigest: knowledgeDigest,
            knowledgeId: "knowledge-1",
          },
          sourceId: "thread:thread-1",
          title: "Launch decision",
        },
      ],
      slashCommands: [
        expect.objectContaining({
          kind: "mcp",
          label: "mcp__github__search",
          meta: "MCP",
          selection: "promptToken",
        }),
        expect.objectContaining({
          kind: "tool",
          label: "render_report",
          meta: "Tool",
          selection: "promptToken",
        }),
      ],
    });
    expect(
      discovery.slashCommands.every(
        (command) => !command.execution && !command.mention,
      ),
    ).toBe(true);
    expect(JSON.stringify(discovery)).not.toContain("control://");
    expect(JSON.stringify(discovery)).not.toContain("jsonSchema");
    expect(JSON.stringify(discovery.slashCommands)).not.toContain("sha256:");
  });

  it("projects immutable Knowledge selections", async () => {
    const discovery = await discoverControlComposerResources(client());
    expect(discovery.knowledgeSelections).toMatchInlineSnapshot(`
      [
        {
          "reference": {
            "contentDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "knowledgeId": "knowledge-1",
          },
          "sourceId": "thread:thread-1",
          "title": "Launch decision",
        },
      ]
    `);
  });

  it("omits Knowledge when its Control read is unavailable", async () => {
    const discovery = await discoverControlComposerResources(
      client({
        listKnowledge: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    );
    expect(discovery.knowledgeSelections).toEqual([]);
  });

  it("fails closed when capability pages drift from the active release", async () => {
    await expect(
      discoverControlComposerResources(
        client({
          listActiveCapabilities: vi.fn(async () => ({
            releaseId: "release-2",
            activatedAt: "2026-08-13T00:00:00.000Z",
            data: [],
            nextCursor: null,
          })),
        }),
      ),
    ).rejects.toThrow("release does not match active catalog");
  });

  it("fails closed when capability metadata is not owned by an active AgentVersion", async () => {
    await expect(
      discoverControlComposerResources(
        client({
          listActiveCapabilities: vi.fn(async () => ({
            releaseId: "release-1",
            activatedAt: "2026-08-13T00:00:00.000Z",
            data: [
              {
                agentVersionId: "agent-v1",
                agentVersionDigest: "sha256:stale-agent-v1",
                kind: "function" as const,
                name: "mcp__github__search",
                description: "Search GitHub metadata",
                execution: "parallel" as const,
                inputFormat: "jsonSchema" as const,
              },
            ],
            nextCursor: null,
          })),
        }),
      ),
    ).rejects.toThrow("outside the active AgentVersion catalog");
  });

  it("rejects repeated cursors and caps renderer items", async () => {
    const listActiveCapabilities = vi.fn(async () => ({
      releaseId: "release-1",
      activatedAt: "2026-08-13T00:00:00.000Z",
      data: [],
      nextCursor: "same-cursor",
    }));
    await expect(
      discoverControlComposerResources(client({ listActiveCapabilities })),
    ).rejects.toThrow("capability cursor repeated");
    expect(listActiveCapabilities).toHaveBeenCalledTimes(2);
  });
});
