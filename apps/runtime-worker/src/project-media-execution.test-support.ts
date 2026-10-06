import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  SqliteExternalOperationStore,
  PostgresExternalOperationStore,
} from "@crewon/store";
import {
  dispatchToolExecutionReceipt,
  prepareToolExecutionReceipt,
} from "@crewon/domain";
import type { ProjectMediaWorkflowId } from "@crewon/application";
import type {
  PluginJsonHttpSubmission,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import { mediaOperationFixture } from "./project-media-operation.test-support.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  ProjectMediaRunContext,
  type ProjectMediaRunPermission,
} from "./project-media-run-context.ts";
import { ProjectMediaExecutionBoundary } from "./project-media-execution-boundary.ts";
import {
  mediaExecutionDigest,
  type ProjectMediaExecutionReview,
} from "./project-media-execution-review.ts";
import { PluginExecutionIoOwner } from "./plugins/plugin-execution-io.ts";
import { installedPluginExternalOperationId } from "./plugins/installed-plugin-execution-io-config.ts";
import {
  withWorkerToolDispatch,
  withCheckedWorkerToolDispatch,
} from "./plugins/worker-tool-dispatch-authority.ts";
import {
  command,
  policy,
  rebind,
  result,
} from "./plugin-tool-runtime-adapter.test-support.ts";
import type {
  PinnedHttpRequest,
  PinnedHttpResponse,
} from "./pinned-node-http.ts";

const packageUrl = new URL(
  "../../../output/extensions/installable-plugins/short-drama-reference-workflows-20261006/short-drama/20.0.2/",
  import.meta.url,
);
const templatesUrl = new URL(
  "../../../examples/plugins/short-drama/src/templates/",
  import.meta.url,
);
type Render = (input: {
  workflowId: ProjectMediaWorkflowId;
  prompt: string;
  operationId: string;
  sourceServiceOrigin: string;
  targetServiceOrigin: string;
  images: unknown;
}) => { graph: PluginJsonHttpSubmission["body"]; workflowDigest: string };

/** Verify the immutable complete package; use only its exported pure adapter, not setup/Tool activation. */
export async function reviewedMediaGraphs() {
  const verified = await verifyLocalPluginPackage({
    directory: packageUrl.pathname,
  });
  assert.equal(
    verified.packageDigest,
    "sha256:2e110c0993eab6c903aacdf92f5385e1228aeedf377288b1b54c58e4b1ac0c56",
  );
  const moduleUrl = new URL("node.mjs", packageUrl).href;
  const adapter = (await import(moduleUrl)) as {
    renderReferenceWorkflow: Render;
  };
  const definitions = [
    {
      id: "krea2-reference-four-view" as const,
      promptBinding: { nodeId: "143", input: "prompt" },
      imageBindings: [{ role: "character" as const, nodeIds: ["146"] }],
    },
    {
      id: "flux2-three-reference-storyboard" as const,
      promptBinding: { nodeId: "235:231", input: "text" },
      imageBindings: [
        { role: "scene" as const, nodeIds: ["240", "277", "548"] },
        { role: "characterOne" as const, nodeIds: ["278"] },
        { role: "characterTwo" as const, nodeIds: ["279"] },
      ],
    },
  ];
  const graphs = await Promise.all(
    definitions.map(async (d) => ({
      ...d,
      template: JSON.parse(
        await readFile(new URL(`${d.id}.api.json`, templatesUrl), "utf8"),
      ),
    })),
  );
  return {
    graphs,
    render: adapter.renderReferenceWorkflow,
    packageDigest: verified.packageDigest,
  };
}

/** Actual admitted/started Run, native DB, selected references and encrypted PNGs.
 * Installation metadata/PDP/review, DNS/provider transport and receipt issuer are named fixtures.
 * The independently verified adapter package above is not this fixture's installed target.
 */
export async function mediaExecutionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const adapter = await reviewedMediaGraphs();
  const workflowDigestsFixture = Object.fromEntries(
    adapter.graphs.map((g) => [g.id, mediaExecutionDigest(g.template)]),
  );
  const f = await mediaOperationFixture(t, backend, {
    kind,
    workflowDigestsFixture,
  });
  const baseline = await f.counts();
  const controls = {
    submit: true,
    observe: true,
    active: true,
    actor: true,
    extensionRun: true,
    ioAuthorized: true,
    dns: 0,
    posts: 0,
    gets: 0,
    requests: [] as PinnedHttpRequest[],
    purposes: [] as ("submit" | "observe")[],
    afterDns: undefined as undefined | (() => Promise<void>),
    transport: undefined as
      | undefined
      | ((
          request: PinnedHttpRequest,
          signal: AbortSignal,
        ) => Promise<PinnedHttpResponse>),
  };
  const authorization = {
    authorize: async (p: ProjectMediaRunPermission) =>
      f.decision(
        p.action === "projectMediaRun:submit"
          ? controls.submit
          : controls.observe,
      ),
    assertActive: () => {
      if (!controls.active)
        throw new Error("named_media_execution_owner_retired");
    },
  };
  const installed = new InstalledPluginRunContext({
    extensions: f.ext,
    runs: f.parent,
    installations: f.parent.pluginInstallationStore(),
    authorization: { authorize: async () => f.decision(controls.extensionRun) },
    resolveActor: async () => (controls.actor ? f.actor : null),
  });
  const reader = new ProjectMediaRunContext({
    installed,
    extensions: f.ext,
    materials: f.materials,
    metadataAuthorization: f.mediaAuthorization,
    authorization,
  });
  const snapshot = await installed.load({
    locator: {
      tenantId: f.accepted.binding.tenantId,
      spaceId: f.accepted.binding.spaceId,
      runId: f.accepted.binding.runId,
    },
    expectedTarget: f.accepted.binding.target,
    purpose: "submit",
    ...f.signal(),
  });
  assert.ok(snapshot);
  const reviews: ProjectMediaExecutionReview[] = adapter.graphs.map((g) => ({
    ...f.reviews.find((r) => r.workflow.workflowId === g.id)!,
    targetIdentity: {
      ...f.reviewedTarget,
      manifestDigest: f.configuration.manifestDigest,
    },
    template: g.template,
    promptBinding: g.promptBinding,
    imageBindings: g.imageBindings,
  }));
  const boundary = new ProjectMediaExecutionBoundary({
    installed,
    snapshot,
    media: reader,
    operations: f.operations,
    reviews,
  });
  const owners: PluginExecutionIoOwner[] = [];
  const owner = (media = boundary) => {
    const io = new PluginExecutionIoOwner({
      context: media.context,
      operations: media.operations,
      projectMedia: media,
      approvalRequirement: "none",
      network: {
        baseUrlParameter: "baseUrl",
        paths: [
          { method: "POST", path: "/prompt" },
          { method: "GET", path: "/queue" },
          { method: "GET", operationPathPrefix: "/history/" },
        ],
      },
      authorize: async ({ purpose }) => {
        controls.purposes.push(purpose);
        if (!controls.ioAuthorized)
          throw new Error("named_media_execution_io_revoked");
      },
      dns: {
        resolveAll: async () => {
          controls.dns++;
          await controls.afterDns?.();
          return [{ address: "8.8.8.8", family: 4 }];
        },
      },
      transport: {
        request: async (request, signal) => {
          controls.requests.push(request);
          if (request.method === "POST") controls.posts++;
          else controls.gets++;
          assert.equal(request.target.address, "8.8.8.8");
          if (controls.transport) return controls.transport(request, signal);
          const body =
            request.method === "POST"
              ? { prompt_id: providerId }
              : { queue_running: [], queue_pending: [] };
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify(body)),
          };
        },
      },
    });
    owners.push(io);
    return io;
  };
  t.after(async () => {
    await Promise.all(owners.map((o) => o.close()));
  });
  const context = snapshot.context;
  const coldBoundary = async () => {
    const next = await f.cold();
    const database =
      backend === "sqlite" ? new DatabaseSync(f.databasePath) : null;
    const pool =
      backend === "postgres"
        ? new Pool({ connectionString: process.env.CREWON_TEST_POSTGRES_URL })
        : null;
    database?.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const schema =
      backend === "postgres"
        ? /^"([a-z][a-z0-9_]+)"\.$/u.exec(f.prefix)?.[1]
        : "main";
    assert.ok(schema);
    const operations = database
      ? new SqliteExternalOperationStore(database)
      : new PostgresExternalOperationStore(pool!, schema);
    t.after(async () => {
      database?.close();
      await pool?.end();
    });
    await operations.migrate();
    await operations.migrateProjectMediaOperations();
    const installed = new InstalledPluginRunContext({
      extensions: next.ext,
      runs: next.parent,
      installations: next.parent.pluginInstallationStore(),
      authorization: {
        authorize: async () => f.decision(controls.extensionRun),
      },
      resolveActor: async () => (controls.actor ? f.actor : null),
    });
    const media = new ProjectMediaRunContext({
      installed,
      extensions: next.ext,
      materials: next.materials,
      metadataAuthorization: f.mediaAuthorization,
      authorization,
    });
    const snapshot = await installed.load({
      locator: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: f.accepted.binding.runId,
      },
      expectedTarget: f.accepted.binding.target,
      purpose: "observe",
      ...f.signal(),
    });
    assert.ok(snapshot);
    return new ProjectMediaExecutionBoundary({
      installed,
      snapshot,
      media,
      operations,
      reviews,
    });
  };
  const makeCommand = (
    mode: "submit" | "observe" = "submit",
    capability?: string,
  ) => {
    const p = policy(
      mode === "submit" ? "mutation" : "readOnly",
      mode === "submit" ? "reconcilable" : "replaySafe",
    );
    const id = randomUUID();
    return rebind(
      command(
        {
          runId: context.run.runId,
          executionId: id,
          idempotencyKey: id,
          name: `crewon_short_drama__${mode}`,
          executionLease: {
            workItemId: f.claim.workItem.workItemId,
            stepId: `named-step-${id}`,
            attemptId: `named-attempt-${id}`,
            leaseId: f.claim.lease.leaseId,
            leaseEpoch: f.claim.lease.epoch,
            expiresAt: f.claim.lease.expiresAt,
          },
        },
        {
          ...p,
          capability:
            capability ??
            (mode === "submit"
              ? "extension.image.generate"
              : "extension.image.read"),
        },
      ),
      {
        policySnapshotId: context.target.policySnapshotId,
        workspaceBindingId: context.target.workspaceBindingId,
      },
    );
  };
  /** Original dispatch/alias proof with an actual DB-claimed lease; receipt is a named private issuer fixture. */
  const invoke = async (
    io: PluginExecutionIoOwner,
    original: ToolExecutionCommand,
    delegate: (checked: ToolExecutionCommand) => Promise<void>,
    signal = f.signal().signal,
  ) => {
    const now = new Date().toISOString();
    const receipt = dispatchToolExecutionReceipt(
      prepareToolExecutionReceipt({
        receiptId: randomUUID(),
        tenantId: context.scope.tenantId,
        runId: original.runId,
        stepId: original.executionLease.stepId,
        attemptId: original.executionLease.attemptId,
        workItemId: original.executionLease.workItemId,
        executionId: original.executionId,
        idempotencyKey: original.idempotencyKey,
        actionDigest: original.actionDigest,
        actionIntent: original.actionIntent,
        call: {
          segmentId: original.segmentId,
          callId: original.callId,
          kind: original.kind,
          name: original.name,
          inputDigest: original.actionIntent.tool.inputDigest,
        },
        effect: original.actionIntent.effect,
        recovery: original.actionIntent.recovery,
        preparedAt: now,
      }),
      now,
    );
    const checked = structuredClone(original),
      invocation = { command: checked, method: "execute" as const, signal };
    return withWorkerToolDispatch(
      {
        ...invocation,
        command: original,
        receipt,
        assertCurrent: () => f.claim,
      },
      () =>
        withCheckedWorkerToolDispatch(
          { ...invocation, originalCommand: original },
          () =>
            io.withInvocation(invocation, async () => {
              await delegate(checked);
              return result(checked);
            }),
        ),
    );
  };
  const render = async (
    io: PluginExecutionIoOwner,
    checked: ToolExecutionCommand,
  ) => {
    const input = await io.readProjectMediaInput({ command: checked });
    assert.equal(input.kind, "new");
    if (input.kind !== "new") throw new Error("expected_new_media_fixture");
    const operationId = installedPluginExternalOperationId(context, checked);
    const rendered = adapter.render({
      workflowId: input.workflow.workflowId,
      prompt: input.prompt,
      operationId,
      sourceServiceOrigin: input.targetServiceOrigin,
      targetServiceOrigin: input.targetServiceOrigin,
      images: input.images,
    });
    assert.equal(rendered.workflowDigest, input.workflow.workflowDigest);
    const request: PluginJsonHttpSubmission = {
      method: "POST",
      path: "/prompt",
      body: {
        prompt: rendered.graph,
        prompt_id: operationId,
        client_id: operationId,
        extra_data: { crewon_request_id: operationId },
      },
    };
    return { input, operationId, request };
  };
  return {
    ...f,
    baseline,
    counts: async () => {
      const current = await f.counts();
      return {
        slots: current.slots - baseline.slots,
        operations: current.operations - baseline.operations,
      };
    },
    ...adapter,
    reviews,
    authorization,
    installed,
    reader,
    snapshot,
    boundary,
    controls,
    owner,
    coldBoundary,
    makeCommand,
    invoke,
    render,
    context,
  };
}
export const providerId = "12345678-1234-1234-1234-123456789012";
export const operationLocator = (
  context: PluginToolRuntimeContext,
  operationId: string,
) => ({
  tenantId: context.scope.tenantId,
  runId: context.run.runId,
  bindingDigest: context.run.bindingDigest,
  operationId,
});
