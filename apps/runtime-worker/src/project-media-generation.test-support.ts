import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import type { TestContext } from "node:test";
import {
  ProjectMediaInputApplicationService,
  ExtensionTaskApplicationService,
  projectMediaGenerationTaskInput,
  MEDIA_GENERATION_INPUT_KIND,
  type ProjectMediaGenerationTask,
  type ProjectMediaInputRevision,
} from "@crewon/application";
import {
  createExtensionConfiguration,
  parseExtensionManifest,
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import { extensionManifestFixture } from "../../../packages/domain/src/extension-manifest.test-support.ts";
import { activation } from "../../../packages/store/src/extension-store.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import { projectMediaInputFixture } from "./project-media-input.test-support.ts";
import { ProjectMaterialPreparer } from "./project-material-preparer.ts";
import { ProjectMediaMaterialPreparer } from "./project-media-material-preparer.ts";
import { ProjectMediaGenerationTaskPreparer } from "./project-media-generation-task-preparer.ts";

/** Actual project, selected sources, encrypted bytes, preparation journal and original TaskCore/Turn SQL.
 * Catalog/readiness/PDP/deployment review/DNS/provider responses are named fixtures; no Main/Agent/plugin acceptance.
 */
export async function mediaGenerationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{ migrate?: boolean; unmetered?: boolean }> = {},
) {
  const f = await projectMediaInputFixture(t, backend);
  const string = { type: "string" as const, maxLength: 256, enum: null },
    schema = {
      type: "object" as const,
      properties: {
        kind: { ...string, enum: [MEDIA_GENERATION_INPUT_KIND] },
        projectId: string,
        mediaInputId: string,
        inputRevision: {
          type: "integer" as const,
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        executionId: string,
        mediaInputDigest: string,
      },
      required: [
        "kind",
        "projectId",
        "mediaInputId",
        "inputRevision",
        "executionId",
        "mediaInputDigest",
      ],
      additionalProperties: false,
    };
  const manifest = parseExtensionManifest({
    ...extensionManifestFixture("crewon.short-drama"),
    version: f.target.package.version,
    task: {
      instructions:
        "Execute only the confirmed media-input reference through its admitted host context.",
      inputSchema: schema,
    },
    configurationSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", maxLength: 4096, enum: null },
        preset: { type: "string", maxLength: 32, enum: ["standard"] },
      },
      required: ["baseUrl", "preset"],
      additionalProperties: false,
    },
    credentialSlots: [],
  });
  const registration = {
    manifest,
    manifestDigest: f.digester.sha256(extensionCanonicalJson(manifest)),
    implementationDigest: f.target.configuration.implementationDigest,
  };
  const configuration = createExtensionConfiguration(
    {
      ...f.target.configuration,
      revision: 2,
      manifestDigest: registration.manifestDigest,
      createdAt: f.dependencies.clock.now(),
    },
    f.digester,
  );
  const extensions = f.parent.extensionStore();
  await extensions.saveExtensionConfiguration({
    configuration,
    expectedRevision: 1,
    receipt: {
      actorId: f.actor.actorId,
      idempotencyKey: "media-run-config",
      requestDigest: f.digester.sha256("media-run-config"),
    },
  });
  await extensions.saveExtensionActivation({
    activation: activation(configuration, {
      pluginId: configuration.pluginId,
      target: f.link.binding.target,
    }),
    expectedRevision: 0,
    receipt: {
      actorId: f.actor.actorId,
      idempotencyKey: "media-run-activation",
      requestDigest: f.digester.sha256("media-run-activation"),
    },
  });
  if (options.migrate !== false)
    await extensions.migrateProjectMediaGenerations();
  if (options.unmetered) await extensions.migrateUnmeteredPluginAdmissions();
  const reviewed = {
      ...f.reviewedTarget,
      manifestDigest: configuration.manifestDigest,
    },
    reviews = f.reviews.map((r) => ({ ...r, targetIdentity: reviewed })),
    state = {
      allowed: true,
      active: true,
      quotes: 0,
      checks: 0,
      afterQuote: undefined as undefined | (() => Promise<void>),
    };
  const authorization = {
    authorize: async () => {
      state.checks++;
      return f.decision(state.allowed);
    },
    assertActive: () => {
      if (!state.active)
        throw new Error("named_media_generation_owner_retired");
    },
  };
  const threadId = "media-task-thread";
  await seedThread(f.parent, { ...f.actor, threadId });
  const pin = parsePluginTaskAdmissionPin({
    ...f.target.installation,
    principalId: f.actor.principalId,
    actorId: f.actor.actorId,
    contributionId: "workbench",
    action: "media.generate",
    authorityEpoch: "named-media-run-epoch",
  });
  const open = (next = f) => {
    const ext = next === f ? extensions : next.parent.extensionStore(),
      store = next.store;
    const app = new ProjectMediaInputApplicationService({
      store,
      sources: next.sources,
      targets: next.targets,
      reviews,
      authorization: f.mediaAuthorization,
      ids: { nextMediaInputId: () => randomUUID() },
      clock: f.dependencies.clock,
    });
    const preparer = new ProjectMaterialPreparer({
        ...next.dependencies,
        freezer: next.freezer,
        reviewedTargets: [reviewed],
      }),
      materials = new ProjectMediaMaterialPreparer({
        store,
        preparer,
        reviews,
        authorization: f.mediaAuthorization,
      });
    const issuer = new ProjectMediaGenerationTaskPreparer({
      materials,
      store,
      extensions: ext,
      reviews,
      metadataAuthorization: f.mediaAuthorization,
      authorization,
      verifier: selectionVerifier,
    });
    const service = new ExtensionTaskApplicationService({
      store: next.parent,
      extensions: ext,
      operations: f.operations,
      catalog: {
        list: () => [registration],
        resolve: ({ pluginId, pluginVersion }) =>
          pluginId === manifest.pluginId && pluginVersion === manifest.version
            ? registration
            : null,
      },
      host: {
        taskAdmissionMode: () => "installed",
        validateConfiguration: async () => {},
        evaluate: async () => ({
          outcome: "ready",
          target: f.link.binding.target,
        }),
      },
      authorization: { authorize: async () => f.decision(true) },
      clock: f.dependencies.clock,
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
      ...(options.unmetered
        ? {
            unmeteredTasks: {
              prepareGeneration: async ({ actor, pin: requested }) => {
                assert.deepEqual(actor, f.actor);
                assert.deepEqual(requested, pin);
                const active = () => {
                  if (!state.active)
                    throw new Error("named_unmetered_owner_retired");
                };
                return {
                  authorization: {
                    authorityId: "named-local-deferred-credits",
                    policyRevision: 1,
                  },
                  assertCurrent: async () => {
                    active();
                    if (!state.allowed)
                      throw new Error("named_unmetered_denied");
                  },
                  assertActive: active,
                };
              },
            },
          }
        : {
            creditQuotes: {
              async quoteGeneration() {
                state.quotes++;
                await state.afterQuote?.();
                return {
                  poolId: f.creditScope.poolId,
                  priceRevision: 1,
                  quotedCredits: "7",
                };
              },
            },
          }),
    });
    return { ext, app, materials, issuer, service };
  };
  const current = open();
  const command = {
      ...f.command,
      target: { ...f.command.target, configurationRevision: 2 },
    },
    d18Command = {
      ...f.d18Command,
      target: { ...f.d18Command.target, configurationRevision: 2 },
    };
  const mediaQuery = (input: ProjectMediaInputRevision) => ({
    projectId: input.projectId,
    mediaInputId: input.mediaInputId,
    inputRevision: input.inputRevision,
    expectedInputRevision: input.inputRevision,
  });
  const signal = () => ({ signal: new AbortController().signal });
  const taskCommand = (
    task: ProjectMediaGenerationTask,
    key = "media-run",
  ) => ({
    pluginId: pin.pluginId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: key,
    intent: {
      kind: "generate" as const,
      input: projectMediaGenerationTaskInput(task.reference),
    },
  });
  const create = (
    task: ProjectMediaGenerationTask,
    key = "media-run",
    service = current.service,
  ) =>
    service.createProjectMediaTaskFromHost({
      actor: f.actor,
      command: taskCommand(task, key),
      pin,
      task,
    });
  const prepare = async (
    kind: "T10" | "D18" = "T10",
    executionId = "original-media-intent",
  ) => {
    const saved = await current.app.saveInput(
        f.actor,
        kind === "T10" ? command : d18Command,
      ),
      q = mediaQuery(saved.input);
    const materials = await current.materials.prepareInput(
      f.actor,
      q,
      signal(),
    );
    assert.equal(materials.disposition, "verified");
    const task = await current.issuer.qualifyTask(
      f.actor,
      { ...q, executionId },
      signal(),
    );
    return { saved, materials, task };
  };
  const cold = async () => {
    const next = await f.cold();
    const reopened = open({ ...f, ...next });
    await reopened.ext.migrateProjectMediaGenerations();
    if (options.unmetered)
      await reopened.ext.migrateUnmeteredPluginAdmissions();
    return { ...next, ...reopened };
  };
  const countRuns = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "run_snapshots",
          "messages",
          "model_history_items",
          "extension_run_bindings",
          "plugin_task_admissions",
          "plugin_credit_reservations",
          "extension_credit_admissions",
          "work_items",
          "outbox",
          "idempotency_receipts",
          "project_media_generation_links",
          "project_media_generation_materials",
        ].map(async (name) => [name, await f.count(name)]),
      ),
    );
  return {
    ...f,
    ...current,
    command,
    d18Command,
    generation: state,
    pin,
    configuration,
    registration,
    mediaQuery,
    signal,
    taskCommand,
    create,
    prepare,
    cold,
    countRuns,
  };
}

/** Observe actual native INSERT success, with original receivers and physical SQL preserved. */
export function observeMediaLinkInsert(
  backend: "sqlite" | "postgres",
  after: () => void,
) {
  const proto =
      backend === "sqlite" ? DatabaseSync.prototype : Client.prototype,
    method = backend === "sqlite" ? "prepare" : "query",
    d = Object.getOwnPropertyDescriptor(proto, method)!,
    original = d.value as (...args: unknown[]) => unknown;
  Object.defineProperty(proto, method, {
    ...d,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      if (
        typeof args[0] !== "string" ||
        !/^INSERT INTO (?:"[a-z0-9_]+"\.)?project_media_generation_links /u.test(
          args[0],
        )
      )
        return result;
      if (backend === "postgres")
        return (result as Promise<unknown>).then((v) => {
          after();
          return v;
        });
      const statement = result as { all(...v: unknown[]): unknown },
        all = statement.all;
      Object.defineProperty(statement, "all", {
        value: (...v: unknown[]) => {
          const output = Reflect.apply(all, statement, v);
          after();
          return output;
        },
      });
      return statement;
    },
  });
  return () => Object.defineProperty(proto, method, d);
}
