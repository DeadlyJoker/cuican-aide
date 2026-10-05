import {
  createProjectHistoricalQueryLink,
  parseProjectHistoricalQueryPublication,
  type PluginQueryTaskAdmission,
  type ProjectHistoricalQueryLink,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import type {
  CommitExtensionTurnOptions,
  ExtensionStore,
} from "./extension-store-port.ts";
import type { ExternalOperation } from "./external-operation-store-port.ts";
import { projectGenerationReadFixture } from "./project-generation-read-application-service.test-support.ts";
import { committedProjectGenerationFixture } from "./plugin-ui-committed-project-generation.test-support.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { PluginUiCommittedTaskAuthority } from "./plugin-ui-committed-task-authority.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { capturePluginHistoricalQueryInvocationCommitAuthority } from "./plugin-project-historical-query-invocation.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { CommitExtensionTurnResult } from "./extension-store-port.ts";
import { uiTestBytes } from "./plugin-ui.test-support.ts";
import { projectHistoricalQueryUiTaskCommand } from "./project-historical-query-task-receipt.ts";
import {
  taskActor,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

/** Real Application services over memory ports; these tests do not demonstrate SQL atomicity or provider IO. */
export async function projectHistoricalQueryTaskFixture() {
  const saved = await projectGenerationReadFixture({ generated: false });
  const business = committedProjectGenerationFixture();
  const generated = await saved.f
    .create()
    .createProjectTaskFromPlugin(
      taskActor,
      saved.f.command,
      { ...taskPin, version: "0.1.0" },
      saved.f.reference,
      saved.f.authority,
    );
  saved.state.run = generated.run.state;
  const request = {
    reference: saved.query,
    operationId: "11111111-1111-4111-8111-111111111111",
    threadId: generated.binding.threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "business-query-intent",
  };
  const context = {
    ...business.detachedContext(),
    action: "crewon.project-historical-queries.v1.queryConceptGeneration",
    input: request,
  };
  const sourcePin = committedTaskContext(context).pin;
  const executionPin = {
    ...taskPin,
    version: "0.1.0",
    packageDigest: taskPin.packageDigest,
    selectionRevision: 7,
    action: "image.query",
    authorityEpoch: "query-epoch-2",
  };
  const originalConfiguration =
    await saved.extensions.loadExtensionConfiguration({
      ...generated.binding,
      revision: generated.binding.configurationRevision,
    });
  if (originalConfiguration === null)
    throw new Error("fixture-original-configuration-missing");
  const publication = parseProjectHistoricalQueryPublication({
    source: business.publication.source,
    target: {
      pluginId: executionPin.pluginId,
      publisherId: executionPin.publisherId,
      version: executionPin.version,
      manifestDigest: originalConfiguration.manifestDigest,
      implementationDigest: originalConfiguration.implementationDigest,
      packageDigest: executionPin.packageDigest,
      contributionId: executionPin.contributionId,
      action: executionPin.action,
    },
  });
  const state = {
    queries: new Map<string, PluginQueryTaskAdmission>(),
    links: new Map<string, ProjectHistoricalQueryLink>(),
    options: [] as Array<CommitExtensionTurnOptions | undefined>,
    sourceProofReads: 0,
    preflightReads: 0,
    transactionReads: [] as Array<readonly [number, number]>,
    alive: true,
    fullChecks: 0,
    transactionChecks: 0,
    activeChecks: 0,
    historicalVersions: [] as string[],
    afterCommit: null as (() => void) | null,
    operation: {
      schemaVersion: "crewon.external-operation.v0",
      tenantId: taskActor.tenantId,
      runId: generated.binding.runId,
      bindingDigest: generated.binding.bindingDigest,
      operationId: request.operationId,
      executionId: "execution-1",
      idempotencyKey: "supplier-generation-key",
      actionDigest: taskDigester.sha256("image.generate"),
      requestDigest: taskDigester.sha256("original-prompt"),
      correlationId: "original-correlation",
      providerOperationId: null,
      status: "unknownOutcome",
      resultJson: null,
      revision: 1,
      createdAt: generated.run.state.createdAt,
      updatedAt: generated.run.state.createdAt,
    } as ExternalOperation | null,
  };
  const runs = {
    async loadRunInSpace(input: {
      tenantId: string;
      spaceId: string;
      runId: string;
    }) {
      const result = [...saved.f.base.state.receipts.values()].find(
        (item) => item.result.binding.runId === input.runId,
      )?.result;
      return result?.binding.tenantId === input.tenantId &&
        result.binding.spaceId === input.spaceId
        ? structuredClone(result.run.state)
        : null;
    },
  };
  const operations = {
    ...saved.f.base.dependencies.operations,
    async loadExternalOperation(input: {
      tenantId: string;
      runId: string;
      bindingDigest: string;
      operationId: string;
    }) {
      state.sourceProofReads++;
      return state.operation !== null &&
        ["tenantId", "runId", "bindingDigest", "operationId"].every(
          (key) =>
            state.operation![key as keyof ExternalOperation] ===
            input[key as keyof typeof input],
        )
        ? structuredClone(state.operation)
        : null;
    },
  };
  const extensions: ExtensionStore = {
    ...saved.extensions,
    projectHistoricalQueryVersion: "crewon.project-historical-query-link.v1",
    pluginQueryAdmissionVersion: "crewon.plugin-query-task-admission.v1",
    async loadExtensionRunBinding(input) {
      return structuredClone(
        [...saved.f.base.state.receipts.values()].find(
          (item) => item.result.binding.runId === input.runId,
        )?.result.binding ?? null,
      );
    },
    async loadPluginQueryTaskAdmission(input) {
      return structuredClone(state.queries.get(input.runId) ?? null);
    },
    async loadProjectHistoricalQueryLink(input) {
      return structuredClone(state.links.get(input.runId) ?? null);
    },
    async commitExtensionTurn(input, options) {
      state.options.push(options);
      const reads = saved.f.state.projectReads.length;
      await options?.projectHistoricalQueryAuthority?.assertCurrent();
      options?.projectHistoricalQueryAuthority?.assertActive();
      state.transactionReads.push([reads, saved.f.state.projectReads.length]);
      const result = await saved.f.base.extensions.commitExtensionTurn(input);
      if (input.pluginQueryAdmission)
        state.queries.set(
          result.binding.runId,
          structuredClone(input.pluginQueryAdmission),
        );
      if (
        input.projectHistoricalQuery &&
        options?.projectHistoricalQueryPublication
      ) {
        const original = saved.f.state.links.get(generated.binding.runId)!;
        const link = createProjectHistoricalQueryLink(
          {
            actor: {
              tenantId: input.pluginQueryAdmission!.tenantId,
              spaceId: input.pluginQueryAdmission!.spaceId,
              principalId: input.pluginQueryAdmission!.principalId,
              actorId: input.pluginQueryAdmission!.actorId,
            },
            reference: input.projectHistoricalQuery.reference,
            generationLink: original,
            queryAdmission: input.pluginQueryAdmission!,
            binding: result.binding,
            receipt: input.receipt,
            ...options.projectHistoricalQueryPublication,
            at: result.run.state.createdAt,
          },
          taskDigester,
        );
        state.links.set(result.binding.runId, link);
      }
      state.afterCommit?.();
      return result;
    },
  };
  const authority = {
    async assertCurrent() {
      if (this !== authority) throw new Error("query-authority-receiver-lost");
      state.fullChecks++;
      state.preflightReads += saved.f.state.projectReads.length;
      if (!state.alive)
        throw new ApplicationError("authorization", "query-owner-withdrawn");
    },
    async assertTransactionCurrent() {
      if (this !== authority) throw new Error("query-authority-receiver-lost");
      state.transactionChecks++;
      if (!state.alive)
        throw new ApplicationError("authorization", "query-owner-withdrawn");
    },
    assertActive() {
      if (this !== authority) throw new Error("query-authority-receiver-lost");
      state.activeChecks++;
      if (!state.alive)
        throw new ApplicationError("authorization", "query-owner-withdrawn");
    },
  };
  const dependencies = {
    ...saved.f.base.dependencies,
    store: { ...saved.f.base.dependencies.store, ...runs },
    extensions,
    operations,
    creativeProjects: saved.f.projects,
    projectGenerationReads: saved.service,
    pluginQueryHost: {
      async resolveRegistration(
        input: Parameters<
          NonNullable<
            typeof saved.f.base.dependencies.pluginQueryHost
          >["resolveRegistration"]
        >[0],
      ) {
        state.historicalVersions.push(input.source.admission.version);
        return saved.f.base.dependencies.catalog.resolve({
          pluginId: taskPin.pluginId,
          pluginVersion: input.source.admission.version,
        });
      },
      async evaluate() {
        return { outcome: "ready" as const, target: generated.binding.target };
      },
    },
  };
  const command = projectHistoricalQueryUiTaskCommand(
    { sourcePin, executionPin, request, sourceRunId: generated.binding.runId },
    taskDigester,
  );
  const input = {
    actor: taskActor,
    command,
    reference: request.reference,
    publication,
    sourcePin,
    executionPin,
    authority,
  };
  const tasks = new ExtensionTaskApplicationService(dependencies);
  const committedDependencies = {
    extensions,
    runs,
    digester: taskDigester,
    projectHistoricalQueries: {
      publications: [publication],
      projects: saved.f.store,
      operations,
    },
  };
  const committed = new PluginUiCommittedTaskAuthority(committedDependencies);
  function createUi(
    afterCommit?: (
      context: PluginUiActionContext,
      result: CommitExtensionTurnResult,
      service: PluginUiApplicationService,
    ) => void | Promise<void>,
    beforeQuery?: (
      context: PluginUiActionContext,
      authority: ReturnType<
        typeof capturePluginHistoricalQueryInvocationCommitAuthority
      >,
    ) => Promise<void>,
  ) {
    const service = new PluginUiApplicationService({
      store: business.ledger,
      profiles: {
        async resolve() {
          return context.scope;
        },
      },
      authorization: {
        async authorize() {
          return business.state.allow
            ? { outcome: "allow", authorityEpoch: business.state.epoch }
            : { outcome: "deny", reasonCode: "withdrawn" };
        },
      },
      packages: {
        async verify() {
          return {
            descriptor: context.lease.descriptor,
            publicAssets: ["ui.mjs"],
          };
        },
        async readAsset() {
          return {
            bytes: uiTestBytes,
            contentType: "text/javascript; charset=utf-8",
          };
        },
      },
      clock: { now: () => business.state.now },
      ids: { nextId: () => "q".repeat(40) },
      committedTasks: committed,
      actions: {
        async invoke(invocation) {
          const original =
            capturePluginHistoricalQueryInvocationCommitAuthority(invocation);
          await beforeQuery?.(invocation, original);
          const currentSource = committedTaskContext(invocation).pin;
          const actualCommand = projectHistoricalQueryUiTaskCommand(
            {
              sourcePin: currentSource,
              executionPin,
              request: invocation.input as typeof request,
              sourceRunId: generated.binding.runId,
            },
            taskDigester,
          );
          const result =
            await tasks.createHistoricalPublishedProjectQueryTaskFromPlugin({
              ...input,
              command: actualCommand,
              sourcePin: currentSource,
              authority: {
                invocation: original,
                async assertCurrent() {
                  await original.assertCurrent();
                  await authority.assertCurrent();
                },
                async assertTransactionCurrent() {
                  await authority.assertTransactionCurrent();
                  if (!business.state.allow)
                    throw new ApplicationError(
                      "authorization",
                      "business-query-withdrawn",
                    );
                },
                assertActive() {
                  original.assertActive();
                  authority.assertActive();
                },
              },
            });
          await afterCommit?.(invocation, result, service);
          return committed.issueProjectHistoricalQuery({
            context: invocation,
            command: actualCommand,
            executionPin,
            result,
          });
        },
      },
    });
    return service;
  }
  return {
    saved,
    generated,
    business,
    state,
    request,
    context,
    sourcePin,
    executionPin,
    publication,
    operations,
    extensions,
    runs,
    authority,
    dependencies,
    command,
    input,
    tasks,
    committed,
    committedDependencies,
    createUi,
  };
}
