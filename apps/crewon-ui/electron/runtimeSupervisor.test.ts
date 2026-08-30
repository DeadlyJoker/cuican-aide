import { describe, expect, it } from "vitest";

import { desktopRuntimeFingerprint } from "./runtimeSupervisor.ts";

describe("desktop runtime identity", () => {
  it("publishes a new immutable AgentVersion when local MCP materialization changes", () => {
    const input = {
      providerId: "provider-1",
      endpoint: "https://provider.example/v1",
      modelId: "model-1",
      agentProfiles: [
        {
          agentVersionIdSuffix: "planner",
          instructions: "Plan the task.",
        },
      ],
    } as const;
    const first = desktopRuntimeFingerprint({
      ...input,
      localWorkspaceMcp: {
        configPath: "/Applications/CrewON.app/runtime.json",
        configDigest: "a".repeat(64),
        serverDigest: "b".repeat(64),
      },
    });

    expect(
      desktopRuntimeFingerprint({
        ...input,
        localWorkspaceMcp: null,
      }),
    ).not.toBe(first);
    expect(
      desktopRuntimeFingerprint({
        ...input,
        localWorkspaceMcp: {
          configPath: "/Volumes/CrewON.app/runtime.json",
          configDigest: "a".repeat(64),
          serverDigest: "b".repeat(64),
        },
      }),
    ).not.toBe(first);
    expect(
      desktopRuntimeFingerprint({
        ...input,
        localWorkspaceMcp: {
          configPath: "/Applications/CrewON.app/runtime.json",
          configDigest: "c".repeat(64),
          serverDigest: "b".repeat(64),
        },
      }),
    ).not.toBe(first);
    expect(
      desktopRuntimeFingerprint({
        ...input,
        localWorkspaceMcp: {
          configPath: "/Applications/CrewON.app/runtime.json",
          configDigest: "a".repeat(64),
          serverDigest: "d".repeat(64),
        },
      }),
    ).not.toBe(first);
  });
});
