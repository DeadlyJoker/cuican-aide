import {
  RunStoreError,
  type ActivateAgentVersionReleaseResult,
  type ActiveAgentVersionRelease,
  type AgentVersionAsset,
  type AgentVersionDeployment,
  type AgentVersionReleaseActivation,
  type AgentVersionReleaseBundle,
  type AbortModelProviderSettingsInput,
  type AbortModelProviderSettingsResult,
  type FinalizeModelProviderSettingsInput,
  type FinalizeModelProviderSettingsResult,
  type ExpireModelProviderSettingsInput,
  type ExpireModelProviderSettingsResult,
  type ModelProviderSettingsState,
  type PrepareModelProviderSettingsInput,
  type PrepareModelProviderSettingsResult,
  type DomainStore,
  type CommitRunInput,
  type DecideToolApprovalInput,
  type ExpireToolApprovalInput,
  type RequireToolApprovalInput,
  type RegisterAgentVersionResult,
  type SupersedeToolApprovalInput,
  type ToolApprovalActionLocator,
  type ToolApprovalCommitResult,
  type ToolApprovalLocator,
  type ToolApprovalRunLocator,
} from "@crewon/application";
import {
  ToolApprovalError,
  decideToolApproval as decideApproval,
  terminateToolApproval,
  validateToolApprovalState,
  type ToolApprovalState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import { type Pool, type PoolClient } from "pg";

import {
  POSTGRES_AGENT_VERSION_SCHEMA_VERSION,
  postgresAgentVersionSchemaSql,
} from "./postgres-agent-version-schema.ts";
import {
  lockPostgresRunCommit,
  PostgresExecutionStore,
} from "./postgres-execution-store.ts";
import {
  insertPostgresToolApproval,
  loadLatestPostgresToolApprovalForRun,
  loadPostgresToolApproval,
  loadPostgresToolApprovalByAction,
  updatePostgresToolApproval,
} from "./postgres-tool-approvals.ts";
import { loadPostgresToolExecutionReceipt } from "./postgres-tool-execution.ts";
import {
  assertPostgresSchemaNotNewer,
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import {
  POSTGRES_MODEL_PROVIDER_SETTINGS_SCHEMA_VERSION,
  migratePostgresModelProviderSettingsSchema,
} from "./postgres-model-provider-settings-schema.ts";
import {
  abortPostgresModelProviderSettings,
  expirePostgresModelProviderSettings,
  finalizePostgresModelProviderSettings,
  loadPostgresModelProviderSettingsState,
  preparePostgresModelProviderSettings,
} from "./postgres-model-provider-settings-store.ts";
import { type PostgresThreadStoreOptions } from "./postgres-thread-store.ts";
import { requireNonEmpty, validateQueueRetry } from "./store-invariants.ts";
import {
  sameAgentVersionAsset,
  sameAgentVersionDeploymentCandidate,
  sameAgentVersionReleaseActivation,
  sameAgentVersionReleaseBundle,
  validateAgentVersionAsset,
  validateAgentVersionDeployment,
  validateAgentVersionReleaseActivation,
  validateAgentVersionReleaseActivationLocator,
  validateAgentVersionReleaseBundle,
  validateAgentVersionReleaseLocator,
  validateAgentVersionReleaseTenant,
  validateAgentVersionList,
  validateAgentVersionLocator,
} from "./agent-version-store-invariants.ts";

/** Complete PostgreSQL domain authority for Control API and Runtime Workers. */
export class PostgresDomainStore
  extends PostgresExecutionStore
  implements DomainStore
{
  static override async open(
    options: PostgresThreadStoreOptions,
  ): Promise<PostgresDomainStore> {
    const store = new PostgresDomainStore(options);
    try {
      await store.migrate();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  override async migrate(): Promise<void> {
    await super.migrate();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `crewon:${this.schema}:agent-version-authority`,
      ]);
      await assertPostgresSchemaNotNewer(
        client,
        this.schemaSql(),
        "agent_version_authority",
        POSTGRES_AGENT_VERSION_SCHEMA_VERSION,
      );
      await client.query(postgresAgentVersionSchemaSql(this.schemaSql()));
      const result = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaSql()}.schema_migrations
         WHERE component = 'agent_version_authority'`,
      );
      const version = result.rows[0]?.version;
      if (version !== POSTGRES_AGENT_VERSION_SCHEMA_VERSION) {
        throw new RunStoreError(
          version !== undefined &&
          version > POSTGRES_AGENT_VERSION_SCHEMA_VERSION
            ? "postgres_schema_too_new"
            : "postgres_schema_version_unsupported",
        );
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `crewon:${this.schema}:model-provider-settings-authority`,
      ]);
      await migratePostgresModelProviderSettingsSchema(
        client,
        this.schemaSql(),
        this.schema,
      );
      const providerSettingsVersion = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaSql()}.schema_migrations
         WHERE component = 'model_provider_settings_authority'`,
      );
      if (
        providerSettingsVersion.rows[0]?.version !==
        POSTGRES_MODEL_PROVIDER_SETTINGS_SCHEMA_VERSION
      ) {
        throw new RunStoreError("postgres_schema_version_unsupported");
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async loadModelProviderSettingsState(input: {
    tenantId: string;
  }): Promise<ModelProviderSettingsState> {
    this.assertOpen();
    requireNonEmpty(input.tenantId, "model_provider_settings_tenant_invalid");
    try {
      return await loadPostgresModelProviderSettingsState(
        this.pool,
        this.schemaSql(),
        input.tenantId,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async prepareModelProviderSettings(
    input: PrepareModelProviderSettingsInput,
  ): Promise<PrepareModelProviderSettingsResult> {
    return this.#withProviderSettingsTransaction((client) =>
      preparePostgresModelProviderSettings(client, this.schemaSql(), input),
    );
  }

  async finalizeModelProviderSettings(
    input: FinalizeModelProviderSettingsInput,
  ): Promise<FinalizeModelProviderSettingsResult> {
    return this.#withProviderSettingsTransaction((client) =>
      finalizePostgresModelProviderSettings(client, this.schemaSql(), input),
    );
  }

  async abortModelProviderSettings(
    input: AbortModelProviderSettingsInput,
  ): Promise<AbortModelProviderSettingsResult> {
    return this.#withProviderSettingsTransaction((client) =>
      abortPostgresModelProviderSettings(client, this.schemaSql(), input),
    );
  }

  async expireModelProviderSettings(
    input: ExpireModelProviderSettingsInput,
  ): Promise<ExpireModelProviderSettingsResult> {
    return this.#withProviderSettingsTransaction((client) =>
      expirePostgresModelProviderSettings(client, this.schemaSql(), input),
    );
  }

  async #withProviderSettingsTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async registerAgentVersion(
    asset: AgentVersionAsset,
  ): Promise<RegisterAgentVersionResult> {
    this.assertOpen();
    validateAgentVersionAsset(asset);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `agent-version:${asset.tenantId}:${asset.agentVersionId}`,
      ]);
      const inserted = await client.query(
        `INSERT INTO ${this.schemaSql()}.agent_versions (
           tenant_id,
           agent_version_id,
           content_digest,
           asset_json,
           created_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
         ON CONFLICT (tenant_id, agent_version_id) DO NOTHING`,
        [
          asset.tenantId,
          asset.agentVersionId,
          asset.contentDigest,
          JSON.stringify(asset),
          asset.createdAt,
        ],
      );
      const existing = await loadPostgresAgentVersion(
        client,
        this.schemaSql(),
        asset,
      );
      if (existing === null) {
        throw new RunStoreError("agent_version_register_failed");
      }
      if (!sameAgentVersionAsset(existing, asset)) {
        throw new RunStoreError("agent_version_id_conflict");
      }
      await client.query("COMMIT");
      return {
        disposition: inserted.rowCount === 1 ? "registered" : "existing",
        asset: structuredClone(existing),
      };
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async loadAgentVersion(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionAsset | null> {
    this.assertOpen();
    validateAgentVersionLocator(input);
    try {
      const asset = await loadPostgresAgentVersion(
        this.pool,
        this.schemaSql(),
        input,
      );
      return asset === null ? null : structuredClone(asset);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async listAgentVersions(input: {
    tenantId: string;
    afterAgentVersionId: string | null;
    limit: number;
  }): Promise<readonly AgentVersionAsset[]> {
    this.assertOpen();
    validateAgentVersionList(input);
    try {
      const result = await this.pool.query<PostgresAgentVersionRow>(
        `SELECT tenant_id, agent_version_id, content_digest, asset_json,
                created_at
         FROM ${this.schemaSql()}.agent_versions
         WHERE tenant_id = $1
           AND ($2::text IS NULL OR agent_version_id > $2)
         ORDER BY agent_version_id ASC
         LIMIT $3`,
        [input.tenantId, input.afterAgentVersionId, input.limit],
      );
      return result.rows.map(decodePostgresAgentVersion);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadAgentVersionDeployment(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionDeployment | null> {
    this.assertOpen();
    validateAgentVersionLocator(input);
    try {
      const deployment = await loadPostgresAgentVersionDeployment(
        this.pool,
        this.schemaSql(),
        input,
      );
      return deployment === null ? null : structuredClone(deployment);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async activateAgentVersionRelease(input: {
    bundle: AgentVersionReleaseBundle;
    activation: AgentVersionReleaseActivation;
    expectedActiveReleaseId: string | null;
  }): Promise<ActivateAgentVersionReleaseResult> {
    this.assertOpen();
    validateAgentVersionReleaseBundle(input.bundle);
    validateAgentVersionReleaseActivation(input.activation);
    validateReleaseActivationInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `agent-version-release:${input.bundle.tenantId}`,
      ]);
      const replayActivation = await loadPostgresAgentVersionReleaseActivation(
        client,
        this.schemaSql(),
        {
          tenantId: input.activation.tenantId,
          activationId: input.activation.activationId,
        },
      );
      if (replayActivation !== null) {
        const replayBundle = await loadPostgresAgentVersionReleaseBundle(
          client,
          this.schemaSql(),
          replayActivation,
        );
        if (
          replayBundle === null ||
          !sameAgentVersionReleaseBundle(replayBundle, input.bundle) ||
          !sameAgentVersionReleaseActivation(replayActivation, input.activation)
        ) {
          throw new RunStoreError("agent_version_release_activation_conflict");
        }
        await client.query("COMMIT");
        return {
          disposition: "replayed",
          release: {
            bundle: structuredClone(replayBundle),
            activation: structuredClone(replayActivation),
          },
        };
      }
      const active = await loadPostgresActiveAgentVersionRelease(
        client,
        this.schemaSql(),
        input.bundle.tenantId,
      );
      if (
        (active?.bundle.releaseId ?? null) !== input.expectedActiveReleaseId ||
        input.activation.previousReleaseId !== input.expectedActiveReleaseId
      ) {
        throw new RunStoreError("agent_version_release_active_conflict");
      }
      const existingBundle = await loadPostgresAgentVersionReleaseBundle(
        client,
        this.schemaSql(),
        input.bundle,
      );
      if (
        existingBundle !== null &&
        !sameAgentVersionReleaseBundle(existingBundle, input.bundle)
      ) {
        throw new RunStoreError("agent_version_release_bundle_conflict");
      }
      const deployments: AgentVersionDeployment[] = [];
      for (const candidate of input.bundle.deployments) {
        const asset = await loadPostgresAgentVersion(
          client,
          this.schemaSql(),
          candidate,
        );
        if (asset === null) {
          throw new RunStoreError("agent_version_release_asset_missing");
        }
        if (asset.contentDigest !== candidate.contentDigest) {
          throw new RunStoreError("agent_version_release_asset_mismatch");
        }
        const existing = await loadPostgresAgentVersionDeployment(
          client,
          this.schemaSql(),
          candidate,
        );
        if (
          existing !== null &&
          !sameAgentVersionDeploymentCandidate(existing, candidate)
        ) {
          throw new RunStoreError("agent_version_deployment_conflict");
        }
        deployments.push({
          ...candidate,
          deployedAt: input.activation.activatedAt,
        });
      }
      await client.query(
        `INSERT INTO ${this.schemaSql()}.agent_version_release_bundles (
           tenant_id, release_id, manifest_digest,
           default_agent_version_id, bundle_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (tenant_id, release_id) DO NOTHING`,
        [
          input.bundle.tenantId,
          input.bundle.releaseId,
          input.bundle.manifestDigest,
          input.bundle.defaultAgentVersionId,
          JSON.stringify(input.bundle),
        ],
      );
      for (const deployment of deployments) {
        await client.query(
          `INSERT INTO ${this.schemaSql()}.agent_version_deployments (
             tenant_id, agent_version_id, content_digest,
             materialization_digest, deployment_json, deployed_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
           ON CONFLICT (tenant_id, agent_version_id) DO NOTHING`,
          [
            deployment.tenantId,
            deployment.agentVersionId,
            deployment.contentDigest,
            deployment.materializationDigest,
            JSON.stringify(deployment),
            deployment.deployedAt,
          ],
        );
      }
      await client.query(
        `INSERT INTO ${this.schemaSql()}.agent_version_release_activations (
           tenant_id, activation_id, release_id, previous_release_id,
           operator_principal_id, operator_actor_id, operator_space_id,
           activation_json, activated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
        [
          input.activation.tenantId,
          input.activation.activationId,
          input.activation.releaseId,
          input.activation.previousReleaseId,
          input.activation.operator.principalId,
          input.activation.operator.actorId,
          input.activation.operator.spaceId,
          JSON.stringify(input.activation),
          input.activation.activatedAt,
        ],
      );
      await client.query(
        `INSERT INTO ${this.schemaSql()}.active_agent_version_releases (
           tenant_id, release_id, activation_id, activated_at
         ) VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (tenant_id) DO UPDATE SET
           release_id=excluded.release_id,
           activation_id=excluded.activation_id,
           activated_at=excluded.activated_at`,
        [
          input.activation.tenantId,
          input.activation.releaseId,
          input.activation.activationId,
          input.activation.activatedAt,
        ],
      );
      await client.query("COMMIT");
      return {
        disposition: "activated",
        release: structuredClone({
          bundle: input.bundle,
          activation: input.activation,
        }),
      };
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async loadAgentVersionReleaseBundle(input: {
    tenantId: string;
    releaseId: string;
  }): Promise<AgentVersionReleaseBundle | null> {
    this.assertOpen();
    validateAgentVersionReleaseLocator(input);
    try {
      const bundle = await loadPostgresAgentVersionReleaseBundle(
        this.pool,
        this.schemaSql(),
        input,
      );
      return bundle === null ? null : structuredClone(bundle);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadAgentVersionReleaseActivation(input: {
    tenantId: string;
    activationId: string;
  }): Promise<AgentVersionReleaseActivation | null> {
    this.assertOpen();
    validateAgentVersionReleaseActivationLocator(input);
    try {
      const activation = await loadPostgresAgentVersionReleaseActivation(
        this.pool,
        this.schemaSql(),
        input,
      );
      return activation === null ? null : structuredClone(activation);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadActiveAgentVersionRelease(input: {
    tenantId: string;
  }): Promise<ActiveAgentVersionRelease | null> {
    this.assertOpen();
    validateAgentVersionReleaseTenant(input);
    try {
      const release = await loadPostgresActiveAgentVersionRelease(
        this.pool,
        this.schemaSql(),
        input.tenantId,
      );
      return release === null ? null : structuredClone(release);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadToolApproval(
    locator: ToolApprovalLocator,
  ): Promise<ToolApprovalState | null> {
    this.assertOpen();
    validateApprovalLocator(locator);
    try {
      return await loadPostgresToolApproval(
        this.pool,
        this.schemaSql(),
        locator,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadToolApprovalByAction(
    locator: ToolApprovalActionLocator,
  ): Promise<ToolApprovalState | null> {
    this.assertOpen();
    validateApprovalActionLocator(locator);
    try {
      return await loadPostgresToolApprovalByAction(
        this.pool,
        this.schemaSql(),
        locator,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadLatestToolApprovalForRun(
    locator: ToolApprovalRunLocator,
  ): Promise<ToolApprovalState | null> {
    this.assertOpen();
    requireNonEmpty(locator.tenantId, "approval_tenant_id_invalid");
    requireNonEmpty(locator.runId, "approval_run_id_invalid");
    try {
      return await loadLatestPostgresToolApprovalForRun(
        this.pool,
        this.schemaSql(),
        locator,
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async requireToolApproval(
    input: RequireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    this.assertOpen();
    validateRequiredApproval(input.approval);
    validateQueueRetry({
      ...input.lease,
      retryAfterMs: input.retryAfterMs,
      reasonCode: "tool_approval_required",
    });
    validateApprovalRunCommit(input.approval, input.commit, "require");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPostgresRunCommit(client, input.commit);
      await this.validateExecutionLeaseWithin(
        client,
        input.approval.tenantId,
        input.approval.runId,
        input.lease,
      );
      const receipt = await loadPostgresToolExecutionReceipt(
        client,
        this.schemaSql(),
        {
          tenantId: input.approval.tenantId,
          runId: input.approval.runId,
          receiptId: input.approval.receiptId,
        },
        true,
      );
      validateApprovalReceiptBinding(input.approval, receipt ?? undefined);
      const run = await this.commitRunWithin(client, input.commit, {
        executionLease: input.lease,
      });
      await insertPostgresToolApproval(
        client,
        this.schemaSql(),
        input.approval,
      );
      await this.retryWorkItemWithin(
        client,
        input.approval.tenantId,
        input.approval.runId,
        input.lease,
        input.retryAfterMs,
        "tool_approval_required",
      );
      await client.query("COMMIT");
      return structuredClone({ approval: input.approval, run });
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async decideToolApproval(
    input: DecideToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    this.assertOpen();
    validateApprovalLocator(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPostgresRunCommit(client, input.commit);
      const current = await loadPostgresToolApproval(
        client,
        this.schemaSql(),
        input,
        true,
      );
      if (current === null) {
        throw new RunStoreError("tool_approval_not_found");
      }
      const approval = decide(current, input);
      validateApprovalRunCommit(approval, input.commit, "decide");
      await validateHeldWorkItem(client, this.schemaSql(), approval);
      const run = await this.commitRunWithin(client, input.commit);
      await updatePostgresToolApproval(
        client,
        this.schemaSql(),
        current,
        approval,
      );
      await wakeWorkItem(client, this.schemaSql(), approval.workItemId);
      await client.query("COMMIT");
      return structuredClone({ approval, run });
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  expireToolApproval(
    input: ExpireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    return this.#terminateApproval(input, "expired");
  }

  supersedeToolApproval(
    input: SupersedeToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    return this.#terminateApproval(input, "superseded");
  }

  async #terminateApproval(
    input: ExpireToolApprovalInput | SupersedeToolApprovalInput,
    status: "expired" | "superseded",
  ): Promise<ToolApprovalCommitResult> {
    this.assertOpen();
    validateApprovalLocator(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPostgresRunCommit(client, input.commit);
      const current = await loadPostgresToolApproval(
        client,
        this.schemaSql(),
        input,
        true,
      );
      if (current === null) {
        throw new RunStoreError("tool_approval_not_found");
      }
      await this.validateExecutionLeaseWithin(
        client,
        current.tenantId,
        current.runId,
        input.lease,
      );
      const approval = terminate(current, input, status);
      validateApprovalRunCommit(approval, input.commit, "decide");
      const run = await this.commitRunWithin(client, input.commit, {
        executionLease: input.lease,
      });
      await updatePostgresToolApproval(
        client,
        this.schemaSql(),
        current,
        approval,
      );
      await client.query("COMMIT");
      return structuredClone({ approval, run });
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
}

function validateApprovalLocator(locator: ToolApprovalLocator): void {
  requireNonEmpty(locator.tenantId, "approval_tenant_id_invalid");
  requireNonEmpty(locator.approvalId, "approval_id_invalid");
}

function validateApprovalActionLocator(
  locator: ToolApprovalActionLocator,
): void {
  requireNonEmpty(locator.tenantId, "approval_tenant_id_invalid");
  requireNonEmpty(locator.runId, "approval_run_id_invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(locator.actionDigest)) {
    throw new RunStoreError("approval_action_digest_invalid");
  }
}

function validateRequiredApproval(approval: ToolApprovalState): void {
  try {
    validateToolApprovalState(approval);
  } catch (error) {
    throw normalizeToolApprovalError(error);
  }
  if (approval.status !== "required") {
    throw new RunStoreError("tool_approval_not_required");
  }
}

function validateApprovalReceiptBinding(
  approval: ToolApprovalState,
  receipt: ToolExecutionReceiptState | undefined,
): void {
  if (
    receipt === undefined ||
    receipt.tenantId !== approval.tenantId ||
    receipt.runId !== approval.runId ||
    receipt.receiptId !== approval.receiptId ||
    receipt.workItemId !== approval.workItemId ||
    receipt.actionDigest !== approval.actionDigest ||
    receipt.actionIntent === null ||
    receipt.actionIntent.policySnapshotId !== approval.policySnapshotId ||
    receipt.actionIntent.approvalRequirement !== "perAction"
  ) {
    throw new RunStoreError("tool_approval_receipt_mismatch");
  }
}

function validateApprovalRunCommit(
  approval: ToolApprovalState,
  commit: CommitRunInput,
  phase: "require" | "decide",
): void {
  const event = commit.events[0];
  if (
    commit.tenantId !== approval.tenantId ||
    commit.events.length !== 1 ||
    event?.identity.runId !== approval.runId ||
    commit.workItems.length !== 0 ||
    (phase === "require" &&
      (event?.type !== "run.approval.required" ||
        event.data.approvalId !== approval.approvalId ||
        event.data.actionDigest !== approval.actionDigest)) ||
    (phase === "decide" &&
      (event?.type !== "run.resumed" ||
        event.data.reasonCode !== `tool_approval_${approval.status}`))
  ) {
    throw new RunStoreError("tool_approval_run_commit_mismatch");
  }
}

function decide(
  current: ToolApprovalState,
  input: DecideToolApprovalInput,
): ToolApprovalState {
  try {
    return decideApproval(current, {
      ...input.decision,
      expectedRevision: input.expectedRevision,
    });
  } catch (error) {
    throw normalizeToolApprovalError(error);
  }
}

function terminate(
  current: ToolApprovalState,
  input: ExpireToolApprovalInput | SupersedeToolApprovalInput,
  status: "expired" | "superseded",
): ToolApprovalState {
  try {
    return terminateToolApproval(current, {
      status,
      expectedRevision: input.expectedRevision,
      reasonCode:
        status === "expired"
          ? "decision_deadline_reached"
          : "run_cancel_requested",
      occurredAt: input.occurredAt,
    });
  } catch (error) {
    throw normalizeToolApprovalError(error);
  }
}

function normalizeToolApprovalError(error: unknown): Error {
  return error instanceof ToolApprovalError
    ? new RunStoreError(error.code, { cause: error })
    : error instanceof Error
      ? error
      : new RunStoreError("tool_approval_error", { cause: error });
}

async function validateHeldWorkItem(
  client: PoolClient,
  schema: string,
  approval: ToolApprovalState,
): Promise<void> {
  const result = await client.query<{
    tenant_id: string;
    run_id: string;
    status: string;
    lease_owner_id: string | null;
    lease_id: string | null;
    lease_expires_at: Date | string | null;
  }>(
    `SELECT tenant_id, run_id, status, lease_owner_id, lease_id,
            lease_expires_at
     FROM ${schema}.work_items WHERE work_item_id=$1 FOR UPDATE`,
    [approval.workItemId],
  );
  const row = result.rows[0];
  if (
    row?.tenant_id !== approval.tenantId ||
    row.run_id !== approval.runId ||
    row.status !== "pending" ||
    row.lease_owner_id !== null ||
    row.lease_id !== null ||
    row.lease_expires_at !== null
  ) {
    throw new RunStoreError("approval_work_item_not_held");
  }
}

async function wakeWorkItem(
  client: PoolClient,
  schema: string,
  workItemId: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE ${schema}.work_items
     SET available_at=clock_timestamp(), last_error_code=NULL
     WHERE work_item_id=$1 AND status='pending'`,
    [workItemId],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("approval_work_item_wake_conflict");
  }
}

async function loadPostgresAgentVersion(
  queryable: Pool | PoolClient,
  schema: string,
  input: { tenantId: string; agentVersionId: string },
): Promise<AgentVersionAsset | null> {
  const result = await queryable.query<PostgresAgentVersionRow>(
    `SELECT tenant_id, agent_version_id, content_digest, asset_json,
            created_at
     FROM ${schema}.agent_versions
     WHERE tenant_id=$1 AND agent_version_id=$2`,
    [input.tenantId, input.agentVersionId],
  );
  const row = result.rows[0];
  return row === undefined ? null : decodePostgresAgentVersion(row);
}

type PostgresAgentVersionRow = Readonly<{
  tenant_id: string;
  agent_version_id: string;
  content_digest: string;
  asset_json: unknown;
  created_at: Date | string;
}>;

function decodePostgresAgentVersion(
  row: PostgresAgentVersionRow,
): AgentVersionAsset {
  try {
    const asset = (
      typeof row.asset_json === "string"
        ? JSON.parse(row.asset_json)
        : row.asset_json
    ) as AgentVersionAsset;
    validateAgentVersionAsset(asset);
    const storedCreatedAt =
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : Date.parse(row.created_at);
    if (
      asset.tenantId !== row.tenant_id ||
      asset.agentVersionId !== row.agent_version_id ||
      asset.contentDigest !== row.content_digest ||
      !Number.isFinite(storedCreatedAt) ||
      Date.parse(asset.createdAt) !== storedCreatedAt
    ) {
      throw new Error("agent_version_columns_mismatch");
    }
    return structuredClone(asset);
  } catch (error) {
    throw new RunStoreError("agent_version_asset_corrupt", { cause: error });
  }
}

async function loadPostgresAgentVersionDeployment(
  queryable: Pool | PoolClient,
  schema: string,
  input: { tenantId: string; agentVersionId: string },
): Promise<AgentVersionDeployment | null> {
  const result = await queryable.query<PostgresAgentVersionDeploymentRow>(
    `SELECT tenant_id, agent_version_id, content_digest,
            materialization_digest, deployment_json, deployed_at
     FROM ${schema}.agent_version_deployments
     WHERE tenant_id=$1 AND agent_version_id=$2`,
    [input.tenantId, input.agentVersionId],
  );
  const row = result.rows[0];
  return row === undefined ? null : decodePostgresAgentVersionDeployment(row);
}

type PostgresAgentVersionDeploymentRow = Readonly<{
  tenant_id: string;
  agent_version_id: string;
  content_digest: string;
  materialization_digest: string;
  deployment_json: unknown;
  deployed_at: Date | string;
}>;

function decodePostgresAgentVersionDeployment(
  row: PostgresAgentVersionDeploymentRow,
): AgentVersionDeployment {
  try {
    const deployment = (
      typeof row.deployment_json === "string"
        ? JSON.parse(row.deployment_json)
        : row.deployment_json
    ) as AgentVersionDeployment;
    validateAgentVersionDeployment(deployment);
    const storedDeployedAt =
      row.deployed_at instanceof Date
        ? row.deployed_at.getTime()
        : Date.parse(row.deployed_at);
    if (
      deployment.tenantId !== row.tenant_id ||
      deployment.agentVersionId !== row.agent_version_id ||
      deployment.contentDigest !== row.content_digest ||
      deployment.materializationDigest !== row.materialization_digest ||
      !Number.isFinite(storedDeployedAt) ||
      Date.parse(deployment.deployedAt) !== storedDeployedAt
    ) {
      throw new Error("agent_version_deployment_columns_mismatch");
    }
    return structuredClone(deployment);
  } catch (error) {
    throw new RunStoreError("agent_version_deployment_corrupt", {
      cause: error,
    });
  }
}

async function loadPostgresAgentVersionReleaseBundle(
  queryable: Pool | PoolClient,
  schema: string,
  input: { tenantId: string; releaseId: string },
): Promise<AgentVersionReleaseBundle | null> {
  const result = await queryable.query<PostgresAgentVersionReleaseBundleRow>(
    `SELECT tenant_id, release_id, manifest_digest,
            default_agent_version_id, bundle_json
     FROM ${schema}.agent_version_release_bundles
     WHERE tenant_id=$1 AND release_id=$2`,
    [input.tenantId, input.releaseId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : decodePostgresAgentVersionReleaseBundle(row);
}

type PostgresAgentVersionReleaseBundleRow = Readonly<{
  tenant_id: string;
  release_id: string;
  manifest_digest: string;
  default_agent_version_id: string;
  bundle_json: unknown;
}>;

function decodePostgresAgentVersionReleaseBundle(
  row: PostgresAgentVersionReleaseBundleRow,
): AgentVersionReleaseBundle {
  try {
    const bundle = (
      typeof row.bundle_json === "string"
        ? JSON.parse(row.bundle_json)
        : row.bundle_json
    ) as AgentVersionReleaseBundle;
    validateAgentVersionReleaseBundle(bundle);
    if (
      bundle.tenantId !== row.tenant_id ||
      bundle.releaseId !== row.release_id ||
      bundle.manifestDigest !== row.manifest_digest ||
      bundle.defaultAgentVersionId !== row.default_agent_version_id
    ) {
      throw new Error("agent_version_release_bundle_columns_mismatch");
    }
    return structuredClone(bundle);
  } catch (error) {
    throw new RunStoreError("agent_version_release_bundle_corrupt", {
      cause: error,
    });
  }
}

async function loadPostgresAgentVersionReleaseActivation(
  queryable: Pool | PoolClient,
  schema: string,
  input: { tenantId: string; activationId: string },
): Promise<AgentVersionReleaseActivation | null> {
  const result =
    await queryable.query<PostgresAgentVersionReleaseActivationRow>(
      `SELECT tenant_id, activation_id, release_id, previous_release_id,
              operator_principal_id, operator_actor_id, operator_space_id,
              activation_json, activated_at
       FROM ${schema}.agent_version_release_activations
       WHERE tenant_id=$1 AND activation_id=$2`,
      [input.tenantId, input.activationId],
    );
  const row = result.rows[0];
  return row === undefined
    ? null
    : decodePostgresAgentVersionReleaseActivation(row);
}

type PostgresAgentVersionReleaseActivationRow = Readonly<{
  tenant_id: string;
  activation_id: string;
  release_id: string;
  previous_release_id: string | null;
  operator_principal_id: string;
  operator_actor_id: string;
  operator_space_id: string;
  activation_json: unknown;
  activated_at: Date | string;
}>;

function decodePostgresAgentVersionReleaseActivation(
  row: PostgresAgentVersionReleaseActivationRow,
): AgentVersionReleaseActivation {
  try {
    const activation = (
      typeof row.activation_json === "string"
        ? JSON.parse(row.activation_json)
        : row.activation_json
    ) as AgentVersionReleaseActivation;
    validateAgentVersionReleaseActivation(activation);
    const storedActivatedAt =
      row.activated_at instanceof Date
        ? row.activated_at.getTime()
        : Date.parse(row.activated_at);
    if (
      activation.tenantId !== row.tenant_id ||
      activation.activationId !== row.activation_id ||
      activation.releaseId !== row.release_id ||
      activation.previousReleaseId !== row.previous_release_id ||
      activation.operator.principalId !== row.operator_principal_id ||
      activation.operator.actorId !== row.operator_actor_id ||
      activation.operator.spaceId !== row.operator_space_id ||
      !Number.isFinite(storedActivatedAt) ||
      Date.parse(activation.activatedAt) !== storedActivatedAt
    ) {
      throw new Error("agent_version_release_activation_columns_mismatch");
    }
    return structuredClone(activation);
  } catch (error) {
    throw new RunStoreError("agent_version_release_activation_corrupt", {
      cause: error,
    });
  }
}

async function loadPostgresActiveAgentVersionRelease(
  queryable: Pool | PoolClient,
  schema: string,
  tenantId: string,
): Promise<ActiveAgentVersionRelease | null> {
  const result = await queryable.query<
    PostgresAgentVersionReleaseBundleRow &
      PostgresAgentVersionReleaseActivationRow
  >(
    `SELECT b.tenant_id, b.release_id, b.manifest_digest,
            b.default_agent_version_id, b.bundle_json,
            a.activation_id, a.previous_release_id,
            a.operator_principal_id, a.operator_actor_id,
            a.operator_space_id, a.activation_json, a.activated_at
     FROM ${schema}.active_agent_version_releases p
     JOIN ${schema}.agent_version_release_bundles b
       ON b.tenant_id=p.tenant_id AND b.release_id=p.release_id
     JOIN ${schema}.agent_version_release_activations a
       ON a.tenant_id=p.tenant_id AND a.activation_id=p.activation_id
     WHERE p.tenant_id=$1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const bundle = decodePostgresAgentVersionReleaseBundle(row);
  const activation = decodePostgresAgentVersionReleaseActivation(row);
  if (
    bundle.tenantId !== activation.tenantId ||
    bundle.releaseId !== activation.releaseId
  ) {
    throw new RunStoreError("agent_version_release_active_corrupt");
  }
  return { bundle, activation };
}

function validateReleaseActivationInput(input: {
  bundle: AgentVersionReleaseBundle;
  activation: AgentVersionReleaseActivation;
}): void {
  if (
    input.activation.tenantId !== input.bundle.tenantId ||
    input.activation.releaseId !== input.bundle.releaseId
  ) {
    throw new RunStoreError("agent_version_release_activation_mismatch");
  }
}
