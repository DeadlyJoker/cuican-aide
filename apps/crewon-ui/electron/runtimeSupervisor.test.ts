import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";
import { desktopFinancialEnvironmentFixture } from "./desktopPluginCreditSettlementEnvironment.test-support.ts";

import {
  RuntimeSupervisor,
  agentPlatformRuntimeEnvironments,
  bindDesktopWorkspaceEnvironment,
  cloudAgentProfilesOrigin,
  cloudAgentRuntimeVersionId,
  desktopRuntimeFingerprint,
  selectDesktopRuntimeModelCatalog,
  terminateRuntimeChild,
  watchRuntimeChildren,
} from "./runtimeSupervisor.ts";

afterEach(() => vi.unstubAllEnvs());

it.each(["configured", "absent"] as const)(
  "isolates declared financial environment at actual Native child spawn with provider %s",
  async (provider) => {
    const finance = desktopFinancialEnvironmentFixture();
    for (const [name, value] of Object.entries(finance.environment))
      vi.stubEnv(name, value);
    const f = desktopPluginManagementFixture({ provider, approval: "present" });
    const audit = join(f.directory, "financial-environment.jsonl");
    for (const kind of ["release", "worker", "control"]) {
      const entry = join(f.directory, `${kind}.mjs`);
      writeFileSync(
        entry,
        finance.childAudit(audit, kind) + readFileSync(entry, "utf8"),
      );
    }
    try {
      await f.owner.start();
      const records = readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map((record) => record.kind).sort()).toEqual(
        provider === "configured"
          ? ["control", "release", "worker"]
          : ["control"],
      );
      for (const record of records) {
        if (record.kind === "worker") {
          expect(record.path).toBe(finance.path);
          expect(record.authorization).toBe(finance.authorizationToken);
          expect(record.decision).toBe(finance.decisionToken);
        } else {
          expect(record.path).toBeNull();
          expect(record.authorization).toBeNull();
          expect(record.decision).toBeNull();
        }
        expect(record.unrelated).toBe(
          provider === "configured"
            ? finance.environment.CREWON_FINANCIAL_UNDECLARED_TOKEN
            : null,
        );
      }
      expect(
        f.records().filter((record) => record.kind === "worker"),
      ).toHaveLength(provider === "configured" ? 1 : 0);
    } finally {
      await f.close();
      finance.cleanup();
    }
  },
);

describe("desktop runtime identity", () => {
  it("injects the Agent Platform key only into a cloned worker environment", () => {
    const ambientEnvironment: NodeJS.ProcessEnv = {
      CREWON_AGENT_PLATFORM_API_KEY: "wrong-ambient-key",
      CREWON_MODEL_API_KEY: "model-provider-key",
    };

    const { sharedEnvironment, workerEnvironment } =
      agentPlatformRuntimeEnvironments(
        ambientEnvironment,
        "bpk_agent-open-key",
      );

    expect(ambientEnvironment.CREWON_AGENT_PLATFORM_API_KEY).toBe(
      "wrong-ambient-key",
    );
    expect(sharedEnvironment.CREWON_AGENT_PLATFORM_API_KEY).toBeUndefined();
    expect(workerEnvironment).toEqual({
      CREWON_AGENT_PLATFORM_API_KEY: "bpk_agent-open-key",
      CREWON_MODEL_API_KEY: "model-provider-key",
    });
  });

  it("requires one secure origin for an atomic cloud Agent profile set", () => {
    const profile = {
      agentVersionId: "agent-platform:93",
      instructions: "Help with procurement.",
      invocationUrl: "https://platform.example/api/v1/open/agent/93/chat",
      modelId: "gpt-5.5",
      agentId: 93,
    } as const;

    expect(cloudAgentProfilesOrigin([profile])).toBe(
      "https://platform.example",
    );
    expect(() =>
      cloudAgentProfilesOrigin([
        profile,
        {
          ...profile,
          agentId: 94,
          invocationUrl:
            "https://credential-collector.example/api/v1/open/agent/94/chat",
        },
      ]),
    ).toThrow("cloud_agent_profile_origin_mismatch");
    expect(() =>
      cloudAgentProfilesOrigin([
        { ...profile, invocationUrl: "http://platform.example/chat" },
      ]),
    ).toThrow("cloud_agent_profile_invocation_url_invalid");
  });

  it("rejects cloud profiles before restart when their origin has no key", async () => {
    const requestedOrigins: string[] = [];
    const supervisor = new RuntimeSupervisor({
      agentPlatformApiKeyForOrigin: (origin) => {
        requestedOrigins.push(origin);
        return null;
      },
      dataDirectory: "/unused",
      paths: {
        control: "/unused/control",
        modelCatalog: "/unused/catalog",
        release: "/unused/release",
        worker: "/unused/worker",
        workspaceMcp: "/unused/mcp",
        source: false,
      },
      repositoryRoot: null,
      provider: () => null,
      providerModelCatalog: async () => null,
      workspaceRoot: () => null,
    });

    await expect(
      supervisor.updateCloudAgentProfiles([
        {
          agentVersionId: "agent-platform:93",
          instructions: "Help with procurement.",
          invocationUrl: "https://platform.example/api/v1/open/agent/93/chat",
          modelId: "gpt-5.5",
          agentId: 93,
        },
      ]),
    ).rejects.toThrow("agent_platform_api_key_missing");
    expect(requestedOrigins).toEqual(["https://platform.example"]);
  });

  it("binds the stable workspace tool catalog and live registry independently from the read-only MCP", () => {
    const environment: NodeJS.ProcessEnv = {
      CREWON_DESKTOP_WORKSPACE_ROOT: "/stale/workspace",
      CREWON_MCP_STDIO_CONFIG_PATH: "/stale/mcp.json",
      CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH: "/stale/registry.json",
    };

    bindDesktopWorkspaceEnvironment(environment, {
      mcpConfig: null,
      workspace: "/selected/workspace",
      registryPath: "/native/desktop-workspace.json",
    });

    expect(environment.CREWON_DESKTOP_WORKSPACE_ROOT).toBe(
      "/selected/workspace",
    );
    expect(environment.CREWON_MCP_STDIO_CONFIG_PATH).toBeUndefined();
    expect(environment.CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH).toBe(
      "/native/desktop-workspace.json",
    );

    bindDesktopWorkspaceEnvironment(environment, {
      mcpConfig: null,
      workspace: null,
    });
    expect(environment.CREWON_DESKTOP_WORKSPACE_ROOT).toBeUndefined();
    expect(environment.CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH).toBeUndefined();
  });

  it("publishes a new immutable AgentVersion when local MCP materialization changes", () => {
    const input = {
      providerId: "provider-1",
      endpoint: "https://provider.example/v1",
      modelId: "model-1",
      modelCatalog: ["model-1"],
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
    expect(
      desktopRuntimeFingerprint({
        ...input,
        modelCatalog: ["model-1", "model-2"],
        localWorkspaceMcp: {
          configPath: "/Applications/CrewON.app/runtime.json",
          configDigest: "a".repeat(64),
          serverDigest: "b".repeat(64),
        },
      }),
    ).not.toBe(first);
  });

  it("versions cloud Agents when their profile or desktop runtime changes", () => {
    const profile = {
      agentVersionId: "agent-platform:93",
      instructions: "Help with procurement.",
      invocationUrl:
        "http://127.0.0.1:5175/agent-platform-api/api/v1/open/agent/93/chat",
      modelId: "gpt-5.5",
      agentId: 93,
    } as const;
    const first = cloudAgentRuntimeVersionId(profile, "runtime-a");

    expect(first).toBe("agent-platform:93:cd85b99f51c01c85ed8b99306a5c4a40");
    expect(cloudAgentRuntimeVersionId(profile, "runtime-a")).toBe(first);
    expect(
      cloudAgentRuntimeVersionId(
        { ...profile, instructions: "Updated procurement instructions." },
        "runtime-a",
      ),
    ).not.toBe(first);
    expect(cloudAgentRuntimeVersionId(profile, "runtime-b")).not.toBe(first);
  });

  it("keeps the last known catalog through transient discovery failures", () => {
    expect(
      selectDesktopRuntimeModelCatalog({
        cached: ["gpt-5.5", "gpt-5.6-sol"],
        defaultModelId: "gpt-5.5",
        discovered: null,
      }),
    ).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
  });

  it("keeps runtime identity for reordered or non-agent-only differences", () => {
    expect(
      selectDesktopRuntimeModelCatalog({
        cached: ["gpt-5.5", "gpt-5.6-sol", "claude-opus", "gpt-image-2"],
        defaultModelId: "gpt-5.5",
        discovered: ["gpt-5.5", "dall-e-3", "claude-opus", "gpt-5.6-sol"],
      }),
    ).toEqual(["gpt-5.5", "gpt-5.6-sol", "claude-opus", "gpt-image-2"]);
  });

  it("accepts a discovered catalog when the runnable model set changes", () => {
    expect(
      selectDesktopRuntimeModelCatalog({
        cached: ["gpt-5.5", "gpt-5.6-sol"],
        defaultModelId: "gpt-5.5",
        discovered: ["gpt-5.5", "gpt-5.6-sol", "claude-opus"],
      }),
    ).toEqual(["gpt-5.5", "gpt-5.6-sol", "claude-opus"]);
  });

  it("falls back to the configured model without a cached catalog", () => {
    expect(
      selectDesktopRuntimeModelCatalog({
        cached: null,
        defaultModelId: "gpt-5.5",
        discovered: null,
      }),
    ).toEqual(["gpt-5.5"]);
  });

  it("does not restore a removed default from a stale cache after successful discovery", () => {
    expect(
      selectDesktopRuntimeModelCatalog({
        cached: ["gpt-5.5", "gpt-5.6-sol"],
        defaultModelId: "gpt-5.5",
        discovered: ["gpt-5.6-sol", "gpt-5.6-terra"],
      }),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(
      selectDesktopRuntimeModelCatalog({
        cached: ["gpt-5.6-sol"],
        defaultModelId: "gpt-5.5",
        discovered: null,
      }),
    ).toEqual(["gpt-5.6-sol"]);
  });

  it("distinguishes a successful empty catalog from failed discovery", () => {
    expect(
      selectDesktopRuntimeModelCatalog({
        cached: ["gpt-5.5", "gpt-5.6-sol"],
        defaultModelId: "gpt-5.5",
        discovered: [],
      }),
    ).toEqual([]);
  });

  it("reports only the first unexpected runtime child exit", () => {
    const control = new EventEmitter() as ChildProcess;
    const worker = new EventEmitter() as ChildProcess;
    const exits: Array<{
      code: number | null;
      name: string;
      signal: NodeJS.Signals | null;
    }> = [];
    watchRuntimeChildren(
      [
        { child: control, name: "Control API" },
        { child: worker, name: "Runtime Worker" },
      ],
      (event) => exits.push(event),
    );

    control.emit("exit", 1, null);
    worker.emit("exit", 0, "SIGTERM");

    expect(exits).toEqual([{ code: 1, name: "Control API", signal: null }]);
  });

  it("ignores child exits after runtime shutdown starts", () => {
    const control = new EventEmitter() as ChildProcess;
    const exits: string[] = [];
    const stopWatching = watchRuntimeChildren(
      [{ child: control, name: "Control API" }],
      (event) => exits.push(event.name),
    );

    stopWatching();
    control.emit("exit", 0, "SIGTERM");

    expect(exits).toEqual([]);
  });

  it("observes a child that exits synchronously on SIGTERM", async () => {
    const child = new FakeRuntimeChild((signal) => signal === "SIGTERM");

    await terminateRuntimeChild(child as unknown as ChildProcess, {
      forcedExitMs: 5,
      gracefulExitMs: 5,
    });

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("force-kills a child that ignores graceful shutdown", async () => {
    const child = new FakeRuntimeChild((signal) => signal === "SIGKILL");

    await terminateRuntimeChild(child as unknown as ChildProcess, {
      forcedExitMs: 20,
      gracefulExitMs: 1,
    });

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

class FakeRuntimeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly exitsOn: (signal: NodeJS.Signals) => boolean) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.exitsOn(signal)) {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    }
    return true;
  }
}
