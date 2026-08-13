import type { ControlApiClient } from "@crewon/control-client";
import { describe, expect, it, vi } from "vitest";

import type { AppLibraryPanelDispatchHandlerParams } from "./appLibraryPanelDispatchHandler";
import { createAppLibraryPanelDispatchHandler } from "./appLibraryPanelDispatchHandler";

describe("app library Control Automation dispatch", () => {
  it("prepares creation from real Control Threads and AgentVersions", async () => {
    const setLibraryPanel = vi.fn();
    const handler = createAppLibraryPanelDispatchHandler({
      client: null,
      controlClient: {
        getActiveAgentVersionCatalog: vi.fn(async () => ({
          data: [
            {
              agentVersionId: "agent-version-1",
              model: { modelId: "gpt-5.6" },
            },
          ],
        })),
        listThreads: vi.fn(async () => ({
          data: [
            {
              status: "active",
              threadId: "thread-1",
              title: "Daily summary",
            },
          ],
        })),
      } as unknown as ControlApiClient,
      locale: "en",
      setLibraryPanel,
      setNotice: vi.fn(),
    } as unknown as AppLibraryPanelDispatchHandlerParams);

    await handler({
      id: "prepare-control-automation",
      label: "New automation",
    });

    expect(setLibraryPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          { id: "submit-control-automation", label: "Save automation" },
        ],
        fields: expect.arrayContaining([
          expect.objectContaining({
            id: "control-automation-thread",
            value: "thread-1",
          }),
          expect.objectContaining({ id: "control-automation-agent" }),
        ]),
      }),
    );
  });

  it("runs through Control and never needs a legacy client", async () => {
    const runAutomationNow = vi.fn(async () => ({
      automation: { automationId: "automation-1", threadId: "thread-1" },
      invocation: { automationId: "automation-1", runId: "run-1" },
      run: { runId: "run-1", threadId: "thread-1" },
    }));
    const setNotice = vi.fn();
    const handler = createAppLibraryPanelDispatchHandler({
      client: null,
      controlClient: {
        getThread: vi.fn(async () => ({
          thread: { threadId: "thread-1", status: "active", revision: 4 },
        })),
        runAutomationNow,
      } as unknown as ControlApiClient,
      locale: "en",
      setNotice,
    } as unknown as AppLibraryPanelDispatchHandlerParams);

    await expect(
      handler({
        id: "run-automation",
        label: "Run now",
        automationThreadId: "thread-1",
        controlAutomationId: "automation-1",
        controlAutomationRevision: 1,
      }),
    ).resolves.toBe(true);

    expect(runAutomationNow).toHaveBeenCalledWith(
      "automation-1",
      { expectedAutomationRevision: 1, expectedThreadRevision: 4 },
      expect.stringMatching(/^automation\.run-now:/u),
    );
    expect(setNotice).toHaveBeenCalledWith({
      text: "Automation started: run-1",
      tone: "success",
    });
  });
});

describe("app library Control Knowledge dispatch", () => {
  it("prepares and submits a real Control memory without a legacy client", async () => {
    const createKnowledge = vi.fn(async () => ({
      disposition: "committed" as const,
      knowledge: { knowledgeId: "knowledge-1" },
    }));
    const openLibrary = vi.fn(async () => undefined);
    const setLibraryPanel = vi.fn();
    const setNotice = vi.fn();
    const prepare = createAppLibraryPanelDispatchHandler({
      client: null,
      controlClient: { createKnowledge } as unknown as ControlApiClient,
      locale: "en",
      setLibraryPanel,
      setNotice,
    } as unknown as AppLibraryPanelDispatchHandlerParams);

    await expect(
      prepare({ id: "create-knowledge-memory", label: "Write memory" }),
    ).resolves.toBe(true);
    expect(setLibraryPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          { id: "submit-control-knowledge", label: "Save memory" },
        ],
        catalogMode: "controlKnowledge",
        fields: expect.arrayContaining([
          expect.objectContaining({ id: "control-knowledge-title" }),
          expect.objectContaining({ id: "control-knowledge-content" }),
        ]),
      }),
    );

    const submit = createAppLibraryPanelDispatchHandler({
      client: null,
      controlClient: { createKnowledge } as unknown as ControlApiClient,
      libraryPanel: {
        fields: [
          { id: "control-knowledge-title", label: "Title", value: "Decision" },
          {
            id: "control-knowledge-content",
            label: "Content",
            value: "Use Control only",
          },
        ],
      },
      locale: "en",
      openLibrary,
      selectedThreadId: "thread-1",
      setLibraryPanel,
      setNotice,
    } as unknown as AppLibraryPanelDispatchHandlerParams);

    await expect(
      submit({ id: "submit-control-knowledge", label: "Save memory" }),
    ).resolves.toBe(true);
    expect(createKnowledge).toHaveBeenCalledWith(
      {
        content: "Use Control only",
        kind: "memory",
        sourceId: "thread:thread-1",
        title: "Decision",
      },
      expect.stringMatching(/^knowledge\.create:/u),
    );
    expect(openLibrary).toHaveBeenCalledWith("knowledge");
    expect(setNotice).toHaveBeenLastCalledWith({
      text: "Memory saved.",
      tone: "success",
    });
  });

  it("loads one immutable Knowledge detail from Control", async () => {
    const getKnowledge = vi.fn(async () => ({
      knowledge: {
        content: "Canonical content",
        createdAt: "2026-08-13T00:00:00.000Z",
        kind: "source" as const,
        sourceId: "manual:user",
        title: "Reference",
      },
    }));
    const setLibraryPanel = vi.fn();
    const handler = createAppLibraryPanelDispatchHandler({
      client: null,
      controlClient: { getKnowledge } as unknown as ControlApiClient,
      locale: "en",
      setLibraryPanel,
      setNotice: vi.fn(),
    } as unknown as AppLibraryPanelDispatchHandlerParams);

    await expect(
      handler({
        id: "open-control-knowledge",
        knowledgePath: "knowledge-1",
        label: "View details",
      }),
    ).resolves.toBe(true);
    expect(getKnowledge).toHaveBeenCalledWith("knowledge-1");
    expect(setLibraryPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Canonical content",
        catalogMode: "controlKnowledge",
        title: "Reference",
      }),
    );
  });
});
