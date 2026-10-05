import { vi } from "vitest";
import type {
  DesktopLocalPluginExecutionIdentity,
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionResult,
  DesktopLocalPluginExecutionSetupClient,
  DesktopLocalPluginExecutionStatus,
} from "../../lib/desktop/desktopLocalPluginExecutionSetupProtocol";

export const executionTestIdentity: DesktopLocalPluginExecutionIdentity =
  Object.freeze({
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "12.0.0",
    packageDigest: `sha256:${"c".repeat(64)}`,
    manifestDigest: `sha256:${"a".repeat(64)}`,
    implementationDigest: `sha256:${"b".repeat(64)}`,
    selectionRevision: 7,
    configurationRevision: 3,
    configurationDigest: `sha256:${"d".repeat(64)}`,
  });
export const executionTestParameters = Object.freeze({
  baseUrl: "https://named-comfy-generation.test/",
  preset: "krea2-portrait" as const,
});
export function historicalQueryPreview(
  identity = executionTestIdentity,
): NonNullable<DesktopLocalPluginExecutionPreview["historyQuery"]> {
  return Object.freeze({
    source: {
      pluginId: identity.pluginId,
      packageDigest: identity.packageDigest,
      contributionId: "workbench",
    },
    target: {
      pluginId: "crewon.comfyui-krea2",
      publisherId: "example.publisher",
      version: "1.0.0",
      packageDigest: `sha256:${"e".repeat(64)}`,
      manifestDigest: `sha256:${"f".repeat(64)}`,
      implementationDigest: `sha256:${"1".repeat(64)}`,
      contributionId: "studio",
      action: "image.query" as const,
    },
    selectionRevision: 2,
    configurationRevision: 1,
    configurationDigest: `sha256:${"2".repeat(64)}`,
    scope: "query-existing-generations" as const,
    methods: Object.freeze(["GET"] as const),
  });
}

/** A named Native DTO fixture only; no filesystem, authority, runtime, network or supplier is created. */
export class ExecutionSetupFixture {
  status: DesktopLocalPluginExecutionStatus | null = null;
  readonly ownerListeners = new Set<() => void>();
  readonly statusListeners = new Set<() => void>();
  onPreview?: () => Promise<DesktopLocalPluginExecutionPreview>;
  onConfirm?: () => Promise<DesktopLocalPluginExecutionResult>;
  onStatus?: () => Promise<DesktopLocalPluginExecutionStatus | null>;
  constructor(readonly identity = executionTestIdentity) {}
  preview(): DesktopLocalPluginExecutionPreview {
    return {
      ...this.identity,
      ...executionTestParameters,
      previewId: "named-execution-preview",
      expiresAt: Date.now() + 60_000,
      approvalRequirement: "none",
      networkPaths: [
        { method: "POST", path: "/prompt" },
        { method: "GET", path: "/queue" },
        { method: "GET", operationPathPrefix: "/history/" },
      ],
    };
  }
  result(): DesktopLocalPluginExecutionResult {
    return {
      ...this.identity,
      state: "prepared",
      runtimeStatus: "ready",
      stage: "mappingCommitted",
    };
  }
  committed(): DesktopLocalPluginExecutionStatus {
    return {
      previewId: "named-execution-preview",
      pluginId: this.identity.pluginId,
      state: "committed",
      result: this.result(),
    };
  }
  emitStatus() {
    for (const listener of [...this.statusListeners]) listener();
  }
  emitOwner() {
    for (const listener of [...this.ownerListeners]) listener();
  }
  readonly client: DesktopLocalPluginExecutionSetupClient = {
    version: 1,
    preview: vi.fn(async (_request) =>
      this.onPreview ? this.onPreview() : this.preview(),
    ),
    confirm: vi.fn(async (_request) => {
      if (this.onConfirm) return this.onConfirm();
      this.status = this.committed();
      return this.result();
    }),
    cancel: vi.fn(async (_request) => {}),
    readStatus: vi.fn(async (_request) =>
      this.onStatus ? this.onStatus() : this.status,
    ),
    subscribeOwnerChanged: (listener) => {
      this.ownerListeners.add(listener);
      return () => {
        this.ownerListeners.delete(listener);
      };
    },
    subscribeStatusChanged: (listener) => {
      this.statusListeners.add(listener);
      return () => {
        this.statusListeners.delete(listener);
      };
    },
  };
  get access() {
    return { client: this.client, ownerKey: "named-account:0" };
  }
}
