import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, chmodSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { ModelTransportPort, ModelRequest } from "@crewon/agent-kernel";
import { RunExecutionService } from "@crewon/application";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
} from "@crewon/plugin-host";
import {
  compileRuntimeAgentVersionRelease,
  activateRuntimeAgentVersionRelease,
} from "./agent-version-release.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import {
  createInstalledPluginAgentVersionRuntimeFactory,
  installedPluginAgentRuntimeTarget,
  type InstalledPluginAgentRuntimeEntry,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import {
  prepareInstalledPluginRuntimeResolver,
  type InstalledPluginExecutionConfig,
} from "./plugins/installed-plugin-runtime-composition.ts";
import { RuntimeWorker, type RuntimeWorkerConfig } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import { mediaInputStageWorkerFixture } from "./project-media-input-stage-worker.test-support.ts";

function removeOwned(root: string) {
  chmodSync(root, 0o700);
  for (const e of readdirSync(root, { withFileTypes: true }))
    if (e.isDirectory()) removeOwned(join(root, e.name));
  rmSync(root, { recursive: true });
}
/** Genuine RuntimeWorker dispatch/queue/stream and installed Short23. Only model, deployment/PDP and preexisting source history are named fixtures. */
export async function mediaInputWorkerFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-media-input-worker-")),
    inode = statSync(root);
  const lifetimes: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const o of lifetimes.slice().reverse()) await o.close();
    const actual = statSync(root);
    assert.equal(actual.dev, inode.dev);
    assert.equal(actual.ino, inode.ino);
    removeOwned(root);
  });
  const pkg = await installLocalPluginPackage({
    directory: resolve(
      process.env.CREWON_MEDIA_INPUT_PACKAGE_DIR ??
        "output/extensions/installable-plugins/short-drama-media-input-agent-20261006/short-drama/23.0.0",
    ),
    installRoot: root,
    authorization: async () => ({ outcome: "allow" }),
  });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: root,
    expectedPluginId: pkg.descriptor.pluginId,
    expectedPublisherId: pkg.descriptor.publisherId,
    expectedVersion: pkg.descriptor.version,
    expectedPackageDigest: pkg.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  const state = {
    service: true,
    active: true,
    package: true,
    factories: 0,
    projectServiceCalls: 0,
    requests: [] as ModelRequest[],
    observed: new Map<string, any>(),
    mode: "normal" as "normal" | "foreign" | "generation" | "unscoped-write",
    beforeService: null as (() => Promise<void>) | null,
  };
  const transport: ModelTransportPort = {
    adapterName: "named-short23-media-input-model",
    adapterVersion: "1",
    modelId: "fixture-media-input-agent",
    async *stream(r) {
      state.requests.push(r);
      assert.equal(
        r.tools.filter((t) => t.name.startsWith("crewon_short_drama__")).length,
        24,
      );
      const results = r.input.items.filter((i) => i.type === "tool_result");
      for (const i of results)
        state.observed.set(
          i.callId,
          JSON.parse(JSON.parse(i.output).resultJson),
        );
      const saved = state.observed.get("saveInput"),
        projectId = f.request.projectId;
      const query = {
        projectId,
        mediaInputId: saved?.input.mediaInputId,
        inputRevision: 1,
      };
      const steps = [
        { method: "getContext", request: {} },
        { method: "getOptions", request: { projectId } },
        {
          method: "saveInput",
          request: {
            ...f.request,
            ...(state.mode === "foreign"
              ? { projectId: "another-project" }
              : {}),
          },
        },
        { method: "getInput", request: query },
        { method: "readPrompt", request: { ...query, offset: 0 } },
        {
          method: "listInputs",
          request: { projectId, afterMediaInputId: null, limit: 4 },
        },
      ];
      const next = steps.find(
        (s) => !results.some((i) => i.callId === s.method),
      );
      if (next)
        yield {
          type: "tool.call",
          kind: "function",
          callId: next.method,
          name:
            state.mode === "generation"
              ? "crewon_short_drama__media_submit"
              : state.mode === "unscoped-write"
                ? "crewon_short_drama__project_create"
                : "crewon_short_drama__media_input",
          input: JSON.stringify(
            state.mode === "generation"
              ? {}
              : state.mode === "unscoped-write"
                ? { title: "must not create", briefText: "forbidden" }
                : {
                    method: next.method,
                    requestJson: JSON.stringify(next.request),
                  },
          ),
        };
      else {
        yield { type: "output.delta", delta: "参考图输入已保存，" };
        yield { type: "output.delta", delta: "可以在工作台继续编辑。" };
      }
      yield { type: "completed", checkpoint: null };
    },
  };
  let entry!: InstalledPluginAgentRuntimeEntry,
    target!: ReturnType<typeof installedPluginAgentRuntimeTarget>;
  const f = await mediaInputStageWorkerFixture(t, backend, kind, {
    installedFixture: {
      version: pkg.descriptor.version,
      publisherId: pkg.descriptor.publisherId,
      packageDigest: pkg.packageDigest,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      preset: "krea2-portrait",
      manifest: registration.manifest,
    },
    runtimeTargetFixture: async ({
      parent,
      actor,
      configuration,
      profileId,
    }) => {
      const route = {
          agentVersionId: "media-base-agent",
          authorityId: "media-base-authority",
          runtimeGeneration: "media-base-generation",
          policySnapshotId: "media-base-policy",
          workspaceBindingId: null,
        },
        base = compileRuntimeAgentVersionRelease(
          {
            runtimeTenantId: actor.tenantId,
            route,
            transport,
            toolRuntime: new InMemoryToolBroker([], new Map()),
            maxToolRounds: 12,
          },
          digester,
        ),
        version = compileInstalledPluginAgentVersion({
          base: {
            executionAuthority: "crewonKernel",
            version: base.bootstrapVersion,
          },
          registration,
          agentVersionId: "installed-media-agent",
          runtimeGeneration: "installed-media-generation",
          policySnapshotId: "installed-media-policy",
          digester,
        });
      entry = {
        scope: { tenantId: actor.tenantId, spaceId: actor.spaceId, profileId },
        registration,
        configuration,
        approvalRequirement: "none",
        base: {
          executionAuthority: "crewonKernel",
          version: base.bootstrapVersion,
          deployment: base.deployments[0]!,
        },
        version,
        authorityId: "installed-media-authority",
        workspaceBindingId: null,
        createTransport: () => transport,
        createBaseToolRuntime: () => new InMemoryToolBroker([], new Map()),
      };
      // Use the actual installation profile selected by the original fixture recipe.
      const installs = parent.pluginInstallationStore();
      const selected = await installs.loadSelection({
        scope: { tenantId: actor.tenantId, spaceId: actor.spaceId, profileId },
        pluginId: pkg.descriptor.pluginId,
      });
      assert.ok(selected);
      target = installedPluginAgentRuntimeTarget({
        defaultAgentVersionId: route.agentVersionId,
        entry,
      });
      const factory = createInstalledPluginAgentVersionRuntimeFactory({
        defaultAgentVersionId: route.agentVersionId,
        entries: [entry],
      });
      const release = compileRuntimeAgentVersionRelease(
        {
          runtimeTenantId: actor.tenantId,
          route,
          transport,
          toolRuntime: new InMemoryToolBroker([], new Map()),
          maxToolRounds: 12,
          additionalAgentVersions: [version],
          agentVersionDeployments: factory.deploymentBindings(actor.tenantId),
        },
        digester,
      );
      await activateRuntimeAgentVersionRelease({
        actor,
        store: parent,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => new Date().toISOString() },
        plan: release,
        activationId: "media-worker-release",
      });
      return target;
    },
  });
  const open = async (
    current: Pick<typeof f, "parent" | "ext" | "app"> = f,
    workerConfig: Partial<RuntimeWorkerConfig> = {},
    deployment: "enabled" | "absent" = "enabled",
  ) => {
    const config: InstalledPluginExecutionConfig = {
      installRoot: root,
      authorization: { authorize: async () => f.decision(state.active) },
      resolveActor: async () => (state.active ? f.actor : null),
      authorizePackage: async () => (state.package ? "allow" : "deny"),
      projectTools: {
        version: "crewon.project-tools.v1",
        authorization: { authorize: async () => f.decision(state.active) },
        authorizeService: async () => {
          state.projectServiceCalls++;
        },
      },
      ...(deployment === "absent"
        ? {}
        : {
            projectMediaInputs: {
              version: "crewon.project-media-input-tools.v1" as const,
              authorization: {
                authorize: async () => f.decision(state.active),
              },
              createInputs: ({ store }: { store: typeof f.parent }) => {
                assert.equal(store, current.parent);
                state.factories++;
                return current.app;
              },
              authorizeService: async (
                _admission: unknown,
                signal: AbortSignal,
              ) => {
                await state.beforeService?.();
                signal.throwIfAborted();
                if (!state.service)
                  throw Error("named_media_input_service_denied");
              },
            },
          }),
    };
    const resolver = await prepareInstalledPluginRuntimeResolver({
      store: current.parent,
      extensions: current.ext,
      config,
    });
    let base:
        | Awaited<
            ReturnType<
              ReturnType<
                typeof createInstalledPluginAgentVersionRuntimeFactory
              >["create"]
            >
          >
        | undefined,
      worker: RuntimeWorker | undefined,
      closed = false;
    const close = async () => {
      if (closed) return;
      await worker?.close();
      await resolver.close?.();
      await base?.close?.();
      closed = true;
    };
    lifetimes.push({ close });
    const factory = createInstalledPluginAgentVersionRuntimeFactory({
      defaultAgentVersionId: entry.base.version.agentVersionId,
      entries: [entry],
    });
    base = await factory.create({
      tenantId: f.actor.tenantId,
      version: entry.version,
    });
    worker = new RuntimeWorker(
      {
        store: current.parent,
        execution: new RunExecutionService({
          store: current.parent,
          clock: { now: () => new Date().toISOString() },
          ids: { nextId: () => randomUUID() },
          digester,
        }),
        kernel: base.kernel,
        policy: new PinnedRunExecutionPolicy(target),
        toolRuntime: base.toolRuntime,
        agentVersionRuntimeResolver: { resolve: () => base },
        pluginTaskAdmissions: current.ext,
        installedPluginRuntimeResolver: resolver,
      },
      {
        ownerId: randomUUID(),
        nextLeaseId: randomUUID,
        leaseDurationMs: 30000,
        retryAfterMs: 0,
        approvalRecheckMs: 1,
        scanIntervalMs: null,
        ...workerConfig,
      },
    );
    return { worker, resolver, base, config, close };
  };
  return {
    ...f,
    root,
    pkg,
    registration,
    materialState: f.state,
    state,
    entry,
    target,
    open,
  };
}
const digester = {
  sha256: (s: string) =>
    "sha256:" + createHash("sha256").update(s).digest("hex"),
};
