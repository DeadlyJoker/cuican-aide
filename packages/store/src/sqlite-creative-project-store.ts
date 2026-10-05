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
} from "@crewon/application";
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

  async loadProject(input: Input<"loadProject">) {
    this.#assertOpen();
    const query = creativeReadInput("loadProject", input);
    return this.#project(query.owner, query.projectId);
  }

  async listProjects(input: Input<"listProjects">) {
    this.#assertOpen();
    const query = creativeReadInput("listProjects", input);
    const conditions = [projectFilter];
    const values: (string | number)[] = [...creativeOwnerValues(query.owner)];
    if (query.state !== "all") {
      conditions.push("p.state=?");
      values.push(query.state);
    }
    if (query.after !== null) {
      conditions.push(
        "(p.updated_at<? OR (p.updated_at=? AND p.project_id COLLATE BINARY < ? COLLATE BINARY))",
      );
      values.push(
        query.after.updatedAt,
        query.after.updatedAt,
        query.after.projectId,
      );
    }
    const rows = this.#database
      .prepare(
        `SELECT p.* FROM creative_projects p WHERE ${conditions.join(" AND ")} ORDER BY p.updated_at DESC,p.project_id COLLATE BINARY DESC LIMIT ?`,
      )
      .all(...values, query.limit + 1);
    const projects = rows.map((row) => {
      const project = decodeCreativeProject(row, query.owner);
      if (project === null) throw new Error("creative_project_record_invalid");
      return project;
    });
    const page = Object.freeze(projects.slice(0, query.limit));
    const last = page.at(-1);
    return Object.freeze({
      projects: page,
      next:
        projects.length > query.limit && last !== undefined
          ? Object.freeze({
              updatedAt: last.updatedAt,
              projectId: last.projectId,
            })
          : null,
    });
  }

  async loadBrief(input: Input<"loadBrief">) {
    this.#assertOpen();
    const query = creativeReadInput("loadBrief", input);
    return this.#brief(query.owner, query.projectId, query.briefRevision);
  }

  async listBriefs(input: Input<"listBriefs">) {
    this.#assertOpen();
    const query = creativeReadInput("listBriefs", input);
    const rows = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_project_briefs c ${childJoin} WHERE ${projectFilter} AND c.project_id=? AND c.brief_revision>? ORDER BY c.brief_revision ASC LIMIT ?`,
      )
      .all(
        ...creativeOwnerValues(query.owner),
        query.projectId,
        query.afterBriefRevision,
        query.limit,
      );
    return Object.freeze(
      rows.map((row) =>
        requiredRecord(decodeCreativeBrief(row, query.owner, query.projectId)),
      ),
    );
  }

  async loadConceptAsset(input: Input<"loadConceptAsset">) {
    this.#assertOpen();
    const query = creativeReadInput("loadConceptAsset", input);
    return this.#asset(query.owner, query.projectId, query.assetId);
  }

  async listConceptAssets(input: Input<"listConceptAssets">) {
    this.#assertOpen();
    const query = creativeReadInput("listConceptAssets", input);
    const after =
      query.afterAssetId === null
        ? ""
        : " AND c.asset_id COLLATE BINARY > ? COLLATE BINARY";
    const values: (string | number)[] = [
      ...creativeOwnerValues(query.owner),
      query.projectId,
    ];
    if (query.afterAssetId !== null) values.push(query.afterAssetId);
    const rows = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_concept_assets c ${childJoin} WHERE ${projectFilter} AND c.project_id=?${after} ORDER BY c.asset_id COLLATE BINARY ASC LIMIT ?`,
      )
      .all(...values, query.limit);
    return Object.freeze(
      rows.map((row) =>
        requiredRecord(decodeCreativeAsset(row, query.owner, query.projectId)),
      ),
    );
  }

  async loadConceptRevision(input: Input<"loadConceptRevision">) {
    this.#assertOpen();
    const query = creativeReadInput("loadConceptRevision", input);
    const row = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_concept_revisions c ${childJoin} WHERE ${projectFilter} AND c.project_id=? AND c.asset_id=? AND c.asset_revision=?`,
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
  }

  async listConceptRevisions(input: Input<"listConceptRevisions">) {
    this.#assertOpen();
    const query = creativeReadInput("listConceptRevisions", input);
    const rows = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_concept_revisions c ${childJoin} WHERE ${projectFilter} AND c.project_id=? AND c.asset_id=? AND c.asset_revision>? ORDER BY c.asset_revision ASC LIMIT ?`,
      )
      .all(
        ...creativeOwnerValues(query.owner),
        query.projectId,
        query.assetId,
        query.afterAssetRevision,
        query.limit,
      );
    return Object.freeze(
      rows.map((row) =>
        requiredRecord(
          decodeCreativeRevision(
            row,
            query.owner,
            query.projectId,
            query.assetId,
          ),
        ),
      ),
    );
  }

  async loadMutationReceipt(
    input: Input<"loadMutationReceipt">,
    options?: CreativeProjectCommitOptions,
  ) {
    this.#assertOpen();
    const identity = creativeMutationIdentity(input);
    const authority = captureCreativeProjectCommitAuthority(options);
    const q = projectRunCommitQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
    );
    if (q === undefined) return this.#receipt(identity);
    await assertCreativeProjectCommitCurrent(authority);
    await assertCreativeProjectCommitTransactionCurrent(authority);
    return this.#transaction(
      () => {
        assertSqliteProjectRunCommit(this.#database, q);
        return this.#receipt(identity);
      },
      authority,
      q,
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
    const authority = captureCreativeProjectCommitAuthority(options);
    const kind = creativeMutationKind(creativeStoreRecord(input).kind);
    if (kind !== "rename-project" && kind !== "set-project-state")
      creativeStoreFailure("creative_project_mutation_kind_invalid");
    const result = await this.#commit(
      prepareCreativeMutation(kind, input),
      authority,
    );
    if (result.kind !== "rename-project" && result.kind !== "set-project-state")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async commitProjectBrief(
    input: Input<"commitProjectBrief">,
    options?: CreativeProjectCommitOptions,
  ): Promise<Result<"commitProjectBrief">> {
    const authority = captureCreativeProjectCommitAuthority(options);
    const result = await this.#commit(
      prepareCreativeMutation("append-brief", input),
      authority,
    );
    if (result.kind !== "append-brief")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async commitConceptRevision(
    input: Input<"commitConceptRevision">,
    options?: CreativeProjectCommitOptions,
  ): Promise<Result<"commitConceptRevision">> {
    const authority = captureCreativeProjectCommitAuthority(options);
    const kind = creativeMutationKind(creativeStoreRecord(input).kind);
    if (kind !== "create-concept" && kind !== "append-concept")
      creativeStoreFailure("creative_project_mutation_kind_invalid");
    const result = await this.#commit(
      prepareCreativeMutation(kind, input),
      authority,
    );
    if (result.kind !== "create-concept" && result.kind !== "append-concept")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async #commit(
    prepared: PreparedCreativeMutation,
    authority: CreativeProjectCommitAuthority | undefined,
  ): Promise<CreativeProjectMutationResult> {
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
        const identity = creativeMutationIdentity({
          actor: prepared.actor,
          receipt: prepared.receipt,
          kind: prepared.kind,
        });
        const replay = this.#receipt(identity);
        if (replay !== null) return replay;
        const current = this.#project(
          identity.owner,
          prepared.project.projectId,
        );
        const isConcept =
          prepared.kind === "create-concept" ||
          prepared.kind === "append-concept";
        const brief = isConcept
          ? this.#brief(
              identity.owner,
              prepared.project.projectId,
              prepared.assetRevision.briefRevision,
            )
          : null;
        const asset = isConcept
          ? this.#asset(
              identity.owner,
              prepared.project.projectId,
              prepared.asset.assetId,
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
          this.#updateProject(result.project, prepared.expectedProjectRevision);
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
            );
          this.#assertCommitActive(authority);
          this.#insertRevision(result.assetRevision);
        }
        this.#assertCommitActive(authority);
        this.#saveReceipt(identity, result);
        return result;
      },
      authority,
      runQualification,
    );
  }

  #project(owner: CreativeProjectOwnerScope, projectId: string) {
    const row = this.#database
      .prepare(
        `SELECT p.* FROM creative_projects p WHERE ${projectFilter} AND p.project_id=?`,
      )
      .get(...creativeOwnerValues(owner), projectId);
    return decodeCreativeProject(row, owner, projectId);
  }

  #brief(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    revision: number,
  ) {
    const row = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_project_briefs c ${childJoin} WHERE ${projectFilter} AND c.project_id=? AND c.brief_revision=?`,
      )
      .get(...creativeOwnerValues(owner), projectId, revision);
    return decodeCreativeBrief(row, owner, projectId);
  }

  #asset(owner: CreativeProjectOwnerScope, projectId: string, assetId: string) {
    const row = this.#database
      .prepare(
        `SELECT c.*,p.owner_principal_id FROM creative_concept_assets c ${childJoin} WHERE ${projectFilter} AND c.project_id=? AND c.asset_id=?`,
      )
      .get(...creativeOwnerValues(owner), projectId, assetId);
    return decodeCreativeAsset(row, owner, projectId);
  }

  #receipt(identity: MutationIdentity) {
    const row = this.#database
      .prepare(
        "SELECT * FROM creative_project_mutation_receipts WHERE tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND kind=? AND idempotency_key=?",
      )
      .get(
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      );
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

  #updateProject(project: CreativeProject, expectedRevision: number): void {
    const changed = this.#database
      .prepare(
        "UPDATE creative_projects SET revision=?,state=?,latest_brief_revision=?,updated_at=?,record_json=? WHERE tenant_id=? AND space_id=? AND project_id=? AND owner_principal_id=? AND revision=?",
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

  #updateAsset(asset: ConceptAsset, expectedRevision: number): void {
    const changed = this.#database
      .prepare(
        "UPDATE creative_concept_assets SET revision=?,latest_asset_revision=?,record_json=? WHERE tenant_id=? AND space_id=? AND project_id=? AND asset_id=? AND revision=?",
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

  #transaction<T>(
    body: () => T,
    authority?: CreativeProjectCommitAuthority,
    runQualification?: ProjectRunQualification,
  ): T {
    this.#assertCommitActive(authority);
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
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
