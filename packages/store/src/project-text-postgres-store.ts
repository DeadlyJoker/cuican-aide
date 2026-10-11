import {
  listPostgresTextArtifacts,
  listPostgresTextRevisions,
} from "./project-text-postgres-reads.ts";
import { commitPostgresLegacyText } from "./project-text-postgres-transaction.ts";
import { commitOriginalProjectMigration } from "./original-project-migration.ts";
import {
  assertPostgresLegacyTextReceipt,
  readPostgresLegacyText,
  textLegacyScope,
} from "./project-text-legacy-access.ts";
import type { PostgresCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import {
  decodeOutlineSourceRevision,
  assertOutlineSourceInputsCurrent,
} from "./project-outline-source-store-support.ts";
import { PostgresStructuredOutlineStorage } from "./project-structured-outline-postgres.ts";
import {
  legacyTextRevision as decodeTextRevision,
  legacyTextReceipt as decodeTextReceipt,
  type StructuredTextInput,
} from "./project-structured-outline-store-support.ts";
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
import { assertPostgresProjectRunCommit } from "./creative-project-run-commit-postgres.ts";
import {
  projectRunCommitQualification,
  type ProjectRunQualification,
} from "./creative-project-run-commit-support.ts";
import type { Pool, PoolClient } from "pg";
import {
  assertCreativeProjectCommitActive,
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
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { migratePostgresProjectText } from "./project-text-schema.ts";
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
} from "./project-text-store-support.ts";

type QueryClient = Pool | PoolClient;
const filter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=? AND p.project_id=?";
const childJoin =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";

/** Every transaction uses one borrowed client, including dependency and receipt reads. */
export class PostgresProjectTextStore implements ProjectStructuredOutlineStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  readonly #structured: PostgresStructuredOutlineStorage;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${creativeProjectSchemaName(input.schema)}.`;
    this.#assertOpen = input.assertOpen;
    this.#structured = new PostgresStructuredOutlineStorage(input);
  }
  loadStructuredRevision(input: StructuredTextInput<"loadStructuredRevision">) {
    return this.#structured.loadRevision(input);
  }
  listStructuredRevisions(
    input: StructuredTextInput<"listStructuredRevisions">,
  ) {
    return this.#structured.listRevisions(input);
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
    await commitOriginalProjectMigration({
      pool: this.#pool,
      assertOpen: this.#assertOpen,
      migrate: (client) => migratePostgresProjectText(client, this.#schema),
    });
  }
  async loadOutline(input: TextInput<"loadOutline">) {
    const q = textRead("loadOutline", input);
    return this.#read(
      q,
      async (client) =>
        this.#artifact(
          client,
          q.owner,
          q.projectId,
          "c.kind='outline' AND c.episode_id=''",
          [],
        ),
      null,
    );
  }
  async loadScript(input: TextInput<"loadScript">) {
    const q = textRead("loadScript", input);
    return this.#read(
      q,
      async (client) =>
        this.#artifact(
          client,
          q.owner,
          q.projectId,
          "c.kind='script' AND c.episode_id=?",
          [q.episodeId],
        ),
      null,
    );
  }
  async loadArtifact(input: TextInput<"loadArtifact">) {
    const q = textRead("loadArtifact", input);
    return this.#read(
      q,
      async (client) =>
        this.#artifact(client, q.owner, q.projectId, "c.artifact_id=?", [
          q.artifactId,
        ]),
      null,
    );
  }
  async loadRevision(input: TextInput<"loadRevision">) {
    const q = textRead("loadRevision", input);
    return this.#read(
      q,
      async (client) =>
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
  async loadOutlineSourceRevision(
    input: TextInput<"loadOutlineSourceRevision">,
  ) {
    const q = textRead("loadRevision", input);
    return this.#read(
      q,
      async (client) =>
        this.#outlineSourceRevision(
          client,
          q.owner,
          q.projectId,
          q.artifactId,
          q.contentRevision,
        ),
      null,
    );
  }
  async listArtifacts(input: TextInput<"listArtifacts">) {
    const q = textRead("listArtifacts", input);
    return this.#read(
      q,
      (client) =>
        listPostgresTextArtifacts(q, (sql, values) =>
          this.#query(client, sql, values),
        ),
      { artifacts: [], nextArtifactId: null },
    );
  }
  async listRevisions(input: TextInput<"listRevisions">) {
    const q = textRead("listRevisions", input);
    return this.#read(
      q,
      (client) =>
        listPostgresTextRevisions(q, (sql, values) =>
          this.#query(client, sql, values),
        ),
      { revisions: [], nextContentRevision: null },
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
    return this.#transaction(
      async (client, access) => {
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
        const result = await this.#receipt(client, identity, access, "read");
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
      async (client, access) => {
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
        const replay = await this.#receipt(
          client,
          identity,
          access,
          "mutation",
        );
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
        // Legacy callers cannot replace or adopt an outline after a v2 candidate exists.
        if (artifact?.kind === "outline" && prepared.kind !== "set-lock")
          await this.#revision(
            client,
            owner,
            id,
            artifact.artifactId,
            artifact.latestContentRevision,
          );
        const saved =
          "contentRevision" in prepared ? prepared.contentRevision : null;
        const brief =
          candidate && saved !== null
            ? await this.#brief(client, owner, id, saved.brief.briefRevision)
            : null;
        const outline =
          candidate && saved?.outline
            ? await this.#outlineSourceRevision(
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
          ? await this.#outlineSourceRevision(
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
          downstream = await capturePostgresProjectFoundationDownstream(
            client,
            this.#schema,
            downstreamLocator,
          );
          assertOutlineSourceInputsCurrent(structuredSource, downstream);
        }
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
      textLegacyScope(prepared.project, prepared.project.projectId),
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
  async #outlineSourceRevision(
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
    return decodeOutlineSourceRevision(row, owner, id, artifactId);
  }
  async #receipt(
    client: QueryClient,
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
  #read<T>(
    q: Readonly<{ owner: CreativeProjectOwnerScope; projectId: string }>,
    read: (client: PoolClient) => Promise<T>,
    absent: T,
  ): Promise<T> {
    return readPostgresLegacyText(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#assertOpen },
      textLegacyScope(q.owner, q.projectId),
      read,
      absent,
    );
  }
  #transaction<T extends ProjectTextMutationResult | null | void>(
    body: (
      client: PoolClient,
      access: PostgresCreativeProjectLegacyAccess,
    ) => Promise<T>,
    authority?: CreativeProjectCommitAuthority,
    runQualification?: ProjectRunQualification,
    _textUi?: ProjectTextUiQualification,
    checkDownstream?: (client: PoolClient) => Promise<void>,
    scope?: CreativeProjectScope,
  ): Promise<T> {
    return commitPostgresLegacyText({
      pool: this.#pool,
      schema: this.#schema,
      assertOpen: this.#assertOpen,
      body,
      authority,
      runQualification,
      checkDownstream,
      scope,
    });
  }
}
import {
  beginPostgresTextIntentCommit,
  finishPostgresTextIntentCommit,
} from "./project-text-ui-intent-commit.ts";
