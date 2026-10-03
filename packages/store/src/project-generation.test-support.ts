import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import type { TestContext } from "node:test";
import type { CommitExtensionTurnInput } from "@crewon/application";
import {
  createConceptAsset,
  createExtensionCreditAdmission,
  parsePluginTaskAdmission,
  type ProjectGenerationReference,
} from "@crewon/domain";
import {
  extensionFixture,
  scope,
  timestamp,
} from "./extension-store.test-support.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import {
  creationRecipe,
  receipt as projectReceipt,
} from "./creative-project-store.test-support.ts";

export const generationTables = [
  "messages",
  "model_history_items",
  "run_snapshots",
  "extension_run_bindings",
  "plugin_task_admissions",
  "extension_credit_admissions",
  "plugin_credit_reservations",
  "outbox",
  "work_items",
  "creative_project_generation_links",
] as const;
export const activeAuthority = Object.freeze({
  projectGenerationAuthority: Object.freeze({
    assertCurrent: async () => {},
    assertActive() {},
  }),
});

/** Actual installed-package provenance, project revisions, Turn and personal hold on the same host DB. */
export async function projectGenerationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    generationMigration?: boolean;
    metadata?: boolean;
    maxPoolSize?: number;
  } = {},
) {
  const f = await extensionFixture(t, backend, {
    maxPoolSize: options.maxPoolSize,
  });
  await f.seed();
  const base = extensionTurnInput();
  const actor = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    actorId: base.binding.actorId,
    principalId: "project-generation-payer",
  };
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "project-generation-profile",
  };
  const installs = f.first.parent.pluginInstallationStore();
  await installs.migrate();
  const recipe = installationRecipe("generation-package", {
    scope: profile,
    actor,
    pluginId: scope.pluginId,
    at: timestamp,
  });
  const installed = await installs.recordInstalledPackage(recipe);
  const enabled = await installs.commitSelection(
    selectionRecipe(installed.selection, "generation-enable", {
      actor,
      at: timestamp,
    }),
  );
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "generation-fixture-pool",
  };
  const credits = f.first.parent.pluginCreditStore();
  await credits.grant({
    scope: creditScope,
    grantId: "generation-fixture-funding",
    credits: "100",
  });
  const pin = {
    schemaVersion: "crewon.plugin-task-admission.v1" as const,
    ...profile,
    pluginId: recipe.package.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: enabled.selection.revision,
    principalId: actor.principalId,
    actorId: actor.actorId,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "generation-fixture-epoch",
  };
  const metadata = f.first.parent.creativeProjectStore();
  let reference: ProjectGenerationReference = {
    projectId: "generation-project",
    assetId: "generation-concept",
    assetRevision: 1,
    expectedProjectRevision: 3,
    expectedAssetMetadataRevision: 1,
  };
  if (options.metadata !== false) {
    await metadata.migrate();
    const initial = await metadata.commitProjectCreation(
      creationRecipe(
        reference.projectId,
        "generation-create",
        actor,
        timestamp,
      ),
    );
    const concept = createConceptAsset(
      {
        project: initial.project,
        actor,
        expectedProjectRevision: initial.project.revision,
        brief: initial.brief,
        assetId: reference.assetId,
        name: "概念图",
        prompt: "A ceramic teapot by a sunlit window.",
        at: timestamp,
      },
      extensionStoreDigester,
    );
    const saved = await metadata.commitConceptRevision({
      kind: "create-concept",
      actor,
      receipt: projectReceipt("generation-concept"),
      expectedProjectRevision: initial.project.revision,
      ...concept,
    });
    reference = {
      projectId: saved.project.projectId,
      assetId: saved.asset.assetId,
      assetRevision: saved.assetRevision.assetRevision,
      expectedProjectRevision: saved.project.revision,
      expectedAssetMetadataRevision: saved.asset.revision,
    };
  }
  if (options.generationMigration !== false) {
    await f.first.store.migrateProjectGenerations();
    await f.second.store.migrateProjectGenerations();
  }
  async function input(
    id = "run-1",
    key = `project-task-${id}`,
    ref: ProjectGenerationReference | undefined = reference,
  ): Promise<CommitExtensionTurnInput> {
    const turn = extensionTurnInput(id);
    await f.prepare({
      ...turn,
      commit: {
        ...turn.turn.run,
        tenantId: turn.turn.tenantId,
        idempotency: turn.turn.idempotency,
      },
    });
    const receipt = {
      actorId: actor.actorId,
      idempotencyKey: key,
      requestDigest: extensionStoreDigester.sha256(
        JSON.stringify({ id, key, ref }),
      ),
    };
    return {
      ...turn,
      receipt,
      ...(ref === undefined ? {} : { projectGeneration: ref }),
      pluginAdmission: parsePluginTaskAdmission({
        ...pin,
        runId: turn.binding.runId,
        threadId: turn.binding.threadId,
        extensionBindingDigest: turn.binding.bindingDigest,
        requestDigest: receipt.requestDigest,
        idempotencyKey: receipt.idempotencyKey,
      }),
      creditAdmission: createExtensionCreditAdmission(
        {
          binding: turn.binding,
          receipt,
          principalId: actor.principalId,
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        },
        extensionStoreDigester,
      ),
    };
  }
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        generationTables.map(async (table) => [table, await f.count(table)]),
      ),
    );
  return {
    ...f,
    actor,
    reference,
    metadata,
    credits,
    creditScope,
    input,
    counts,
    installs,
    enabled,
  };
}

export async function failGenerationInsert(
  f: Awaited<ReturnType<typeof projectGenerationFixture>>,
  backend: "sqlite" | "postgres",
  table: "creative_project_generation_links" | "extension_mutation_receipts",
  enable: boolean,
) {
  const taskOnly = table === "extension_mutation_receipts";
  await f.sql(
    backend === "sqlite"
      ? enable
        ? `CREATE TRIGGER generation_fixture_failure BEFORE INSERT ON ${table} ${taskOnly ? "WHEN NEW.kind='task'" : ""} BEGIN SELECT RAISE(ABORT,'generation_fixture_failure'); END;`
        : "DROP TRIGGER generation_fixture_failure;"
      : enable
        ? `CREATE FUNCTION ${f.prefix}generation_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'generation_fixture_failure'; END $$; CREATE TRIGGER generation_fixture_failure BEFORE INSERT ON ${f.prefix}${table} FOR EACH ROW ${taskOnly ? "WHEN (NEW.kind='task')" : ""} EXECUTE FUNCTION ${f.prefix}generation_fixture_failure();`
        : `DROP TRIGGER generation_fixture_failure ON ${f.prefix}${table}; DROP FUNCTION ${f.prefix}generation_fixture_failure();`,
  );
}

/** Observe the real link INSERT, preserving native receivers and the actual SQL result. */
export function observeGenerationWrite(
  backend: "sqlite" | "postgres",
  afterWrite: () => void,
): () => void {
  const prototype =
    backend === "sqlite" ? DatabaseSync.prototype : Client.prototype;
  const method = backend === "sqlite" ? "prepare" : "query";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
  const original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(prototype, method, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      if (
        typeof args[0] !== "string" ||
        !/^INSERT INTO (?:"[a-z0-9_]+"\.)?creative_project_generation_links /u.test(
          args[0],
        )
      )
        return result;
      if (backend === "postgres")
        return (result as Promise<unknown>).then((value) => {
          afterWrite();
          return value;
        });
      const statement = result as { run(...values: unknown[]): unknown };
      const run = statement.run;
      Object.defineProperty(statement, "run", {
        value: function (...values: unknown[]) {
          const value = Reflect.apply(run, statement, values);
          afterWrite();
          return value;
        },
      });
      return statement;
    },
  });
  return () => Object.defineProperty(prototype, method, descriptor);
}
