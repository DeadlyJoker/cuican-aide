import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  CommitProjectConceptSelectionInput,
  ProjectGenerationImageResultVerifier,
  ExternalOperation,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  captureProjectConceptSelectionPublication,
} from "@crewon/domain";
import { publicationFixture } from "./project-generation-publication.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
export const selectionAuthority = Object.freeze({
  assertCurrent: async () => {},
  assertActive() {},
});
export const selectionVerifier: ProjectGenerationImageResultVerifier =
  Object.freeze({
    verifyImage({
      operation,
      resultIndex,
    }: Parameters<ProjectGenerationImageResultVerifier["verifyImage"]>[0]) {
      const raw: unknown = JSON.parse(operation.resultJson!);
      assert.ok(
        raw &&
          typeof raw === "object" &&
          "images" in raw &&
          Array.isArray(raw.images),
      );
      const image = raw.images[resultIndex] as
        | { filename: string; url: string }
        | undefined;
      if (!image) throw new Error("fixture_image_not_found");
      return {
        ...image,
        resultIndex,
        providerReferenceJson: extensionCanonicalJson({
          providerOperationId: operation.providerOperationId,
          resultIndex,
        }),
      };
    },
  });
export async function conceptSelectionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    prepared?: boolean;
    verifier?: ProjectGenerationImageResultVerifier;
  } = {},
) {
  const f = await publicationFixture(t, backend, { maxPoolSize: 1 });
  const saved = await f.commit();
  const link = await f.first.store.loadProjectGenerationLink(saved.binding);
  assert.ok(link);
  const operations = f.first.parent.externalOperationStore();
  await operations.migrate();
  const current = await f.first.parent.loadRun(link.binding);
  assert.ok(current);
  const claim = await f.first.parent.claimNextWorkItem({
    ownerId: "selection-worker",
    leaseId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    leaseDurationMs: 60000,
  });
  assert.ok(claim);
  await f.first.parent.commitLeasedRun({
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    commit: {
      tenantId: link.tenantId,
      idempotency: {
        scope: "selection-fixture-start",
        key: link.binding.runId,
        requestFingerprint: digester.sha256("selection-start"),
      },
      expectedRevision: current.revision,
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: link.binding.runId },
          eventId: "selection-fixture-running",
          sequence: current.lastSequence + 1,
          occurredAt: timestamp,
          type: "run.started",
          data: {},
        },
      ],
      outbox: [],
      workItems: [],
    },
    history: null,
  });
  const reserved = await operations.reserveExternalOperation({
    tenantId: link.tenantId,
    runId: link.binding.runId,
    bindingDigest: link.binding.bindingDigest,
    operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    correlationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    executionId: "selection-execution",
    idempotencyKey: "provider-generation-operation",
    actionDigest: digester.sha256("action"),
    requestDigest: digester.sha256("request"),
    createdAt: timestamp,
  });
  const result = await operations.advanceExternalOperation({
    ...reserved.operation,
    expectedRevision: reserved.operation.revision,
    status: "succeeded",
    providerOperationId: "provider-original-operation",
    resultJson: extensionCanonicalJson({
      images: [
        {
          filename: "original-0.png",
          url: "https://provider.example/original/0.png",
        },
        {
          filename: "original-1.png",
          url: "https://provider.example/original/1.png",
        },
      ],
    }),
    updatedAt: timestamp,
  });
  const operation: ExternalOperation = result.operation;
  const store = f.first.parent.projectConceptSelectionStore({
    verifier: options.verifier ?? selectionVerifier,
  });
  if (options.prepared !== false) await store.migrateConceptSelections();
  const sourcePin = parsePluginTaskAdmissionPin({
    ...f.sourcePin,
    action: "crewon.project-generation-selections.v1.selectConceptImage",
  });
  const pkg = await f.installs.loadPackage({
    scope: {
      tenantId: sourcePin.tenantId,
      spaceId: sourcePin.spaceId,
      profileId: sourcePin.profileId,
    },
    packageDigest: sourcePin.packageDigest,
  });
  assert.ok(pkg);
  const publication = captureProjectConceptSelectionPublication({
    publication: {
      source: {
        pluginId: sourcePin.pluginId,
        packageDigest: sourcePin.packageDigest,
        contributionId: sourcePin.contributionId,
      },
    },
    sourcePin,
    selection: f.source.selection,
    package: pkg,
  });
  const input: CommitProjectConceptSelectionInput = {
    actor: f.actor,
    reference: f.reference,
    operationId: operation.operationId,
    expectedOperationRevision: operation.revision,
    resultIndex: 0,
    expectedSelectionRevision: 0,
    receipt: {
      idempotencyKey: "select-0",
      requestDigest: digester.sha256("select-0"),
    },
    at: timestamp,
  };
  const commitOptions = {
    authority: selectionAuthority,
    source: { kind: "installed-plugin-ui" as const, publication },
  };
  const readInput = {
    owner: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      principalId: f.actor.principalId,
    },
    projectId: f.reference.projectId,
    assetId: f.reference.assetId,
  };
  const secondInput = {
    ...input,
    resultIndex: 1,
    expectedSelectionRevision: 1,
    receipt: {
      idempotencyKey: "select-1",
      requestDigest: digester.sha256("select-1"),
    },
  };
  return {
    ...f,
    selectionStore: store,
    operation,
    operations,
    link,
    selectionInput: input,
    secondSelectionInput: secondInput,
    selectionCommitOptions: commitOptions,
    selectionReadInput: readInput,
  };
}

/** Intercept only physical native statement success; keep actual SQL execution and receivers. */
export function observeSelectionSql(
  backend: "sqlite" | "postgres",
  point: "receipt" | "link" | "commit",
  after: () => void,
): () => void {
  const prototype =
      backend === "sqlite" ? DatabaseSync.prototype : Client.prototype,
    method =
      backend === "postgres"
        ? "query"
        : point === "commit"
          ? "exec"
          : "prepare",
    descriptor = Object.getOwnPropertyDescriptor(prototype, method)!,
    original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(prototype, method, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args),
        sql = args[0];
      if (
        typeof sql !== "string" ||
        !(point === "commit"
          ? sql === "COMMIT"
          : sql.startsWith("INSERT INTO ") &&
            sql.includes(
              (point === "receipt"
                ? "creative_concept_selection_receipts"
                : "creative_operation_result_links") + "(",
            ))
      )
        return result;
      if (backend === "postgres")
        return (result as Promise<unknown>).then((value) => {
          after();
          return value;
        });
      if (point === "commit") {
        after();
        return result;
      }
      const statement = result as { all(...args: unknown[]): unknown },
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
