import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { PluginProjectMediaInputToolsService } from "@crewon/contracts/project-media-input-tools";
import { mediaInputToolFixture } from "./project-media-input-tools.test-support.ts";
import {
  ProjectMediaInputToolsServiceOwner,
  type ProjectMediaInputToolsServiceOwnerDependencies,
} from "./plugins/project-media-input-tools-service-owner.ts";
import {
  withWorkerToolDispatch,
  withCheckedWorkerToolDispatch,
} from "./plugins/worker-tool-dispatch-authority.ts";

export async function mediaInputToolsOwnerFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
  options: NonNullable<Parameters<typeof mediaInputToolFixture>[3]> = {},
) {
  const f = await mediaInputToolFixture(t, backend, kind, options),
    binding = await f.ext.loadExtensionRunBinding(f.locator);
  assert.ok(binding);
  const configuration = await f.ext.loadExtensionConfiguration({
    ...f.actor,
    pluginId: binding.pluginId,
    revision: binding.configurationRevision,
  });
  assert.ok(configuration);
  const context: PluginToolRuntimeContext = {
    identity: {
      pluginId: f.admission.pluginId,
      version: f.admission.version,
      packageDigest: f.admission.packageDigest,
    },
    scope: {
      tenantId: f.admission.tenantId,
      spaceId: f.admission.spaceId,
      profileId: f.admission.profileId,
    },
    run: {
      runId: binding.runId,
      threadId: binding.threadId,
      bindingDigest: binding.bindingDigest,
      inputDigest: binding.inputDigest,
      source: binding.source,
    },
    configuration: {
      revision: configuration.revision,
      contentDigest: configuration.contentDigest,
      parameters: configuration.parameters,
      credentialBindings: configuration.credentialBindings,
    },
    target: binding.target,
  };
  const state = { service: true, actor: f.actor };
  const deps: ProjectMediaInputToolsServiceOwnerDependencies = {
    context,
    admission: f.admission,
    mediaInputStageAdmission: f.stage,
    inputs: f.app,
    stages: f.stages,
    conversations: f.conversations,
    tools: options.installedFixture?.manifest.tools ?? [
      {
        operationId: "media_input",
        adapterId: "named_media_input_adapter",
        description: "Named actual dispatch fixture",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        execution: "serial",
        effect: "mutation",
        recovery: "reconcilable",
        capability: "project.media-input.write",
      },
    ],
    runs: f.parent,
    installations: f.parent.pluginInstallationStore(),
    authorization: {
      authorize: async () =>
        f.controls.policy
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_media_input_denied" },
    },
    resolveActor: async () => state.actor,
    authorizeMediaInputService: async (signal) => {
      signal.throwIfAborted();
      if (!state.service) throw Error("named_media_input_service_withdrawn");
    },
    authorizeCurrent: async ({ signal }) => {
      signal.throwIfAborted();
      await f.current();
    },
    authorizeTransaction: async ({ signal }) => {
      signal.throwIfAborted();
      await f.current();
    },
    assertActive: f.active,
  };
  const owners: ProjectMediaInputToolsServiceOwner[] = [];
  function owner(
    overrides: Partial<ProjectMediaInputToolsServiceOwnerDependencies> = {},
  ) {
    const owner = new ProjectMediaInputToolsServiceOwner({
      ...deps,
      ...overrides,
    });
    owners.push(owner);
    return owner;
  }
  t.after(async () => {
    for (const owner of owners) {
      await owner.close();
      assert.equal(owner.canRetire(), true);
    }
  });
  const service = (owner: ProjectMediaInputToolsServiceOwner) =>
    owner.hostServices()[0]!.value as PluginProjectMediaInputToolsService;
  async function invoke<T>(
    owner: ProjectMediaInputToolsServiceOwner,
    op: Awaited<ReturnType<typeof f.prepareTool>>,
    delegate: (command: typeof op.command) => Promise<T>,
    options: {
      copied?: boolean;
      signal?: AbortSignal;
      method?: "execute" | "reconcile" | "cancel";
    } = {},
  ) {
    const i = {
      command: op.command,
      method: options.method ?? "execute",
      signal: options.signal ?? new AbortController().signal,
    };
    return withWorkerToolDispatch(
      { ...i, receipt: op.receipt, assertCurrent: () => op.claim },
      () => {
        const checked = structuredClone(op.command);
        return withCheckedWorkerToolDispatch(
          { ...i, originalCommand: op.command, command: checked },
          () =>
            owner.withInvocation({ ...i, command: checked }, () =>
              delegate(options.copied ? structuredClone(checked) : checked),
            ),
        );
      },
    );
  }
  return { ...f, context, deps, ownerState: state, owner, service, invoke };
}
