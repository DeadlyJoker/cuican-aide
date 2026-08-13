import { describe, expect, it, vi } from "vitest";

import type { ControlApiClient } from "@crewon/control-client";
import type { LibraryPanel } from "../domain/crewonDomain";
import { openControlLibraryAction } from "./controlLibraryActions";

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

  it("fails closed without calling Control API for unsupported resources", async () => {
    let panel: LibraryPanel | null = null;
    const getActiveAgentVersionCatalog = vi.fn();

    await openControlLibraryAction({
      client: { getActiveAgentVersionCatalog } as unknown as ControlApiClient,
      kind: "tools",
      locale: "en",
      selectedThreadId: null,
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(getActiveAgentVersionCatalog).not.toHaveBeenCalled();
    expect(panel).toMatchObject({
      kind: "tools",
      items: [],
      error: expect.stringContaining("Select a thread"),
    });
  });

  it("shows only run outputs that Control verifies as Artifacts", async () => {
    let panel: LibraryPanel | null = null;
    const listThreadRuns = vi.fn(async () => ({
      data: [
        { outputRef: "artifact-1" },
        { outputRef: "message:assistant-1" },
        { outputRef: "artifact-1" },
      ],
      nextCursor: null,
    }));
    const getArtifact = vi.fn(async (artifactId: string) => {
      if (artifactId !== "artifact-1") {
        throw new Error("not an artifact");
      }
      return {
        artifact: {
          artifactId,
          kind: "toolOutput" as const,
          mediaType: "application/json",
          sensitivity: "workspaceSensitive" as const,
          contentDigest: "sha256:digest",
          byteLength: 42,
          source: {
            kind: "toolOutput" as const,
            runId: "run-1",
            stepId: "step-1",
            callId: "call-1",
          },
          retention: {
            kind: "run" as const,
            expiresAt: "2026-08-14T00:00:00.000Z",
          },
          encryption: { scheme: "aes256gcm" as const },
          scan: { status: "clean" as const, scannedAt: null },
        },
      };
    });

    await openControlLibraryAction({
      client: { listThreadRuns, getArtifact } as unknown as ControlApiClient,
      kind: "tools",
      locale: "en",
      selectedThreadId: "thread-1",
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(listThreadRuns).toHaveBeenCalledWith("thread-1", { limit: 50 });
    expect(getArtifact).toHaveBeenCalledTimes(2);
    expect(panel).toMatchObject({
      kind: "tools",
      items: [
        {
          title: "artifact-1",
          meta: "application/json · 42 B",
          description: "From Run run-1 · Step step-1",
        },
      ],
    });
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
      "requires a published AgentVersion selection",
    );
  });
});
