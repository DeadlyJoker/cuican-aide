import {
  bindProjectAssetReadView,
  readSqliteOwnedProjectAsset,
  type ProjectAssetReadMethod,
} from "./plugin-project-asset-read-view.ts";
import { captureSqliteAssetRunOwnedAccess } from "./project-asset-run-owned-access.ts";
import type { PluginProjectReadScope } from "@crewon/application";
import type { CreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import { executeSqliteAssetLegacyInstruction } from "./project-asset-legacy-instruction.ts";
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
  bindProjectReads(scope: PluginProjectReadScope) {
    return bindProjectAssetReadView(this, scope);
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
  async loadAsset(
    input: AssetInput<"loadAsset">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = captureAssetRead(input, ["assetId"]);
    return this.#read(
      assetHead(this.#d, q.owner, q.projectId, q.assetId!),
      assetLegacyProjectScope(q.owner, q.projectId),
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadAsset", query: q },
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
  async loadRevision(
    input: AssetInput<"loadRevision">,
    readScope?: PluginProjectReadScope,
  ) {
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
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadRevision", query: q },
    );
  }
  async loadReferenceRevision(
    input: AssetInput<"loadReferenceRevision">,
    readScope?: PluginProjectReadScope,
  ) {
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
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadReferenceRevision", query: q },
    );
  }
  async listAssets(
    input: AssetInput<"listAssets">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = captureAssetRead(input, ["kind", "afterAssetId", "limit"]);
    return this.#read(
      assetPage(this.#d, q),
      assetLegacyProjectScope(q.owner, q.projectId),
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "listAssets", query: q },
    );
  }
  async listRevisions(
    input: AssetInput<"listRevisions">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterContentRevision",
      "limit",
    ]);
    return this.#read(
      assetContentPage(this.#d, q),
      assetLegacyProjectScope(q.owner, q.projectId),
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "listRevisions", query: q },
    );
  }
  async listReferences(
    input: AssetInput<"listReferences">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterReferenceRevision",
      "limit",
    ]);
    return this.#read(
      assetReferencePage(this.#d, q),
      assetLegacyProjectScope(q.owner, q.projectId),
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "listReferences", query: q },
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
      (projectAccess) =>
        this.#execute(
          loadAssetMutationReceiptPlan(
            this.#d,
            identity,
            authority,
            this.#verifier,
            assertSqliteAssetIntentSchema(this.#db, true),
          ),
          authority,
          undefined,
          projectAccess,
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
      (projectAccess) =>
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
          projectAccess,
        ),
      authority,
      {
        projectScope: assetLegacyProjectScope(
          prepared.actor,
          prepared.command.projectId,
        ),
        receiptIdentity: prepared,
      },
      (projectAccess) => {
        if (downstream !== undefined)
          assertSqliteProjectFoundationDownstreamUnchanged(
            this.#db,
            downstream.locator,
            downstream.snapshot,
            projectAccess === undefined ? undefined : { projectAccess },
          );
      },
    );
  }
  #read<T>(
    plan: AssetPlan<T>,
    scope: CreativeProjectScope,
    call?: Readonly<{
      scope: PluginProjectReadScope;
      method: ProjectAssetReadMethod;
      query: Parameters<typeof readSqliteOwnedProjectAsset>[1]["query"];
    }>,
  ): T | Promise<T> {
    this.#open();
    if (call !== undefined)
      return readSqliteOwnedProjectAsset(
        { database: this.#db, assertOpen: this.#open },
        call,
        (access) => {
          assertSqliteProjectAssetSchema(this.#db);
          access.assertProject(scope);
          const result = this.#execute(plan, undefined, undefined, access);
          access.assertProject(scope);
          return result;
        },
      );
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
    projectAccess?: CreativeProjectLegacyAccess,
  ): T {
    let next = plan.next();
    while (!next.done) {
      this.#open();
      assertProjectAssetCommitActive(authority);
      const step = next.value;
      let rows: readonly Record<string, unknown>[];
      if ("assetLegacyAccess" in step) {
        if (projectAccess && step.assetLegacyAccess.kind === "project") {
          projectAccess.assertProject(step.assetLegacyAccess.scope);
          rows = [];
        } else rows = executeSqliteAssetLegacyInstruction(this.#db, step);
      } else if ("foundationDownstream" in step) {
        const snapshot = captureSqliteProjectFoundationDownstream(
          this.#db,
          step.foundationDownstream,
          projectAccess === undefined ? undefined : { projectAccess },
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
    body: (projectAccess?: CreativeProjectLegacyAccess) => T,
    authority: ProjectAssetCommitAuthority | undefined,
    isolation: Readonly<{
      projectScope?: CreativeProjectScope;
      receiptIdentity?: ProjectAssetMutationIdentity;
    }>,
    checkDownstream?: (projectAccess?: CreativeProjectLegacyAccess) => void,
  ): Promise<T> {
    this.#open();
    await assertProjectAssetCommitCurrent(authority);
    await assertProjectAssetCommitTransactionCurrent(authority);
    this.#open();
    // All database work after this point is synchronous, so no external await holds the SQLite write lock.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectAssetSchema(this.#db);
      const owned = captureSqliteAssetRunOwnedAccess(
        this.#db,
        authority?.runTransaction,
      );
      const access =
        owned ?? captureSqliteCreativeProjectLegacyAccess(this.#db);
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
      assertSqliteProjectAssetQualification(this.#db, authority, {
        projectAccess: access,
      });
      const result = body(owned);
      checkDownstream?.(owned);
      assertLegacy();
      captureSqliteAssetRunOwnedAccess(this.#db, authority?.runTransaction);
      assertSqliteProjectAssetQualification(this.#db, authority, {
        projectAccess: access,
      });
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
