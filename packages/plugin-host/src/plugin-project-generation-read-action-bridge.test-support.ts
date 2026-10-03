import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
  type ProjectGenerationReadUiResponse,
} from "@crewon/contracts/plugins";
import { registerPluginUiInvocation } from "../../application/src/plugin-ui-invocation-authority.ts";
import {
  uiTestActor,
  uiTestScope,
  uiTestPackage,
  uiTestSelection,
  uiTestDescriptor,
  uiDeferred,
} from "../../application/src/plugin-ui.test-support.ts";
import {
  PluginProjectGenerationReadActionBridge,
  type PluginProjectGenerationReadDispatchPort,
} from "./plugin-project-generation-read-action-bridge.ts";

/** Explicit memory source/reader ports; no SQL, package execution or supplier admission is claimed. */
export function generationReadBridgeFixture() {
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
    files: uiTestDescriptor.files.filter((item) => item.path === "ui.mjs"),
    requires: [
      {
        service: "crewon.project-generation-reads",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  const publication = {
    pluginId: descriptor.pluginId,
    packageDigest: uiTestPackage.packageDigest,
    contributionId: "workbench",
  };
  const context = (): PluginUiActionContext => ({
    actor: uiTestActor,
    scope: uiTestScope,
    selection: uiTestSelection,
    package: uiTestPackage,
    authorityEpoch: "epoch-a",
    action: "crewon.project-generation-reads.v1.getConceptGeneration",
    input: { projectId: "project-a", assetId: "asset-a", assetRevision: 1 },
    lease: parsePluginUiLease({
      schemaVersion: "crewon.plugin-ui-lease.v1",
      mountRef: "r".repeat(40),
      expiresAt: "2026-10-03T01:00:00.000Z",
      selectionRevision: uiTestSelection.revision,
      packageDigest: uiTestPackage.packageDigest,
      descriptor,
      contributionId: "workbench",
      publicAssets: ["ui.mjs"],
    }),
  });
  const state = {
    open: true,
    allow: true,
    available: true,
    calls: 0,
    currentCalls: 0,
    fallbacks: 0,
    output: { generation: null } as ProjectGenerationReadUiResponse,
    beforeRead: undefined as (() => Promise<void>) | undefined,
    last: undefined as
      | Parameters<
          PluginProjectGenerationReadDispatchPort["getConceptGeneration"]
        >[0]
      | undefined,
  };
  const reads: PluginProjectGenerationReadDispatchPort = {
    async getConceptGeneration(input) {
      state.calls++;
      state.last = input;
      await state.beforeRead?.();
      return state.output;
    },
    isAvailable() {
      return state.available;
    },
  };
  const bridge = new PluginProjectGenerationReadActionBridge({
    publications: [publication],
    reads,
  });
  const actions = bridge.actions({
    invoke: async () => {
      state.fallbacks++;
      return { ordinary: true };
    },
  });
  const register = (input: PluginUiActionContext) =>
    registerPluginUiInvocation(
      input,
      async () => {
        state.currentCalls++;
        if (!state.allow)
          throw new ApplicationError("authorization", "read_fixture_revoked");
      },
      () => {
        if (!state.open)
          throw new ApplicationError("authorization", "read_fixture_expired");
      },
    );
  const invoke = async (input = context()) => {
    const dispose = register(input);
    try {
      return await actions.invoke(input);
    } finally {
      dispose();
    }
  };
  return {
    state,
    descriptor,
    publication,
    context,
    reads,
    bridge,
    actions,
    register,
    invoke,
    deferred: uiDeferred,
  };
}

export function generationReadResponse(): ProjectGenerationReadUiResponse {
  return {
    generation: {
      projectId: "project-a",
      assetId: "asset-a",
      assetRevision: 1,
      briefRevision: 1,
      createdAt: "2026-10-03T00:00:00.000Z",
      task: {
        runId: "original-run",
        threadId: "original-thread",
        pluginId: "crewon.comfyui-krea2",
        pluginVersion: "1.0.0",
        configurationRevision: 1,
        runStatus: "running",
        sourceRunId: null,
        truncated: true,
        operations: [
          {
            operationId: "11111111-2222-3333-4444-555555555555",
            sourceRunId: "original-run",
            status: "succeeded",
            operationRevision: 7,
            observedAt: "2026-10-03T00:00:00.000Z",
            images: [
              {
                url: "https://comfy.example.test/view?filename=a.png",
                filename: "a.png",
                resultIndex: 0,
              },
              {
                url: "https://comfy.example.test/view?filename=c.png",
                filename: "c.png",
                resultIndex: 2,
              },
            ],
          },
        ],
      },
    },
  };
}
