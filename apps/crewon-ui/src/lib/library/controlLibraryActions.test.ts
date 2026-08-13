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
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
    });

    expect(getActiveAgentVersionCatalog).not.toHaveBeenCalled();
    expect(panel).toMatchObject({
      kind: "tools",
      items: [],
      error: expect.stringContaining("legacy app-server fallback is blocked"),
    });
  });
});
