import { observePostgresPlanManualSelection } from "./project-text-plan-manual-selection.ts";
import {
  capturePostgresProjectFoundationDownstream,
  assertPostgresProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamSnapshot,
} from "./project-foundation-downstream-guard.ts";
import {
  planSelectionQualification,
  beginPostgresPlanSelection,
  finishPostgresPlanSelection,
} from "./project-text-plan-selection.ts";
import {
  beginPostgresPlanResult,
  finishPostgresPlanResult,
} from "./project-text-plan-tool.ts";
import {
  projectTextUiCommitQualification,
  assertPostgresProjectTextUiCommit,
  type ProjectTextUiQualification,
} from "./project-text-ui-commit-support.ts";
import {
  assertPostgresProjectRunCommit,
  assertPostgresProjectRunLease,
} from "./creative-project-run-commit-postgres.ts";
import {
  projectRunCommitQualification,
  type ProjectRunQualification,
} from "./creative-project-run-commit-support.ts";
import type { Pool, PoolClient } from "pg";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  type CreativeProjectCommitAuthority,
  type CreativeProjectCommitOptions,
  type CreativeProjectOwnerScope,
  type ProjectTextStore,
  type ProjectTextMutationResult,
} from "@crewon/application";
import { projectTextFailure } from "@crewon/domain";
import {
  creativeOwnerValues,
  decodeCreativeBrief,
  decodeCreativeProject,
} from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { migratePostgresProjectText } from "./project-text-schema.ts";
import {
  artifactColumns,
  artifactValues,
  decodeTextArtifact,
  decodeTextReceipt,
  decodeTextRevision,
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
} from "./project-text-store-support.ts";

type QueryClient = Pool | PoolClient;
const filter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=? AND p.project_id=?";
const childJoin =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";

/** Every transaction uses one borrowed client, including dependency and receipt reads. */
export class PostgresProjectTextStore implements ProjectTextStore {
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
  async migrate(): Promise<void> {
    await this.#transaction((client) =>
      migratePostgresProjectText(client, this.#schema),
    );
  }
  async loadOutline(input: TextInput<"loadOutline">) {
    const q = textRead("loadOutline", input);
    return this.#artifact(
      this.#pool,
      q.owner,
      q.projectId,
      "c.kind='outline' AND c.episode_id=''",
      [],
    );
  }
  async loadScript(input: TextInput<"loadScript">) {
    const q = textRead("loadScript", input);
    return this.#artifact(
      this.#pool,
      q.owner,
      q.projectId,
      "c.kind='script' AND c.episode_id=?",
      [q.episodeId],
    );
  }
  async loadArtifact(input: TextInput<"loadArtifact">) {
    const q = textRead("loadArtifact", input);
    return this.#artifact(this.#pool, q.owner, q.projectId, "c.artifact_id=?", [
      q.artifactId,
    ]);
  }
  async loadRevision(input: TextInput<"loadRevision">) {
    const q = textRead("loadRevision", input);
    return this.#revision(
      this.#pool,
      q.owner,
      q.projectId,
      q.artifactId,
      q.contentRevision,
    );
  }
  async listArtifacts(input: TextInput<"listArtifacts">) {
    const q = textRead("listArtifacts", input);
    const rows = await this.#query(
      this.#pool,
      `SELECT c.* FROM project_text_artifacts c ${childJoin} WHERE ${filter}${q.afterArtifactId === null ? "" : ' AND c.artifact_id COLLATE "C" > ? COLLATE "C"'} ORDER BY c.artifact_id COLLATE "C" ASC LIMIT ?`,
      [
        ...creativeOwnerValues(q.owner),
        q.projectId,
        ...(q.afterArtifactId === null ? [] : [q.afterArtifactId]),
        q.limit + 1,
      ],
    );
    const items = rows.rows.map((row) =>
      textRequired(decodeTextArtifact(row, q.owner, q.projectId)),
    );
    const artifacts = Object.freeze(items.slice(0, q.limit));
    return Object.freeze({
      artifacts,
      nextArtifactId:
        items.length > q.limit ? artifacts.at(-1)!.artifactId : null,
    });
  }
  async listRevisions(input: TextInput<"listRevisions">) {
    const q = textRead("listRevisions", input);
    const rows = await this.#query(
      this.#pool,
      `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${childJoin} WHERE ${filter} AND c.artifact_id=? AND c.content_revision>? ORDER BY c.content_revision ASC LIMIT ?`,
      [
        ...creativeOwnerValues(q.owner),
        q.projectId,
        q.artifactId,
        q.afterContentRevision,
        q.limit + 1,
      ],
    );
    const items = rows.rows.map((row) =>
      textRequired(decodeTextRevision(row, q.owner, q.projectId, q.artifactId)),
    );
    const revisions = Object.freeze(items.slice(0, q.limit));
    return Object.freeze({
      revisions,
      nextContentRevision:
        items.length > q.limit ? revisions.at(-1)!.contentRevision : null,
    });
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
    return this.#transaction(
      async (client) => {
        await assertPostgresProjectRunCommit(client, this.#schema, q);
        await assertPostgresProjectTextUiCommit(client, this.#schema, textUi);
        const intent = await beginPostgresTextIntentCommit(
          client,
          this.#schema,
          textUi,
          identity,
        );
        const planResult = await beginPostgresPlanResult(
          client,
          this.#schema,
          q,
        );
        const selectionCheckpoint = await beginPostgresPlanSelection(
          client,
          this.#schema,
          planSelection,
        );
        const result = await this.#receipt(client, identity);
        if (result !== null) {
          await finishPostgresPlanResult(
            client,
            this.#schema,
            planResult,
            result,
          );
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
              identity.actor,
              identity.receipt,
              result,
              textUi,
            );
        }
        if (result !== null)
          await finishPostgresTextIntentCommit(client, this.#schema, intent);
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
    );
    let downstream: ProjectFoundationDownstreamSnapshot | undefined;
    const downstreamLocator = {
      actor: prepared.actor,
      projectId: prepared.project.projectId,
    };
    return this.#transaction(
      async (client) => {
        await assertPostgresProjectRunCommit(
          client,
          this.#schema,
          runQualification,
        );
        await assertPostgresProjectTextUiCommit(client, this.#schema, textUi);
        const identity = textIdentity({
          actor: prepared.actor,
          kind: prepared.kind,
          receipt: prepared.receipt,
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
        const intent = await beginPostgresTextIntentCommit(
          client,
          this.#schema,
          textUi,
          identity,
        );
        const planResult = await beginPostgresPlanResult(
          client,
          this.#schema,
          runQualification,
        );
        const selectionCheckpoint = await beginPostgresPlanSelection(
          client,
          this.#schema,
          planSelection,
        );
        const replay = await this.#receipt(client, identity);
        if (replay !== null) {
          await finishPostgresPlanResult(
            client,
            this.#schema,
            planResult,
            replay,
          );
          await finishPostgresPlanSelection(
            client,
            this.#schema,
            selectionCheckpoint,
            replay,
          );
          if (planSelection === undefined)
            await observePostgresPlanManualSelection(
              client,
              this.#schema,
              identity.actor,
              identity.receipt,
              replay,
              textUi,
            );
          await finishPostgresTextIntentCommit(client, this.#schema, intent);
          return replay;
        }
        // Exactly the same lock namespace as project archival and brief mutations.
        await this.#lock(client, [
          "creative-project-project",
          this.#schema,
          prepared.project.tenantId,
          prepared.project.spaceId,
          id,
        ]);
        const project = await this.#project(client, owner, id);
        const candidate =
          prepared.kind === "save-outline" || prepared.kind === "save-script";
        const artifact = candidate
          ? await this.#artifact(
              client,
              owner,
              id,
              "c.kind=? AND c.episode_id=?",
              [prepared.artifact.kind, prepared.artifact.episodeId ?? ""],
            )
          : await this.#artifact(client, owner, id, "c.artifact_id=?", [
              prepared.artifact.artifactId,
            ]);
        const saved =
          "contentRevision" in prepared ? prepared.contentRevision : null;
        const brief =
          candidate && saved !== null
            ? await this.#brief(client, owner, id, saved.brief.briefRevision)
            : null;
        const outline =
          candidate && saved?.outline
            ? await this.#revision(
                client,
                owner,
                id,
                saved.outline.artifactId,
                saved.outline.contentRevision,
              )
            : null;
        const revision =
          prepared.kind === "select-revision"
            ? await this.#revision(
                client,
                owner,
                id,
                prepared.artifact.artifactId,
                prepared.contentRevision.contentRevision,
              )
            : null;
        const latestBrief =
          prepared.kind === "select-revision" && project !== null
            ? await this.#brief(client, owner, id, project.latestBriefRevision)
            : null;
        const outlineHead =
          prepared.kind === "select-revision"
            ? await this.#artifact(
                client,
                owner,
                id,
                "c.kind='outline' AND c.episode_id=''",
                [],
              )
            : null;
        const selectedOutline = outlineHead?.selectedContentRevision
          ? await this.#revision(
              client,
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
        if (candidate)
          downstream = await capturePostgresProjectFoundationDownstream(
            client,
            this.#schema,
            downstreamLocator,
          );
        this.#active(authority);
        const a = result.artifact;
        if (prepared.expectedArtifactRevision === 0)
          await this.#query(
            client,
            `INSERT INTO project_text_artifacts(${artifactColumns}) VALUES(${Array(12).fill("?").join(",")})`,
            artifactValues(a),
          );
        else {
          const changed = await this.#query(
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
          );
          if (changed.rowCount !== 1)
            projectTextFailure("project_text_revision_conflict");
        }
        if (candidate) {
          this.#active(authority);
          await this.#query(
            client,
            `INSERT INTO project_text_revisions(${revisionColumns}) VALUES(${Array(14).fill("?").join(",")})`,
            revisionValues(textRequired(result.contentRevision)),
          );
        }
        this.#active(authority);
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
        await finishPostgresTextIntentCommit(client, this.#schema, intent);
        await finishPostgresPlanResult(
          client,
          this.#schema,
          planResult,
          result,
        );
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
      async (client) => {
        if (downstream !== undefined)
          await assertPostgresProjectFoundationDownstreamUnchanged(
            client,
            this.#schema,
            downstreamLocator,
            downstream,
          );
      },
    );
  }
  async #project(
    client: QueryClient,
    owner: CreativeProjectOwnerScope,
    id: string,
  ) {
    const row = (
      await this.#query(
        client,
        `SELECT p.* FROM creative_projects p WHERE ${filter}`,
        [...creativeOwnerValues(owner), id],
      )
    ).rows[0];
    return decodeCreativeProject(row, owner, id);
  }
  async #brief(
    client: QueryClient,
    owner: CreativeProjectOwnerScope,
    id: string,
    revision: number,
  ) {
    const row = (
      await this.#query(
        client,
        `SELECT c.*,p.owner_principal_id FROM creative_project_briefs c ${childJoin} WHERE ${filter} AND c.brief_revision=?`,
        [...creativeOwnerValues(owner), id, revision],
      )
    ).rows[0];
    return decodeCreativeBrief(row, owner, id);
  }
  async #artifact(
    client: QueryClient,
    owner: CreativeProjectOwnerScope,
    id: string,
    condition: string,
    values: unknown[],
  ) {
    const row = (
      await this.#query(
        client,
        `SELECT c.* FROM project_text_artifacts c ${childJoin} WHERE ${filter} AND ${condition}`,
        [...creativeOwnerValues(owner), id, ...values],
      )
    ).rows[0];
    return decodeTextArtifact(row, owner, id);
  }
  async #revision(
    client: QueryClient,
    owner: CreativeProjectOwnerScope,
    id: string,
    artifactId: string,
    revision: number,
  ) {
    const row = (
      await this.#query(
        client,
        `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${childJoin} WHERE ${filter} AND c.artifact_id=? AND c.content_revision=?`,
        [...creativeOwnerValues(owner), id, artifactId, revision],
      )
    ).rows[0];
    return decodeTextRevision(row, owner, id, artifactId);
  }
  async #receipt(client: QueryClient, identity: TextIdentity) {
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
    const result = decodeTextReceipt(row, identity);
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
  async #query(client: QueryClient, sql: string, values: unknown[] = []) {
    this.#assertOpen();
    let index = 0;
    // All statements are private constants, never caller SQL. Qualify tables and number parameters.
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
  #active(authority: CreativeProjectCommitAuthority | undefined) {
    assertCreativeProjectCommitActive(authority);
    this.#assertOpen();
  }
  async #transaction<T>(
    body: (client: PoolClient) => Promise<T>,
    authority?: CreativeProjectCommitAuthority,
    runQualification?: ProjectRunQualification,
    textUi?: ProjectTextUiQualification,
    checkDownstream?: (client: PoolClient) => Promise<void>,
  ): Promise<T> {
    this.#assertOpen();
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    this.#active(authority);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await body(client);
      if (authority?.planTransaction !== undefined) {
        await authority.planTransaction.assertCurrent();
        await authority.planTransaction.authority.assertTransactionCurrent();
      } else if (authority?.textUiTransaction !== undefined)
        await authority.textUiTransaction.assertCurrent();
      else if (authority?.runTransaction !== undefined)
        await authority.runTransaction.assertCurrent();
      else if (authority !== undefined)
        await assertCreativeProjectCommitCurrent(authority);
      await assertPostgresProjectRunLease(
        client,
        this.#schema,
        runQualification,
      );
      await checkDownstream?.(client);
      this.#active(authority);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
import {
  beginPostgresTextIntentCommit,
  finishPostgresTextIntentCommit,
} from "./project-text-ui-intent-commit.ts";
