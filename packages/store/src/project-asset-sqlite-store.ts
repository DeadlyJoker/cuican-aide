import type { CreativeProjectScope } from "@crewon/domain";
import {
  assetLegacyProjectScope,
  assertSqliteAssetReceiptLegacyAccess,
} from "./project-asset-legacy-access.ts";
import { captureSqliteCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import { assertSqliteAssetVtwoRecoverySchema } from "./project-asset-vtwo-recovery-schema.ts";
import {
  captureSqliteProjectFoundationDownstream,
  assertSqliteProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamCheck,
} from "./project-foundation-downstream-guard.ts";
import {
  loadAssetMutationReceiptPlan,
  type AssetCommitPlan,
} from "./project-asset-vtwo-recovery-commit.ts";
import { assertSqliteProjectMediaOperationSchema } from "./project-media-operation-schema.ts";
import { assertSqliteProjectMediaResultSchema } from "./project-media-result-schema.ts";
import { assertSqliteAssetIntentSchema } from "./project-asset-ui-intent-schema.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  captureProjectAssetCommitAuthority,
  assertProjectAssetCommitCurrent,
  assertProjectAssetCommitTransactionCurrent,
  assertProjectAssetCommitActive,
  captureProjectGenerationImageResultVerifier,
  type ProjectGenerationImageResultVerifier,
  type ProjectAssetStore,
  type ProjectAssetReferenceImageStore,
  type ProjectAssetCommitAuthority,
  type ProjectAssetCommitOptions,
  type ProjectAssetMutationIdentity,
} from "@crewon/application";
import {
  assetHead,
  assetContent,
  assetReference,
  captureAssetIdentity,
  captureAssetCommit,
  type AssetInput,
  type AssetPlan,
} from "./project-asset-store-support.ts";
import {
  captureAssetRead,
  assetPage,
  assetContentPage,
  assetReferencePage,
} from "./project-asset-store-reads.ts";
import {
  assertAssetReceiptQualification,
  commitAssetPlan,
} from "./project-asset-mutation-plan.ts";
import {
  captureAssetReferenceImageRead,
  loadAssetReferenceImagePlan,
} from "./project-asset-reference-image-plan.ts";
import {
  assertSqliteProjectAssetSchema,
  migrateSqliteProjectAssets,
} from "./project-asset-schema.ts";
import { assertSqliteProjectAssetQualification } from "./project-asset-qualification.ts";
import { SqliteProjectMaterialPreparationStore } from "./project-material-preparation-sqlite-store.ts";
import { SqliteProjectMediaInputStore } from "./project-media-input-sqlite-store.ts";

/** Parent-owned connection. Construction never migrates or invokes a supplier. */
export class SqliteProjectAssetStore
  implements ProjectAssetStore, ProjectAssetReferenceImageStore
{
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier | undefined;
  readonly #d = Object.freeze({ postgres: false, schema: "main", prefix: "" });
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    verifier?: ProjectGenerationImageResultVerifier;
  }) {
    this.#db = input.database;
    this.#open = input.assertOpen.bind(input);
    this.#verifier =
      input.verifier === undefined
        ? undefined
        : captureProjectGenerationImageResultVerifier(input.verifier);
  }
  async migrate(): Promise<void> {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteProjectAssets(this.#db);
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve failure. */
      }
      throw error;
    }
  }
  projectMaterialPreparationStore(): SqliteProjectMaterialPreparationStore {
    return new SqliteProjectMaterialPreparationStore({
      database: this.#db,
      assertOpen: this.#open,
      ...(this.#verifier === undefined ? {} : { verifier: this.#verifier }),
    });
  }
  projectMediaInputStore(): SqliteProjectMediaInputStore {
    return new SqliteProjectMediaInputStore({
      database: this.#db,
      assertOpen: this.#open,
      ...(this.#verifier === undefined ? {} : { verifier: this.#verifier }),
    });
  }
  async loadAsset(input: AssetInput<"loadAsset">) {
    const q = captureAssetRead(input, ["assetId"]);
    return this.#read(
      assetHead(this.#d, q.owner, q.projectId, q.assetId!),
      assetLegacyProjectScope(q.owner, q.projectId),
    );
  }
  async loadReferenceImageSource(
    input: Parameters<
      ProjectAssetReferenceImageStore["loadReferenceImageSource"]
    >[0],
  ) {
    const q = captureAssetReferenceImageRead(input);
    return this.#transaction(
      () =>
        this.#execute(loadAssetReferenceImagePlan(this.#d, q, this.#verifier)),
      undefined,
      { projectScope: assetLegacyProjectScope(q.actor, q.query.projectId) },
    );
  }
  async loadRevision(input: AssetInput<"loadRevision">) {
    const q = captureAssetRead(input, ["assetId", "contentRevision"]);
    return this.#read(
      assetContent(
        this.#d,
        q.owner,
        q.projectId,
        q.assetId!,
        q.contentRevision!,
      ),
      assetLegacyProjectScope(q.owner, q.projectId),
    );
  }
  async loadReferenceRevision(input: AssetInput<"loadReferenceRevision">) {
    const q = captureAssetRead(input, ["assetId", "referenceRevision"]);
    return this.#read(
      assetReference(
        this.#d,
        q.owner,
        q.projectId,
        q.assetId!,
        q.referenceRevision!,
      ),
      assetLegacyProjectScope(q.owner, q.projectId),
    );
  }
  async listAssets(input: AssetInput<"listAssets">) {
    const q = captureAssetRead(input, ["kind", "afterAssetId", "limit"]);
    return this.#read(
      assetPage(this.#d, q),
      assetLegacyProjectScope(q.owner, q.projectId),
    );
  }
  async listRevisions(input: AssetInput<"listRevisions">) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterContentRevision",
      "limit",
    ]);
    return this.#read(
      assetContentPage(this.#d, q),
      assetLegacyProjectScope(q.owner, q.projectId),
    );
  }
  async listReferences(input: AssetInput<"listReferences">) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterReferenceRevision",
      "limit",
    ]);
    return this.#read(
      assetReferencePage(this.#d, q),
      assetLegacyProjectScope(q.owner, q.projectId),
    );
  }
  async loadMutationReceipt(
    input: AssetInput<"loadMutationReceipt">,
    options?: ProjectAssetCommitOptions,
  ) {
    const identity = captureAssetIdentity(input),
      authority = captureProjectAssetCommitAuthority(options);
    assertAssetReceiptQualification(authority, identity);
    return this.#transaction(
      () =>
        this.#execute(
          loadAssetMutationReceiptPlan(
            this.#d,
            identity,
            authority,
            this.#verifier,
            assertSqliteAssetIntentSchema(this.#db, true),
          ),
          authority,
        ),
      authority,
      { receiptIdentity: identity },
    );
  }

  async commitMutation(
    input: AssetInput<"commitMutation">,
    options?: ProjectAssetCommitOptions,
  ) {
    const prepared = captureAssetCommit(input),
      authority = captureProjectAssetCommitAuthority(options);
    let downstream: ProjectFoundationDownstreamCheck | undefined;
    return this.#transaction(
      () =>
        this.#execute(
          commitAssetPlan(
            this.#d,
            prepared,
            authority,
            this.#verifier,
            assertSqliteAssetIntentSchema(this.#db, true),
          ),
          authority,
          (check) => {
            downstream = check;
          },
        ),
      authority,
      {
        projectScope: assetLegacyProjectScope(
          prepared.actor,
          prepared.command.projectId,
        ),
        receiptIdentity: prepared,
      },
      () => {
        if (downstream !== undefined)
          assertSqliteProjectFoundationDownstreamUnchanged(
            this.#db,
            downstream.locator,
            downstream.snapshot,
          );
      },
    );
  }
  #read<T>(plan: AssetPlan<T>, scope: CreativeProjectScope): T {
    this.#open();
    return readSqliteLegacyCreativeProject(this.#db, (access) => {
      assertSqliteProjectAssetSchema(this.#db);
      access.assertProject(scope);
      const result = this.#execute(plan);
      access.assertProject(scope);
      this.#open();
      return result;
    });
  }
  #execute<T>(
    plan: AssetCommitPlan<T>,
    authority?: ProjectAssetCommitAuthority,
    onFoundationSnapshot?: (check: ProjectFoundationDownstreamCheck) => void,
  ): T {
    let next = plan.next();
    while (!next.done) {
      this.#open();
      assertProjectAssetCommitActive(authority);
      const step = next.value;
      let rows: readonly Record<string, unknown>[];
      if ("foundationDownstream" in step) {
        const snapshot = captureSqliteProjectFoundationDownstream(
          this.#db,
          step.foundationDownstream,
        );
        onFoundationSnapshot?.({
          locator: step.foundationDownstream,
          snapshot,
        });
        rows = [];
      } else if ("assetVtwoRecoverySchema" in step) {
        rows = [
          { available: assertSqliteAssetVtwoRecoverySchema(this.#db, true) },
        ];
      } else if ("mediaOperationSchema" in step) {
        assertSqliteProjectMediaOperationSchema(this.#db);
        rows = [];
      } else if ("mediaResultSchema" in step) {
        assertSqliteProjectMediaResultSchema(this.#db);
        rows = [];
      } else rows = this.#db.prepare(step.sql).all(...step.values);
      next = plan.next(rows);
    }
    return next.value;
  }
  async #transaction<T>(
    body: () => T,
    authority: ProjectAssetCommitAuthority | undefined,
    isolation: Readonly<{
      projectScope?: CreativeProjectScope;
      receiptIdentity?: ProjectAssetMutationIdentity;
    }>,
    checkDownstream?: () => void,
  ): Promise<T> {
    this.#open();
    await assertProjectAssetCommitCurrent(authority);
    await assertProjectAssetCommitTransactionCurrent(authority);
    this.#open();
    // All database work after this point is synchronous, so no external await holds the SQLite write lock.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectAssetSchema(this.#db);
      const access = captureSqliteCreativeProjectLegacyAccess(this.#db);
      const assertLegacy = () => {
        if (isolation.projectScope)
          access.assertProject(isolation.projectScope);
        if (isolation.receiptIdentity)
          assertSqliteAssetReceiptLegacyAccess(
            this.#db,
            access,
            isolation.receiptIdentity,
          );
      };
      assertLegacy();
      assertSqliteProjectAssetQualification(this.#db, authority);
      const result = body();
      checkDownstream?.();
      assertLegacy();
      assertSqliteProjectAssetQualification(this.#db, authority);
      assertProjectAssetCommitActive(authority);
      this.#open();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve failure. */
      }
      throw error;
    }
  }
}
