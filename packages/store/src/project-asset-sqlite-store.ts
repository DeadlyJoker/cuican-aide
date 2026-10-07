import { assertSqliteAssetVtwoRecoverySchema } from "./project-asset-vtwo-recovery-schema.ts";
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
    return this.#read(assetHead(this.#d, q.owner, q.projectId, q.assetId!));
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
    );
  }
  async listAssets(input: AssetInput<"listAssets">) {
    const q = captureAssetRead(input, ["kind", "afterAssetId", "limit"]);
    return this.#read(assetPage(this.#d, q));
  }
  async listRevisions(input: AssetInput<"listRevisions">) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterContentRevision",
      "limit",
    ]);
    return this.#read(assetContentPage(this.#d, q));
  }
  async listReferences(input: AssetInput<"listReferences">) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterReferenceRevision",
      "limit",
    ]);
    return this.#read(assetReferencePage(this.#d, q));
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
    );
  }

  async commitMutation(
    input: AssetInput<"commitMutation">,
    options?: ProjectAssetCommitOptions,
  ) {
    const prepared = captureAssetCommit(input),
      authority = captureProjectAssetCommitAuthority(options);
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
        ),
      authority,
    );
  }
  #read<T>(plan: AssetPlan<T>): T {
    this.#open();
    assertSqliteProjectAssetSchema(this.#db);
    return this.#execute(plan);
  }
  #execute<T>(
    plan: AssetCommitPlan<T>,
    authority?: ProjectAssetCommitAuthority,
  ): T {
    let next = plan.next();
    while (!next.done) {
      this.#open();
      assertProjectAssetCommitActive(authority);
      const step = next.value;
      let rows: readonly Record<string, unknown>[];
      if ("assetVtwoRecoverySchema" in step) {
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
  ): Promise<T> {
    this.#open();
    await assertProjectAssetCommitCurrent(authority);
    await assertProjectAssetCommitTransactionCurrent(authority);
    this.#open();
    // All database work after this point is synchronous, so no external await holds the SQLite write lock.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectAssetSchema(this.#db);
      assertSqliteProjectAssetQualification(this.#db, authority);
      const result = body();
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
