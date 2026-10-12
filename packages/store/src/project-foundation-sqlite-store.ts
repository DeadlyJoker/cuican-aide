import {
  bindProjectFoundationReadView,
  readSqliteOwnedProjectFoundation,
} from "./plugin-project-foundation-read-view.ts";
import {
  assertSqliteSavedSourceUploadProjectAccess,
  assertSqliteSavedSourceUploadLegacyAccess,
  foundationResultSavedSource,
} from "./project-source-upload-legacy-access.ts";
import { commitOriginalSqliteProjectMigration } from "./original-project-migration.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  captureSqliteCreativeProjectLegacyAccess,
  type CreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import { insertSqliteFoundationSource } from "./project-foundation-sqlite-source-writer.ts";
import { migrateSqliteProjectFoundationRuns } from "./project-foundation-run-schema.ts";
import {
  qualifyFoundationRunMutation,
  assertSqliteFoundationRunCommit,
  isFoundationReplay,
} from "./project-foundation-run-qualification.ts";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitCurrent,
  assertProjectFoundationCommitTransactionCurrent,
  captureProjectFoundationCommitAuthority,
  qualifyProjectFoundationPluginCommit,
  type CreativeProjectOwnerScope,
  type ProjectFoundationCommitAuthority,
  type ProjectFoundationCommitOptions,
  type ProjectFoundationMutationResult,
  type ProjectFoundationStore,
  type PluginProjectReadScope,
} from "@crewon/application";
import {
  creativeProjectDigest,
  creativeProjectRevision,
  parseProjectSource,
  parseProjectSourceChunk,
  parseProjectSourceChapter,
  assertProjectSourceChapterIdentity,
  assertProjectProposalFoundation,
  projectSourceScalarLength,
  readProjectSourcePage,
  validateProjectFoundation,
  type CreativeProject,
  type ProjectBriefRevision,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
  type ProjectSourceChunk,
} from "@crewon/domain";
import {
  creativeOwnerValues,
  decodeCreativeProject,
} from "./creative-project-store-records.ts";
import {
  assertSqliteProjectFoundationSchema,
  migrateSqliteProjectFoundations,
} from "./project-foundation-schema.ts";
import {
  decodeFoundationReceipt,
  foundationDigest,
  foundationEqual,
  foundationFailure,
  foundationIdentity,
  foundationJson,
  foundationKind,
  foundationLimit,
  foundationProposal,
  foundationRead,
  prepareFoundation,
  verifyFoundation,
  type FoundationIdentity,
  type FoundationPrepared,
} from "./project-foundation-store-support.ts";
import {
  admitSqlitePluginInstallationPin,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import {
  prepareFoundationSourceAdoption,
  type FoundationSourceAdmission,
} from "./project-foundation-source-adoption.ts";
import {
  admitSqliteFoundationSourceAdoption,
  associateSqliteFoundationSource,
} from "./project-foundation-sqlite-source-adoption.ts";

type Input<M extends keyof ProjectFoundationStore> = Parameters<
  NonNullable<ProjectFoundationStore[M]>
>[0];
type Row = Record<string, unknown>;
type Qualification = ReturnType<typeof qualifyProjectFoundationPluginCommit>;
const join =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";
const filter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=? AND p.project_id=?";

/** Borrows the original host connection. Construction and legacy reads do no DDL. */
export class SqliteProjectFoundationStore implements ProjectFoundationStore {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  readonly #sourceAdmission: FoundationSourceAdmission | undefined;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    sourceAdmission?: FoundationSourceAdmission;
  }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
    this.#sourceAdmission = input.sourceAdmission;
  }
  async migrate(): Promise<void> {
    commitOriginalSqliteProjectMigration({
      database: this.#database,
      assertOpen: this.#assertOpen,
      migrate: () => {
        migrateSqliteProjectFoundations(this.#database);
        migrateSqliteProjectFoundationRuns(this.#database);
      },
    });
  }
  bindProjectReads(scope: PluginProjectReadScope) {
    return bindProjectFoundationReadView(this, scope);
  }
  async loadFoundation(
    input: Input<"loadFoundation">,
    scope?: PluginProjectReadScope,
  ) {
    this.#assertOpen();
    const q = foundationRead(input);
    const read = (access: CreativeProjectLegacyAccess) => {
      access.assertProject(foundationLegacyScope(q.owner, q.projectId));
      if (!assertSqliteProjectFoundationSchema(this.#database)) return null;
      return this.#foundation(q.owner, q.projectId, access);
    };
    return scope === undefined
      ? readSqliteLegacyCreativeProject(this.#database, read)
      : readSqliteOwnedProjectFoundation(
          { database: this.#database, assertOpen: this.#assertOpen },
          { scope, method: "loadFoundation", query: q },
          read,
        );
  }

  async loadSource(input: Input<"loadSource">, scope?: PluginProjectReadScope) {
    this.#assertOpen();
    const q = foundationRead(input, ["revision"]);
    const revision = creativeProjectRevision(q.revision);
    const read = (access: CreativeProjectLegacyAccess) => {
      access.assertProject(foundationLegacyScope(q.owner, q.projectId));
      if (!assertSqliteProjectFoundationSchema(this.#database)) return null;
      return this.#source(q.owner, q.projectId, revision, access);
    };
    return scope === undefined
      ? readSqliteLegacyCreativeProject(this.#database, read)
      : readSqliteOwnedProjectFoundation(
          { database: this.#database, assertOpen: this.#assertOpen },
          { scope, method: "loadSource", query: q },
          read,
        );
  }
  async readSourcePage(
    input: Input<"readSourcePage">,
    scope?: PluginProjectReadScope,
  ) {
    this.#assertOpen();
    const q = foundationRead(input, [
      "revision",
      "digest",
      "startOffset",
      "limit",
    ]);
    const revision = creativeProjectRevision(q.revision);
    const digest = creativeProjectDigest(q.digest);
    const startOffset = creativeProjectRevision(q.startOffset, { minimum: 0 });
    const limit = foundationLimit(q.limit, 1_024);
    const read = (access: CreativeProjectLegacyAccess) => {
      access.assertProject(foundationLegacyScope(q.owner, q.projectId));
      if (!assertSqliteProjectFoundationSchema(this.#database))
        foundationFailure("project_foundation_source_not_found");
      const source = this.#source(q.owner, q.projectId, revision, access);
      if (source === null)
        foundationFailure("project_foundation_source_not_found");
      if (source.digest !== digest)
        foundationFailure("project_foundation_source_digest_mismatch");
      const end = Math.min(source.characterLength, startOffset + limit);
      const rows = this.#database
        .prepare(
          `
      SELECT c.* FROM project_source_chunks c ${join} WHERE ${filter} AND ${access.predicate("p")}
      AND c.source_revision=? AND c.start_offset<? AND c.start_offset+c.character_length>?
      ORDER BY c.start_offset ASC LIMIT 1025
    `,
        )
        .all(
          ...creativeOwnerValues(q.owner),
          q.projectId,
          revision,
          end,
          startOffset,
        );
      const chunks = rows.map((row) => this.#chunk(row));
      return readProjectSourcePage({ source, chunks, startOffset, limit });
    };
    return scope === undefined
      ? readSqliteLegacyCreativeProject(this.#database, read)
      : readSqliteOwnedProjectFoundation(
          { database: this.#database, assertOpen: this.#assertOpen },
          { scope, method: "readSourcePage", query: q },
          read,
        );
  }
  async listSourceChapters(
    input: Input<"listSourceChapters">,
    scope?: PluginProjectReadScope,
  ) {
    this.#assertOpen();
    const q = foundationRead(input, [
      "revision",
      "digest",
      "afterStartOffset",
      "limit",
    ]);
    const revision = creativeProjectRevision(q.revision);
    const digest = creativeProjectDigest(q.digest);
    const after =
      q.afterStartOffset === null
        ? -1
        : creativeProjectRevision(q.afterStartOffset, { minimum: 0 });
    const limit = foundationLimit(q.limit);
    const read = (access: CreativeProjectLegacyAccess) => {
      access.assertProject(foundationLegacyScope(q.owner, q.projectId));
      if (!assertSqliteProjectFoundationSchema(this.#database))
        foundationFailure("project_foundation_source_not_found");
      const source = this.#source(q.owner, q.projectId, revision, access);
      if (source === null)
        foundationFailure("project_foundation_source_not_found");
      if (source.digest !== digest)
        foundationFailure("project_foundation_source_digest_mismatch");
      const rows = this.#database
        .prepare(
          `SELECT c.* FROM project_source_chapters c ${join} WHERE ${filter} AND ${access.predicate("p")} AND c.source_revision=? AND c.start_offset>? ORDER BY c.start_offset ASC LIMIT ?`,
        )
        .all(
          ...creativeOwnerValues(q.owner),
          q.projectId,
          revision,
          after,
          limit + 1,
        );
      const chapters = Object.freeze(
        rows.slice(0, limit).map((row) => {
          const chapter = parseProjectSourceChapter(
            JSON.parse(String(row.record_json)),
          );
          assertProjectSourceChapterIdentity(source, chapter);
          foundationEqual(
            [chapter.startOffset, chapter.endOffset, chapter.chapterId],
            [row.start_offset, row.end_offset, row.chapter_id],
          );
          return chapter;
        }),
      );
      return Object.freeze({
        chapters,
        nextStartOffset:
          rows.length > limit ? chapters.at(-1)!.startOffset : null,
      });
    };
    return scope === undefined
      ? readSqliteLegacyCreativeProject(this.#database, read)
      : readSqliteOwnedProjectFoundation(
          { database: this.#database, assertOpen: this.#assertOpen },
          { scope, method: "listSourceChapters", query: q },
          read,
        );
  }
  async loadProposal(input: Input<"loadProposal">) {
    this.#assertOpen();
    const q = foundationRead(input, ["revision"]);
    const revision = creativeProjectRevision(q.revision);
    return readSqliteLegacyCreativeProject(this.#database, (access) => {
      access.assertProject(foundationLegacyScope(q.owner, q.projectId));
      if (!assertSqliteProjectFoundationSchema(this.#database)) return null;
      return this.#proposal(q.owner, q.projectId, revision, access);
    });
  }
  async listProposals(input: Input<"listProposals">) {
    this.#assertOpen();
    const q = foundationRead(input, ["afterRevision", "limit"]);
    const after = creativeProjectRevision(q.afterRevision, { minimum: 0 });
    const limit = foundationLimit(q.limit);
    return readSqliteLegacyCreativeProject(this.#database, (access) => {
      access.assertProject(foundationLegacyScope(q.owner, q.projectId));
      if (!assertSqliteProjectFoundationSchema(this.#database))
        return Object.freeze({
          proposals: Object.freeze([]),
          nextRevision: null,
        });
      const rows = this.#database
        .prepare(
          `SELECT c.* FROM project_proposals c ${join} WHERE ${filter} AND ${access.predicate("p")} AND c.proposal_revision>? ORDER BY c.proposal_revision ASC LIMIT ?`,
        )
        .all(...creativeOwnerValues(q.owner), q.projectId, after, limit + 1);
      const proposals = Object.freeze(
        rows
          .slice(0, limit)
          .map((row) => this.#proposalRow(row, q.owner.principalId)),
      );
      return Object.freeze({
        proposals,
        nextRevision: rows.length > limit ? proposals.at(-1)!.revision : null,
      });
    });
  }
  async loadMutationReceipt(
    input: Input<"loadMutationReceipt">,
    options?: ProjectFoundationCommitOptions,
  ) {
    this.#assertOpen();
    const identity = foundationIdentity(input);
    const authority = captureProjectFoundationCommitAuthority(options);
    qualifyFoundationRunMutation(authority, identity);
    const qualification = qualifyProjectFoundationPluginCommit(
      authority,
      identity.actor,
      identity.kind,
    );
    await this.#externalCurrent(authority, qualification);
    return this.#transaction(
      (access) =>
        assertSqliteProjectFoundationSchema(this.#database)
          ? this.#receipt(identity, access)
          : null,
      authority,
      qualification,
    );
  }
  async commitCreation(
    input: Input<"commitCreation">,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#commit(
      prepareFoundation("create-project", input),
      captureProjectFoundationCommitAuthority(options),
    );
  }
  async commitProposal(
    input: Input<"commitProposal">,
    options?: ProjectFoundationCommitOptions,
  ) {
    return this.#commit(
      prepareFoundation("save-proposal", input),
      captureProjectFoundationCommitAuthority(options),
    );
  }
  async commitFoundationChange(
    input: Input<"commitFoundationChange">,
    options?: ProjectFoundationCommitOptions,
  ) {
    const kind = foundationKind(
      Object.getOwnPropertyDescriptor(input, "kind")?.value,
    );
    if (kind === "create-project" || kind === "save-proposal")
      foundationFailure("project_foundation_mutation_kind_invalid");
    return this.#commit(
      prepareFoundation(kind, input),
      captureProjectFoundationCommitAuthority(options),
    );
  }

  async #externalCurrent(
    authority: ProjectFoundationCommitAuthority | undefined,
    qualification: Qualification,
  ) {
    await assertProjectFoundationCommitCurrent(authority);
    if (qualification !== undefined || authority?.runTransaction !== undefined)
      await assertProjectFoundationCommitTransactionCurrent(authority);
  }
  async #commit(
    prepared: FoundationPrepared,
    authority: ProjectFoundationCommitAuthority | undefined,
  ): Promise<ProjectFoundationMutationResult> {
    const sourceAdoption = prepareFoundationSourceAdoption(
      prepared,
      this.#sourceAdmission,
    );
    const identity = foundationIdentity({
      actor: prepared.actor,
      kind: prepared.kind,
      receipt: prepared.receipt,
    });
    qualifyFoundationRunMutation(authority, identity, prepared);
    const qualification = qualifyProjectFoundationPluginCommit(
      authority,
      prepared.actor,
      prepared.kind,
    );
    await this.#externalCurrent(authority, qualification);
    this.#assertOpen();
    return this.#transaction(
      (access) => {
        access.assertProject(
          foundationLegacyScope(identity.owner, prepared.foundation.projectId),
        );
        if (!assertSqliteProjectFoundationSchema(this.#database))
          foundationFailure("project_foundation_schema_unconfigured");
        const replay = this.#receipt(identity, access);
        if (replay !== null) return replay;
        assertSqliteFoundationRunCommit(
          this.#database,
          authority?.runTransaction,
        );
        const projectId = prepared.foundation.projectId;
        const project = this.#project(identity.owner, projectId, access);
        // Creation cannot hide a conflicting identity belonging to a different owner.
        if (
          prepared.kind === "create-project" &&
          this.#database
            .prepare(
              "SELECT 1 FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=?",
            )
            .get(identity.owner.tenantId, identity.owner.spaceId, projectId) !==
            undefined
        )
          foundationFailure("project_foundation_project_conflict");
        const foundation = this.#foundation(identity.owner, projectId, access);
        const latestProposalRow = this.#database
          .prepare(
            `SELECT c.* FROM project_proposals c ${join} WHERE ${filter} AND ${access.predicate("p")} ORDER BY c.proposal_revision DESC LIMIT 1`,
          )
          .get(...creativeOwnerValues(identity.owner), projectId);
        const latestProposal =
          latestProposalRow === undefined
            ? null
            : this.#proposalRow(latestProposalRow, identity.owner.principalId);
        const confirmedProposal =
          prepared.kind === "confirm-proposal" && prepared.proposal !== null
            ? this.#proposal(
                identity.owner,
                projectId,
                prepared.proposal.revision,
                access,
              )
            : null;
        const latestSourceRevision = Number(
          this.#database
            .prepare(
              `SELECT COALESCE(MAX(c.source_revision),0) AS revision FROM project_sources c ${join} WHERE ${filter} AND ${access.predicate("p")}`,
            )
            .get(...creativeOwnerValues(identity.owner), projectId)?.revision,
        );
        const result = verifyFoundation(prepared, {
          project,
          foundation,
          latestProposal,
          confirmedProposal,
          latestSourceRevision,
        });
        if (sourceAdoption !== null)
          admitSqliteFoundationSourceAdoption(this.#database, sourceAdoption);
        assertProjectFoundationCommitActive(authority);
        if (prepared.kind === "create-project") {
          this.#insertProject(result.project);
          this.#insertBrief(result.brief!);
          this.#insertFoundation(result.foundation);
        } else if (prepared.kind !== "save-proposal") {
          this.#updateFoundation(
            result.foundation,
            prepared.expectedFoundationRevision,
          );
        }
        if (
          prepared.kind === "create-project" ||
          prepared.kind === "append-source"
        ) {
          if (prepared.source !== null)
            insertSqliteFoundationSource(
              this.#database,
              prepared.source,
              prepared.chunks,
              prepared.chapters,
            );
        }
        if (prepared.kind === "save-proposal")
          this.#insertProposal(result.proposal!);
        if (sourceAdoption !== null)
          associateSqliteFoundationSource(this.#database, sourceAdoption);
        this.#saveReceipt(identity, result);
        return result;
      },
      authority,
      qualification,
    );
  }
  #project(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    access: CreativeProjectLegacyAccess,
  ): CreativeProject | null {
    const row = this.#database
      .prepare(
        `SELECT p.* FROM creative_projects p WHERE ${filter} AND ${access.predicate("p")}`,
      )
      .get(...creativeOwnerValues(owner), projectId);
    return decodeCreativeProject(row, owner, projectId);
  }
  #foundation(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    access: CreativeProjectLegacyAccess,
  ): ProjectFoundation | null {
    const row = this.#database
      .prepare(
        `SELECT c.* FROM project_foundations c ${join} WHERE ${filter} AND ${access.predicate("p")}`,
      )
      .get(...creativeOwnerValues(owner), projectId);
    if (row === undefined) return null;
    const foundation = validateProjectFoundation(
      JSON.parse(String(row.record_json)),
    );
    foundationEqual(
      [
        foundation.tenantId,
        foundation.spaceId,
        foundation.projectId,
        foundation.ownerPrincipalId,
        foundation.origin,
        foundation.revision,
        foundation.parametersRevision,
      ],
      [
        row.tenant_id,
        row.space_id,
        row.project_id,
        row.owner_principal_id,
        row.origin,
        row.revision,
        row.parameters_revision,
      ],
    );
    if (foundation.source !== null) {
      const source = this.#source(
        owner,
        projectId,
        foundation.source.revision,
        access,
      );
      if (source === null || source.digest !== foundation.source.digest)
        foundationFailure("project_foundation_source_not_found");
    }
    if (foundation.confirmedProposal !== null) {
      const proposal = this.#proposal(
        owner,
        projectId,
        foundation.confirmedProposal.revision,
        access,
      );
      if (
        proposal === null ||
        proposal.contentDigest !== foundation.confirmedProposal.digest
      )
        foundationFailure("project_foundation_confirmed_proposal_mismatch");
      assertProjectProposalFoundation(foundation, proposal, {
        confirmed: true,
      });
    }
    return foundation;
  }
  #source(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    revision: number,
    access: CreativeProjectLegacyAccess,
  ): ProjectSource | null {
    const row = this.#database
      .prepare(
        `SELECT c.* FROM project_sources c ${join} WHERE ${filter} AND ${access.predicate("p")} AND c.source_revision=?`,
      )
      .get(...creativeOwnerValues(owner), projectId, revision);
    if (row === undefined) return null;
    assertSqliteSavedSourceUploadProjectAccess(
      this.#database,
      {
        owner,
        projectId,
        sourceRevision: revision,
      },
      access,
    );
    const source = parseProjectSource(JSON.parse(String(row.record_json)));
    foundationEqual(
      [
        source.tenantId,
        source.spaceId,
        source.projectId,
        source.revision,
        source.digest,
        source.fileDigest,
        source.characterLength,
      ],
      [
        row.tenant_id,
        row.space_id,
        row.project_id,
        row.source_revision,
        row.content_digest,
        row.file_digest,
        row.character_length,
      ],
    );
    return source;
  }
  #chunk(row: Row): ProjectSourceChunk {
    const chunk = parseProjectSourceChunk({
      tenantId: row.tenant_id,
      spaceId: row.space_id,
      projectId: row.project_id,
      sourceRevision: row.source_revision,
      index: row.chunk_index,
      startOffset: row.start_offset,
      content: row.content,
      digest: row.content_digest,
    });
    if (
      projectSourceScalarLength(chunk.content) !== row.character_length ||
      foundationDigest(chunk.content) !== chunk.digest
    )
      foundationFailure("project_foundation_source_chunk_mismatch");
    return chunk;
  }
  #proposal(
    owner: CreativeProjectOwnerScope,
    projectId: string,
    revision: number,
    access: CreativeProjectLegacyAccess,
  ): ProjectProposal | null {
    const row = this.#database
      .prepare(
        `SELECT c.* FROM project_proposals c ${join} WHERE ${filter} AND ${access.predicate("p")} AND c.proposal_revision=?`,
      )
      .get(...creativeOwnerValues(owner), projectId, revision);
    return row === undefined ? null : this.#proposalRow(row, owner.principalId);
  }
  #proposalRow(row: Row, principalId: string): ProjectProposal {
    const proposal = foundationProposal(JSON.parse(String(row.record_json)));
    if (proposal.ownerPrincipalId !== principalId)
      foundationFailure("project_foundation_owner_mismatch");
    foundationEqual(
      [
        proposal.tenantId,
        proposal.spaceId,
        proposal.projectId,
        proposal.revision,
        proposal.contentDigest,
      ],
      [
        row.tenant_id,
        row.space_id,
        row.project_id,
        row.proposal_revision,
        row.content_digest,
      ],
    );
    return proposal;
  }
  #receipt(
    identity: FoundationIdentity,
    access: CreativeProjectLegacyAccess,
  ): ProjectFoundationMutationResult | null {
    const row = this.#database
      .prepare(
        "SELECT * FROM project_foundation_mutation_receipts WHERE tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND kind=? AND idempotency_key=?",
      )
      .get(
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      );
    if (row === undefined) return null;
    access.assertProject(
      foundationLegacyScope(identity.owner, String(row.project_id)),
    );
    if (row.request_digest !== identity.receipt.requestDigest)
      foundationFailure("project_foundation_idempotency_conflict");
    const result = decodeFoundationReceipt(
      JSON.parse(String(row.result_json)),
      identity,
    );
    if (result.project.projectId !== row.project_id)
      foundationFailure("project_foundation_receipt_invalid");
    const savedSource = foundationResultSavedSource(result);
    if (savedSource !== null)
      assertSqliteSavedSourceUploadLegacyAccess(this.#database, savedSource);
    return result;
  }
  #insertProject(project: CreativeProject) {
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
        foundationJson(project, 8_192),
      );
  }
  #insertBrief(brief: ProjectBriefRevision) {
    this.#database
      .prepare("INSERT INTO creative_project_briefs VALUES(?,?,?,?,?,?)")
      .run(
        brief.tenantId,
        brief.spaceId,
        brief.projectId,
        brief.briefRevision,
        brief.contentDigest,
        foundationJson(brief, 32_768),
      );
  }
  #insertFoundation(foundation: ProjectFoundation) {
    this.#database
      .prepare("INSERT INTO project_foundations VALUES(?,?,?,?,?,?,?,?)")
      .run(
        foundation.tenantId,
        foundation.spaceId,
        foundation.projectId,
        foundation.ownerPrincipalId,
        foundation.origin,
        foundation.revision,
        foundation.parametersRevision,
        foundationJson(foundation, 32_768),
      );
  }
  #updateFoundation(foundation: ProjectFoundation, expected: number) {
    const changed = this.#database
      .prepare(
        "UPDATE project_foundations SET revision=?,parameters_revision=?,record_json=? WHERE tenant_id=? AND space_id=? AND project_id=? AND owner_principal_id=? AND revision=?",
      )
      .run(
        foundation.revision,
        foundation.parametersRevision,
        foundationJson(foundation, 32_768),
        foundation.tenantId,
        foundation.spaceId,
        foundation.projectId,
        foundation.ownerPrincipalId,
        expected,
      );
    if (changed.changes !== 1)
      foundationFailure("project_foundation_revision_conflict");
  }
  #insertProposal(proposal: ProjectProposal) {
    this.#database
      .prepare("INSERT INTO project_proposals VALUES(?,?,?,?,?,?)")
      .run(
        proposal.tenantId,
        proposal.spaceId,
        proposal.projectId,
        proposal.revision,
        proposal.contentDigest,
        foundationJson(proposal, 32_768),
      );
  }
  #saveReceipt(
    identity: FoundationIdentity,
    result: ProjectFoundationMutationResult,
  ) {
    this.#database
      .prepare(
        "INSERT INTO project_foundation_mutation_receipts VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
        identity.receipt.requestDigest,
        result.project.projectId,
        foundationJson(result),
      );
  }
  #transaction<T extends ProjectFoundationMutationResult | null | void>(
    work: (access: CreativeProjectLegacyAccess) => T,
    authority?: ProjectFoundationCommitAuthority,
    qualification?: Qualification,
  ): T {
    this.#assertOpen();
    assertProjectFoundationCommitActive(authority);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const access = captureSqliteCreativeProjectLegacyAccess(this.#database);
      if (qualification !== undefined) {
        assertSqlitePluginInstallationPinSchema(this.#database);
        const installation = admitSqlitePluginInstallationPin(
          this.#database,
          qualification.pin,
        );
        foundationEqual(installation.selection, qualification.selection);
        foundationEqual(installation.package, qualification.package);
      }
      assertProjectFoundationCommitActive(authority);
      assertSqliteFoundationRunCommit(
        this.#database,
        authority?.runTransaction,
        "receipt-publication",
      );
      const result = work(access);
      if (result != null) {
        access.assertProject(
          foundationLegacyScope(result.project, result.project.projectId),
        );
        const savedSource = foundationResultSavedSource(result);
        if (savedSource !== null)
          assertSqliteSavedSourceUploadLegacyAccess(
            this.#database,
            savedSource,
          );
      }
      assertProjectFoundationCommitActive(authority);
      assertSqliteFoundationRunCommit(
        this.#database,
        authority?.runTransaction,
        isFoundationReplay(result) ? "receipt-publication" : "fresh-proposal",
      );
      assertProjectFoundationCommitActive(authority);
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
