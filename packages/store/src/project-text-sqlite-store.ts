import {
  bindProjectTextReadView,
  readSqliteOwnedProjectText,
} from "./plugin-project-text-read-view.ts";
import { captureSqliteTextRunProjectAccess } from "./project-text-run-owned-access.ts";
import type { PluginProjectReadCall } from "./plugin-project-owned-read-sqlite.ts";
import type { PluginProjectReadScope } from "@crewon/application";
import {
  assertSqliteLegacyTextReceipt,
  readSqliteLegacyText,
  textLegacyResultScope,
  textLegacyScope,
} from "./project-text-legacy-access.ts";
import { commitOriginalSqliteProjectMigration } from "./original-project-migration.ts";
import {
  captureSqliteCreativeProjectLegacyAccess,
  type CreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import {
  decodeOutlineSourceRevision,
  assertOutlineSourceInputsCurrent,
} from "./project-outline-source-store-support.ts";
import { SqliteStructuredOutlineStorage } from "./project-structured-outline-sqlite.ts";
import {
  legacyTextRevision as decodeTextRevision,
  legacyTextReceipt as decodeTextReceipt,
  type StructuredTextInput,
} from "./project-structured-outline-store-support.ts";
import { observeSqlitePlanManualSelection } from "./project-text-plan-manual-selection.ts";
import {
  captureSqliteProjectFoundationDownstream,
  assertSqliteProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamSnapshot,
} from "./project-foundation-downstream-guard.ts";
import {
  planSelectionQualification,
  beginSqlitePlanSelection,
  finishSqlitePlanSelection,
} from "./project-text-plan-selection.ts";
import {
  beginSqlitePlanResult,
  finishSqlitePlanResult,
} from "./project-text-plan-tool.ts";
import {
  projectTextUiCommitQualification,
  assertSqliteProjectTextUiCommit,
  type ProjectTextUiQualification,
} from "./project-text-ui-commit-support.ts";
import { assertSqliteProjectRunCommit } from "./creative-project-run-commit-sqlite.ts";
import {
  projectRunCommitQualification,
  type ProjectRunQualification,
} from "./creative-project-run-commit-support.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  type CreativeProjectCommitAuthority,
  type CreativeProjectCommitOptions,
  type CreativeProjectOwnerScope,
  type ProjectStructuredOutlineStore,
  type ProjectTextMutationResult,
} from "@crewon/application";
import { projectTextFailure, type CreativeProjectScope } from "@crewon/domain";
import {
  creativeOwnerValues,
  decodeCreativeBrief,
  decodeCreativeProject,
} from "./creative-project-store-records.ts";
import { migrateSqliteProjectText } from "./project-text-schema.ts";
import {
  artifactColumns,
  artifactValues,
  decodeTextArtifact,
  prepareText,
  prepareTextCandidate,
  revisionColumns,
  revisionValues,
  textAuthority,
  textIdentity,
  textJson,
  textRead,
  textRequired,
  verifyText,
  type TextInput,
  type TextIdentity,
  type TextPrepared,
  type TextRow,
} from "./project-text-store-support.ts";

const filter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=? AND p.project_id=?";
const join =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";

/** Borrows the parent's connection and lifetime. Construction never migrates. */
export class SqliteProjectTextStore implements ProjectStructuredOutlineStore {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  readonly #structured: SqliteStructuredOutlineStorage;
  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
    this.#structured = new SqliteStructuredOutlineStorage(input);
  }
  bindProjectReads(scope: PluginProjectReadScope) {
    return bindProjectTextReadView(this, scope);
  }
  loadStructuredRevision(
    input: StructuredTextInput<"loadStructuredRevision">,
    scope?: PluginProjectReadScope,
  ) {
    return this.#structured.loadRevision(input, scope);
  }
  listStructuredRevisions(
    input: StructuredTextInput<"listStructuredRevisions">,
    scope?: PluginProjectReadScope,
  ) {
    return this.#structured.listRevisions(input, scope);
  }
  loadStructuredMutationReceipt(
    input: StructuredTextInput<"loadStructuredMutationReceipt">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#structured.receipt(input, options);
  }
  commitStructuredOutlineCandidate(
    input: StructuredTextInput<"commitStructuredOutlineCandidate">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#structured.candidate(input, options);
  }
  commitStructuredOutlineSelection(
    input: StructuredTextInput<"commitStructuredOutlineSelection">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#structured.selection(input, options);
  }
  async migrate(): Promise<void> {
    commitOriginalSqliteProjectMigration({
      database: this.#database,
      assertOpen: this.#assertOpen,
      migrate: () => migrateSqliteProjectText(this.#database),
    });
  }
  async loadOutline(
    input: TextInput<"loadOutline">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = textRead("loadOutline", input);
    return this.#read(
      q,
      () =>
        this.#artifact(
          q.owner,
          q.projectId,
          "c.kind='outline' AND c.episode_id=''",
          [],
        ),
      null,
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadOutline", query: q },
    );
  }
  async loadScript(
    input: TextInput<"loadScript">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = textRead("loadScript", input);
    return this.#read(
      q,
      () =>
        this.#artifact(
          q.owner,
          q.projectId,
          "c.kind='script' AND c.episode_id=?",
          [q.episodeId],
        ),
      null,
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadScript", query: q },
    );
  }
  async loadArtifact(
    input: TextInput<"loadArtifact">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = textRead("loadArtifact", input);
    return this.#read(
      q,
      () =>
        this.#artifact(q.owner, q.projectId, "c.artifact_id=?", [q.artifactId]),
      null,
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadArtifact", query: q },
    );
  }
  async loadRevision(
    input: TextInput<"loadRevision">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = textRead("loadRevision", input);
    return this.#read(
      q,
      () =>
        this.#revision(q.owner, q.projectId, q.artifactId, q.contentRevision),
      null,
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadRevision", query: q },
    );
  }
  async loadOutlineSourceRevision(
    input: TextInput<"loadOutlineSourceRevision">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = textRead("loadRevision", input);
    return this.#read(
      q,
      () =>
        this.#outlineSourceRevision(
          q.owner,
          q.projectId,
          q.artifactId,
          q.contentRevision,
        ),
      null,
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "loadOutlineSourceRevision", query: q },
    );
  }
  async listArtifacts(
    input: TextInput<"listArtifacts">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = textRead("listArtifacts", input);
    return this.#read(
      q,
      () => {
        const rows = this.#all(
          `SELECT c.* FROM project_text_artifacts c ${join} WHERE ${filter}${q.afterArtifactId === null ? "" : " AND c.artifact_id COLLATE BINARY > ? COLLATE BINARY"} ORDER BY c.artifact_id COLLATE BINARY ASC LIMIT ?`,
          [
            ...creativeOwnerValues(q.owner),
            q.projectId,
            ...(q.afterArtifactId === null ? [] : [q.afterArtifactId]),
            q.limit + 1,
          ],
        );
        const items = rows.map((row) =>
          textRequired(decodeTextArtifact(row, q.owner, q.projectId)),
        );
        const artifacts = Object.freeze(items.slice(0, q.limit));
        return Object.freeze({
          artifacts,
          nextArtifactId:
            items.length > q.limit ? artifacts.at(-1)!.artifactId : null,
        });
      },
      { artifacts: [], nextArtifactId: null },
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "listArtifacts", query: q },
    );
  }
  async listRevisions(
    input: TextInput<"listRevisions">,
    readScope?: PluginProjectReadScope,
  ) {
    const q = textRead("listRevisions", input);
    return this.#read(
      q,
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
            decodeTextRevision(row, q.owner, q.projectId, q.artifactId),
          ),
        );
        const revisions = Object.freeze(items.slice(0, q.limit));
        return Object.freeze({
          revisions,
          nextContentRevision:
            items.length > q.limit ? revisions.at(-1)!.contentRevision : null,
        });
      },
      { revisions: [], nextContentRevision: null },
      readScope === undefined
        ? undefined
        : { scope: readScope, method: "listRevisions", query: q },
    );
  }
  async loadMutationReceipt(
    input: TextInput<"loadMutationReceipt">,
    options?: CreativeProjectCommitOptions,
  ) {
    const identity = textIdentity(input);
    const authority = textAuthority(options);
    const q = projectRunCommitQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
    );
    const textUi = projectTextUiCommitQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
    );

    const planSelection = planSelectionQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
    );
    await assertCreativeProjectCommitCurrent(authority);
    if (authority?.runTransaction !== undefined)
      await authority.runTransaction.assertCurrent();
    if (authority?.textUiTransaction !== undefined)
      await authority.textUiTransaction.assertCurrent();
    if (authority?.planTransaction !== undefined) {
      await authority.planTransaction.assertCurrent();
      await authority.planTransaction.authority.assertTransactionCurrent();
      authority.planTransaction.authority.assertActive();
    }
    return this.#transaction(
      (access) => {
        assertSqliteProjectRunCommit(this.#database, q);
        assertSqliteProjectTextUiCommit(this.#database, textUi);
        const intent = beginSqliteTextIntentCommit(
          this.#database,
          textUi,
          identity,
        );
        const planResult = beginSqlitePlanResult(this.#database, q);
        const selectionCheckpoint = beginSqlitePlanSelection(
          this.#database,
          planSelection,
        );
        const result = this.#receipt(identity, access, "read");
        if (result !== null) {
          finishSqlitePlanResult(this.#database, planResult, result);
          finishSqlitePlanSelection(
            this.#database,
            selectionCheckpoint,
            result,
          );
          if (
            planSelection === undefined &&
            identity.kind === "select-revision"
          )
            observeSqlitePlanManualSelection(
              this.#database,
              identity.actor,
              identity.receipt,
              result,
              textUi,
            );
        }
        if (result !== null)
          finishSqliteTextIntentCommit(this.#database, intent);
        return result;
      },
      authority,
      q,
      textUi,
    );
  }
  async commitCandidate(
    input: TextInput<"commitCandidate">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit(prepareTextCandidate(input), textAuthority(options));
  }
  async commitSelection(
    input: TextInput<"commitSelection">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit(
      prepareText("select-revision", input),
      textAuthority(options),
    );
  }
  async commitLock(
    input: TextInput<"commitLock">,
    options?: CreativeProjectCommitOptions,
  ) {
    return this.#commit(prepareText("set-lock", input), textAuthority(options));
  }
  async #commit(
    prepared: TextPrepared,
    authority: CreativeProjectCommitAuthority | undefined,
  ): Promise<ProjectTextMutationResult> {
    const runQualification = projectRunCommitQualification(
      authority,
      prepared.actor,
      prepared.kind,
      prepared.receipt,
    );
    const textUi = projectTextUiCommitQualification(
      authority,
      prepared.actor,
      prepared.kind,
      prepared.receipt,
      prepared,
    );

    const planSelection = planSelectionQualification(
      authority,
      prepared.actor,
      prepared.kind,
      prepared.receipt,
    ); // Never retain SQLite's writer lock across an asynchronous external authority check.
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    if (authority?.runTransaction !== undefined)
      await authority.runTransaction.assertCurrent();
    if (authority?.textUiTransaction !== undefined)
      await authority.textUiTransaction.assertCurrent();
    if (authority?.planTransaction !== undefined) {
      await authority.planTransaction.assertCurrent();
      await authority.planTransaction.authority.assertTransactionCurrent();
      authority.planTransaction.authority.assertActive();
    }
    let downstream: ProjectFoundationDownstreamSnapshot | undefined;
    const downstreamLocator = {
      actor: prepared.actor,
      projectId: prepared.project.projectId,
    };
    return this.#transaction(
      (access) => {
        assertSqliteProjectRunCommit(this.#database, runQualification);
        assertSqliteProjectTextUiCommit(this.#database, textUi);
        const identity = textIdentity({
          actor: prepared.actor,
          kind: prepared.kind,
          receipt: prepared.receipt,
        });
        const intent = beginSqliteTextIntentCommit(
          this.#database,
          textUi,
          identity,
        );
        const planResult = beginSqlitePlanResult(
          this.#database,
          runQualification,
        );
        const selectionCheckpoint = beginSqlitePlanSelection(
          this.#database,
          planSelection,
        );
        const replay = this.#receipt(identity, access, "mutation");
        if (replay !== null) {
          finishSqlitePlanResult(this.#database, planResult, replay);
          finishSqlitePlanSelection(
            this.#database,
            selectionCheckpoint,
            replay,
          );
          if (
            planSelection === undefined &&
            identity.kind === "select-revision"
          )
            observeSqlitePlanManualSelection(
              this.#database,
              identity.actor,
              identity.receipt,
              replay,
              textUi,
            );
          finishSqliteTextIntentCommit(this.#database, intent);
          return replay;
        }
        const owner = identity.owner,
          id = prepared.project.projectId;
        const project = this.#project(owner, id);
        const candidate =
          prepared.kind === "save-outline" || prepared.kind === "save-script";
        const artifact = candidate
          ? this.#artifact(owner, id, "c.kind=? AND c.episode_id=?", [
              prepared.artifact.kind,
              prepared.artifact.episodeId ?? "",
            ])
          : this.#artifact(owner, id, "c.artifact_id=?", [
              prepared.artifact.artifactId,
            ]);
        // Legacy callers cannot replace or adopt an outline after a v2 candidate exists.
        if (artifact?.kind === "outline" && prepared.kind !== "set-lock")
          this.#revision(
            owner,
            id,
            artifact.artifactId,
            artifact.latestContentRevision,
          );
        const saved =
          "contentRevision" in prepared ? prepared.contentRevision : null;
        const brief =
          candidate && saved !== null
            ? this.#brief(owner, id, saved.brief.briefRevision)
            : null;
        const outline =
          candidate && saved?.outline
            ? this.#outlineSourceRevision(
                owner,
                id,
                saved.outline.artifactId,
                saved.outline.contentRevision,
              )
            : null;
        const revision =
          prepared.kind === "select-revision"
            ? this.#revision(
                owner,
                id,
                prepared.artifact.artifactId,
                prepared.contentRevision.contentRevision,
              )
            : null;
        const latestBrief =
          prepared.kind === "select-revision" && project !== null
            ? this.#brief(owner, id, project.latestBriefRevision)
            : null;
        const outlineHead =
          prepared.kind === "select-revision"
            ? this.#artifact(
                owner,
                id,
                "c.kind='outline' AND c.episode_id=''",
                [],
              )
            : null;
        const selectedOutline = outlineHead?.selectedContentRevision
          ? this.#outlineSourceRevision(
              owner,
              id,
              outlineHead.artifactId,
              outlineHead.selectedContentRevision,
            )
          : null;
        const result = verifyText(prepared, {
          project,
          artifact,
          brief,
          outline,
          revision,
          latestBrief,
          selectedOutline,
        });
        const structuredSource =
          prepared.kind === "save-script"
            ? outline
            : prepared.kind === "select-revision" &&
                prepared.artifact.kind === "script"
              ? selectedOutline
              : null;
        if (
          candidate ||
          structuredSource?.schemaVersion === "crewon.project-text-revision.v2"
        ) {
          downstream = captureSqliteProjectFoundationDownstream(
            this.#database,
            downstreamLocator,
            { projectAccess: access },
          );
          assertOutlineSourceInputsCurrent(structuredSource, downstream);
        }
        this.#active(authority);
        const a = result.artifact;
        if (prepared.expectedArtifactRevision === 0)
          this.#run(
            `INSERT INTO project_text_artifacts(${artifactColumns}) VALUES(${Array(12).fill("?").join(",")})`,
            artifactValues(a),
          );
        else {
          const changed = this.#run(
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
          );
          if (changed.changes !== 1)
            projectTextFailure("project_text_revision_conflict");
        }
        if (candidate) {
          this.#active(authority);
          this.#run(
            `INSERT INTO project_text_revisions(${revisionColumns}) VALUES(${Array(14).fill("?").join(",")})`,
            revisionValues(textRequired(result.contentRevision)),
          );
        }
        this.#active(authority);
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
        finishSqliteTextIntentCommit(this.#database, intent);
        finishSqlitePlanResult(this.#database, planResult, result);
        finishSqlitePlanSelection(this.#database, selectionCheckpoint, result);
        if (planSelection === undefined && identity.kind === "select-revision")
          observeSqlitePlanManualSelection(
            this.#database,
            identity.actor,
            identity.receipt,
            result,
            textUi,
          );
        return result;
      },
      authority,
      runQualification,
      textUi,
      (access) => {
        if (downstream !== undefined)
          assertSqliteProjectFoundationDownstreamUnchanged(
            this.#database,
            downstreamLocator,
            downstream,
            { projectAccess: access },
          );
      },
      textLegacyScope(prepared.project, prepared.project.projectId),
    );
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
  #artifact(
    owner: CreativeProjectOwnerScope,
    id: string,
    condition: string,
    values: SQLInputValue[],
  ) {
    return decodeTextArtifact(
      this.#get(
        `SELECT c.* FROM project_text_artifacts c ${join} WHERE ${filter} AND ${condition}`,
        [...creativeOwnerValues(owner), id, ...values],
      ),
      owner,
      id,
    );
  }
  #revision(
    owner: CreativeProjectOwnerScope,
    id: string,
    artifactId: string,
    revision: number,
  ) {
    return decodeTextRevision(
      this.#get(
        `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${join} WHERE ${filter} AND c.artifact_id=? AND c.content_revision=?`,
        [...creativeOwnerValues(owner), id, artifactId, revision],
      ),
      owner,
      id,
      artifactId,
    );
  }
  #outlineSourceRevision(
    owner: CreativeProjectOwnerScope,
    id: string,
    artifactId: string,
    revision: number,
  ) {
    return decodeOutlineSourceRevision(
      this.#get(
        `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${join} WHERE ${filter} AND c.artifact_id=? AND c.content_revision=?`,
        [...creativeOwnerValues(owner), id, artifactId, revision],
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
    const result = decodeTextReceipt(row, identity);
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
  #all(sql: string, values: SQLInputValue[]): Record<string, unknown>[] {
    this.#assertOpen();
    return this.#database.prepare(sql).all(...values);
  }
  #run(sql: string, values: SQLInputValue[]) {
    this.#assertOpen();
    return this.#database.prepare(sql).run(...values);
  }
  #active(authority: CreativeProjectCommitAuthority | undefined) {
    assertCreativeProjectCommitActive(authority);
    this.#assertOpen();
  }
  #read<T>(
    q: Readonly<{ owner: CreativeProjectOwnerScope; projectId: string }>,
    read: () => T,
    absent: T,
    call?: PluginProjectReadCall,
  ): T | Promise<T> {
    this.#assertOpen();
    if (call !== undefined)
      return readSqliteOwnedProjectText(
        { database: this.#database, assertOpen: this.#assertOpen },
        call,
        read,
      );
    return readSqliteLegacyText(
      this.#database,
      textLegacyScope(q.owner, q.projectId),
      read,
      absent,
    );
  }
  #transaction<T extends ProjectTextMutationResult | null | void>(
    body: (access: CreativeProjectLegacyAccess) => T,
    authority?: CreativeProjectCommitAuthority,
    runQualification?: ProjectRunQualification,
    textUi?: ProjectTextUiQualification,
    checkDownstream?: (access: CreativeProjectLegacyAccess) => void,
    scope?: CreativeProjectScope,
  ): T {
    this.#active(authority);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const access =
        captureSqliteTextRunProjectAccess(this.#database, authority) ??
        captureSqliteCreativeProjectLegacyAccess(this.#database);
      if (scope !== undefined) access.assertProject(scope);
      const result = body(access);
      const current =
        captureSqliteTextRunProjectAccess(this.#database, authority) ??
        captureSqliteCreativeProjectLegacyAccess(this.#database);
      if (scope !== undefined) current.assertProject(scope);
      const resultScope = textLegacyResultScope(result);
      if (resultScope !== undefined) current.assertProject(resultScope);
      checkDownstream?.(current);
      // The original physical lease and UI qualification follow every new SQL fence.
      assertSqliteProjectRunCommit(this.#database, runQualification);
      assertSqliteProjectTextUiCommit(this.#database, textUi);
      authority?.planTransaction?.authority.assertActive();
      this.#active(authority);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    }
  }
}
import {
  beginSqliteTextIntentCommit,
  finishSqliteTextIntentCommit,
} from "./project-text-ui-intent-commit.ts";
