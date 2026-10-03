import {
  ApplicationError,
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
  type ProjectGenerationContextUiResponse,
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
  PluginProjectGenerationContextActionBridge,
  type PluginProjectGenerationContextDispatchPort,
} from "./plugin-project-generation-context-action-bridge.ts";

/** Explicit memory assembly/reader ports; this does not claim production admission or execution. */
export function generationContextBridgeFixture() {
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
    files: uiTestDescriptor.files.filter((item) => item.path === "ui.mjs"),
    requires: [
      {
        service: "crewon.project-generation-contexts",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const publication = {
    source: {
      pluginId: descriptor.pluginId,
      packageDigest: uiTestPackage.packageDigest,
      contributionId: "workbench",
    },
    target: {
      pluginId: "example.execution",
      packageDigest: `sha256:${"b".repeat(64)}`,
      contributionId: "generation",
      action: "generate",
    },
  };
  const reference = {
    projectId: "project-a",
    assetId: "asset-a",
    assetRevision: 1,
    expectedProjectRevision: 3,
    expectedAssetMetadataRevision: 5,
  };
  const context = (): PluginUiActionContext => ({
    actor: { ...uiTestActor },
    scope: { ...uiTestScope },
    selection: uiTestSelection,
    package: uiTestPackage,
    authorityEpoch: "epoch-a",
    action: "crewon.project-generation-contexts.v1.getReadiness",
    input: { reference: { ...reference } },
    lease: parsePluginUiLease({
      schemaVersion: "crewon.plugin-ui-lease.v1",
      mountRef: "r".repeat(40),
      expiresAt: "2026-10-04T01:00:00.000Z",
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
    availabilityCalls: 0,
    fallbacks: 0,
    output: {
      reference,
      readiness: { outcome: "ready" },
    } as ProjectGenerationContextUiResponse,
    beforeCurrent: undefined as (() => Promise<void>) | undefined,
    beforeRead: undefined as (() => Promise<void>) | undefined,
    last: undefined as
      | Parameters<
          PluginProjectGenerationContextDispatchPort["getReadiness"]
        >[0]
      | undefined,
  };
  const contexts: PluginProjectGenerationContextDispatchPort = {
    async getReadiness(input) {
      // The real Control owner requires actual WeakMap membership, not a detached shape.
      capturePluginUiInvocationCommitAuthority(input.context).assertActive();
      state.calls++;
      state.last = input;
      await state.beforeRead?.();
      return state.output;
    },
    isAvailable() {
      state.availabilityCalls++;
      return state.available;
    },
  };
  const bridge = new PluginProjectGenerationContextActionBridge({
    publications: [publication],
    contexts,
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
        await state.beforeCurrent?.();
        if (!state.allow)
          throw new ApplicationError(
            "authorization",
            "context_fixture_revoked",
          );
      },
      () => {
        if (!state.open)
          throw new ApplicationError(
            "authorization",
            "context_fixture_expired",
          );
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
  const availability = () => ({
    scope: context().scope,
    candidate: { descriptor, packageDigest: publication.source.packageDigest },
    requirement: descriptor.requires[0]!,
  });
  return {
    state,
    descriptor,
    publication,
    reference,
    context,
    contexts,
    bridge,
    actions,
    register,
    invoke,
    availability,
    deferred: uiDeferred,
  };
}
