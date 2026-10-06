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
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
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
import { mediaGenerationFixture } from "./project-media-generation.test-support.ts";
import {
  reviewedMediaGraphs,
  providerId,
} from "./project-media-execution.test-support.ts";
import { ProjectMediaResultPublisher } from "./project-media-result-publisher.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import { mediaExecutionDigest } from "./project-media-execution-review.ts";
import type { PinnedHttpRequest } from "./pinned-node-http.ts";

function removeOwned(root: string) {
  chmodSync(root, 0o700);
  for (const e of readdirSync(root, { withFileTypes: true }))
    if (e.isDirectory()) removeOwned(join(root, e.name));
  rmSync(root, { recursive: true });
}
/** Genuine Worker, installed factory/Node owner, native queue/Tool receipts and source/results.
 * Model stream, PDP/review and DNS/provider sockets are named fixtures. No private dispatch receipt issuer.
 */
export async function mediaWorkerFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-media-worker-")),
    inode = statSync(root);
  const lifetimes: { close(): Promise<void> }[] = [],
    publishers: ProjectMediaResultPublisher[] = [],
    archives: FilesystemProjectMediaResultArchive[] = [];
  t.after(async () => {
    for (const o of lifetimes.slice().reverse()) await o.close();
    for (const p of publishers) await p.close();
    for (const a of archives) a.close();
    const current = statSync(root);
    assert.equal(current.dev, inode.dev);
    assert.equal(current.ino, inode.ino);
    removeOwned(root);
  });
  const pkg = await installLocalPluginPackage({
    directory: resolve(
      process.env.CREWON_MEDIA_WORKER_PACKAGE_DIR ??
        "output/extensions/installable-plugins/short-drama-media-worker-20261006/short-drama/21.0.1",
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
  const graphs = await reviewedMediaGraphs(),
    state = {
      submit: true,
      observe: true,
      active: true,
      io: true,
      package: true,
      posts: 0,
      gets: 0,
      materialFactories: 0,
      materialCloses: 0,
      onHttp: null as ((request: PinnedHttpRequest) => Promise<void>) | null,
      requests: [] as ModelRequest[],
      http: [] as PinnedHttpRequest[],
    };
  const transport: ModelTransportPort = {
    adapterName: "named-short21-media-model",
    adapterVersion: "1",
    modelId: "fixture-media-agent",
    async *stream(r) {
      state.requests.push(r);
      const results = r.input.items.filter((i) => i.type === "tool_result");
      if (!results.some((i) => i.callId === "media-submit"))
        yield {
          type: "tool.call",
          kind: "function",
          callId: "media-submit",
          name: "crewon_short_drama__media_submit",
          input: "{}",
        };
      else if (!results.some((i) => i.callId === "media-observe"))
        yield {
          type: "tool.call",
          kind: "function",
          callId: "media-observe",
          name: "crewon_short_drama__media_observe",
          input: "{}",
        };
      else yield { type: "output.delta", delta: "named media task finished" };
      yield { type: "completed", checkpoint: null };
    },
  };
  let entry!: InstalledPluginAgentRuntimeEntry,
    target!: ReturnType<typeof installedPluginAgentRuntimeTarget>;
  const f = await mediaGenerationFixture(t, backend, {
    unmetered: true,
    taskClockFixture: "current",
    workflowDigestsFixture: Object.fromEntries(
      graphs.graphs.map((g) => [g.id, mediaExecutionDigest(g.template)]),
    ),
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
            maxToolRounds: 8,
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
          maxToolRounds: 8,
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
  // Hold only historical source-fixture work. The media lease and every Tool receipt are issued by the actual Worker.
  for (let i = 0; i < 16; i++) {
    const held = await f.parent.claimNextWorkItem({
      ownerId: "named-held-source-history",
      leaseId: randomUUID(),
      leaseDurationMs: 60000,
    });
    if (!held) break;
  }
  const { task } = await f.prepare(kind),
    accepted = await f.create(task),
    reviews = graphs.graphs.map((g) => ({
      ...f.reviews.find((r) => r.workflow.workflowId === g.id)!,
      targetIdentity: {
        ...f.reviewedTarget,
        manifestDigest: registration.manifestDigest,
      },
      template: g.template,
      promptBinding: g.promptBinding,
      imageBindings: g.imageBindings,
    }));
  assert.equal(entry.scope.profileId, f.pin.profileId);
  const open = async (
    current: Pick<typeof f, "parent" | "ext" | "materials"> = f,
    workerConfig: Partial<RuntimeWorkerConfig> = {},
  ) => {
    const config: InstalledPluginExecutionConfig = {
      installRoot: root,
      authorization: { authorize: async () => f.decision(state.active) },
      resolveActor: async () => (state.active ? f.actor : null),
      authorizePackage: async () => (state.package ? "allow" : "deny"),
      executionIo: {
        resolveNetwork: async () =>
          state.io
            ? {
                baseUrlParameter: "baseUrl",
                paths: [
                  { method: "POST", path: "/prompt" },
                  { method: "GET", path: "/queue" },
                  { method: "GET", operationPathPrefix: "/history/" },
                ],
              }
            : null,
        dns: { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] },
        transport: {
          request: async (r) => {
            state.http.push(r);
            const post = r.method === "POST";
            if (post) state.posts++;
            else state.gets++;
            await state.onHttp?.(r);
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: Buffer.from(
                JSON.stringify(
                  post
                    ? { prompt_id: providerId }
                    : {
                        [providerId]: {
                          status: { completed: true, status_str: "success" },
                          outputs: {
                            [kind === "T10" ? "129" : "17"]: {
                              images: [
                                {
                                  filename: "actual-worker-result.png",
                                  subfolder: "worker",
                                  type: "output",
                                },
                              ],
                            },
                          },
                        },
                      },
                ),
              ),
            };
          },
        },
      },
      projectMedia: {
        version: "crewon.project-media-worker.v1",
        reviews,
        metadataAuthorization: f.mediaAuthorization,
        authorization: {
          authorize: async (p) =>
            f.decision(
              p.action === "projectMediaRun:submit"
                ? state.submit
                : state.observe,
            ),
          assertActive: () => {
            if (!state.active) throw new Error("named_media_worker_retired");
          },
        },
        createMaterials: async ({ store }) => {
          assert.equal(store, current.parent);
          state.materialFactories++;
          return {
            materials: current.materials,
            close: async () => {
              state.materialCloses++;
            },
          };
        },
      },
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
  const resultRoot = join(root, "result-bytes"),
    publish = async (current: Pick<typeof f, "parent" | "ext"> = f) => {
      const store = current.ext.projectMediaResults();
      await store.migrate();
      const archive = new FilesystemProjectMediaResultArchive({
        archiveId: "named-worker-result",
        rootDirectory: resultRoot,
        encryptionKey: Buffer.alloc(32, 27),
        keyId: "named-worker-result-key",
      });
      archives.push(archive);
      const publisher = new ProjectMediaResultPublisher({
        store,
        archive,
        authorization: {
          authorize: async () => f.decision(state.active),
          assertActive: () => {
            if (!state.active) throw new Error("named_media_worker_retired");
          },
        },
        reviews: reviews.map(({ workflow, targetIdentity }) => ({
          workflow,
          targetIdentity,
        })),
        clock: { now: () => new Date().toISOString() },
        dns: { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] },
        transport: {
          request: async () => ({
            status: 200,
            headers: { "content-type": "image/png" },
            body: materialPng(),
          }),
        },
      });
      publishers.push(publisher);
      return {
        publisher,
        result: await publisher.publish(
          f.actor,
          {
            projectId: task.reference.projectId,
            runId: accepted.binding.runId,
            resultIndex: 0,
          },
          { signal: new AbortController().signal },
        ),
      };
    };
  return {
    ...f,
    root,
    pkg,
    registration,
    entry,
    target,
    state,
    materialState: f.state,
    task,
    accepted,
    open,
    publish,
  };
}
const digester = {
  sha256: (s: string) =>
    "sha256:" + createHash("sha256").update(s).digest("hex"),
};
