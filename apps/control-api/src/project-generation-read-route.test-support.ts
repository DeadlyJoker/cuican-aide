import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  CreativeProjectApplicationService,
  ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import {
  createExtensionConfiguration,
  createExtensionCreditAdmission,
  createExtensionRunBinding,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import {
  activeAuthority,
  projectGenerationFixture,
} from "../../../packages/store/src/project-generation.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { errorResponse } from "./control-api-errors.ts";
import { registerProjectGenerationReadRoutes } from "./project-generation-read-route.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

const origin = "https://generation-read.example.test";
const token = "generation-read-verified-session-at-least-32";

/** Real SQL/project/Run services; Host and authorization are explicit test ports, with no vendor or pricing service. */
export async function generationReadHttpFixture(
  context: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await projectGenerationFixture(context, backend);
  await f.first.store.enableProjectGenerationReads();
  const policy = { deniedProject: false, deniedTask: "", hostCalls: 0 };
  const projects = new CreativeProjectApplicationService({
    store: f.metadata,
    authorization: {
      authorize: async () =>
        policy.deniedProject
          ? { outcome: "deny", reasonCode: "generation-read-project-denied" }
          : { outcome: "allow" },
    },
    clock: { now: () => timestamp },
    ids: { nextId: () => randomUUID() },
    digester: extensionStoreDigester,
  });
  const operations = f.first.parent.externalOperationStore();
  await operations.migrate();
  const reads = new ExtensionReadApplicationService({
    extensions: f.first.store,
    operations,
    runs: f.first.parent,
    agentVersions: f.first.parent,
    authorization: {
      authorize: async ({ action }) =>
        action === policy.deniedTask
          ? { outcome: "deny", reasonCode: "generation-read-task-denied" }
          : { outcome: "allow" },
    },
    catalog: { list: () => [], resolve: () => null },
    host: {
      validateConfiguration: async () => {
        policy.hostCalls++;
        throw new Error("unexpected_host_read");
      },
      evaluate: async () => {
        policy.hostCalls++;
        throw new Error("unexpected_host_read");
      },
    },
    digester: extensionStoreDigester,
  });
  const service = new ProjectGenerationReadApplicationService({
    projects,
    tasks: reads,
    extensions: f.first.store,
    digester: extensionStoreDigester,
  });
  const identities = [
    f.actor,
    { ...f.actor, principalId: "other-owner", actorId: "other-actor" },
    { ...f.actor, tenantId: "other-tenant" },
    { ...f.actor, spaceId: "other-space" },
  ].map(
    (actor, index) =>
      new StandaloneIdentity({
        actor,
        sessionToken: index === 0 ? token : `${token}-${index}`,
        csrfToken: "generation-read-control-csrf-at-least-32",
        allowedOrigins: [origin],
      }),
  );
  const app = Fastify();
  context.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, request.id);
    return reply.code(response.statusCode).send(response.body);
  });
  registerProjectGenerationReadRoutes(app, {
    projectGenerationReads: service,
    extensionReads: reads,
    identity: {
      resolveActor: async (request) => {
        const index = [
          token,
          ...[1, 2, 3].map((index) => `${token}-${index}`),
        ].findIndex(
          (value) => request.headers.authorization === `Bearer ${value}`,
        );
        if (index < 0)
          throw new ControlApiIdentityError(
            "authentication",
            "session_invalid",
          );
        return identities[index]!.resolveActor(request);
      },
    },
  });
  const headers = (account = 0) => ({
    authorization: `Bearer ${account === 0 ? token : `${token}-${account}`}`,
    origin,
  });
  const base = `/api/v1/creative-projects/${encodeURIComponent(f.reference.projectId)}/concepts/${encodeURIComponent(f.reference.assetId)}/revisions`;
  const url = `${base}/${f.reference.assetRevision}/generation`;
  const commitGeneration = async () => {
    const command = await f.input();
    return f.first.store.commitExtensionTurn(command, activeAuthority);
  };
  const commitGenerationWithResult = async () => {
    const scope = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      pluginId: "crewon.comfyui-krea2",
    };
    const previous = (await f.first.store.loadExtensionConfiguration({
      ...scope,
      revision: 1,
    }))!;
    const configuration = createExtensionConfiguration(
      {
        ...previous,
        revision: 2,
        parameters: { baseUrl: "https://comfy.example.test:8443/" },
      },
      extensionStoreDigester,
    );
    await f.first.store.saveExtensionConfiguration({
      configuration,
      expectedRevision: 1,
      receipt: {
        actorId: f.actor.actorId,
        idempotencyKey: "result-config",
        requestDigest: extensionStoreDigester.sha256("result-config"),
      },
    });
    const activation = (await f.first.store.loadExtensionActivation(scope))!;
    await f.first.store.saveExtensionActivation({
      activation: {
        ...activation,
        revision: activation.revision + 1,
        configurationRevision: configuration.revision,
        configurationDigest: configuration.contentDigest,
      },
      expectedRevision: activation.revision,
      receipt: {
        actorId: f.actor.actorId,
        idempotencyKey: "result-activation",
        requestDigest: extensionStoreDigester.sha256("result-activation"),
      },
    });
    const command = await f.input();
    const binding = createExtensionRunBinding(
      {
        ...command.binding,
        configurationRevision: configuration.revision,
        configurationDigest: configuration.contentDigest,
      },
      extensionStoreDigester,
    );
    const committed = await f.first.store.commitExtensionTurn(
      {
        ...command,
        binding,
        expectedActivationRevision: activation.revision + 1,
        pluginAdmission: parsePluginTaskAdmission({
          ...command.pluginAdmission!,
          extensionBindingDigest: binding.bindingDigest,
        }),
        creditAdmission: createExtensionCreditAdmission(
          {
            binding,
            receipt: command.receipt,
            principalId: f.actor.principalId,
            poolId: f.creditScope.poolId,
            priceRevision: 1,
            quotedCredits: "30",
          },
          extensionStoreDigester,
        ),
      },
      activeAuthority,
    );
    await f.first.parent.commitRun({
      tenantId: f.actor.tenantId,
      expectedRevision: committed.run.state.revision,
      idempotency: {
        scope: "generation-http-result-run",
        key: "start",
        requestFingerprint: extensionStoreDigester.sha256("start"),
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: binding.runId },
          eventId: randomUUID(),
          sequence: committed.run.state.revision + 1,
          occurredAt: timestamp,
          type: "run.started",
          data: {},
        },
      ],
      outbox: [],
      workItems: [],
    });
    const operationId = "11111111-2222-3333-4444-555555555555";
    const locator = {
      tenantId: f.actor.tenantId,
      runId: binding.runId,
      bindingDigest: binding.bindingDigest,
      operationId,
    };
    await operations.reserveExternalOperation({
      ...locator,
      executionId: "result-tool",
      idempotencyKey: "result-reservation",
      actionDigest: extensionStoreDigester.sha256("image.generate"),
      requestDigest: extensionStoreDigester.sha256("result-request"),
      correlationId: operationId,
      createdAt: timestamp,
    });
    const images = ["first.png", "second.png"].map((filename) => {
      const image = { filename, subfolder: "", type: "output" };
      return {
        ...image,
        url: new URL(
          `/view?${new URLSearchParams(image)}`,
          configuration.parameters.baseUrl as string,
        ).href,
      };
    });
    const observed = await operations.advanceExternalOperation({
      ...locator,
      expectedRevision: 1,
      status: "succeeded",
      providerOperationId: operationId,
      resultJson: JSON.stringify({ images }),
      updatedAt: timestamp,
    });
    return { committed, images, operation: observed.operation };
  };
  return {
    ...f,
    app,
    headers,
    url,
    base,
    projects,
    reads,
    service,
    policy,
    commitGeneration,
    commitGenerationWithResult,
  };
}
