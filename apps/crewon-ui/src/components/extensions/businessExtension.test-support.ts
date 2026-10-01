import { vi } from "vitest";
import type {
  ActiveAgentVersionCatalogResponse,
  ExtensionCatalogEntry,
  ExtensionTaskView,
  GetExtensionActivationResponse,
  GetExtensionConfigurationResponse,
  ThreadView,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import { controlThreadProjection } from "../../lib/control-runtime/controlThreadRuntime";

export const digest = `sha256:${"a".repeat(64)}`;
export const timestamp = "2026-10-01T00:00:00.000Z";
export const entry: ExtensionCatalogEntry = {
  pluginId: "crewon.comfyui-krea2",
  pluginVersion: "0.1.0",
  title: "Krea2 image generation",
  description: "Generate images through ComfyUI.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string", maxLength: 2_000, enum: null } },
  },
  configurationSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: { baseUrl: { type: "string", maxLength: 2_048, enum: null } },
  },
  credentialSlots: [],
  resultViews: ["text", "externalOperation", "externalResult"],
};
export const configuration: NonNullable<
  GetExtensionConfigurationResponse["configuration"]
> = {
  schemaVersion: "crewon.extension-configuration.v0",
  tenantId: "tenant",
  spaceId: "space",
  pluginId: entry.pluginId,
  pluginVersion: entry.pluginVersion,
  revision: 1,
  manifestDigest: digest,
  implementationDigest: digest,
  contentDigest: digest,
  parameters: { baseUrl: "https://comfyui.example.com/" },
  credentialBindings: [],
  createdByActorId: "actor",
  createdAt: timestamp,
};
export const target = {
  executionAuthority: "crewonKernel" as const,
  agentVersionId: "image-agent",
  agentVersionContentDigest: digest,
  materializationDigest: digest,
  authorityId: "authority",
  runtimeGeneration: "ts-v0",
  policySnapshotId: "policy",
  workspaceBindingId: null,
};
export const activation: NonNullable<
  GetExtensionActivationResponse["activation"]
> = {
  schemaVersion: "crewon.extension-activation.v0",
  tenantId: "tenant",
  spaceId: "space",
  pluginId: entry.pluginId,
  revision: 1,
  configurationRevision: 1,
  configurationDigest: digest,
  state: "enabled",
  target,
  updatedByActorId: "actor",
  updatedAt: timestamp,
};
export const catalog: ActiveAgentVersionCatalogResponse = {
  releaseId: digest,
  activatedAt: timestamp,
  defaultAgentVersionId: "default-agent",
  data: ["default-agent", "image-agent"].map((agentVersionId) => ({
    agentVersionId,
    contentDigest: digest,
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy",
    model: {
      adapterName: "responses-http",
      adapterVersion: "1",
      modelId: "fixture-model",
    },
    createdAt: timestamp,
  })),
};
export function threadView(id = "thread-1"): ThreadView {
  return {
    threadId: id,
    title: "Current conversation",
    status: "active",
    revision: 3,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    deletedAt: null,
  };
}
export function thread(id = "thread-1") {
  return controlThreadProjection(threadView(id), [], []);
}
export function task(
  patch: Partial<ExtensionTaskView> = {},
): ExtensionTaskView {
  return {
    runId: "image-run",
    threadId: "thread-1",
    pluginId: entry.pluginId,
    pluginVersion: entry.pluginVersion,
    configurationRevision: 1,
    runStatus: "running",
    sourceRunId: null,
    operations: [],
    truncated: false,
    ...patch,
  };
}
export function client() {
  return {
    listExtensions: vi.fn<ControlApiClient["listExtensions"]>(async () => ({
      extensions: [entry],
    })),
    getExtensionConfiguration: vi.fn<
      ControlApiClient["getExtensionConfiguration"]
    >(async () => ({ configuration })),
    getExtensionActivation: vi.fn<ControlApiClient["getExtensionActivation"]>(
      async () => ({ activation }),
    ),
    getActiveAgentVersionCatalog: vi.fn<
      ControlApiClient["getActiveAgentVersionCatalog"]
    >(async () => catalog),
    getExtensionRuntime: vi.fn<ControlApiClient["getExtensionRuntime"]>(
      async (_plugin, query) => ({
        pluginId: entry.pluginId,
        ...query,
        readiness: {
          outcome: "ready",
          target: { ...target, agentVersionId: query.agentVersionId },
        },
      }),
    ),
    getExtensionTask: vi.fn<ControlApiClient["getExtensionTask"]>(
      async (_plugin, runId) => ({ task: task({ runId }) }),
    ),
    saveExtensionConfiguration: vi.fn<
      ControlApiClient["saveExtensionConfiguration"]
    >(async (_plugin, body) => ({
      disposition: "created",
      configuration: {
        ...configuration,
        revision: body.expectedRevision + 1,
        parameters: body.parameters,
      },
    })),
    setExtensionActivation: vi.fn<ControlApiClient["setExtensionActivation"]>(
      async (_plugin, body) => ({
        disposition: "updated",
        activation: {
          ...activation,
          revision: body.expectedRevision + 1,
          state: body.state,
          configurationRevision: body.configurationRevision,
          target:
            body.agentVersionId === null
              ? null
              : { ...target, agentVersionId: body.agentVersionId },
        },
      }),
    ),
    createThread: vi.fn<ControlApiClient["createThread"]>(async () => ({
      disposition: "committed",
      thread: threadView(),
    })),
    getThread: vi.fn<ControlApiClient["getThread"]>(async (id) => ({
      thread: threadView(id),
      eventSequence: 3,
    })),
    createExtensionTask: vi.fn<ControlApiClient["createExtensionTask"]>(
      async (_plugin, body) => ({
        disposition: "committed",
        threadId: body.threadId,
        threadRevision: body.expectedThreadRevision + 1,
        runId: "image-run",
        messageId: "message-1",
        configurationRevision: 1,
      }),
    ),
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
