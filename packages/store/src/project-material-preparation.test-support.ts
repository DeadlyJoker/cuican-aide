import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import type { TestContext } from "node:test";
import {
  parseFrozenProjectReferenceMaterial,
  projectReferenceMaterialFreezeIdentity,
  type ProjectMaterialPreparationCommitAuthority,
  type ProjectMaterialPreparationRequest,
  type ProjectMaterialPreparationReservation,
} from "@crewon/application";
import { createExtensionConfiguration } from "@crewon/domain";
import { projectAssetReferenceImageFixture } from "./project-asset-reference-image.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { selectionVerifier } from "./project-concept-selection.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";

export const materialPreparationAt = "2026-10-06T08:00:00.000Z";
export type MaterialTargetFixture = Readonly<{
  version: string;
  publisherId: string;
  packageDigest: string;
  manifestDigest: string;
  implementationDigest: string;
  preset: string;
}>;
/** Real adopted project/source/Run and installation/config records.
 * Archive/media observation, package bytes and external preparation grants are named fixtures.
 * This journal test does not prove a source archive read, upload, Main or media Run admission.
 */
export async function materialPreparationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    migrate?: boolean;
    targetFixture?: MaterialTargetFixture;
    serviceProtocol?: "native" | "workflow-panel-v1" | "workflow-api-v1";
  } = {},
) {
  const f = await projectAssetReferenceImageFixture(t, backend),
    source = await f.resolver().resolveSelectedReference(f.actor, f.query);
  const freezeRequest = {
    actor: f.actor,
    query: f.query,
    idempotencyKey: "freeze-original-source",
  };
  const frozen = parseFrozenProjectReferenceMaterial(
    {
      schemaVersion: "crewon.project-reference-frozen-material.v1",
      ...projectReferenceMaterialFreezeIdentity(
        freezeRequest,
        "named-existing-source-archive",
        digester,
      ),
      request: freezeRequest,
      source: {
        actor: f.actor,
        projectId: f.query.projectId,
        assetId: f.query.assetId,
        assetRevision: source.asset.revision,
        contentRevision: source.content.contentRevision,
        contentDigest: source.content.contentDigest,
        referenceRevision: source.reference.referenceRevision,
        referenceDigest: source.reference.contentDigest,
        resultLinkDigest: source.resultLink.contentDigest,
        sourceBindingDigest: source.resultLink.sourceBindingDigest,
        sourceRunId: source.resultLink.sourceRunId,
        operationId: source.resultLink.operationId,
        pluginId: source.resultLink.pluginId,
        pluginVersion: source.resultLink.pluginVersion,
        packageDigest: source.resultLink.packageDigest,
        configurationRevision: source.configuration.revision,
        configurationDigest: source.configuration.contentDigest,
        origin: new URL(source.resultLink.image.url).origin + "/",
        output: {
          filename: source.resultLink.image.filename,
          subfolder: "named-fixture",
          type: "output",
        },
        byteDigest: digester.sha256("named-frozen-media-bytes"),
        byteLength: 512,
        width: 2,
        height: 1,
        mediaType: "image/png",
        observedAt: materialPreparationAt,
      },
    },
    digester,
  );
  const scope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.executionPin.profileId,
  };
  const installed = await f.installs.recordInstalledPackage(
    installationRecipe("material-target-package", {
      scope,
      actor: f.actor,
      pluginId: "crewon.short-drama",
      version: options.targetFixture?.version ?? "20.0.2",
      ...(options.targetFixture
        ? {
            publisherId: options.targetFixture.publisherId,
            packageDigest: options.targetFixture.packageDigest,
          }
        : {}),
    }),
  );
  const enabled = await f.installs.commitSelection(
    selectionRecipe(installed.selection, "material-target-enable", {
      actor: f.actor,
    }),
  );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: installed.package.pluginId,
      revision: 1,
      pluginVersion: installed.package.version,
      manifestDigest:
        options.targetFixture?.manifestDigest ??
        digester.sha256("named-target-manifest"),
      implementationDigest:
        options.targetFixture?.implementationDigest ??
        digester.sha256("named-target-implementation"),
      parameters: {
        baseUrl: "https://target.provider.example:8443/",
        preset: options.targetFixture?.preset ?? "standard",
        ...(options.serviceProtocol
          ? { serviceProtocol: options.serviceProtocol }
          : {}),
      },
      credentialBindings: [],
      createdByActorId: f.actor.actorId,
      createdAt: materialPreparationAt,
    },
    digester,
  );
  await f.first.store.saveExtensionConfiguration({
    configuration,
    expectedRevision: 0,
    receipt: {
      actorId: f.actor.actorId,
      idempotencyKey: "material-target-config",
      requestDigest: digester.sha256("material-target-config"),
    },
  });
  const target = {
    installation: {
      ...scope,
      pluginId: installed.package.pluginId,
      publisherId: installed.package.publisherId,
      version: installed.package.version,
      packageDigest: installed.package.packageDigest,
      selectionRevision: enabled.selection.revision,
    },
    selection: enabled.selection,
    package: installed.package,
    configuration,
  };
  const request: ProjectMaterialPreparationRequest = {
    source: freezeRequest,
    target: {
      profileId: scope.profileId,
      pluginId: target.installation.pluginId,
      configurationRevision: configuration.revision,
    },
    idempotencyKey: "prepare-original",
  };
  const state = {
    allow: true,
    active: true,
    checks: 0,
    transactionChecks: 0,
    before: undefined as undefined | (() => Promise<void>),
    transaction: undefined as undefined | (() => Promise<void>),
  };
  const authority = (
    q = request,
  ): ProjectMaterialPreparationCommitAuthority => ({
    version: "crewon.project-material-preparation-commit.v1",
    request: q,
    assertCurrent: async () => {
      state.checks++;
      await state.before?.();
      if (!state.allow) throw new Error("named_preparation_pdp_denied");
    },
    assertTransactionCurrent: async () => {
      state.transactionChecks++;
      await state.transaction?.();
      if (!state.allow) throw new Error("named_preparation_pdp_denied");
    },
    assertActive() {
      if (!state.active) throw new Error("named_preparation_owner_retired");
    },
  });
  const reservation = (q = request): ProjectMaterialPreparationReservation => ({
    request: q,
    source: { ...frozen, request: q.source },
    target,
    proposedTransfer: {
      preparationId: randomUUID(),
      requestDigest: digester.sha256("named-opaque-upload-request"),
    },
    at: materialPreparationAt,
  });
  const journal = f.store.projectMaterialPreparationStore();
  if (options.migrate !== false) await journal.migrate();
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "project_material_preparations",
          "project_material_preparation_events",
          "project_material_preparation_heads",
        ].map(async (name) => [name, await f.count(name)]),
      ),
    );
  const open = async () => {
    const next = await f.open();
    return {
      parent: next.parent,
      journal: next.parent
        .projectAssetStore({ verifier: selectionVerifier })
        .projectMaterialPreparationStore(),
    };
  };
  return {
    ...f,
    frozen,
    target,
    enabled,
    request,
    state,
    authority,
    reservation,
    journal,
    journalCounts: counts,
    openJournal: open,
  };
}
/** Observe actual native SQL success; no replacement rows or virtual transaction is introduced. */
export function observeMaterialPreparationSql(
  backend: "sqlite" | "postgres",
  match: RegExp,
  after: () => void,
): () => void {
  const prototype =
      backend === "sqlite" ? DatabaseSync.prototype : Client.prototype,
    method = backend === "sqlite" ? "prepare" : "query",
    descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
  Object.defineProperty(prototype, method, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(descriptor.value, this, args);
      if (typeof args[0] !== "string" || !match.test(args[0])) return result;
      if (backend === "postgres")
        return (result as Promise<unknown>).then((value) => {
          after();
          return value;
        });
      const statement = result as { all(...values: unknown[]): unknown },
        all = statement.all;
      Object.defineProperty(statement, "all", {
        value: (...values: unknown[]) => {
          const output = Reflect.apply(all, statement, values);
          after();
          return output;
        },
      });
      return statement;
    },
  });
  return () => Object.defineProperty(prototype, method, descriptor);
}
