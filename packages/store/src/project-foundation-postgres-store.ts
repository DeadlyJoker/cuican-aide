import { readPostgresOwnedCreativeProject } from "./plugin-project-owned-read-postgres.ts";
import {
  assertPostgresSavedSourceUploadLegacyAccess,
  foundationResultSavedSource,
} from "./project-source-upload-legacy-access.ts";
import { commitOriginalProjectMigration } from "./original-project-migration.ts";
import { migratePostgresProjectFoundationRuns } from "./project-foundation-run-schema.ts";
import type { Pool, PoolClient } from "pg";
import {
  qualifyFoundationRunMutation,
  assertPostgresFoundationRunCommit,
} from "./project-foundation-run-qualification.ts";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitTransactionCurrent,
  captureProjectFoundationCommitAuthority,
  qualifyProjectFoundationPluginCommit,
  type CreativeProjectOwnerScope,
  type ProjectFoundationCommitAuthority,
  type ProjectFoundationCommitOptions,
  type ProjectFoundationMutationResult,
  type ProjectFoundationStore,
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "@crewon/application";
import {
  creativeProjectDigest,
  assertProjectProposalFoundation,
  creativeProjectRevision,
  extensionCanonicalJson,
  readProjectSourcePage,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  creativeOwnerValues,
  decodeCreativeProject,
} from "./creative-project-store-records.ts";
import {
  assertPostgresProjectFoundationSchema,
  migratePostgresProjectFoundations,
} from "./project-foundation-schema.ts";
import {
  foundationFailure,
  foundationFields,
  foundationIdentity,
  foundationJson,
  foundationKind,
  foundationLimit,
  foundationRead,
  prepareFoundation,
  verifyFoundation,
  type FoundationIdentity,
  type FoundationPrepared,
} from "./project-foundation-store-support.ts";
import {
  decodePostgresFoundation,
  decodePostgresFoundationMutationReceipt,
  decodePostgresFoundationProposal,
  decodePostgresFoundationSource,
  decodePostgresFoundationSourceChapter,
  decodePostgresFoundationSourceChunk,
} from "./project-foundation-postgres-records.ts";
import {
  admitPostgresPluginInstallationPin,
  assertPostgresPluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import type { PostgresCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import {
  readPostgresFoundationLegacy,
  insertPostgresFoundationOriginalProject,
  transactPostgresFoundationLegacy,
} from "./project-foundation-postgres-operations.ts";
import { ProjectFoundationPostgresSourceWriter } from "./project-foundation-postgres-source-writer.ts";
import {
  prepareFoundationSourceAdoption,
  type FoundationSourceAdmission,
} from "./project-foundation-source-adoption.ts";
import {
  assertPostgresFoundationSourceAdoption,
  insertPostgresFoundationSourceAssociation,
} from "./project-foundation-source-adoption-postgres.ts";

type Input<M extends keyof ProjectFoundationStore> = Parameters<
  NonNullable<ProjectFoundationStore[M]>
>[0];
type Row = Record<string, unknown>;
type ReadScope = Readonly<{
  owner: CreativeProjectOwnerScope;
  projectId: string;
}>;

/** Borrows the original host pool and schema. Construction and reads never migrate. */
export class PostgresProjectFoundationStore implements ProjectFoundationStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  readonly #sourceWriter: ProjectFoundationPostgresSourceWriter;
  readonly #sourceAdmission: FoundationSourceAdmission | undefined;

  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    sourceAdmission?: FoundationSourceAdmission;
  }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${creativeProjectSchemaName(input.schema)}.`;
    this.#assertOpen = input.assertOpen;
    this.#sourceAdmission = input.sourceAdmission;
    this.#sourceWriter = new ProjectFoundationPostgresSourceWriter({
      prefix: this.#prefix,
      assertOpen: this.#assertOpen,
    });
  }

  async migrate(): Promise<void> {
    await commitOriginalProjectMigration({
      pool: this.#pool,
      assertOpen: this.#assertOpen,
      migrate: async (client) => {
        await this.#lock(client, [
          "project-foundation-migration",
          this.#schema,
        ]);
        await migratePostgresProjectFoundations(client, this.#schema);
        await migratePostgresProjectFoundationRuns(client, this.#schema);
        this.#assertOpen();
      },
    });
  }

  bindProjectReads(scope: PluginProjectReadScope) {
    qualifyPluginProjectReadScope(scope);
    return Object.freeze({
      loadFoundation: (input: Input<"loadFoundation">) =>
        this.loadFoundation(input, scope),
    });
  }
  async loadFoundation(
    input: Input<"loadFoundation">,
    scope?: PluginProjectReadScope,
  ) {
    const query = foundationRead(input);
    if (scope === undefined)
      return this.#read(
        query,
        (client, access) => this.#foundation(client, query, access),
        null,
      );
    const result = await readPostgresOwnedCreativeProject(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#assertOpen },
      { scope, method: "loadFoundation", query },
      async (client, access) => {
        await access.assertProject(
          foundationLegacyScope(query.owner, query.projectId),
        );
        return {
          projectId: query.projectId,
          value: (await this.#schemaConfigured(client))
            ? await this.#foundation(client, query, access)
            : null,
        };
      },
    );
    return result.value;
  }

  async loadSource(input: Input<"loadSource">) {
    const query = foundationRead(input, ["revision"]);
    const revision = creativeProjectRevision(query.revision);
    return this.#read(
      query,
      (client, access) => this.#source(client, query, revision, access),
      null,
    );
  }

  async listSourceChapters(input: Input<"listSourceChapters">) {
    const query = foundationRead(input, [
      "revision",
      "digest",
      "afterStartOffset",
      "limit",
    ]);
    const revision = creativeProjectRevision(query.revision);
    const digest = creativeProjectDigest(query.digest);
    const after =
      query.afterStartOffset === null
        ? -1
        : creativeProjectRevision(query.afterStartOffset, { minimum: 0 });
    const limit = foundationLimit(query.limit);
    return this.#read(
      query,
      async (client, access) => {
        const source = await this.#source(client, query, revision, access);
        if (source === null)
          foundationFailure("project_foundation_source_not_found");
        if (source.digest !== digest)
          foundationFailure("project_foundation_source_digest_mismatch");
        const rows = await this.#query(
          client,
          `${this.#childSelect("project_source_chapters", "c", access)}
        WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
        AND p.project_id=$4 AND c.source_revision=$5 AND c.start_offset>$6
        ORDER BY c.start_offset LIMIT $7`,
          [
            ...creativeOwnerValues(query.owner),
            query.projectId,
            revision,
            after,
            limit + 1,
          ],
        );
        const checked = rows.rows.map((row) =>
          decodePostgresFoundationSourceChapter(row, query, source),
        );
        for (let i = 1; i < checked.length; i++)
          if (checked[i]!.startOffset < checked[i - 1]!.endOffset)
            foundationFailure("project_foundation_source_chapter_mismatch");
        const chapters = Object.freeze(checked.slice(0, limit));
        return Object.freeze({
          chapters,
          nextStartOffset:
            checked.length > limit ? chapters.at(-1)!.startOffset : null,
        });
      },
      () => foundationFailure("project_foundation_source_not_found"),
    );
  }

  async readSourcePage(input: Input<"readSourcePage">) {
    const query = foundationRead(input, [
      "revision",
      "digest",
      "startOffset",
      "limit",
    ]);
    const revision = creativeProjectRevision(query.revision);
    const digest = creativeProjectDigest(query.digest);
    const startOffset = creativeProjectRevision(query.startOffset, {
      minimum: 0,
    });
    const limit = foundationLimit(query.limit, 1_024);
    return this.#read(
      query,
      async (client, access) => {
        const source = await this.#source(client, query, revision, access);
        if (source === null)
          foundationFailure("project_foundation_source_not_found");
        if (source.digest !== digest)
          foundationFailure("project_foundation_source_digest_mismatch");
        if (startOffset > source.characterLength)
          foundationFailure("project_foundation_source_range_invalid");
        const endOffset =
          startOffset + Math.min(limit, source.characterLength - startOffset);
        const rows = await this.#query(
          client,
          `${this.#childSelect("project_source_chunks", "c", access)}
        WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
        AND p.project_id=$4 AND c.source_revision=$5
        AND c.start_offset<$6 AND c.start_offset+c.character_length>$7
        ORDER BY c.start_offset LIMIT 1026`,
          [
            ...creativeOwnerValues(query.owner),
            query.projectId,
            revision,
            endOffset,
            startOffset,
          ],
        );
        const chunks = rows.rows.map((row) =>
          decodePostgresFoundationSourceChunk(row, query),
        );
        return readProjectSourcePage({ source, chunks, startOffset, limit });
      },
      () => foundationFailure("project_foundation_source_not_found"),
    );
  }

  async loadProposal(input: Input<"loadProposal">) {
    const query = foundationRead(input, ["revision"]);
    const revision = creativeProjectRevision(query.revision);
    return this.#read(
      query,
      (client, access) => this.#proposal(client, query, revision, access),
      null,
    );
  }

  async listProposals(input: Input<"listProposals">) {
    const query = foundationRead(input, ["afterRevision", "limit"]);
    const afterRevision = creativeProjectRevision(query.afterRevision, {
      minimum: 0,
    });
    const limit = foundationLimit(query.limit);
    return this.#read(
      query,
      async (client, access) => {
        const rows = await this.#query(
          client,
          `${this.#childSelect("project_proposals", "q", access)}
        WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
        AND p.project_id=$4 AND q.proposal_revision>$5
        ORDER BY q.proposal_revision LIMIT $6`,
          [
            ...creativeOwnerValues(query.owner),
            query.projectId,
            afterRevision,
            limit + 1,
          ],
        );
        const proposals = Object.freeze(
          rows.rows
            .slice(0, limit)
            .map((row) => decodePostgresFoundationProposal(row, query)),
        );
        return Object.freeze({
          proposals,
          nextRevision:
            rows.rows.length > limit ? proposals.at(-1)!.revision : null,
        });
      },
      Object.freeze({
        proposals: Object.freeze([]) as readonly ProjectProposal[],
        nextRevision: null,
      }),
    );
  }

  async loadMutationReceipt(
    input: Input<"loadMutationReceipt">,
    options?: ProjectFoundationCommitOptions,
  ) {
    const identity = foundationIdentity(input);
    const authority = captureProjectFoundationCommitAuthority(options);
    qualifyFoundationRunMutation(authority, identity);
    qualifyProjectFoundationPluginCommit(
      authority,
      identity.actor,
      identity.kind,
    );
    return this.#transaction(async (client, access) => {
      if (!(await this.#schemaConfigured(client))) return null;
      await this.#receiptLock(client, identity);
      await this.#admitInstallation(client, identity, authority);
      return this.#receipt(client, identity, access);
    }, authority);
  }

  async commitCreation(
    input: Input<"commitCreation">,
    options?: ProjectFoundationCommitOptions,
  ) {
    const authority = captureProjectFoundationCommitAuthority(options);
    return this.#commit(prepareFoundation("create-project", input), authority);
  }

  async commitFoundationChange(
    input: Input<"commitFoundationChange">,
    options?: ProjectFoundationCommitOptions,
  ) {
    const authority = captureProjectFoundationCommitAuthority(options);
    const fields = [
      "actor",
      "receipt",
      "kind",
      "expectedFoundationRevision",
      "foundation",
      "source",
      "chunks",
      "chapters",
      "proposal",
    ];
    const hasSourceUpload =
      input !== null &&
      typeof input === "object" &&
      Object.hasOwn(input, "sourceUpload");
    const value = foundationFields(
      input,
      hasSourceUpload ? [...fields, "sourceUpload"] : fields,
    );
    const kind = foundationKind(value.kind);
    if (kind === "create-project" || kind === "save-proposal")
      foundationFailure("project_foundation_mutation_kind_invalid");
    return this.#commit(prepareFoundation(kind, value), authority);
  }

  async commitProposal(
    input: Input<"commitProposal">,
    options?: ProjectFoundationCommitOptions,
  ) {
    const authority = captureProjectFoundationCommitAuthority(options);
    return this.#commit(prepareFoundation("save-proposal", input), authority);
  }

  async #commit(
    prepared: FoundationPrepared,
    authority: ProjectFoundationCommitAuthority | undefined,
  ) {
    const adoption = prepareFoundationSourceAdoption(
      prepared,
      this.#sourceAdmission,
    );
    const identity = foundationIdentity({
      actor: prepared.actor,
      kind: prepared.kind,
      receipt: prepared.receipt,
    });
    qualifyFoundationRunMutation(authority, identity, prepared);
    qualifyProjectFoundationPluginCommit(
      authority,
      identity.actor,
      identity.kind,
    );
    return this.#transaction(async (client, access) => {
      if (!(await this.#schemaConfigured(client)))
        foundationFailure("project_foundation_schema_unconfigured");
      await access.assertProject(
        foundationLegacyScope(identity.owner, prepared.foundation.projectId),
      );
      // Serialize the canonical command before looking at a newly generated project identity.
      await this.#receiptLock(client, identity);
      await this.#admitInstallation(client, identity, authority);
      const previous = await this.#receipt(client, identity, access);
      if (previous !== null) return previous;
      await assertPostgresFoundationRunCommit(
        client,
        this.#schema,
        authority?.runTransaction,
      );
      const scope = {
        owner: identity.owner,
        projectId: prepared.foundation.projectId,
      };
      // This exact old namespace/key also serializes archive, brief and metadata mutations.
      await this.#lock(client, [
        "creative-project-project",
        this.#schema,
        prepared.foundation.tenantId,
        prepared.foundation.spaceId,
        prepared.foundation.projectId,
      ]);
      const projectRows = await this.#query(
        client,
        `SELECT p.* FROM ${this.#prefix}creative_projects p
        WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4 AND ${access.predicate("p")}`,
        [...creativeOwnerValues(scope.owner), scope.projectId],
      );
      const project = decodeCreativeProject(
        projectRows.rows[0],
        scope.owner,
        scope.projectId,
      );
      const foundation = await this.#foundation(client, scope, access);
      const proposalRows = await this.#query(
        client,
        `${this.#childSelect("project_proposals", "q", access)}
        WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4
        ORDER BY q.proposal_revision DESC LIMIT 1`,
        [...creativeOwnerValues(scope.owner), scope.projectId],
      );
      const latestProposal =
        proposalRows.rows[0] === undefined
          ? null
          : decodePostgresFoundationProposal(proposalRows.rows[0], scope);
      const confirmedProposal =
        prepared.kind === "confirm-proposal" && prepared.proposal !== null
          ? await this.#proposal(
              client,
              scope,
              prepared.proposal.revision,
              access,
            )
          : null;
      const sourceRows = await this.#query(
        client,
        `${this.#childSelect("project_sources", "s", access)}
        WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4
        ORDER BY s.source_revision DESC LIMIT 1`,
        [...creativeOwnerValues(scope.owner), scope.projectId],
      );
      const latestSourceRevision =
        sourceRows.rows[0] === undefined
          ? 0
          : decodePostgresFoundationSource(sourceRows.rows[0], scope).revision;
      const result = verifyFoundation(prepared, {
        project,
        foundation,
        latestProposal,
        confirmedProposal,
        latestSourceRevision,
      });
      const sourceTransaction = {
        client,
        schema: this.#schema,
        assertOpen: this.#assertOpen,
      };
      if (adoption !== null)
        await assertPostgresFoundationSourceAdoption(
          sourceTransaction,
          adoption,
        );
      if (prepared.kind === "create-project")
        await insertPostgresFoundationOriginalProject(
          { client, prefix: this.#prefix, assertOpen: this.#assertOpen },
          result,
        );
      if (prepared.kind !== "save-proposal")
        await this.#writeFoundation(client, result.foundation, prepared);
      if (prepared.kind !== "save-proposal" && prepared.source !== null)
        await this.#sourceWriter.insertSource(client, prepared);
      if (adoption !== null)
        await insertPostgresFoundationSourceAssociation(
          sourceTransaction,
          adoption,
        );
      if (prepared.kind === "save-proposal")
        await this.#insertProposal(client, prepared.proposal);
      await this.#query(
        client,
        `INSERT INTO ${this.#prefix}project_foundation_mutation_receipts
        (tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ...creativeOwnerValues(identity.owner),
          identity.actor.actorId,
          identity.kind,
          identity.receipt.idempotencyKey,
          identity.receipt.requestDigest,
          result.project.projectId,
          foundationJson(result),
        ],
      );
      return result;
    }, authority);
  }

  async #foundation(
    client: PoolClient,
    scope: ReadScope,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<ProjectFoundation | null> {
    const rows = await this.#query(
      client,
      `${this.#childSelect("project_foundations", "f", access)}
      WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4`,
      [...creativeOwnerValues(scope.owner), scope.projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    const foundation = decodePostgresFoundation(row, scope);
    if (foundation.source !== null) {
      const source = await this.#source(
        client,
        scope,
        foundation.source.revision,
        access,
      );
      if (source === null || source.digest !== foundation.source.digest)
        foundationFailure("project_foundation_source_not_found");
    }
    if (foundation.confirmedProposal !== null) {
      const proposal = await this.#proposal(
        client,
        scope,
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

  async #source(
    client: PoolClient,
    scope: ReadScope,
    revision: number,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<ProjectSource | null> {
    const rows = await this.#query(
      client,
      `${this.#childSelect("project_sources", "s", access)}
      WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
      AND p.project_id=$4 AND s.source_revision=$5`,
      [...creativeOwnerValues(scope.owner), scope.projectId, revision],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    if (row !== undefined)
      await assertPostgresSavedSourceUploadLegacyAccess(client, this.#schema, {
        owner: scope.owner,
        projectId: scope.projectId,
        sourceRevision: revision,
      });
    return decodePostgresFoundationSource(row, scope, revision);
  }

  async #proposal(
    client: PoolClient,
    scope: ReadScope,
    revision: number,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<ProjectProposal | null> {
    const rows = await this.#query(
      client,
      `${this.#childSelect("project_proposals", "q", access)}
      WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
      AND p.project_id=$4 AND q.proposal_revision=$5`,
      [...creativeOwnerValues(scope.owner), scope.projectId, revision],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return decodePostgresFoundationProposal(row, scope, revision);
  }

  async #receipt(
    client: PoolClient,
    identity: FoundationIdentity,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    const rows = await this.#query(
      client,
      `SELECT * FROM ${this.#prefix}project_foundation_mutation_receipts
      WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6`,
      [
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      ],
    );
    const row = rows.rows[0];
    if (row !== undefined) {
      const scope = foundationLegacyScope(
        identity.owner,
        String(row.project_id),
      );
      await this.#lock(client, [
        "creative-project-project",
        this.#schema,
        scope.tenantId,
        scope.spaceId,
        scope.projectId,
      ]);
      await access.assertProject(scope);
    }
    const result = decodePostgresFoundationMutationReceipt(row, identity);
    const savedSource =
      result == null ? null : foundationResultSavedSource(result);
    if (savedSource !== null)
      await assertPostgresSavedSourceUploadLegacyAccess(
        client,
        this.#schema,
        savedSource,
      );
    return result;
  }

  #childSelect(
    table:
      | "project_foundations"
      | "project_sources"
      | "project_source_chunks"
      | "project_source_chapters"
      | "project_proposals",
    alias: string,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    return `SELECT ${alias}.*,p.owner_principal_id FROM ${this.#prefix}${table} ${alias}
      JOIN ${this.#prefix}creative_projects p ON p.tenant_id=${alias}.tenant_id
      AND p.space_id=${alias}.space_id AND p.project_id=${alias}.project_id AND ${access.predicate("p")}`;
  }

  async #writeFoundation(
    client: PoolClient,
    foundation: ProjectFoundation,
    prepared: FoundationPrepared,
  ) {
    const values = [
      foundation.tenantId,
      foundation.spaceId,
      foundation.projectId,
      foundation.ownerPrincipalId,
      foundation.origin,
      foundation.revision,
      foundation.parametersRevision,
      foundationJson(foundation, 32_768),
    ];
    if (prepared.kind === "create-project") {
      await this.#query(
        client,
        `INSERT INTO ${this.#prefix}project_foundations
        (tenant_id,space_id,project_id,owner_principal_id,origin,revision,parameters_revision,record_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        values,
      );
      return;
    }
    if (prepared.kind === "save-proposal")
      foundationFailure("project_foundation_recipe_invalid");
    const updated = await this.#query(
      client,
      `UPDATE ${this.#prefix}project_foundations
      SET revision=$6,parameters_revision=$7,record_json=$8
      WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND owner_principal_id=$4 AND origin=$5 AND revision=$9`,
      [...values, prepared.expectedFoundationRevision],
    );
    if (updated.rowCount !== 1)
      foundationFailure("project_foundation_revision_conflict");
  }

  async #insertProposal(client: PoolClient, proposal: ProjectProposal) {
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}project_proposals
      (tenant_id,space_id,project_id,proposal_revision,content_digest,record_json) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        proposal.tenantId,
        proposal.spaceId,
        proposal.projectId,
        proposal.revision,
        proposal.contentDigest,
        foundationJson(proposal, 32_768),
      ],
    );
  }

  async #receiptLock(client: PoolClient, identity: FoundationIdentity) {
    await this.#lock(client, [
      "project-foundation-receipt",
      this.#schema,
      ...creativeOwnerValues(identity.owner),
      identity.actor.actorId,
      identity.kind,
      identity.receipt.idempotencyKey,
    ]);
  }

  async #lock(client: PoolClient, key: readonly unknown[]) {
    await this.#query(
      client,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify(key)],
    );
  }

  async #admitInstallation(
    client: PoolClient,
    identity: FoundationIdentity,
    authority: ProjectFoundationCommitAuthority | undefined,
  ) {
    const qualified = qualifyProjectFoundationPluginCommit(
      authority,
      identity.actor,
      identity.kind,
    );
    await assertPostgresFoundationRunCommit(
      client,
      this.#schema,
      authority?.runTransaction,
      "receipt-publication",
    );
    if (qualified === undefined) return;
    await assertPostgresPluginInstallationPinSchema(client, this.#schema);
    const actual = await admitPostgresPluginInstallationPin(
      client,
      this.#schema,
      qualified.pin,
    );
    if (
      extensionCanonicalJson(qualified.selection) !==
        extensionCanonicalJson(actual.selection) ||
      extensionCanonicalJson(qualified.package) !==
        extensionCanonicalJson(actual.package)
    )
      foundationFailure("project_foundation_plugin_commit_selection_mismatch");
    await assertProjectFoundationCommitTransactionCurrent(authority);
    assertProjectFoundationCommitActive(authority);
    this.#assertOpen();
  }

  async #query(client: PoolClient, sql: string, values: unknown[] = []) {
    this.#assertOpen();
    const result = await client.query<Row>(sql, values);
    this.#assertOpen();
    return result;
  }

  async #read<T>(
    scope: ReadScope,
    body: (
      client: PoolClient,
      access: PostgresCreativeProjectLegacyAccess,
    ) => Promise<T>,
    absent: T | (() => never),
  ): Promise<T> {
    return readPostgresFoundationLegacy(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#assertOpen },
      foundationLegacyScope(scope.owner, scope.projectId),
      body,
      absent,
    );
  }

  async #schemaConfigured(client: PoolClient): Promise<boolean> {
    this.#assertOpen();
    const configured = await assertPostgresProjectFoundationSchema(
      client,
      this.#schema,
    );
    this.#assertOpen();
    return configured;
  }

  async #transaction<T extends ProjectFoundationMutationResult | null | void>(
    body: (
      client: PoolClient,
      access: PostgresCreativeProjectLegacyAccess,
    ) => Promise<T>,
    authority?: ProjectFoundationCommitAuthority,
  ): Promise<T> {
    return transactPostgresFoundationLegacy(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#assertOpen },
      body,
      authority,
    );
  }
}
