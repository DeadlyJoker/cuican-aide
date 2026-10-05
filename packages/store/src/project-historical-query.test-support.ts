import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
} from "@crewon/application";
import {
  parseProjectHistoricalQueryPublication,
  parsePluginTaskAdmissionPin,
  parsePluginQueryTaskAdmission,
  extensionCanonicalJson,
} from "@crewon/domain";
import { projectQueryFixture } from "./project-query.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";
/** Real original paid generation and reserved operation; no supplier completion or new funding. */
export async function projectHistoricalQueryFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: { migration?: boolean } = {},
) {
  const f = await projectQueryFixture(t, backend);
  const executionSelection = await f.installs.commitSelection(
    selectionRecipe(f.current.selection, "history-enable-original", {
      actor: f.actor,
      at: timestamp,
      packageDigest: f.sourceAdmission.packageDigest,
    }),
  );
  const sourcePackage = await f.installs.recordInstalledPackage(
    installationRecipe("history-ui-18", {
      scope: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.sourcePin.profileId,
      },
      actor: f.actor,
      pluginId: f.sourcePin.pluginId,
      version: "18.0.0",
      expectedSelectionRevision: f.source.selection.revision,
      at: timestamp,
    }),
  );
  const sourceSelection = await f.installs.commitSelection(
    selectionRecipe(sourcePackage.selection, "history-ui-enable", {
      actor: f.actor,
      at: timestamp,
      packageDigest: sourcePackage.package.packageDigest,
    }),
  );
  const sourcePin = parsePluginTaskAdmissionPin({
    ...f.sourcePin,
    version: sourcePackage.package.version,
    packageDigest: sourcePackage.package.packageDigest,
    selectionRevision: sourceSelection.selection.revision,
    action: "crewon.project-historical-queries.v1.queryConceptGeneration",
  });
  const executionPin = parsePluginTaskAdmissionPin({
    ...f.executionPin,
    version: f.sourceAdmission.version,
    packageDigest: f.sourceAdmission.packageDigest,
    selectionRevision: executionSelection.selection.revision,
  });
  const configuration = await f.first.store.loadExtensionConfiguration({
    ...f.generation.binding,
    revision: f.generation.binding.configurationRevision,
  });
  assert.ok(configuration);
  const publication = parseProjectHistoricalQueryPublication({
    source: {
      pluginId: sourcePin.pluginId,
      packageDigest: sourcePin.packageDigest,
      contributionId: sourcePin.contributionId,
    },
    target: {
      pluginId: executionPin.pluginId,
      publisherId: executionPin.publisherId,
      version: executionPin.version,
      packageDigest: executionPin.packageDigest,
      manifestDigest: configuration.manifestDigest,
      implementationDigest: configuration.implementationDigest,
      contributionId: executionPin.contributionId,
      action: "image.query",
    },
  });
  const commitOptions: CommitExtensionTurnOptions = {
    projectHistoricalQueryAuthority: {
      async assertCurrent() {},
      assertActive() {},
    },
    projectHistoricalQueryPublication: { publication, sourcePin, executionPin },
  };
  if (options.migration !== false) {
    await f.first.store.migrateProjectHistoricalQueries();
    await f.second.store.migrateProjectHistoricalQueries();
  }
  async function queryInput(
    id = "historical-query-run",
    key = "historical-query-key",
  ): Promise<CommitExtensionTurnInput> {
    const old = await f.queryInput(id, key);
    const { projectQuery, ...base } = old;
    const receipt = {
      ...old.receipt,
      requestDigest: extensionStoreDigester.sha256(
        extensionCanonicalJson({
          reference: f.reference,
          generationLinkDigest: f.generationLink.contentDigest,
          operationId: f.operationId,
          publication,
          sourcePin,
          executionPin,
          key,
        }),
      ),
    };
    return {
      ...base,
      receipt,
      projectHistoricalQuery: projectQuery,
      pluginQueryAdmission: parsePluginQueryTaskAdmission({
        ...old.pluginQueryAdmission!,
        ...executionPin,
        ...receipt,
      }),
    };
  }
  async function disable(owner: "source" | "execution") {
    return f.installs.commitSelection(
      selectionRecipe(
        owner === "source"
          ? sourceSelection.selection
          : executionSelection.selection,
        `history-${owner}-disable`,
        { actor: f.actor, state: "disabled" },
      ),
    );
  }
  return {
    ...f,
    sourcePin,
    executionPin,
    publication,
    commitOptions,
    queryInput,
    disable,
    configuration,
  };
}
