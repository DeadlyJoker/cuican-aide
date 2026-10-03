import type { TestContext } from "node:test";
import type { CommitExtensionTurnInput } from "@crewon/application";
import {
  parsePluginTaskAdmissionPin,
  parseProjectGenerationPublication,
} from "@crewon/domain";
import {
  projectGenerationFixture,
  activeAuthority,
} from "./project-generation.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

/** Real DB installation and paid Turn fixtures; package bytes/UI dispatch are covered by Control tests. */
export async function publicationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    generationMigration?: boolean;
    metadata?: boolean;
    maxPoolSize?: number;
  } = {},
) {
  const f = await projectGenerationFixture(t, backend, options);
  const input = await f.input();
  const {
    schemaVersion: _schema,
    runId: _run,
    threadId: _thread,
    extensionBindingDigest: _binding,
    requestDigest: _receipt,
    idempotencyKey: _key,
    ...rawPin
  } = input.pluginAdmission!;
  const executionPin = parsePluginTaskAdmissionPin(rawPin);
  const profile = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: executionPin.profileId,
  };
  const recipe = installationRecipe("business-generation-package", {
    scope: profile,
    actor: f.actor,
    pluginId: "example.business-source",
    version: "5.0.0",
  });
  const installed = await f.installs.recordInstalledPackage(recipe);
  const source = await f.installs.commitSelection(
    selectionRecipe(installed.selection, "business-generation-enable", {
      actor: f.actor,
    }),
  );
  const sourcePin = parsePluginTaskAdmissionPin({
    ...executionPin,
    pluginId: recipe.package.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: source.selection.revision,
    action: "crewon.project-generations.v1.generateConcept",
    authorityEpoch: "business-generation-policy",
  });
  const publication = parseProjectGenerationPublication({
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
  const commitOptions = {
    ...activeAuthority,
    projectGenerationPublication: { publication, sourcePin, executionPin },
  };
  async function selection(
    owner: "source" | "target",
    state: "disabled" | "uninstalled",
    key = `${owner}-${state}`,
  ) {
    return f.installs.commitSelection(
      selectionRecipe(
        owner === "source" ? source.selection : f.enabled.selection,
        key,
        { actor: f.actor, state },
      ),
    );
  }
  const commit = (command: CommitExtensionTurnInput = input) =>
    f.first.store.commitExtensionTurn(command, commitOptions);
  return {
    ...f,
    inputValue: input,
    source,
    sourcePin,
    executionPin,
    publication,
    commitOptions,
    commit,
    selection,
  };
}
