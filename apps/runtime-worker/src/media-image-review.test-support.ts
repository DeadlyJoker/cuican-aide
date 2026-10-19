import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { join } from "node:path";
import { CrewONAgentKernel } from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "@crewon/agent-responses";
import {
  ThreadApplicationService,
  TurnApplicationService,
  RunExecutionService,
  type ProjectMediaImageReviewReport,
  type ProjectMediaResultPermission,
} from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import { SqliteRunStore } from "@crewon/store";
import { ProjectMediaResultPublisher } from "@crewon/media-runtime/project-media-result-publisher";
import {
  mediaExecutionFixture,
  providerId,
} from "./project-media-execution.test-support.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  PinnedRunExecutionPolicy,
} from "./standalone-adapters.ts";
import { MediaReviewImageEncoder } from "./media-review-image-encoder.ts";
import { MediaImageReviewSourceReader } from "./media-image-review-source.ts";
import { MediaImageReviewKernel } from "./media-image-review-kernel.ts";
import { MediaImageReviewJobService } from "./media-image-review-job-service.ts";
import { compileAgentVersion } from "@crewon/agent-version";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import {
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";

/** Real same-file SQLite Run/candidate, encrypted PNG, local FFmpeg and local HTTP/Worker.
 * Generation responses, semantic model judgment and permissions are named fixtures.
 * No historical installed-handler directory or real provider generation is used.
 */
export async function mediaImageReviewFixture(
  t: TestContext,
  options: Readonly<{
    execution?: "bound-review" | "configured-review" | "ordinary-kernel";
  }> = {},
) {
  const f = await mediaExecutionFixture(t, "sqlite");
  assert.ok(f.parent instanceof SqliteRunStore);
  const io = f.owner();
  let origin = "";
  await f.invoke(io, f.makeCommand(), async (checked) => {
    const rendered = await f.render(io, checked);
    origin = rendered.input.targetServiceOrigin;
    const reserved = await io.services.externalOperations!.reserve({
      command: checked,
      operationId: rendered.operationId,
      request: rendered.request,
    });
    assert.ok(reserved.dispatchRef);
    await io.services.jsonHttp!.request({
      command: checked,
      operationId: rendered.operationId,
      ...rendered.request,
      dispatchRef: reserved.dispatchRef,
    });
    const running = await io.services.externalOperations!.advance({
      command: checked,
      operationId: rendered.operationId,
      expectedRevision: reserved.operation.revision,
      status: "running",
      providerOperationId: providerId,
      resultJson: null,
    });
    const ref = {
      filename: "named-review-image.png",
      subfolder: "actual-output",
      type: "output",
    };
    const image = {
      ...ref,
      url: new URL(`/view?${new URLSearchParams(ref)}`, origin).href,
    };
    await io.services.externalOperations!.advance({
      command: checked,
      operationId: rendered.operationId,
      expectedRevision: running.operation.revision,
      status: "succeeded",
      providerOperationId: providerId,
      resultJson: JSON.stringify({ images: [image] }),
    });
  });
  const query = {
    projectId: f.query.projectId,
    runId: f.accepted.binding.runId,
    resultIndex: 0,
  };
  const request = { actor: f.actor, query };
  const state = {
    read: true,
    send: true,
    gets: 0,
    samples: 0,
    sendDecisionCalls: 0,
    pixelRequests: [] as unknown[],
    mutate: undefined as
      | undefined
      | ((report: ProjectMediaImageReviewReport) => unknown),
    afterModel: undefined as undefined | (() => void),
    beforeResponse: undefined as undefined | (() => Promise<void>),
    activeFailure: undefined as undefined | Error,
  };
  const clock = new SystemApplicationClock(),
    digester = new NodeSha256ContentDigester(),
    ids = { nextId: () => randomUUID() };
  const archiveConfig = {
    archiveId: "named-image-review-archive",
    rootDirectory: join(f.root, "review-archive"),
    keyId: "named-image-review-key",
    encryptionKey: Buffer.alloc(32, 73),
  };
  const publishers: ProjectMediaResultPublisher[] = [];
  const archives: FilesystemProjectMediaResultArchive[] = [];
  const openPublisher = async (parent: SqliteRunStore) => {
    const store = parent.extensionStore().projectMediaResults();
    await store.migrate();
    const archive = new FilesystemProjectMediaResultArchive(archiveConfig);
    archives.push(archive);
    const active = (p: ProjectMediaResultPermission) => {
      if (p.action === "projectMediaResult:read" && !state.read)
        throw new Error("named-image-read-revoked");
    };
    const publisher = new ProjectMediaResultPublisher({
      store,
      archive,
      reviews: f.reviews.map(({ targetIdentity, workflow }) => ({
        targetIdentity,
        workflow,
      })),
      authorization: {
        authorize: async (p) =>
          ({
            outcome:
              p.action === "projectMediaResult:read" && !state.read
                ? "deny"
                : "allow",
            reasonCode: "named-image-read",
          }) as const,
        assertActive: active,
      },
      clock,
      dns: { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] },
      transport: {
        request: async (input) => {
          assert.equal(input.method, "GET");
          state.gets++;
          return {
            status: 200,
            headers: { "content-type": "image/png" },
            body: materialPng(1024, 768),
          };
        },
      },
    });
    publishers.push(publisher);
    return publisher;
  };
  let publisher = await openPublisher(f.parent);
  const saved = await publisher.publish(f.actor, query, {
    signal: new AbortController().signal,
  });
  const encoder = new MediaReviewImageEncoder({
    ffmpegPath: process.env.CREWON_TEST_FFMPEG!,
  });
  const sourceReader = (current: ProjectMediaResultPublisher) =>
    new MediaImageReviewSourceReader({
      results: current,
      encoder,
      authorization: {
        authorize: async () => {
          state.sendDecisionCalls++;
          return state.send
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named-model-send-denied" };
        },
        assertActive: () => {
          if (state.activeFailure) throw state.activeFailure;
          if (!state.send) throw new Error("named-model-send-denied");
        },
      },
    });
  const route = {
    authorityId: "named-image-review",
    runtimeGeneration: "named-image-review-v1",
    agentVersionId: "named-image-reviewer-v1",
    policySnapshotId: "named-image-review-policy-v1",
    workspaceBindingId: null,
  };
  const reviewVersion = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: route.agentVersionId,
      runtimeGeneration: route.runtimeGeneration,
      policySnapshotId: route.policySnapshotId,
      instructions:
        "Review only the exact authorized saved-image evidence. No generation or adoption.",
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "named-visual-review-fixture",
        contextWindowTokens: 128000,
        autoCompactAtTokens: null,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 1 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  const common = {
    store: f.parent,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    clock,
    digester,
    ids,
  };
  const thread = await new ThreadApplicationService(common).createThread(
    f.actor,
    {
      kind: "thread.create",
      title: "Named image review",
      workspaceId: null,
      idempotencyKey: randomUUID(),
    },
  );
  const reader = sourceReader(publisher);
  const jobs = f.parent.projectMediaImageReviewJobStore();
  await jobs.migrate();
  const jobService = new MediaImageReviewJobService({
    store: f.parent,
    turns: new TurnApplicationService(common),
    sources: reader,
    route,
  });
  const reviewStart = {
    request,
    candidateId: saved.candidate.candidateId,
    candidateDigest: saved.candidate.contentDigest,
    threadId: thread.state.threadId,
    expectedThreadRevision: thread.state.revision,
    idempotencyKey: randomUUID(),
  };
  const admitted = await jobService.start(reviewStart, {
    signal: new AbortController().signal,
  });
  const accepted = admitted.turn;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.samples++;
    state.pixelRequests.push(body);
    assert.deepEqual(body.tools, []);
    const prompt = body.input.findLast(
      (item: { content: unknown }) => typeof item.content === "string",
    ).content as string;
    const skeleton = JSON.parse(
      prompt.split("\n").find((line) => line.startsWith('{"schemaVersion"'))!,
    );
    const report: ProjectMediaImageReviewReport = {
      ...skeleton,
      summary: "Named semantic fixture; not a real model visual judgment.",
      issues: [],
    };
    const output = JSON.stringify(state.mutate?.(report) ?? report);
    await state.beforeResponse?.();
    state.afterModel?.();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const id = `named-review-${state.samples}`;
    for (const event of [
      { type: "response.created", sequence_number: 0, response: { id } },
      { type: "response.output_text.delta", sequence_number: 1, delta: output },
      {
        type: "response.completed",
        sequence_number: 2,
        response: {
          id,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: output }],
            },
          ],
        },
      },
    ])
      res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = () =>
    new DirectResponsesTransport({
      endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
      model: "named-visual-review-fixture",
      idleTimeoutMs: 1000,
    });
  const bind = (parent: SqliteRunStore, source: MediaImageReviewSourceReader) =>
    MediaImageReviewKernel.restore({
      kernel: new CrewONAgentKernel({
        transport: transport(),
        streamMaxRetries: 0,
      }),
      sources: source,
      store: parent,
      scope: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: admitted.job.runId,
      },
      signal: new AbortController().signal,
    });
  let kernel = await bind(f.parent, reader);
  const factoryBinding = {
    tenantId: f.actor.tenantId,
    agentVersionId: reviewVersion.agentVersionId,
    contentDigest: reviewVersion.contentDigest,
    authorityId: route.authorityId,
    workspaceBindingId: null,
    materializationDigest: `sha256:${"d".repeat(64)}`,
    executionAuthority: "crewonKernel" as const,
    savedImageReview: {
      kind: "saved-image-review" as const,
      store: f.parent,
      sources: reader,
      actor: f.actor,
    },
    createTransport: transport,
    createToolRuntime: () => new InMemoryToolBroker(),
  };
  const runtimeFactory = new ConfiguredAgentVersionRuntimeFactory([
    factoryBinding,
  ]);
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  let configuredRuntime: AgentVersionRuntime | undefined;
  if (options.execution === "configured-review") {
    configuredRuntime = await runtimeFactory.create({
      tenantId: f.actor.tenantId,
      version: reviewVersion,
    });
    registry.register({
      tenantId: f.actor.tenantId,
      runtime: configuredRuntime,
    });
  }
  const worker = new RuntimeWorker(
    {
      store: f.parent,
      execution: new RunExecutionService({
        store: f.parent,
        clock,
        ids,
        digester,
      }),
      kernel:
        options.execution === "ordinary-kernel"
          ? new CrewONAgentKernel({
              transport: transport(),
              streamMaxRetries: 0,
            })
          : kernel,
      policy: new PinnedRunExecutionPolicy(route),
      ...(configuredRuntime ? { agentVersionRuntimeResolver: registry } : {}),
    },
    {
      ownerId: "named-review-worker",
      nextLeaseId: () => randomUUID(),
      leaseDurationMs: 10000,
      scanIntervalMs: null,
      workItemExecutionScope: {
        tenantId: f.actor.tenantId,
        extensionImplementationDigest: `sha256:${"0".repeat(64)}`,
        extensionTargets: [],
        unboundRuns: "include",
      },
    },
  );
  const coldStores: SqliteRunStore[] = [];
  t.after(async () => {
    await worker.close();
    await registry.close();
    await encoder.close();
    await Promise.all(publishers.map((p) => p.close()));
    for (const archive of archives) archive.close();
    for (const parent of coldStores) await parent.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    ...f,
    parent: f.parent,
    state,
    worker,
    kernel,
    reader,
    saved,
    request,
    accepted,
    admitted,
    jobService,
    reviewStart,
    jobs,
    route,
    common,
    thread,
    reviewVersion,
    runtimeFactory,
    factoryBinding,
    configuredRuntime,
    async coldReport() {
      await worker.close();
      await publisher.close();
      await f.parent.close();
      const parent = new SqliteRunStore(f.databasePath);
      coldStores.push(parent);
      publisher = await openPublisher(parent);
      kernel = await bind(parent, sourceReader(publisher));
      return kernel.loadCompletedReport({
        signal: new AbortController().signal,
      });
    },
  };
}
