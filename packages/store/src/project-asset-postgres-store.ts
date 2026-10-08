import { assertPostgresAssetVtwoRecoverySchema } from "./project-asset-vtwo-recovery-schema.ts";
import {
  capturePostgresProjectFoundationDownstream,
  assertPostgresProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamCheck,
} from "./project-foundation-downstream-guard.ts";
import {
  loadAssetMutationReceiptPlan,
  type AssetCommitPlan,
} from "./project-asset-vtwo-recovery-commit.ts";
import { assertPostgresProjectMediaOperationSchema } from "./project-media-operation-schema.ts";
import { assertPostgresProjectMediaResultSchema } from "./project-media-result-schema.ts";
import { assertPostgresAssetIntentSchema } from "./project-asset-ui-intent-schema.ts";
import type { Pool, PoolClient } from "pg";
import {
  captureProjectAssetCommitAuthority,
  assertProjectAssetCommitCurrent,
  assertProjectAssetCommitTransactionCurrent,
  assertProjectAssetCommitActive,
  captureProjectGenerationImageResultVerifier,
  type ProjectGenerationImageResultVerifier,
  type ProjectAssetStore,
  type ProjectAssetReferenceImageStore,
  type ProjectAssetCommitAuthority,
  type ProjectAssetCommitOptions,
} from "@crewon/application";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assetHead,
  assetContent,
  assetReference,
  captureAssetIdentity,
  captureAssetCommit,
  type AssetInput,
  type AssetPlan,
} from "./project-asset-store-support.ts";
import {
  captureAssetRead,
  assetPage,
  assetContentPage,
  assetReferencePage,
} from "./project-asset-store-reads.ts";
import {
  assertAssetReceiptQualification,
  commitAssetPlan,
} from "./project-asset-mutation-plan.ts";
import {
  captureAssetReferenceImageRead,
  loadAssetReferenceImagePlan,
} from "./project-asset-reference-image-plan.ts";
import {
  assertPostgresProjectAssetSchema,
  migratePostgresProjectAssets,
} from "./project-asset-schema.ts";
import { assertPostgresProjectAssetQualification } from "./project-asset-qualification.ts";
import { PostgresProjectMaterialPreparationStore } from "./project-material-preparation-postgres-store.ts";
import { PostgresProjectMediaInputStore } from "./project-media-input-postgres-store.ts";

/** One parent pool borrow per operation, including every dependency and final current check. */
export class PostgresProjectAssetStore
  implements ProjectAssetStore, ProjectAssetReferenceImageStore
{
  readonly #pool: Pool;
  readonly #open: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier | undefined;
  readonly #d: Readonly<{ postgres: true; schema: string; prefix: string }>;
  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    verifier?: ProjectGenerationImageResultVerifier;
  }) {
    this.#pool = input.pool;
    this.#open = input.assertOpen.bind(input);
    this.#d = Object.freeze({
      postgres: true,
      schema: input.schema,
      prefix: `${creativeProjectSchemaName(input.schema)}.`,
    });
    this.#verifier =
      input.verifier === undefined
        ? undefined
        : captureProjectGenerationImageResultVerifier(input.verifier);
  }
  async migrate(): Promise<void> {
    await this.#withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await migratePostgresProjectAssets(client, this.#d.schema);
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* Preserve failure. */
        }
        throw error;
      }
    });
  }
  projectMaterialPreparationStore(): PostgresProjectMaterialPreparationStore {
    return new PostgresProjectMaterialPreparationStore({
      pool: this.#pool,
      schema: this.#d.schema,
      assertOpen: this.#open,
      ...(this.#verifier === undefined ? {} : { verifier: this.#verifier }),
    });
  }
  projectMediaInputStore(): PostgresProjectMediaInputStore {
    return new PostgresProjectMediaInputStore({
      pool: this.#pool,
      schema: this.#d.schema,
      assertOpen: this.#open,
      ...(this.#verifier === undefined ? {} : { verifier: this.#verifier }),
    });
  }
  async loadAsset(input: AssetInput<"loadAsset">) {
    const q = captureAssetRead(input, ["assetId"]);
    return this.#read(assetHead(this.#d, q.owner, q.projectId, q.assetId!));
  }
  async loadReferenceImageSource(
    input: Parameters<
      ProjectAssetReferenceImageStore["loadReferenceImageSource"]
    >[0],
  ) {
    const q = captureAssetReferenceImageRead(input);
    return this.#transaction(
      (client) =>
        this.#execute(
          client,
          loadAssetReferenceImagePlan(this.#d, q, this.#verifier),
        ),
      undefined,
    );
  }
  async loadRevision(input: AssetInput<"loadRevision">) {
    const q = captureAssetRead(input, ["assetId", "contentRevision"]);
    return this.#read(
      assetContent(
        this.#d,
        q.owner,
        q.projectId,
        q.assetId!,
        q.contentRevision!,
      ),
    );
  }
  async loadReferenceRevision(input: AssetInput<"loadReferenceRevision">) {
    const q = captureAssetRead(input, ["assetId", "referenceRevision"]);
    return this.#read(
      assetReference(
        this.#d,
        q.owner,
        q.projectId,
        q.assetId!,
        q.referenceRevision!,
      ),
    );
  }
  async listAssets(input: AssetInput<"listAssets">) {
    const q = captureAssetRead(input, ["kind", "afterAssetId", "limit"]);
    return this.#read(assetPage(this.#d, q));
  }
  async listRevisions(input: AssetInput<"listRevisions">) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterContentRevision",
      "limit",
    ]);
    return this.#read(assetContentPage(this.#d, q));
  }
  async listReferences(input: AssetInput<"listReferences">) {
    const q = captureAssetRead(input, [
      "assetId",
      "afterReferenceRevision",
      "limit",
    ]);
    return this.#read(assetReferencePage(this.#d, q));
  }
  async loadMutationReceipt(
    input: AssetInput<"loadMutationReceipt">,
    options?: ProjectAssetCommitOptions,
  ) {
    const identity = captureAssetIdentity(input),
      authority = captureProjectAssetCommitAuthority(options);
    assertAssetReceiptQualification(authority, identity);
    return this.#transaction(
      async (client) =>
        this.#execute(
          client,
          loadAssetMutationReceiptPlan(
            this.#d,
            identity,
            authority,
            this.#verifier,
            await assertPostgresAssetIntentSchema(client, this.#d.schema, true),
          ),
          authority,
        ),
      authority,
    );
  }

  async commitMutation(
    input: AssetInput<"commitMutation">,
    options?: ProjectAssetCommitOptions,
  ) {
    const prepared = captureAssetCommit(input),
      authority = captureProjectAssetCommitAuthority(options);
    let downstream: ProjectFoundationDownstreamCheck | undefined;
    return this.#transaction(
      async (client) =>
        this.#execute(
          client,
          commitAssetPlan(
            this.#d,
            prepared,
            authority,
            this.#verifier,
            await assertPostgresAssetIntentSchema(client, this.#d.schema, true),
          ),
          authority,
          (check) => {
            downstream = check;
          },
        ),
      authority,
      async (client) => {
        if (downstream !== undefined)
          await assertPostgresProjectFoundationDownstreamUnchanged(
            client,
            this.#d.schema,
            downstream.locator,
            downstream.snapshot,
          );
      },
    );
  }
  async #read<T>(plan: AssetPlan<T>): Promise<T> {
    return this.#withClient(async (client) => {
      await assertPostgresProjectAssetSchema(client, this.#d.schema);
      return this.#execute(client, plan);
    });
  }
  async #execute<T>(
    client: PoolClient,
    plan: AssetCommitPlan<T>,
    authority?: ProjectAssetCommitAuthority,
    onFoundationSnapshot?: (check: ProjectFoundationDownstreamCheck) => void,
  ): Promise<T> {
    let next = plan.next();
    while (!next.done) {
      this.#open();
      assertProjectAssetCommitActive(authority);
      const step = next.value;
      let rows: readonly Record<string, unknown>[];
      if ("foundationDownstream" in step) {
        const snapshot = await capturePostgresProjectFoundationDownstream(
          client,
          this.#d.schema,
          step.foundationDownstream,
        );
        onFoundationSnapshot?.({
          locator: step.foundationDownstream,
          snapshot,
        });
        rows = [];
      } else if ("assetVtwoRecoverySchema" in step) {
        rows = [
          {
            available: await assertPostgresAssetVtwoRecoverySchema(
              client,
              this.#d.schema,
              true,
            ),
          },
        ];
      } else if ("mediaOperationSchema" in step) {
        await assertPostgresProjectMediaOperationSchema(client, this.#d.schema);
        rows = [];
      } else if ("mediaResultSchema" in step) {
        await assertPostgresProjectMediaResultSchema(client, this.#d.schema);
        rows = [];
      } else
        rows = (
          await client.query<Record<string, unknown>>(step.sql, [
            ...step.values,
          ])
        ).rows;
      this.#open();
      assertProjectAssetCommitActive(authority);
      next = plan.next(rows);
    }
    return next.value;
  }
  async #withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#open();
    const client = await this.#pool.connect();
    try {
      this.#open();
      return await work(client);
    } finally {
      client.release();
    }
  }
  async #transaction<T>(
    body: (client: PoolClient) => Promise<T>,
    authority: ProjectAssetCommitAuthority | undefined,
    checkDownstream?: (client: PoolClient) => Promise<void>,
  ): Promise<T> {
    this.#open();
    await assertProjectAssetCommitCurrent(authority);
    return this.#withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await assertPostgresProjectAssetSchema(client, this.#d.schema);
        await assertPostgresProjectAssetQualification(
          client,
          this.#d.schema,
          authority,
        );
        const result = await body(client);
        await assertProjectAssetCommitTransactionCurrent(authority);
        await assertPostgresProjectAssetQualification(
          client,
          this.#d.schema,
          authority,
        );
        await checkDownstream?.(client);
        assertProjectAssetCommitActive(authority);
        this.#open();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* Preserve failure. */
        }
        throw error;
      }
    });
  }
}
