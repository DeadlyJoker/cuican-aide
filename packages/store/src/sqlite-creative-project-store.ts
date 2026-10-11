import {
  prepareSqliteOwnedMetadataMutation,
  readSqliteOwnedMetadataReceipt,
  assertSqliteOwnedMetadataTarget,
} from "./plugin-project-owned-mutation-sqlite.ts";
import {
  listSqliteCreativeProjects,
  listSqliteCreativeBriefs,
  listSqliteCreativeAssets,
  listSqliteCreativeRevisions,
} from "./creative-project-sqlite-lists.ts";
import {
  bindSqliteCreativeProjectReadView,
  readSqliteOwnedCreativeProject,
  type PluginProjectReadCall,
  captureSqliteOwnedProjectAccess,
} from "./plugin-project-owned-read-sqlite.ts";
import type {
  PluginProjectReadScope,
  PluginProjectMutationScope,
} from "@crewon/application";
import {
  beginSqlitePlanResult,
  finishSqlitePlanResult,
} from "./project-text-plan-tool.ts";
import { assertSqliteProjectRunCommit } from "./creative-project-run-commit-sqlite.ts";
import {
  projectRunCommitQualification,
  type ProjectRunQualification,
} from "./creative-project-run-commit-support.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
  captureCreativeProjectCommitAuthority,
  type CreativeProjectCommitAuthority,
  type CreativeProjectCommitOptions,
  type CreativeProjectMutationResult,
  type CreativeProjectOwnerScope,
  type CreativeProjectStore,
  type OwnedCreativeProjectCreationInput,
  type OwnedCreativeProjectCreationReceiptInput,
} from "@crewon/application";
import {
  prepareOwnedCreativeCreation,
  readOwnedCreativeCreationReceipt,
  commitOwnedCreativeCreationRecords,
} from "./plugin-project-owned-creation-sqlite.ts";
import type {
  ConceptAsset,
  ConceptAssetRevision,
  CreativeProject,
  ProjectBriefRevision,
} from "@crewon/domain";
import { migrateSqliteCreativeProjects } from "./creative-project-schema.ts";
import {
  creativeMutationIdentity,
  creativeMutationKind,
  creativeOwnerValues,
  creativeReadInput,
  creativeRecordJson,
  creativeStoreFailure,
  creativeStoreRecord,
  decodeCreativeAsset,
  decodeCreativeBrief,
  decodeCreativeProject,
  decodeCreativeReceipt,
  decodeCreativeRevision,
  prepareCreativeMutation,
  verifyCreativeMutation,
  type PreparedCreativeMutation,
} from "./creative-project-store-records.ts";
import {
  admitSqlitePluginInstallationPin,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import {
  creativeProjectPluginCommitQualification,
  assertCreativeProjectPluginCommitSelection,
} from "./creative-project-plugin-commit-support.ts";
import { assertSqliteCreativeProjectLegacyMutation } from "./creative-project-legacy-mutation-access.ts";
import {
  captureSqliteCreativeProjectLegacyAccess,
  type CreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";

type BoundProjectReadScope =
  | PluginProjectReadScope
  | PluginProjectMutationScope;

type Input<Method extends keyof CreativeProjectStore> = Parameters<
  CreativeProjectStore[Method]
>[0];
type Result<Method extends keyof CreativeProjectStore> = Awaited<
  ReturnType<CreativeProjectStore[Method]>
>;
type MutationIdentity = ReturnType<typeof creativeMutationIdentity>;

const projectFilter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=?";
const childJoin =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";

/** Host-owned connection; construction neither migrates nor creates projects. */
export class SqliteCreativeProjectStore implements CreativeProjectStore {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;

  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
  }

  async migrate(): Promise<void> {
    this.#transaction(() => migrateSqliteCreativeProjects(this.#database));
  }

  bindProjectReads(scope: BoundProjectReadScope) {
    return bindSqliteCreativeProjectReadView(this, scope);
  }

  async loadProject(
    input: Input<"loadProject">,
    scope?: BoundProjectReadScope,
  ) {
    this.#assertOpen();
    const query = creativeReadInput("loadProject", input);
    return this.#read(
      (access) => this.#project(query.owner, query.projectId, access),
      scope === undefined ? undefined : { scope, method: "loadProject", query },
    );
  }

  async listProjects(
    input: Input<"listProjects">,
    scope?: BoundProjectReadScope,
  ) {
    this.#assertOpen();
    const query = creativeReadInput("listProjects", input);
    return this.#read(
      (access) => listSqliteCreativeProjects(this.#database, query, access),
      scope === undefined
        ? undefined
        : { scope, method: "listProjects", query },
    );
  }

  async loadBrief(input: Input<"loadBrief">, scope?: BoundProjectReadScope) {
    this.#assertOpen();
    const query = creativeReadInput("loadBrief", input);
    return this.#read(
      (access) =>
        this.#brief(query.owner, query.projectId, query.briefRevision, access),
      scope === undefined ? undefined : { scope, method: "loadBrief", query },
    );
  }

  async listBriefs(input: Input<"listBriefs">, scope?: BoundProjectReadScope) {
    this.#assertOpen();
    const query = creativeReadInput("listBriefs", input);
    return this.#read(
      (access) => listSqliteCreativeBriefs(this.#database, query, access),
      scope === undefined ? undefined : { scope, method: "listBriefs", query },
    );
  }

  async loadConceptAsset(
    input: Input<"loadConceptAsset">,
    scope?: BoundProjectReadScope,
  ) {
    this.#assertOpen();
    const query = creativeReadInput("loadConceptAsset", input);
    return this.#read(
      (access) =>
        this.#asset(query.owner, query.projectId, query.assetId, access),
      scope === undefined
        ? undefined
        : { scope, method: "loadConceptAsset", query },
    );
  }

  async listConceptAssets(
    input: Input<"listConceptAssets">,
    scope?: BoundProjectReadScope,
  ) {
    this.#assertOpen();
    const query = creativeReadInput("listConceptAssets", input);
    return this.#read(
      (access) => listSqliteCreativeAssets(this.#database, query, access),
      scope === undefined
        ? undefined
        : { scope, method: "listConceptAssets", query },
    );
  }

  async loadConceptRevision(
    input: Input<"loadConceptRevision">,
    scope?: BoundProjectReadScope,
  ) {
    this.#assertOpen();
    const query = creativeReadInput("loadConceptRevision", input);
    return this.#read(
      (access) => {
        const row = this.#database
          .prepare(
            `SELECT c.*,p.owner_principal_id FROM creative_concept_revisions c ${childJoin} WHERE ${projectFilter} AND ${access.predicate("p")} AND c.project_id=? AND c.asset_id=? AND c.asset_revision=?`,
          )
          .get(
            ...creativeOwnerValues(query.owner),
            query.projectId,
            query.assetId,
            query.assetRevision,
          );
        return decodeCreativeRevision(
          row,
          query.owner,
          query.projectId,
          query.assetId,
        );
      },
      scope === undefined
        ? undefined
        : { scope, method: "loadConceptRevision", query },
    );
  }

  async listConceptRevisions(
    input: Input<"listConceptRevisions">,
    scope?: BoundProjectReadScope,
  ) {
    this.#assertOpen();
    const query = creativeReadInput("listConceptRevisions", input);
    return this.#read(
      (access) => listSqliteCreativeRevisions(this.#database, query, access),
      scope === undefined
        ? undefined
        : { scope, method: "listConceptRevisions", query },
    );
  }

  async loadMutationReceipt(
    input: Input<"loadMutationReceipt">,
    options?: CreativeProjectCommitOptions,
  ) {
    this.#assertOpen();
    const identity = creativeMutationIdentity(input);
    const authority = captureCreativeProjectCommitAuthority(options, {
      allowTextUiTransaction: false,
      allowMutationScope: true,
    });
    if (options?.mutationScope !== undefined) {
      const source = await prepareSqliteOwnedMetadataMutation(
        options.mutationScope,
        authority,
        identity,
      );
      await assertCreativeProjectCommitTransactionCurrent(authority);
      return this.#transaction(
        () =>
          readSqliteOwnedMetadataReceipt(this.#database, source, (access) =>
            this.#receipt(identity, access),
          ),
        authority,
        undefined,
        source.assertActive,
      );
    }
    const q = projectRunCommitQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
    );
    if (q === undefined)
      return this.#read((access) => this.#receipt(identity, access));
    await assertCreativeProjectCommitCurrent(authority);
    await assertCreativeProjectCommitTransactionCurrent(authority);
    let result: CreativeProjectMutationResult | null = null;
    return this.#transaction(
      () => {
        assertSqliteProjectRunCommit(this.#database, q);
        const planResult = beginSqlitePlanResult(this.#database, q);
        result = this.#receipt(identity);
        if (result !== null)
          finishSqlitePlanResult(this.#database, planResult, result);
        return result;
      },
      authority,
      q,
      () => {
        if (result !== null)
          this.#legacyAccess().assertProject({
            tenantId: result.project.tenantId,
            spaceId: result.project.spaceId,
            projectId: result.project.projectId,
          });
      },
    );
  }

  async loadOwnedCreationReceipt(
    input: OwnedCreativeProjectCreationReceiptInput,
    options?: CreativeProjectCommitOptions,
  ) {
    this.#assertOpen();
    const owned = await prepareOwnedCreativeCreation(input, options);
    return this.#transaction(
      () => readOwnedCreativeCreationReceipt(this.#database, owned),
      owned.authority,
      undefined,
      owned.source.assertActive,
    );
  }

  async commitOwnedProjectCreation(
    input: OwnedCreativeProjectCreationInput,
    options?: CreativeProjectCommitOptions,
  ) {
    this.#assertOpen();
    const owned = await prepareOwnedCreativeCreation(input, options, "commit");
    return this.#transaction(
      () =>
        commitOwnedCreativeCreationRecords(this.#database, owned, {
          insertProject: (project) => this.#insertProject(project),
          insertBrief: (brief) => this.#insertBrief(brief),
          saveReceipt: (identity, result) =>
            this.#saveReceipt(identity, result),
        }),
      owned.authority,
      undefined,
      owned.source.assertActive,
    );
  }

  async commitProjectCreation(
    input: Input<"commitProjectCreation">,
    options?: CreativeProjectCommitOptions,
  ): Promise<Result<"commitProjectCreation">> {
    const authority = captureCreativeProjectCommitAuthority(options);
    const result = await this.#commit(
      prepareCreativeMutation("create-project", input),
      authority,
    );
    if (result.kind !== "create-project")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async commitProjectMetadata(
    input: Input<"commitProjectMetadata">,
    options?: CreativeProjectCommitOptions,
  ): Promise<Result<"commitProjectMetadata">> {
    const authority = captureCreativeProjectCommitAuthority(options, {
      allowTextUiTransaction: false,
      allowMutationScope: true,
    });
    const kind = creativeMutationKind(creativeStoreRecord(input).kind);
    if (kind !== "rename-project" && kind !== "set-project-state")
      creativeStoreFailure("creative_project_mutation_kind_invalid");
    const result = await this.#commit(
      prepareCreativeMutation(kind, input),
      authority,
      options?.mutationScope,
    );
    if (result.kind !== "rename-project" && result.kind !== "set-project-state")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async commitProjectBrief(
    input: Input<"commitProjectBrief">,
    options?: CreativeProjectCommitOptions,
  ): Promise<Result<"commitProjectBrief">> {
    const authority = captureCreativeProjectCommitAuthority(options, {
      allowTextUiTransaction: false,
      allowMutationScope: true,
    });
    const result = await this.#commit(
      prepareCreativeMutation("append-brief", input),
      authority,
      options?.mutationScope,
    );
    if (result.kind !== "append-brief")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async commitConceptRevision(
    input: Input<"commitConceptRevision">,
    options?: CreativeProjectCommitOptions,
  ): Promise<Result<"commitConceptRevision">> {
    const authority = captureCreativeProjectCommitAuthority(options, {
      allowTextUiTransaction: false,
      allowMutationScope: true,
    });
    const kind = creativeMutationKind(creativeStoreRecord(input).kind);
    if (kind !== "create-concept" && kind !== "append-concept")
      creativeStoreFailure("creative_project_mutation_kind_invalid");
    const result = await this.#commit(
      prepareCreativeMutation(kind, input),
      authority,
      options?.mutationScope,
    );
    if (result.kind !== "create-concept" && result.kind !== "append-concept")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async #commit(
    prepared: PreparedCreativeMutation,
    authority: CreativeProjectCommitAuthority | undefined,
    mutationScope?: PluginProjectMutationScope,
  ): Promise<CreativeProjectMutationResult> {
    const identity = creativeMutationIdentity({
      actor: prepared.actor,
      receipt: prepared.receipt,
      kind: prepared.kind,
    });
    const owned =
      mutationScope === undefined
        ? undefined
        : await prepareSqliteOwnedMetadataMutation(
            mutationScope,
            authority,
            identity,
          );
    const assertLegacy = (access: CreativeProjectLegacyAccess) => {
      if (owned !== undefined) {
        assertSqliteOwnedMetadataTarget(
          this.#database,
          owned,
          prepared.project,
        );
      } else
        assertSqliteCreativeProjectLegacyMutation(
          this.#database,
          access,
          prepared.project,
          identity,
        );
    };
    const qualification = creativeProjectPluginCommitQualification(
      authority,
      prepared.actor,
      prepared.kind,
    );
    const runQualification = projectRunCommitQualification(
      authority,
      prepared.actor,
      prepared.kind,
      prepared.receipt,
    );
    // SQLite's transaction stays synchronous; external authority work happens before BEGIN.
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    if (qualification !== undefined || runQualification !== undefined)
      await assertCreativeProjectCommitTransactionCurrent(authority);
    return this.#transaction(
      () => {
        const access =
          owned === undefined
            ? this.#legacyAccess()
            : captureSqliteOwnedProjectAccess(this.#database, owned);
        assertSqliteProjectRunCommit(this.#database, runQualification);
        if (qualification !== undefined) {
          assertSqlitePluginInstallationPinSchema(this.#database);
          const installation = admitSqlitePluginInstallationPin(
            this.#database,
            qualification.pin,
          );
          assertCreativeProjectPluginCommitSelection(
            qualification,
            installation,
          );
          this.#assertCommitActive(authority);
        }
        assertLegacy(access);
        const planResult = beginSqlitePlanResult(
          this.#database,
          runQualification,
        );
        const replay = this.#receipt(identity, access);
        if (replay !== null) {
          if (
            owned !== undefined &&
            replay.project.projectId !== owned.projectId
          )
            throw new Error("plugin_project_mutation_receipt_target_mismatch");
          finishSqlitePlanResult(this.#database, planResult, replay);
          return replay;
        }
        const current = this.#project(
          identity.owner,
          prepared.project.projectId,
          access,
        );
        const isConcept =
          prepared.kind === "create-concept" ||
          prepared.kind === "append-concept";
        const brief = isConcept
          ? this.#brief(
              identity.owner,
              prepared.project.projectId,
              prepared.assetRevision.briefRevision,
              access,
            )
          : null;
        const asset = isConcept
          ? this.#asset(
              identity.owner,
              prepared.project.projectId,
              prepared.asset.assetId,
              access,
            )
          : null;
        const result = verifyCreativeMutation(prepared, {
          project: current,
          brief,
          asset,
        });
        this.#assertCommitActive(authority);
        if (prepared.kind === "create-project")
          this.#insertProject(result.project);
        else
          this.#updateProject(
            result.project,
            prepared.expectedProjectRevision,
            access,
          );
        if (
          result.kind === "create-project" ||
          result.kind === "append-brief"
        ) {
          this.#assertCommitActive(authority);
          this.#insertBrief(result.brief);
        }
        if (
          result.kind === "create-concept" ||
          result.kind === "append-concept"
        ) {
          this.#assertCommitActive(authority);
          if (prepared.kind === "create-concept")
            this.#insertAsset(result.asset);
          else if (prepared.kind === "append-concept")
            this.#updateAsset(
              result.asset,
              prepared.expectedAssetMetadataRevision,
              access,
            );
          this.#assertCommitActive(authority);
          this.#insertRevision(result.assetRevision);
        }
        this.#assertCommitActive(authority);
        this.#saveReceipt(identity, result);
        finishSqlitePlanResult(this.#database, planResult, result);
        return result;
      },
      authority,
      runQualification,
      () => assertLegacy(this.#legacyAccess()),
    );
  }

  #legacyAccess() {
    return captureSqliteCreativeProjectLegacyAccess(this.#database);
  }

  #project(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    access = this.#legacyAccess(),
  ) {
    const row = this.#database
      .prepare(
        `SELECT p.* FROM creative_projects p WHERE ${projectFilter} AND ${access.predicate("p")} AND p.project_id=?`,
      )
      .get(...creativeOwnerValues(owner), projectId);
    return decodeCreativeProject(row, owner, projectId);
  }

  #brief(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    revision: number,
    access = this.#legacyAccess(),
  ) {
    const row = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_project_briefs c ${childJoin} WHERE ${projectFilter} AND ${access.predicate("p")} AND c.project_id=? AND c.brief_revision=?`,
      )
      .get(...creativeOwnerValues(owner), projectId, revision);
    return decodeCreativeBrief(row, owner, projectId);
  }

  #asset(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    assetId: string,
    access = this.#legacyAccess(),
  ) {
    const row = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_concept_assets c ${childJoin} WHERE ${projectFilter} AND ${access.predicate("p")} AND c.project_id=? AND c.asset_id=?`,
      )
      .get(...creativeOwnerValues(owner), projectId, assetId);
    return decodeCreativeAsset(row, owner, projectId);
  }

  #receipt(identity: MutationIdentity, access = this.#legacyAccess()) {
    const row = this.#database
      .prepare(
        `SELECT r.*,p.project_id AS legacy_parent_project_id,p.owner_principal_id AS legacy_parent_principal_id FROM creative_project_mutation_receipts r LEFT JOIN creative_projects p ON p.tenant_id=r.tenant_id AND p.space_id=r.space_id AND p.project_id=r.project_id WHERE r.tenant_id=? AND r.space_id=? AND r.principal_id=? AND r.actor_id=? AND r.kind=? AND r.idempotency_key=? AND ${access.predicate("r")}`,
      )
      .get(
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      );
    if (
      row !== undefined &&
      (row.legacy_parent_project_id !== row.project_id ||
        row.legacy_parent_principal_id !== identity.owner.principalId)
    )
      throw new Error("creative_project_receipt_invalid");
    return decodeCreativeReceipt(row, identity);
  }

  #insertProject(project: CreativeProject): void {
    this.#database
      .prepare(
        "INSERT INTO creative_projects(tenant_id,space_id,project_id,owner_principal_id,revision,state,latest_brief_revision,updated_at,record_json) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        project.tenantId,
        project.spaceId,
        project.projectId,
        project.ownerPrincipalId,
        project.revision,
        project.state,
        project.latestBriefRevision,
        project.updatedAt,
        creativeRecordJson(project),
      );
  }

  #updateProject(
    project: CreativeProject,
    expectedRevision: number,
    access: CreativeProjectLegacyAccess,
  ): void {
    const changed = this.#database
      .prepare(
        `UPDATE creative_projects AS p SET revision=?,state=?,latest_brief_revision=?,updated_at=?,record_json=? WHERE tenant_id=? AND space_id=? AND project_id=? AND owner_principal_id=? AND revision=? AND ${access.predicate("p")}`,
      )
      .run(
        project.revision,
        project.state,
        project.latestBriefRevision,
        project.updatedAt,
        creativeRecordJson(project),
        project.tenantId,
        project.spaceId,
        project.projectId,
        project.ownerPrincipalId,
        expectedRevision,
      );
    if (changed.changes !== 1)
      throw new Error("creative_project_revision_conflict");
  }

  #insertBrief(brief: ProjectBriefRevision): void {
    this.#database
      .prepare(
        "INSERT INTO creative_project_briefs(tenant_id,space_id,project_id,brief_revision,content_digest,record_json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        brief.tenantId,
        brief.spaceId,
        brief.projectId,
        brief.briefRevision,
        brief.contentDigest,
        creativeRecordJson(brief),
      );
  }

  #insertAsset(asset: ConceptAsset): void {
    this.#database
      .prepare(
        "INSERT INTO creative_concept_assets(tenant_id,space_id,project_id,asset_id,revision,latest_asset_revision,record_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        asset.tenantId,
        asset.spaceId,
        asset.projectId,
        asset.assetId,
        asset.revision,
        asset.latestAssetRevision,
        creativeRecordJson(asset),
      );
  }

  #updateAsset(
    asset: ConceptAsset,
    expectedRevision: number,
    access: CreativeProjectLegacyAccess,
  ): void {
    const changed = this.#database
      .prepare(
        `UPDATE creative_concept_assets AS a SET revision=?,latest_asset_revision=?,record_json=? WHERE tenant_id=? AND space_id=? AND project_id=? AND asset_id=? AND revision=? AND ${access.predicate("a")}`,
      )
      .run(
        asset.revision,
        asset.latestAssetRevision,
        creativeRecordJson(asset),
        asset.tenantId,
        asset.spaceId,
        asset.projectId,
        asset.assetId,
        expectedRevision,
      );
    if (changed.changes !== 1)
      throw new Error("creative_project_asset_revision_conflict");
  }

  #insertRevision(revision: ConceptAssetRevision): void {
    this.#database
      .prepare(
        "INSERT INTO creative_concept_revisions(tenant_id,space_id,project_id,asset_id,asset_revision,brief_revision,brief_content_digest,content_digest,record_json) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        revision.tenantId,
        revision.spaceId,
        revision.projectId,
        revision.assetId,
        revision.assetRevision,
        revision.briefRevision,
        revision.briefContentDigest,
        revision.contentDigest,
        creativeRecordJson(revision),
      );
  }

  #saveReceipt(
    identity: MutationIdentity,
    result: CreativeProjectMutationResult,
  ): void {
    this.#database
      .prepare(
        "INSERT INTO creative_project_mutation_receipts(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
        identity.receipt.requestDigest,
        result.project.projectId,
        creativeRecordJson(result),
      );
  }

  #assertCommitActive(
    authority: CreativeProjectCommitAuthority | undefined,
  ): void {
    if (authority !== undefined) {
      assertCreativeProjectCommitActive(authority);
      this.#assertOpen();
    }
  }

  #read<T>(
    read: (access: CreativeProjectLegacyAccess) => T,
    call?: PluginProjectReadCall,
  ): T | Promise<T> {
    if (call !== undefined)
      return readSqliteOwnedCreativeProject(
        this.#database,
        call,
        read,
        this.#assertOpen,
      );
    return readSqliteLegacyCreativeProject(this.#database, (access) => {
      const result = read(access);
      this.#assertOpen();
      return result;
    });
  }

  #transaction<T>(
    body: () => T,
    authority?: CreativeProjectCommitAuthority,
    runQualification?: ProjectRunQualification,
    assertLegacy?: () => void,
  ): T {
    this.#assertCommitActive(authority);
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      assertLegacy?.();
      // Negative schema inspection must finish before the original physical lease.
      assertSqliteProjectRunCommit(this.#database, runQualification);
      this.#assertCommitActive(authority);
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Preserve the original failure if the host closed. */
      }
      throw error;
    }
  }
}

function requiredRecord<T>(value: T | null): T {
  if (value === null) throw new Error("creative_project_record_invalid");
  return value;
}
