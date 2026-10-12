import { readSqliteProjectText } from "./plugin-project-text-read-view.ts";
import type { PluginProjectReadScope } from "@crewon/application";
import {
  beginSqlitePlanResult,
  finishSqlitePlanResult,
} from "./project-text-plan-tool.ts";
import {
  planSelectionQualification,
  beginSqlitePlanSelection,
  finishSqlitePlanSelection,
} from "./project-text-plan-selection.ts";
import { observeSqlitePlanManualSelection } from "./project-text-plan-manual-selection.ts";
import {
  projectOutlineRunCommitQualification,
  assertProjectOutlineRunPrepared,
  assertSqliteProjectOutlineRunCommit,
} from "./project-outline-run-qualification.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
  type CreativeProjectCommitOptions,
  type CreativeProjectOwnerScope,
  type StoredProjectTextMutationResult,
} from "@crewon/application";
import { projectTextFailure } from "@crewon/domain";
import {
  creativeOwnerValues,
  decodeCreativeProject,
  decodeCreativeBrief,
} from "./creative-project-store-records.ts";
import {
  artifactColumns,
  artifactValues,
  revisionColumns,
  decodeTextArtifact,
  textIdentity,
  textRead,
  textJson,
  textRequired,
  type TextIdentity,
  type TextRow,
} from "./project-text-store-support.ts";
import {
  decodeStoredTextReceipt,
  decodeStoredTextRevision,
  prepareStructuredText,
  structuredRevisionValues,
  structuredTextAuthority,
  verifyStructuredText,
  type StructuredTextInput,
  type StructuredTextPrepared,
} from "./project-structured-outline-store-support.ts";
import {
  captureSqliteProjectFoundationDownstream,
  assertSqliteProjectFoundationDownstreamUnchanged,
} from "./project-foundation-downstream-guard.ts";
import { verifySqliteProjectOutlineSourceEvidence } from "./project-outline-source-evidence.ts";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  captureSqliteCreativeProjectLegacyAccess,
  type CreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import {
  assertSqliteLegacyTextReceipt,
  readSqliteLegacyText,
  textLegacyScope,
} from "./project-text-legacy-access.ts";
import {
  projectOutlineUiCommitQualification,
  assertProjectOutlineUiPrepared,
} from "./project-outline-ui-commit-support.ts";

const filter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=? AND p.project_id=?";
const join =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";
/** Borrows the original parent's connection. No migration, separate head, Run, model or supplier. */
export class SqliteStructuredOutlineStorage {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
  }
  async loadRevision(
    input: StructuredTextInput<"loadStructuredRevision">,
    scope?: PluginProjectReadScope,
  ) {
    const q = textRead("loadRevision", input);
    this.#assertOpen();
    return readSqliteProjectText(
      { database: this.#database, assertOpen: this.#assertOpen },
      q,
      "loadStructuredRevision",
      () =>
        this.#revision(q.owner, q.projectId, q.artifactId, q.contentRevision),
      null,
      scope,
    );
  }
  async listRevisions(
    input: StructuredTextInput<"listStructuredRevisions">,
    scope?: PluginProjectReadScope,
  ) {
    const q = textRead("listRevisions", input);
    this.#assertOpen();
    return readSqliteProjectText(
      { database: this.#database, assertOpen: this.#assertOpen },
      q,
      "listStructuredRevisions",
      () => {
        const rows = this.#all(
          `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${join} WHERE ${filter} AND c.artifact_id=? AND c.content_revision>? ORDER BY c.content_revision ASC LIMIT ?`,
          [
            ...creativeOwnerValues(q.owner),
            q.projectId,
            q.artifactId,
            q.afterContentRevision,
            q.limit + 1,
          ],
        );
        const items = rows.map((row) =>
          textRequired(
            decodeStoredTextRevision(row, q.owner, q.projectId, q.artifactId),
          ),
        );
        const revisions = Object.freeze(items.slice(0, q.limit));
        return Object.freeze({
          revisions,
          nextContentRevision:
            items.length > q.limit ? revisions.at(-1)!.contentRevision : null,
        });
      },
      Object.freeze({
        revisions: Object.freeze([]),
        nextContentRevision: null,
      }),
      scope,
    );
  }
  async receipt(
    input: StructuredTextInput<"loadStructuredMutationReceipt">,
    options?: CreativeProjectCommitOptions,
  ) {
    const identity = textIdentity(input);
    const authority = structuredTextAuthority(options);
    const q = projectOutlineUiCommitQualification(
      authority,
      identity.actor,
      identity.kind as "save-outline" | "select-revision",
      identity.receipt,
    );
    const rq = projectOutlineRunCommitQualification(
      authority,
      identity.actor,
      identity.kind as "save-outline" | "select-revision",
      identity.receipt,
    );
    await assertCreativeProjectCommitCurrent(authority);
    if (authority?.outlineRunTransaction || authority?.planTransaction)
      await assertCreativeProjectCommitTransactionCurrent(authority);
    this.#active(authority);
    const pq = planSelectionQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
      "structured-outline",
    );
    return readSqliteLegacyCreativeProject(this.#database, (access) => {
      assertSqliteProjectTextUiCommit(this.#database, q);
      assertSqliteProjectOutlineRunCommit(
        this.#database,
        rq,
        "receipt-publication",
      );
      beginSqlitePlanResult(this.#database, rq);
      beginSqlitePlanSelection(this.#database, pq);
      const result = this.#receipt(identity, access, "read");
      const current = captureSqliteCreativeProjectLegacyAccess(this.#database);
      if (result !== null)
        current.assertProject(
          textLegacyScope(result.artifact, result.artifact.projectId),
        );
      assertSqliteProjectTextUiCommit(this.#database, q);
      assertSqliteProjectOutlineRunCommit(
        this.#database,
        rq,
        "receipt-publication",
      );
      this.#active(authority);
      return result;
    });
  }
  async candidate(
    input: StructuredTextInput<"commitStructuredOutlineCandidate">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit(prepareStructuredText("save-outline", input), options);
  }
  async selection(
    input: StructuredTextInput<"commitStructuredOutlineSelection">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit(
      prepareStructuredText("select-revision", input),
      options,
    );
  }
  async #commit(
    prepared: StructuredTextPrepared,
    options?: CreativeProjectCommitOptions,
  ): Promise<StoredProjectTextMutationResult> {
    const authority = structuredTextAuthority(options);
    const q = projectOutlineUiCommitQualification(
      authority,
      prepared.actor,
      prepared.kind,
      prepared.receipt,
    );
    const rq = projectOutlineRunCommitQualification(
      authority,
      prepared.actor,
      prepared.kind,
      prepared.receipt,
    );
    const planSelection = planSelectionQualification(
      authority,
      prepared.actor,
      prepared.kind,
      prepared.receipt,
      "structured-outline",
    );
    const qualifiedCommand = q?.command ?? rq?.command;
    await assertCreativeProjectCommitCurrent(authority);
    if (authority?.outlineRunTransaction || authority?.planTransaction)
      await assertCreativeProjectCommitTransactionCurrent(authority);
    this.#active(authority);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const access = captureSqliteCreativeProjectLegacyAccess(this.#database);
      const scope = textLegacyScope(
        prepared.project,
        prepared.project.projectId,
      );
      access.assertProject(scope);
      assertSqliteProjectTextUiCommit(this.#database, q);
      assertSqliteProjectOutlineRunCommit(
        this.#database,
        rq,
        "receipt-publication",
      );
      const identity = textIdentity({
        actor: prepared.actor,
        receipt: prepared.receipt,
        kind: prepared.kind,
      });
      const planResult = beginSqlitePlanResult(this.#database, rq);
      const selectionCheckpoint = beginSqlitePlanSelection(
        this.#database,
        planSelection,
      );
      const replay = this.#receipt(identity, access, "mutation");
      if (replay !== null) {
        finishSqlitePlanResult(this.#database, planResult, replay);
        finishSqlitePlanSelection(this.#database, selectionCheckpoint, replay);
        const current = captureSqliteCreativeProjectLegacyAccess(
          this.#database,
        );
        current.assertProject(scope);
        current.assertProject(
          textLegacyScope(replay.artifact, replay.artifact.projectId),
        );
        assertSqliteProjectTextUiCommit(this.#database, q);
        assertSqliteProjectOutlineRunCommit(
          this.#database,
          rq,
          "receipt-publication",
        );
        this.#active(authority);
        this.#database.exec("COMMIT");
        return replay;
      }
      const owner = identity.owner,
        id = prepared.project.projectId;
      const project = this.#project(owner, id);
      const artifact = decodeTextArtifact(
        this.#get(
          `SELECT c.* FROM project_text_artifacts c ${join} WHERE ${filter} AND c.kind='outline' AND c.episode_id=''`,
          [...creativeOwnerValues(owner), id],
        ),
        owner,
        id,
      );
      const foundation = captureSqliteProjectFoundationDownstream(
        this.#database,
        { actor: prepared.actor, projectId: id },
      );
      const base =
        qualifiedCommand &&
        "base" in qualifiedCommand &&
        qualifiedCommand.base !== null
          ? this.#revision(
              owner,
              id,
              prepared.artifact.artifactId,
              qualifiedCommand.base.contentRevision,
            )
          : null;
      assertProjectOutlineUiPrepared(q, prepared, base);
      assertProjectOutlineRunPrepared(rq, prepared, base);
      assertSqliteProjectOutlineRunCommit(this.#database, rq);
      const candidate = prepared.kind === "save-outline";
      const revision = candidate
        ? null
        : this.#revision(
            owner,
            id,
            prepared.artifact.artifactId,
            prepared.contentRevision.contentRevision,
          );
      const result = verifyStructuredText(prepared, {
        project,
        artifact,
        foundation,
        revision,
        brief: candidate
          ? this.#brief(owner, id, prepared.contentRevision.brief.briefRevision)
          : null,
        latestBrief:
          !candidate && project !== null
            ? this.#brief(owner, id, project.latestBriefRevision)
            : null,
      });
      if (!candidate)
        verifySqliteProjectOutlineSourceEvidence(
          this.#database,
          prepared.contentRevision,
          textRequired(
            foundation?.source ?? null,
            "project_foundation_source_not_found",
          ),
          owner.principalId,
        );
      this.#active(authority);
      const a = result.artifact;
      if (prepared.expectedArtifactRevision === 0)
        this.#run(
          `INSERT INTO project_text_artifacts(${artifactColumns}) VALUES(${Array(12).fill("?").join(",")})`,
          artifactValues(a),
        );
      else if (
        this.#run(
          "UPDATE project_text_artifacts SET revision=?,latest_content_revision=?,selected_content_revision=?,locked=?,record_json=? WHERE tenant_id=? AND space_id=? AND project_id=? AND artifact_id=? AND owner_principal_id=? AND revision=?",
          [
            a.revision,
            a.latestContentRevision,
            a.selectedContentRevision,
            a.locked ? 1 : 0,
            textJson(a),
            a.tenantId,
            a.spaceId,
            a.projectId,
            a.artifactId,
            a.ownerPrincipalId,
            prepared.expectedArtifactRevision,
          ],
        ).changes !== 1
      )
        projectTextFailure("project_text_revision_conflict");
      if (candidate)
        this.#run(
          `INSERT INTO project_text_revisions(${revisionColumns}) VALUES(${Array(14).fill("?").join(",")})`,
          structuredRevisionValues(textRequired(result.contentRevision)),
        );
      this.#run(
        "INSERT INTO project_text_mutation_receipts(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json) VALUES(?,?,?,?,?,?,?,?,?)",
        [
          ...creativeOwnerValues(owner),
          identity.actor.actorId,
          identity.kind,
          identity.receipt.idempotencyKey,
          identity.receipt.requestDigest,
          id,
          textJson(result),
        ],
      );
      finishSqlitePlanResult(this.#database, planResult, result);
      finishSqlitePlanSelection(this.#database, selectionCheckpoint, result);
      if (planSelection === undefined)
        observeSqlitePlanManualSelection(
          this.#database,
          prepared.actor,
          prepared.receipt,
          result,
        );
      this.#active(authority);
      assertSqliteProjectFoundationDownstreamUnchanged(
        this.#database,
        { actor: prepared.actor, projectId: id },
        foundation,
      );
      const current = captureSqliteCreativeProjectLegacyAccess(this.#database);
      current.assertProject(scope);
      current.assertProject(
        textLegacyScope(result.artifact, result.artifact.projectId),
      );
      assertSqliteProjectTextUiCommit(this.#database, q);
      assertSqliteProjectOutlineRunCommit(this.#database, rq);
      this.#active(authority);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
  }
  #project(owner: CreativeProjectOwnerScope, id: string) {
    return decodeCreativeProject(
      this.#get(`SELECT p.* FROM creative_projects p WHERE ${filter}`, [
        ...creativeOwnerValues(owner),
        id,
      ]),
      owner,
      id,
    );
  }
  #brief(owner: CreativeProjectOwnerScope, id: string, revision: number) {
    return decodeCreativeBrief(
      this.#get(
        `SELECT c.*,p.owner_principal_id FROM creative_project_briefs c ${join} WHERE ${filter} AND c.brief_revision=?`,
        [...creativeOwnerValues(owner), id, revision],
      ),
      owner,
      id,
    );
  }
  #revision(
    owner: CreativeProjectOwnerScope,
    id: string,
    artifactId: string,
    contentRevision: number,
  ) {
    return decodeStoredTextRevision(
      this.#get(
        `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${join} WHERE ${filter} AND c.artifact_id=? AND c.content_revision=?`,
        [...creativeOwnerValues(owner), id, artifactId, contentRevision],
      ),
      owner,
      id,
      artifactId,
    );
  }
  #receipt(
    identity: TextIdentity,
    access: CreativeProjectLegacyAccess,
    mode: "read" | "mutation",
  ) {
    const row = this.#get(
      "SELECT * FROM project_text_mutation_receipts WHERE tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND kind=? AND idempotency_key=?",
      [
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      ],
    );
    if (!assertSqliteLegacyTextReceipt(access, identity.owner, row, mode))
      return null;
    const result = decodeStoredTextReceipt(row, identity);
    if (
      result !== null &&
      this.#project(identity.owner, result.artifact.projectId) === null
    )
      projectTextFailure("creative_project_not_found");
    return result;
  }
  #get(sql: string, values: SQLInputValue[]): TextRow {
    this.#assertOpen();
    return this.#database.prepare(sql).get(...values);
  }
  #all(sql: string, values: SQLInputValue[]) {
    this.#assertOpen();
    return this.#database.prepare(sql).all(...values);
  }
  #run(sql: string, values: SQLInputValue[]) {
    this.#assertOpen();
    return this.#database.prepare(sql).run(...values);
  }
  #active(authority: ReturnType<typeof structuredTextAuthority>) {
    assertCreativeProjectCommitActive(authority);
    this.#assertOpen();
  }
}
