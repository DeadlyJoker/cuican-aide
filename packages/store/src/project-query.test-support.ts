import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
} from "@crewon/application";
import {
  createExtensionRunBinding,
  extensionCanonicalJson,
  parsePluginQueryTaskAdmission,
  parsePluginTaskAdmissionPin,
  parseProjectQueryPublication,
} from "@crewon/domain";
import { publicationFixture } from "./project-generation-publication.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { startExternalOperationFixtureRun } from "./external-operation-run.test-support.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { timestamp, digest } from "./extension-store.test-support.ts";
export const queryWriteTables = [
  "messages",
  "model_history_items",
  "run_snapshots",
  "extension_run_bindings",
  "plugin_query_task_admissions",
  "outbox",
  "work_items",
  "creative_project_query_links",
] as const;
export const unchangedTables = [
  "plugin_task_admissions",
  "extension_credit_admissions",
  "plugin_credit_reservations",
  "creative_project_generation_links",
  "creative_concept_revisions",
  "creative_project_briefs",
] as const;
/** Real old paid generation A, current query package B and separate business package in the original DB. */
export async function projectQueryFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: { migration?: boolean } = {},
) {
  const f = await publicationFixture(t, backend, { maxPoolSize: 1 });
  const generation = await f.commit();
  const storedGenerationLink = await f.first.store.loadProjectGenerationLink(
    generation.binding,
  );
  assert.ok(storedGenerationLink);
  const generationLink = storedGenerationLink;
  const sourceAdmission = await f.first.store.loadPluginTaskAdmission(
    generation.binding,
  );
  assert.ok(sourceAdmission);
  await startExternalOperationFixtureRun(f.first.parent, generation.binding);
  const operationId = randomUUID();
  await f.operations.reserveExternalOperation({
    tenantId: f.actor.tenantId,
    runId: generation.binding.runId,
    bindingDigest: generation.binding.bindingDigest,
    operationId,
    executionId: "project-query-original-operation",
    idempotencyKey: "project-query-original-operation",
    actionDigest: digest,
    requestDigest: digest,
    correlationId: operationId,
    createdAt: timestamp,
  });
  const upgrade = await f.installs.recordInstalledPackage(
    installationRecipe("query-execution-upgrade", {
      scope: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.executionPin.profileId,
      },
      actor: f.actor,
      pluginId: f.executionPin.pluginId,
      version: "2.0.0",
      expectedSelectionRevision: f.enabled.selection.revision,
      at: timestamp,
    }),
  );
  const current = await f.installs.commitSelection(
    selectionRecipe(upgrade.selection, "query-execution-enable", {
      actor: f.actor,
      at: timestamp,
      packageDigest: upgrade.package.packageDigest,
    }),
  );
  const executionPin = parsePluginTaskAdmissionPin({
    ...f.executionPin,
    version: upgrade.package.version,
    packageDigest: upgrade.package.packageDigest,
    selectionRevision: current.selection.revision,
    action: "image.query",
    authorityEpoch: "project-query-execution-policy",
  });
  const sourcePin = parsePluginTaskAdmissionPin({
    ...f.sourcePin,
    action: "crewon.project-generation-queries.v1.queryConceptGeneration",
    authorityEpoch: "project-query-business-policy",
  });
  const publication = parseProjectQueryPublication({
    source: {
      pluginId: sourcePin.pluginId,
      packageDigest: sourcePin.packageDigest,
      contributionId: sourcePin.contributionId,
    },
    target: {
      pluginId: executionPin.pluginId,
      packageDigest: executionPin.packageDigest,
      contributionId: executionPin.contributionId,
      action: executionPin.action,
    },
  });
  const commitOptions: CommitExtensionTurnOptions = {
    projectQueryAuthority: { async assertCurrent() {}, assertActive() {} },
    projectQueryPublication: { publication, sourcePin, executionPin },
  };
  const reference = {
    projectId: generationLink.projectId,
    assetId: generationLink.reference.assetId,
    assetRevision: generationLink.reference.assetRevision,
  };
  if (options.migration !== false) {
    await f.first.store.migrateProjectQueries();
    await f.second.store.migrateProjectQueries();
  }
  const preparedThreads = new Set<string>();
  async function queryInput(
    id = "project-query-run",
    key = "project-query-key",
  ): Promise<CommitExtensionTurnInput> {
    const base = extensionTurnInput(id, {
      threadId: `thread-${key}`,
      source: {
        runId: generation.binding.runId,
        bindingDigest: generation.binding.bindingDigest,
        operationId,
      },
    });
    const content = extensionCanonicalJson({ kind: "query", operationId }),
      inputDigest = extensionStoreDigester.sha256(content);
    const binding = createExtensionRunBinding(
      { ...base.binding, inputDigest },
      extensionStoreDigester,
    );
    const event = base.turn.thread.events[0]!,
      message = base.turn.thread.messages[0]!,
      history = base.turn.thread.history.items[0]!;
    assert.equal(event.type, "thread.message.appended");
    assert.equal(history.type, "message");
    const receipt = {
      actorId: f.actor.actorId,
      idempotencyKey: key,
      requestDigest: extensionStoreDigester.sha256(
        extensionCanonicalJson({
          key,
          reference,
          generationLinkDigest: generationLink.contentDigest,
          operationId,
          publication,
          sourcePin,
          executionPin,
        }),
      ),
    };
    const input: CommitExtensionTurnInput = {
      ...base,
      binding,
      receipt,
      projectQuery: {
        reference,
        generationLinkDigest: generationLink.contentDigest,
      },
      pluginQueryAdmission: parsePluginQueryTaskAdmission({
        schemaVersion: "crewon.plugin-query-task-admission.v1",
        ...executionPin,
        runId: binding.runId,
        threadId: binding.threadId,
        extensionBindingDigest: binding.bindingDigest,
        ...receipt,
        source: sourceAdmission,
        operationId,
      }),
      turn: {
        ...base.turn,
        thread: {
          ...base.turn.thread,
          events: [
            { ...event, data: { ...event.data, contentDigest: inputDigest } },
          ],
          messages: [{ ...message, content, contentDigest: inputDigest }],
          history: {
            ...base.turn.thread.history,
            items: [{ ...history, content, contentDigest: inputDigest }],
          },
        },
      },
    };
    if (!preparedThreads.has(binding.threadId)) {
      await f.prepare({
        ...input,
        commit: {
          ...input.turn.run,
          tenantId: input.turn.tenantId,
          idempotency: input.turn.idempotency,
        },
      });
      preparedThreads.add(binding.threadId);
    }
    return input;
  }
  async function counts() {
    return Object.fromEntries(
      await Promise.all(
        [...queryWriteTables, ...unchangedTables].map(async (table) => [
          table,
          await f.count(table),
        ]),
      ),
    );
  }
  async function disable(
    owner: "source" | "execution",
    state: "disabled" | "uninstalled" = "disabled",
  ) {
    return f.installs.commitSelection(
      selectionRecipe(
        owner === "source" ? f.source.selection : current.selection,
        `${owner}-${state}-query`,
        { actor: f.actor, state },
      ),
    );
  }
  return {
    ...f,
    generation,
    generationLink,
    sourceAdmission,
    operationId,
    current,
    upgrade,
    reference,
    sourcePin,
    executionPin,
    publication,
    commitOptions,
    queryInput,
    counts,
    disable,
  };
}
