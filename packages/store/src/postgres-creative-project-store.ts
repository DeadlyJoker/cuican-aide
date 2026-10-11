import {
  beginPostgresPlanResult,
  finishPostgresPlanResult,
} from "./project-text-plan-tool.ts";
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
  assertCreativeProjectCommitTransactionCurrent,
  captureCreativeProjectCommitAuthority,
  type CreativeProjectCommitAuthority,
  type CreativeProjectCommitOptions,
  type CreativeProjectStore,
  type CreativeProjectMutationResult,
  type CreativeProjectOwnerScope,
} from "@crewon/application";
import type {
  CreativeProject,
  ProjectBriefRevision,
  ConceptAsset,
  ConceptAssetRevision,
} from "@crewon/domain";
import {
  creativeProjectSchemaName,
  migratePostgresCreativeProjects,
} from "./creative-project-schema.ts";
import {
  creativeMutationIdentity,
  creativeMutationKind,
  creativeOwnerValues,
  creativeReadInput,
  creativeRecordJson,
  creativeStoreFailure,
  creativeStoreRecord,
  decodeCreativeProject,
  decodeCreativeBrief,
  decodeCreativeAsset,
  decodeCreativeRevision,
  prepareCreativeMutation,
  verifyCreativeMutation,
  type PreparedCreativeMutation,
} from "./creative-project-store-records.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import { commitOriginalProjectMigration } from "./original-project-migration.ts";
import {
  admitPostgresPluginInstallationPin,
  assertPostgresPluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import {
  creativeProjectPluginCommitQualification,
  assertCreativeProjectPluginCommitSelection,
} from "./creative-project-plugin-commit-support.ts";
import {
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import {
  readPostgresLegacyCreativeProject,
  readPostgresLegacyCreativeProjectReceipt,
  type PostgresCreativeProjectLegacyRead,
} from "./creative-project-postgres-legacy-read.ts";
import {
  postgresCreativeProjectLegacyMutationFence,
  finishPostgresCreativeProjectLegacyMutation,
  type PostgresCreativeProjectLegacyMutationFence,
} from "./creative-project-legacy-mutation-access.ts";

type ReadInput<Method extends keyof CreativeProjectStore> = Parameters<
  CreativeProjectStore[Method]
>[0];
type MutationIdentity = ReturnType<typeof creativeMutationIdentity>;
type QueryClient = PoolClient;

/** Internal project persistence only; shares its host's pool, schema and lifetime. */
export class PostgresCreativeProjectStore implements CreativeProjectStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;

  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#schema = input.schema;
    this.#prefix = `${creativeProjectSchemaName(input.schema)}.`;
    this.#pool = input.pool;
    this.#assertOpen = input.assertOpen;
  }

  /** Explicit and independent of the host's historical migration. */
  async migrate(): Promise<void> {
    await commitOriginalProjectMigration({
      pool: this.#pool,
      assertOpen: this.#assertOpen,
      migrate: async (client) => {
        await this.#lock(client, ["creative-project-migration", this.#schema]);
        await migratePostgresCreativeProjects(client, this.#schema);
      },
    });
  }

  async loadProject(input: ReadInput<"loadProject">) {
    const query = creativeReadInput("loadProject", input);
    return this.#read((client, access) =>
      this.#project(client, query.owner, query.projectId, access),
    );
  }

  async listProjects(input: ReadInput<"listProjects">) {
    const query = creativeReadInput("listProjects", input);
    return this.#read(async (client, access) => {
      const rows = await this.#query(
        client,
        `SELECT p.* FROM ${this.#prefix}creative_projects p
       WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND ${access.predicate("p")}
       AND ($4::text='all' OR state=$4)
       AND ($5::text IS NULL OR updated_at<$5 OR
         (updated_at=$5 AND project_id COLLATE "C"<$6 COLLATE "C"))
       ORDER BY updated_at DESC,project_id COLLATE "C" DESC LIMIT $7`,
        [
          ...creativeOwnerValues(query.owner),
          query.state,
          query.after?.updatedAt ?? null,
          query.after?.projectId ?? null,
          query.limit + 1,
        ],
      );
      const projects = Object.freeze(
        rows.rows
          .slice(0, query.limit)
          .map((row) =>
            this.#required(decodeCreativeProject(row, query.owner)),
          ),
      );
      const last = projects.at(-1);
      return Object.freeze({
        projects,
        next:
          rows.rows.length > query.limit && last !== undefined
            ? Object.freeze({
                updatedAt: last.updatedAt,
                projectId: last.projectId,
              })
            : null,
      });
    });
  }

  async loadBrief(input: ReadInput<"loadBrief">) {
    const query = creativeReadInput("loadBrief", input);
    return this.#read((client, access) =>
      this.#brief(
        client,
        query.owner,
        query.projectId,
        query.briefRevision,
        access,
      ),
    );
  }

  async listBriefs(input: ReadInput<"listBriefs">) {
    const query = creativeReadInput("listBriefs", input);
    return this.#read(async (client, access) => {
      const rows = await this.#query(
        client,
        `${this.#childSelect("creative_project_briefs", "b")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${access.predicate("p")} AND b.brief_revision>$5
       ORDER BY b.brief_revision LIMIT $6`,
        [
          ...creativeOwnerValues(query.owner),
          query.projectId,
          query.afterBriefRevision,
          query.limit,
        ],
      );
      return Object.freeze(
        rows.rows.map((row) =>
          this.#required(
            decodeCreativeBrief(row, query.owner, query.projectId),
          ),
        ),
      );
    });
  }

  async loadConceptAsset(input: ReadInput<"loadConceptAsset">) {
    const query = creativeReadInput("loadConceptAsset", input);
    return this.#read((client, access) =>
      this.#asset(client, query.owner, query.projectId, query.assetId, access),
    );
  }

  async listConceptAssets(input: ReadInput<"listConceptAssets">) {
    const query = creativeReadInput("listConceptAssets", input);
    return this.#read(async (client, access) => {
      const rows = await this.#query(
        client,
        `${this.#childSelect("creative_concept_assets", "a")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${access.predicate("p")}
       AND ($5::text IS NULL OR a.asset_id COLLATE "C">$5 COLLATE "C")
       ORDER BY a.asset_id COLLATE "C" LIMIT $6`,
        [
          ...creativeOwnerValues(query.owner),
          query.projectId,
          query.afterAssetId,
          query.limit,
        ],
      );
      return Object.freeze(
        rows.rows.map((row) =>
          this.#required(
            decodeCreativeAsset(row, query.owner, query.projectId),
          ),
        ),
      );
    });
  }

  async loadConceptRevision(input: ReadInput<"loadConceptRevision">) {
    const query = creativeReadInput("loadConceptRevision", input);
    return this.#read(async (client, access) => {
      const rows = await this.#query(
        client,
        `${this.#childSelect("creative_concept_revisions", "r")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${access.predicate("p")} AND r.asset_id=$5 AND r.asset_revision=$6`,
        [
          ...creativeOwnerValues(query.owner),
          query.projectId,
          query.assetId,
          query.assetRevision,
        ],
      );
      return decodeCreativeRevision(
        rows.rows[0],
        query.owner,
        query.projectId,
        query.assetId,
      );
    });
  }

  async listConceptRevisions(input: ReadInput<"listConceptRevisions">) {
    const query = creativeReadInput("listConceptRevisions", input);
    return this.#read(async (client, access) => {
      const rows = await this.#query(
        client,
        `${this.#childSelect("creative_concept_revisions", "r")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${access.predicate("p")} AND r.asset_id=$5 AND r.asset_revision>$6
       ORDER BY r.asset_revision LIMIT $7`,
        [
          ...creativeOwnerValues(query.owner),
          query.projectId,
          query.assetId,
          query.afterAssetRevision,
          query.limit,
        ],
      );
      return Object.freeze(
        rows.rows.map((row) =>
          this.#required(
            decodeCreativeRevision(
              row,
              query.owner,
              query.projectId,
              query.assetId,
            ),
          ),
        ),
      );
    });
  }

  async loadMutationReceipt(
    input: ReadInput<"loadMutationReceipt">,
    options?: CreativeProjectCommitOptions,
  ) {
    const identity = creativeMutationIdentity(input);
    const authority = captureCreativeProjectCommitAuthority(options);
    const q = projectRunCommitQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
    );
    if (q === undefined)
      return this.#read((client, access) =>
        this.#receipt(client, identity, access),
      );
    let result: CreativeProjectMutationResult | null = null;
    return this.#transaction(
      async (client, access) => {
        await assertPostgresProjectRunCommit(client, this.#schema, q);
        const planResult = await beginPostgresPlanResult(
          client,
          this.#schema,
          q,
        );
        result = await this.#receipt(client, identity, access);
        if (result !== null)
          await finishPostgresPlanResult(
            client,
            this.#schema,
            planResult,
            result,
          );
        return result;
      },
      authority,
      q,
      async (_client, access) => {
        if (result !== null)
          await access.assertProject({
            tenantId: result.project.tenantId,
            spaceId: result.project.spaceId,
            projectId: result.project.projectId,
          });
      },
    );
  }

  async commitProjectCreation(
    input: ReadInput<"commitProjectCreation">,
    options?: CreativeProjectCommitOptions,
  ) {
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
    input: ReadInput<"commitProjectMetadata">,
    options?: CreativeProjectCommitOptions,
  ) {
    const authority = captureCreativeProjectCommitAuthority(options);
    const detached = creativeStoreRecord(input);
    const kind = creativeMutationKind(detached.kind);
    if (kind !== "rename-project" && kind !== "set-project-state")
      creativeStoreFailure("creative_project_mutation_kind_invalid");
    const result = await this.#commit(
      prepareCreativeMutation(kind, detached),
      authority,
    );
    if (result.kind !== "rename-project" && result.kind !== "set-project-state")
      throw new Error("creative_project_receipt_invalid");
    return result;
  }

  async commitProjectBrief(
    input: ReadInput<"commitProjectBrief">,
    options?: CreativeProjectCommitOptions,
  ) {
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
    input: ReadInput<"commitConceptRevision">,
    options?: CreativeProjectCommitOptions,
  ) {
    const authority = captureCreativeProjectCommitAuthority(options);
    const detached = creativeStoreRecord(input);
    const kind = creativeMutationKind(detached.kind);
    if (kind !== "create-concept" && kind !== "append-concept")
      creativeStoreFailure("creative_project_mutation_kind_invalid");
    const result = await this.#commit(
      prepareCreativeMutation(kind, detached),
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
    const identity = creativeMutationIdentity({
      actor: prepared.actor,
      receipt: prepared.receipt,
      kind: prepared.kind,
    });
    const qualification = creativeProjectPluginCommitQualification(
      authority,
      identity.actor,
      identity.kind,
    );
    const runQualification = projectRunCommitQualification(
      authority,
      identity.actor,
      identity.kind,
      identity.receipt,
    );
    const assertLegacy = postgresCreativeProjectLegacyMutationFence({
      schema: this.#schema,
      project: prepared.project,
      identity,
    });
    return this.#transaction(
      async (client, access) => {
        await assertPostgresProjectRunCommit(
          client,
          this.#schema,
          runQualification,
        );
        if (qualification !== undefined) {
          await assertPostgresPluginInstallationPinSchema(client, this.#schema);
          const installation = await admitPostgresPluginInstallationPin(
            client,
            this.#schema,
            qualification.pin,
          );
          assertCreativeProjectPluginCommitSelection(
            qualification,
            installation,
          );
          await assertCreativeProjectCommitTransactionCurrent(authority);
          assertCreativeProjectCommitActive(authority);
          this.#assertOpen();
        }
        // Receipt first: retries may prepare a different server-generated project ID.
        await this.#lock(client, [
          "creative-project-receipt",
          this.#schema,
          ...creativeOwnerValues(identity.owner),
          identity.actor.actorId,
          identity.kind,
          identity.receipt.idempotencyKey,
        ]);
        await assertLegacy(client, access);
        const planResult = await beginPostgresPlanResult(
          client,
          this.#schema,
          runQualification,
        );
        const previous = await this.#receipt(client, identity, access);
        if (previous !== null) {
          await finishPostgresPlanResult(
            client,
            this.#schema,
            planResult,
            previous,
          );
          return previous;
        }
        await this.#lock(client, [
          "creative-project-project",
          this.#schema,
          prepared.project.tenantId,
          prepared.project.spaceId,
          prepared.project.projectId,
        ]);
        const project = await this.#project(
          client,
          identity.owner,
          prepared.project.projectId,
          access,
        );
        const concept =
          prepared.kind === "create-concept" ||
          prepared.kind === "append-concept";
        const brief = concept
          ? await this.#brief(
              client,
              identity.owner,
              prepared.project.projectId,
              prepared.assetRevision.briefRevision,
              access,
            )
          : null;
        const asset = concept
          ? await this.#asset(
              client,
              identity.owner,
              prepared.project.projectId,
              prepared.asset.assetId,
              access,
            )
          : null;
        const result = verifyCreativeMutation(prepared, {
          project,
          brief,
          asset,
        });
        await this.#writeProject(client, result.project, prepared, access);
        if (result.kind === "create-project" || result.kind === "append-brief")
          await this.#insertBrief(client, result.brief);
        if (
          result.kind === "create-concept" ||
          result.kind === "append-concept"
        ) {
          await this.#writeAsset(client, result.asset, prepared, access);
          await this.#insertRevision(client, result.assetRevision);
        }
        await this.#query(
          client,
          `INSERT INTO ${this.#prefix}creative_project_mutation_receipts
         (tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ...creativeOwnerValues(identity.owner),
            identity.actor.actorId,
            identity.kind,
            identity.receipt.idempotencyKey,
            identity.receipt.requestDigest,
            result.project.projectId,
            creativeRecordJson(result),
          ],
        );
        await finishPostgresPlanResult(
          client,
          this.#schema,
          planResult,
          result,
        );
        return result;
      },
      authority,
      runQualification,
      assertLegacy,
    );
  }

  async #project(
    client: QueryClient,
    owner: CreativeProjectOwnerScope,
    projectId: string,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    const rows = await this.#query(
      client,
      `SELECT p.* FROM ${this.#prefix}creative_projects p
       WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND project_id=$4 AND ${access.predicate("p")}`,
      [...creativeOwnerValues(owner), projectId],
    );
    return decodeCreativeProject(rows.rows[0], owner, projectId);
  }

  async #brief(
    client: QueryClient,
    owner: CreativeProjectOwnerScope,
    projectId: string,
    briefRevision: number,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    const rows = await this.#query(
      client,
      `${this.#childSelect("creative_project_briefs", "b")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${access.predicate("p")} AND b.brief_revision=$5`,
      [...creativeOwnerValues(owner), projectId, briefRevision],
    );
    return decodeCreativeBrief(rows.rows[0], owner, projectId);
  }

  async #asset(
    client: QueryClient,
    owner: CreativeProjectOwnerScope,
    projectId: string,
    assetId: string,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    const rows = await this.#query(
      client,
      `${this.#childSelect("creative_concept_assets", "a")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${access.predicate("p")} AND a.asset_id=$5`,
      [...creativeOwnerValues(owner), projectId, assetId],
    );
    return decodeCreativeAsset(rows.rows[0], owner, projectId);
  }

  async #receipt(
    client: QueryClient,
    identity: MutationIdentity,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    return readPostgresLegacyCreativeProjectReceipt({
      client,
      schema: this.#schema,
      identity,
      access,
      assertOpen: this.#assertOpen,
    });
  }

  #childSelect(
    table:
      | "creative_project_briefs"
      | "creative_concept_assets"
      | "creative_concept_revisions",
    alias: string,
  ) {
    return `SELECT ${alias}.*,p.owner_principal_id FROM ${this.#prefix}${table} ${alias}
      JOIN ${this.#prefix}creative_projects p ON p.tenant_id=${alias}.tenant_id
      AND p.space_id=${alias}.space_id AND p.project_id=${alias}.project_id`;
  }

  async #writeProject(
    client: PoolClient,
    project: CreativeProject,
    prepared: PreparedCreativeMutation,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    const values = [
      project.tenantId,
      project.spaceId,
      project.projectId,
      project.ownerPrincipalId,
      project.revision,
      project.state,
      project.latestBriefRevision,
      project.updatedAt,
      creativeRecordJson(project),
    ];
    if (prepared.kind === "create-project") {
      await this.#query(
        client,
        `INSERT INTO ${this.#prefix}creative_projects
         (tenant_id,space_id,project_id,owner_principal_id,revision,state,latest_brief_revision,updated_at,record_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values,
      );
      return;
    }
    const updated = await this.#query(
      client,
      `UPDATE ${this.#prefix}creative_projects AS p
       SET revision=$5,state=$6,latest_brief_revision=$7,updated_at=$8,record_json=$9
       WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND owner_principal_id=$4 AND revision=$10 AND ${access.predicate("p")}`,
      [...values, prepared.expectedProjectRevision],
    );
    if (updated.rowCount !== 1)
      throw new Error("creative_project_revision_conflict");
  }

  async #insertBrief(client: PoolClient, brief: ProjectBriefRevision) {
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}creative_project_briefs
       (tenant_id,space_id,project_id,brief_revision,content_digest,record_json)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        brief.tenantId,
        brief.spaceId,
        brief.projectId,
        brief.briefRevision,
        brief.contentDigest,
        creativeRecordJson(brief),
      ],
    );
  }

  async #writeAsset(
    client: PoolClient,
    asset: ConceptAsset,
    prepared: PreparedCreativeMutation,
    access: PostgresCreativeProjectLegacyAccess,
  ) {
    const values = [
      asset.tenantId,
      asset.spaceId,
      asset.projectId,
      asset.assetId,
      asset.revision,
      asset.latestAssetRevision,
      creativeRecordJson(asset),
    ];
    if (prepared.kind === "create-concept") {
      await this.#query(
        client,
        `INSERT INTO ${this.#prefix}creative_concept_assets
         (tenant_id,space_id,project_id,asset_id,revision,latest_asset_revision,record_json)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        values,
      );
      return;
    }
    if (prepared.kind !== "append-concept")
      throw new Error("creative_project_mutation_invalid");
    const updated = await this.#query(
      client,
      `UPDATE ${this.#prefix}creative_concept_assets AS a
       SET revision=$5,latest_asset_revision=$6,record_json=$7
       WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND asset_id=$4 AND revision=$8 AND ${access.predicate("a")}`,
      [...values, prepared.expectedAssetMetadataRevision],
    );
    if (updated.rowCount !== 1)
      throw new Error("creative_project_asset_revision_conflict");
  }

  async #insertRevision(client: PoolClient, revision: ConceptAssetRevision) {
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}creative_concept_revisions
       (tenant_id,space_id,project_id,asset_id,asset_revision,brief_revision,brief_content_digest,content_digest,record_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        revision.tenantId,
        revision.spaceId,
        revision.projectId,
        revision.assetId,
        revision.assetRevision,
        revision.briefRevision,
        revision.briefContentDigest,
        revision.contentDigest,
        creativeRecordJson(revision),
      ],
    );
  }

  #required<T>(value: T | null): T {
    if (value === null) throw new Error("creative_project_record_invalid");
    return value;
  }

  async #lock(client: PoolClient, key: readonly unknown[]) {
    await this.#query(
      client,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify(key)],
    );
  }

  async #query(client: QueryClient, sql: string, values: unknown[] = []) {
    this.#assertOpen();
    const result = await client.query<Record<string, unknown>>(sql, values);
    this.#assertOpen();
    return result;
  }

  async #transaction<T>(
    body: PostgresCreativeProjectLegacyRead<T>,
    authority?: CreativeProjectCommitAuthority,
    runQualification?: ProjectRunQualification,
    assertLegacy?: PostgresCreativeProjectLegacyMutationFence,
  ): Promise<T> {
    this.#assertOpen();
    if (authority !== undefined) {
      await assertCreativeProjectCommitCurrent(authority);
      assertCreativeProjectCommitActive(authority);
      this.#assertOpen();
    }
    const client = await this.#pool.connect();
    try {
      await this.#query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
      await lockPostgresCreativeProjectLegacySchema(client, this.#schema);
      const access = await capturePostgresCreativeProjectLegacyAccess(
        client,
        this.#schema,
      );
      const result = await body(client, access);
      // Revalidate after all SQL awaits, including lock waits and the final receipt INSERT.
      if (authority !== undefined)
        await assertCreativeProjectCommitTransactionCurrent(authority);
      await assertPostgresProjectRunLease(
        client,
        this.#schema,
        runQualification,
      );
      await finishPostgresCreativeProjectLegacyMutation({
        client,
        schema: this.#schema,
        assertLegacy,
        authority,
        runQualification,
      });
      assertCreativeProjectCommitActive(authority);
      // A confirmed COMMIT remains successful even if the host closes while awaiting it.
      this.#assertOpen();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }

  #read<T>(read: PostgresCreativeProjectLegacyRead<T>): Promise<T> {
    return readPostgresLegacyCreativeProject(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#assertOpen },
      read,
    );
  }
}
