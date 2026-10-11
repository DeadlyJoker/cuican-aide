import {
  beginPostgresPlanResult,
  finishPostgresPlanResult,
} from "./project-text-plan-tool.ts";
import {
  planSelectionQualification,
  beginPostgresPlanSelection,
  finishPostgresPlanSelection,
} from "./project-text-plan-selection.ts";
import { observePostgresPlanManualSelection } from "./project-text-plan-manual-selection.ts";
import {
  projectOutlineRunCommitQualification,
  assertProjectOutlineRunPrepared,
  assertPostgresProjectOutlineRunCommit,
} from "./project-outline-run-qualification.ts";
import type { Pool, PoolClient } from "pg";
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
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
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
  capturePostgresProjectFoundationDownstream,
  assertPostgresProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamSnapshot,
} from "./project-foundation-downstream-guard.ts";
import { verifyPostgresProjectOutlineSourceEvidence } from "./project-outline-source-evidence.ts";
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import {
  assertPostgresLegacyTextReceipt,
  readPostgresLegacyText,
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
/** Borrows the original pool/lifetime and commits using one physical connection. */
export class PostgresStructuredOutlineStorage {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${creativeProjectSchemaName(input.schema)}.`;
    this.#assertOpen = input.assertOpen;
  }
  async loadRevision(input: StructuredTextInput<"loadStructuredRevision">) {
    const q = textRead("loadRevision", input);
    return readPostgresLegacyText(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#assertOpen },
      textLegacyScope(q.owner, q.projectId),
      (client) =>
        this.#revision(
          client,
          q.owner,
          q.projectId,
          q.artifactId,
          q.contentRevision,
        ),
      null,
    );
  }
  async listRevisions(input: StructuredTextInput<"listStructuredRevisions">) {
    const q = textRead("listRevisions", input);
    return readPostgresLegacyText(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#assertOpen },
      textLegacyScope(q.owner, q.projectId),
      async (client) => {
        const rows = (
          await this.#query(
            client,
            `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${join} WHERE ${filter} AND c.artifact_id=? AND c.content_revision>? ORDER BY c.content_revision ASC LIMIT ?`,
            [
              ...creativeOwnerValues(q.owner),
              q.projectId,
              q.artifactId,
              q.afterContentRevision,
              q.limit + 1,
            ],
          )
        ).rows;
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
    const client = await this.#pool.connect();
    let result: StoredProjectTextMutationResult | null = null;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await lockPostgresCreativeProjectLegacySchema(client, this.#schema);
      const access = await capturePostgresCreativeProjectLegacyAccess(
        client,
        this.#schema,
      );
      await assertPostgresProjectTextUiCommit(client, this.#schema, q);
      await assertPostgresProjectOutlineRunCommit(
        client,
        this.#schema,
        rq,
        "receipt-publication",
      );
      await beginPostgresPlanResult(client, this.#schema, rq);
      const pq = planSelectionQualification(
        authority,
        identity.actor,
        identity.kind,
        identity.receipt,
        "structured-outline",
      );
      await beginPostgresPlanSelection(client, this.#schema, pq);
      result = await this.#receipt(client, identity, access, "read");
      const current = await capturePostgresCreativeProjectLegacyAccess(
        client,
        this.#schema,
      );
      if (result !== null)
        await current.assertProject(
          textLegacyScope(result.artifact, result.artifact.projectId),
        );
      if (authority?.outlineUiTransaction)
        await authority.outlineUiTransaction.assertCurrent();
      else if (authority?.outlineRunTransaction || authority?.planTransaction)
        await assertCreativeProjectCommitTransactionCurrent(authority);
      await assertPostgresProjectTextUiCommit(client, this.#schema, q);
      await assertPostgresProjectOutlineRunCommit(
        client,
        this.#schema,
        rq,
        "receipt-publication",
      );
      this.#active(authority);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    } finally {
      client.release();
    }
    // Complete UI/ordinary fences can borrow this same pool; run them after release.
    if (!rq && !authority?.planTransaction) {
      await assertCreativeProjectCommitCurrent(authority);
      this.#active(authority);
    }
    return result;
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
    const client = await this.#pool.connect();
    let foundation: ProjectFoundationDownstreamSnapshot | undefined;
    const locator = {
      actor: prepared.actor,
      projectId: prepared.project.projectId,
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await lockPostgresCreativeProjectLegacySchema(client, this.#schema);
      const access = await capturePostgresCreativeProjectLegacyAccess(
        client,
        this.#schema,
      );
      const scope = textLegacyScope(
        prepared.project,
        prepared.project.projectId,
      );
      await access.assertProject(scope);
      await assertPostgresProjectTextUiCommit(client, this.#schema, q);
      await assertPostgresProjectOutlineRunCommit(
        client,
        this.#schema,
        rq,
        "receipt-publication",
      );
      const identity = textIdentity({
        actor: prepared.actor,
        receipt: prepared.receipt,
        kind: prepared.kind,
      });
      const owner = identity.owner,
        id = prepared.project.projectId;
      await this.#lock(client, [
        "project-text-receipt",
        this.#schema,
        ...creativeOwnerValues(owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      ]);
      const planResult = await beginPostgresPlanResult(
        client,
        this.#schema,
        rq,
      );
      const selectionCheckpoint = await beginPostgresPlanSelection(
        client,
        this.#schema,
        planSelection,
      );
      const replay = await this.#receipt(client, identity, access, "mutation");
      let result: StoredProjectTextMutationResult;
      if (replay !== null) result = replay;
      else {
        await this.#lock(client, [
          "creative-project-project",
          this.#schema,
          prepared.project.tenantId,
          prepared.project.spaceId,
          id,
        ]);
        const project = await this.#project(client, owner, id);
        const artifact = decodeTextArtifact(
          (
            await this.#query(
              client,
              `SELECT c.* FROM project_text_artifacts c ${join} WHERE ${filter} AND c.kind='outline' AND c.episode_id=''`,
              [...creativeOwnerValues(owner), id],
            )
          ).rows[0],
          owner,
          id,
        );
        foundation = await capturePostgresProjectFoundationDownstream(
          client,
          this.#schema,
          locator,
        );
        const base =
          qualifiedCommand &&
          "base" in qualifiedCommand &&
          qualifiedCommand.base !== null
            ? await this.#revision(
                client,
                owner,
                id,
                prepared.artifact.artifactId,
                qualifiedCommand.base.contentRevision,
              )
            : null;
        assertProjectOutlineUiPrepared(q, prepared, base);
        assertProjectOutlineRunPrepared(rq, prepared, base);
        await assertPostgresProjectOutlineRunCommit(client, this.#schema, rq);
        const candidate = prepared.kind === "save-outline";
        const revision = candidate
          ? null
          : await this.#revision(
              client,
              owner,
              id,
              prepared.artifact.artifactId,
              prepared.contentRevision.contentRevision,
            );
        result = verifyStructuredText(prepared, {
          project,
          artifact,
          foundation,
          revision,
          brief: candidate
            ? await this.#brief(
                client,
                owner,
                id,
                prepared.contentRevision.brief.briefRevision,
              )
            : null,
          latestBrief:
            !candidate && project !== null
              ? await this.#brief(
                  client,
                  owner,
                  id,
                  project.latestBriefRevision,
                )
              : null,
        });
        if (!candidate)
          await verifyPostgresProjectOutlineSourceEvidence(
            client,
            this.#schema,
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
          await this.#query(
            client,
            `INSERT INTO project_text_artifacts(${artifactColumns}) VALUES(${Array(12).fill("?").join(",")})`,
            artifactValues(a),
          );
        else if (
          (
            await this.#query(
              client,
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
            )
          ).rowCount !== 1
        )
          projectTextFailure("project_text_revision_conflict");
        if (candidate)
          await this.#query(
            client,
            `INSERT INTO project_text_revisions(${revisionColumns}) VALUES(${Array(14).fill("?").join(",")})`,
            structuredRevisionValues(textRequired(result.contentRevision)),
          );
        await this.#query(
          client,
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
      }
      await finishPostgresPlanResult(client, this.#schema, planResult, result);
      await finishPostgresPlanSelection(
        client,
        this.#schema,
        selectionCheckpoint,
        result,
      );
      if (planSelection === undefined)
        await observePostgresPlanManualSelection(
          client,
          this.#schema,
          prepared.actor,
          prepared.receipt,
          result,
        );
      if (foundation !== undefined)
        await assertPostgresProjectFoundationDownstreamUnchanged(
          client,
          this.#schema,
          locator,
          foundation,
        );
      const current = await capturePostgresCreativeProjectLegacyAccess(
        client,
        this.#schema,
      );
      await current.assertProject(scope);
      await current.assertProject(
        textLegacyScope(result.artifact, result.artifact.projectId),
      );
      // All new SQL precedes the original policy and physical qualification fence.
      await assertCreativeProjectCommitCurrent(authority);
      if (authority?.outlineRunTransaction || authority?.planTransaction)
        await assertCreativeProjectCommitTransactionCurrent(authority);
      await assertPostgresProjectTextUiCommit(client, this.#schema, q);
      await assertPostgresProjectOutlineRunCommit(
        client,
        this.#schema,
        rq,
        result.disposition === "replayed"
          ? "receipt-publication"
          : "fresh-candidate",
      );
      this.#active(authority);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async #project(
    client: Pool | PoolClient,
    owner: CreativeProjectOwnerScope,
    id: string,
  ) {
    return decodeCreativeProject(
      (
        await this.#query(
          client,
          `SELECT p.* FROM creative_projects p WHERE ${filter}`,
          [...creativeOwnerValues(owner), id],
        )
      ).rows[0],
      owner,
      id,
    );
  }
  async #brief(
    client: Pool | PoolClient,
    owner: CreativeProjectOwnerScope,
    id: string,
    revision: number,
  ) {
    return decodeCreativeBrief(
      (
        await this.#query(
          client,
          `SELECT c.*,p.owner_principal_id FROM creative_project_briefs c ${join} WHERE ${filter} AND c.brief_revision=?`,
          [...creativeOwnerValues(owner), id, revision],
        )
      ).rows[0],
      owner,
      id,
    );
  }
  async #revision(
    client: Pool | PoolClient,
    owner: CreativeProjectOwnerScope,
    id: string,
    artifactId: string,
    contentRevision: number,
  ) {
    return decodeStoredTextRevision(
      (
        await this.#query(
          client,
          `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${join} WHERE ${filter} AND c.artifact_id=? AND c.content_revision=?`,
          [...creativeOwnerValues(owner), id, artifactId, contentRevision],
        )
      ).rows[0],
      owner,
      id,
      artifactId,
    );
  }
  async #receipt(
    client: PoolClient,
    identity: TextIdentity,
    access: PostgresCreativeProjectLegacyAccess,
    mode: "read" | "mutation",
  ) {
    const row = (
      await this.#query(
        client,
        "SELECT * FROM project_text_mutation_receipts WHERE tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND kind=? AND idempotency_key=?",
        [
          ...creativeOwnerValues(identity.owner),
          identity.actor.actorId,
          identity.kind,
          identity.receipt.idempotencyKey,
        ],
      )
    ).rows[0];
    if (
      !(await assertPostgresLegacyTextReceipt(
        access,
        identity.owner,
        row,
        mode,
      ))
    )
      return null;
    const result = decodeStoredTextReceipt(row, identity);
    if (
      result !== null &&
      (await this.#project(
        client,
        identity.owner,
        result.artifact.projectId,
      )) === null
    )
      projectTextFailure("creative_project_not_found");
    return result;
  }
  async #lock(client: PoolClient, key: readonly string[]) {
    await this.#query(
      client,
      "SELECT pg_advisory_xact_lock(hashtextextended(?,0))",
      [JSON.stringify(key)],
    );
  }
  async #query(client: Pool | PoolClient, sql: string, values: unknown[]) {
    this.#assertOpen();
    let index = 0;
    const statement = sql
      .replace(
        /\b(creative_projects|creative_project_briefs|project_text_artifacts|project_text_revisions|project_text_mutation_receipts)\b/gu,
        (name) => `${this.#prefix}${name}`,
      )
      .replace(/\?/gu, () => `$${++index}`);
    const result = await client.query<Record<string, unknown>>(
      statement,
      values,
    );
    this.#assertOpen();
    return result;
  }
  #active(authority: ReturnType<typeof structuredTextAuthority>) {
    assertCreativeProjectCommitActive(authority);
    this.#assertOpen();
  }
}
