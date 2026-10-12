import { postgresFoundationStageReadAccess } from "./project-foundation-stage-read.ts";
import { assertPluginTaskCommitActive } from "@crewon/application";
import { capturePluginTaskCommitAuthorityOption } from "./plugin-task-commit-authority-option.ts";
import {
  lockPostgresRunComposition,
  readPostgresRunComposition,
} from "./plugin-run-composition-store-support.ts";
import type { PostgresExtensionTurnHost } from "./postgres-extension-turn-host.ts";
import { assertProjectStageTurnCurrent } from "./project-stage-turn-current.ts";
import {
  capturePluginTaskModelSelectionOption,
  assertPluginTaskModelSelectionTurn,
} from "./plugin-task-model-selection-commit.ts";
import { assertPluginTaskModelSelectionAdmission } from "@crewon/application";
import {
  attachPostgresFoundationRun,
  assertPostgresFoundationTurnCurrent,
  assertPostgresFoundationTurnReplay,
} from "./project-foundation-run-turn.ts";
import {
  captureProjectMediaInputStageTurn,
  assertPostgresMediaInputStageTurn,
  assertMediaInputStageReplay,
  mediaInputStageValues,
} from "./project-media-input-stage-turn.ts";
import { loadPostgresMediaInputStage } from "./project-media-input-stage-markers.ts";
import {
  assertProjectMediaGenerationCurrent,
  assertProjectMediaGenerationActive,
} from "@crewon/application";
import {
  captureProjectMediaGenerationTurn,
  stripProjectMediaGenerationOptions,
  prepareProjectMediaGenerationTurn,
  saveProjectMediaGenerationTurn,
  assertProjectMediaGenerationReplay,
} from "./project-media-generation-turn.ts";
import { loadProjectMediaGenerationLinkPlan } from "./project-media-generation-read.ts";
import { assertPostgresProjectMediaGenerationSchema } from "./project-media-generation-schema.ts";
import { executePostgresMediaGenerationPlan } from "./project-media-generation-transaction.ts";
import { assertProjectMediaConversationTurn } from "./project-media-conversation-turn.ts";
import { assertPostgresConversationSchema } from "./project-conversation-schema.ts";
import type { MaterialPreparationPlan as ProjectMediaInputPlan } from "./project-material-preparation-plan.ts";
import {
  captureProjectAssetStageTurn,
  assertPostgresAssetStageTurn,
  assertAssetStageReplay,
  assetStageValues,
} from "./project-asset-stage-turn.ts";
import { loadPostgresAssetStage } from "./project-asset-stage-markers.ts";
import {
  captureProjectTextPlanTurn,
  beginPostgresPlanTurn,
  finishPostgresPlanTurn,
  assertPlanTurnCurrent,
} from "./project-text-plan-turn.ts";
import { loadPostgresPlanAdmission } from "./project-text-plan-markers.ts";
import { planEqual } from "./project-text-plan-records.ts";
import {
  captureProjectStageTurn,
  assertPostgresProjectStage,
  assertStageReplay,
  loadPostgresStageIfAvailable,
  stageValues,
} from "./project-stage-run-store-support.ts";
import { assertUnmeteredReplay } from "./plugin-task-unmetered-store-support.ts";
import {
  captureUnmeteredTurn,
  savePostgresPluginTaskUnmeteredAdmission,
  verifyPostgresUnmeteredReceipt,
} from "./plugin-task-unmetered-store-support.ts";
import type { PoolClient } from "pg";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnResult,
  CommitTurnStartInput,
  CommitTurnStartResult,
  ExtensionMutationReceipt,
} from "@crewon/application";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
} from "@crewon/application";
import {
  CreditLedgerError,
  type ExtensionScope,
  type ExtensionCreditAdmission,
  type ProjectGenerationLink,
} from "@crewon/domain";
import {
  validateExtensionTurnCommit,
  parseExtensionTurnReceipt,
  extensionTurnCommit,
  extensionTurnResult,
  extensionScopeValues,
} from "./extension-store-records.ts";
import {
  checkedExtensionCreditAdmission,
  assertExtensionCreditReplayPrincipal,
} from "./extension-credit-admission-records.ts";
import {
  checkedPluginQueryTurn,
  loadPostgresPluginQuery,
  assertPluginQueryReplay,
  admitPostgresPluginQuery,
  savePostgresPluginQuery,
} from "./plugin-query-task-store-support.ts";
import {
  checkedPluginTaskAdmission,
  capturePluginTaskTurnInput,
  assertPluginTaskAdmissionReplay,
  loadPostgresPluginTask,
  admitPostgresPluginTask,
  savePostgresPluginTask,
} from "./plugin-task-admission-store-support.ts";
import {
  lockPostgresPluginCreditAccount,
  reservePostgresPluginCreditsWithinTransaction,
} from "./postgres-plugin-credit-reservation.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { assertPostgresProjectGenerationSchema } from "./project-generation-schema.ts";
import {
  captureProjectGeneration,
  assertProjectGenerationReceipt,
  preparePostgresProjectGeneration,
  projectGenerationReadSql,
  projectGenerationLocator,
  decodeProjectGeneration,
  projectGenerationSlotSql,
  projectGenerationSlotValues,
  projectGenerationInsertSql,
  projectGenerationValues,
  type ProjectGenerationCommitOptions,
} from "./project-generation-store-support.ts";
import { admitPostgresProjectGenerationPublication } from "./project-generation-publication-admission.ts";
import { assertPostgresProjectQuerySchema } from "./project-query-schema.ts";
import {
  captureProjectQuery,
  admitPostgresProjectQueryPublication,
  preparePostgresProjectQuery,
  loadPostgresProjectQueryLink,
  assertProjectQueryReceipt,
  projectQueryInsertSql,
  projectQueryValues,
} from "./project-query-store-support.ts";

import {
  captureProjectHistoricalQuery,
  stripProjectHistoricalQueryOptions,
  admitSqliteProjectHistoricalQueryPublication,
  admitPostgresProjectHistoricalQueryPublication,
  prepareSqliteProjectHistoricalQuery,
  preparePostgresProjectHistoricalQuery,
  assertProjectHistoricalQueryReceipt,
  loadSqliteProjectHistoricalQueryLink,
  loadPostgresProjectHistoricalQueryLink,
  projectHistoricalQueryInsertSql,
  projectHistoricalQueryValues,
} from "./project-historical-query-store-support.ts";
import {
  assertSqliteProjectHistoricalQuerySchema,
  assertPostgresProjectHistoricalQuerySchema,
} from "./project-historical-query-schema.ts";
import {
  assertSqliteHistoricalQueryMarker,
  assertPostgresHistoricalQueryMarker,
} from "./project-historical-query-marker.ts";

/** Keeps optional metadata association inside the original Turn/Run/hold transaction. */
export async function commitPostgresExtensionTurn(
  host: PostgresExtensionTurnHost,
  input: CommitExtensionTurnInput,
  options?: ProjectGenerationCommitOptions,
) {
  const invocation = capturePluginTaskCommitAuthorityOption(options);
  options = invocation.options;
  const selectedModel = capturePluginTaskModelSelectionOption(options);
  options = selectedModel.options;
  const media = captureProjectMediaGenerationTurn(
    input,
    checkedPluginTaskAdmission(input),
    host.projectMediaGenerationsEnabled,
    options,
  );
  options = stripProjectMediaGenerationOptions(options);
  if (media !== null)
    input = { ...input, projectMediaGeneration: media.reference };
  const historicalQuery = captureProjectHistoricalQuery(
    input,
    checkedPluginQueryTurn(input),
    host.projectHistoricalQueriesEnabled,
    options,
  );
  options = stripProjectHistoricalQueryOptions(options);
  if (historicalQuery !== null)
    input = {
      ...input,
      projectHistoricalQuery: {
        reference: historicalQuery.reference,
        generationLinkDigest: historicalQuery.generationLinkDigest,
      },
    };
  const capturedMediaInput = captureProjectMediaInputStageTurn(input, options);
  const mediaInputStage = capturedMediaInput.stage;
  options = capturedMediaInput.options;
  const capturedAsset = captureProjectAssetStageTurn(input, options);
  const assetStage = capturedAsset.stage;
  options = capturedAsset.options;
  const capturedPlan = captureProjectTextPlanTurn(input, options);
  const plan = capturedPlan.plan;
  options = capturedPlan.options;
  await assertPlanTurnCurrent(plan);
  const capturedStage = captureProjectStageTurn(input, options);
  const stage = capturedStage.stage;
  options = capturedStage.options;
  const unmetered = captureUnmeteredTurn(input, host.unmeteredEnabled, options);
  if (unmetered.admission !== undefined)
    input = { ...input, unmeteredAdmission: unmetered.admission };
  options = unmetered.projectOptions;
  const pluginQuery = checkedPluginQueryTurn(input);
  const projectQuery = captureProjectQuery(
    input,
    pluginQuery,
    host.projectQueriesEnabled,
    options,
  );
  if (projectQuery !== null)
    input = {
      ...input,
      projectQuery: {
        reference: projectQuery.reference,
        generationLinkDigest: projectQuery.generationLinkDigest,
      },
    };
  // Retain one snapshot while the PostgreSQL transaction awaits independent Store operations.
  // Validate v1 exact fields/accessors before clone can flatten or invoke them.
  const pluginAdmission = checkedPluginTaskAdmission(input);
  const prepared = captureProjectGeneration(
    input,
    pluginAdmission,
    host.projectGenerationsEnabled,
    options,
  );
  const prefix = creativeProjectSchemaName(host.schema);
  if (prepared !== null) {
    input = { ...input, projectGeneration: prepared.reference };
  }
  const frozenInput =
    pluginAdmission === undefined
      ? structuredClone(input)
      : capturePluginTaskTurnInput(input, pluginAdmission);
  await assertProjectStageTurnCurrent(
    [mediaInputStage, assetStage, stage],
    "before",
  );
  const binding = validateExtensionTurnCommit(frozenInput);
  await assertPluginTaskModelSelectionTurn(
    selectedModel.selection,
    frozenInput,
    binding,
    pluginAdmission,
  );
  if (unmetered.authority !== undefined) {
    await unmetered.authority.assertCurrent();
    unmetered.authority.assertActive();
  }
  if (prepared !== null)
    await assertCreativeProjectCommitCurrent(prepared.authority);
  assertCreativeProjectCommitActive(prepared?.authority);
  if (projectQuery !== null)
    await assertCreativeProjectCommitCurrent(projectQuery.authority);
  assertCreativeProjectCommitActive(projectQuery?.authority);
  if (historicalQuery !== null)
    await assertCreativeProjectCommitCurrent(historicalQuery.authority);
  assertCreativeProjectCommitActive(historicalQuery?.authority);
  if (media !== null)
    await assertProjectMediaGenerationCurrent(media.authority, "before");
  const mediaDialect = {
    postgres: true,
    schema: host.schema,
    prefix: `${prefix}.`,
  };
  let creditPath = false;
  return host.transaction(
    binding,
    async (client) => {
      await lockPostgresRunComposition(client, host.schema, binding);
      const executeMedia = <T>(plan: ProjectMediaInputPlan<T>) =>
        executePostgresMediaGenerationPlan(
          client,
          host.schema,
          plan,
          () => host.assertOpen(),
          media?.authority,
        );
      if (host.projectMediaGenerationsEnabled)
        await assertPostgresProjectMediaGenerationSchema(client, host.schema);
      if (media !== null)
        await assertProjectMediaGenerationCurrent(
          media.authority,
          "transaction",
        );
      if (host.projectGenerationsEnabled)
        await assertPostgresProjectGenerationSchema(client, host.schema);
      if (host.projectQueriesEnabled)
        await assertPostgresProjectQuerySchema(client, host.schema);
      if (projectQuery !== null)
        await admitPostgresProjectQueryPublication(
          client,
          host.schema,
          projectQuery,
        );
      if (historicalQuery !== null) {
        await assertPostgresProjectHistoricalQuerySchema(client, host.schema);
        await admitPostgresProjectHistoricalQueryPublication(
          client,
          host.schema,
          historicalQuery,
        );
      }
      const replay = await host.receipt(
        client,
        binding,
        "task",
        frozenInput.receipt,
      );
      if (media?.authority.conversation !== undefined) {
        await assertPostgresConversationSchema(client, host.schema);
        await executeMedia(
          assertProjectMediaConversationTurn(mediaDialect, media, input),
        );
      } else if (assetStage === null && mediaInputStage === null)
        await assertPostgresProjectStage(
          client,
          host.schema,
          stage,
          frozenInput,
          replay === null,
          prepared ?? projectQuery ?? historicalQuery,
        );
      await assertPostgresMediaInputStageTurn(
        client,
        host.schema,
        mediaInputStage,
        replay === null,
      );
      await assertPostgresAssetStageTurn(
        client,
        host.schema,
        assetStage,
        replay === null,
      );
      const planCheckpoint = await beginPostgresPlanTurn(
        client,
        host.schema,
        plan,
        replay !== null,
      );
      if (replay !== null) {
        const result = parseExtensionTurnReceipt(
          replay,
          binding,
          frozenInput.receipt,
        );
        await verifyPostgresUnmeteredReceipt(client, host.schema, result);
        assertUnmeteredReplay(result.unmeteredAdmission, unmetered.admission);
        if (host.projectMediaGenerationsEnabled)
          assertProjectMediaGenerationReplay(
            media,
            await executeMedia(
              loadProjectMediaGenerationLinkPlan(mediaDialect, {
                tenantId: result.binding.tenantId,
                spaceId: result.binding.spaceId,
                runId: result.binding.runId,
              }),
            ),
            { binding: result.binding, receipt: frozenInput.receipt },
          );
        assertExtensionCreditReplayPrincipal({
          saved: result.creditAdmission,
          requested: frozenInput.creditAdmission,
        });
        creditPath = result.creditAdmission !== undefined;
        await readPostgresRunComposition(client, host.schema, result.binding);
        await host.assertCreditLink(client, result.creditAdmission);
        if (pluginAdmission !== undefined)
          assertPluginTaskAdmissionReplay({
            requested: pluginAdmission,
            saved: await loadPostgresPluginTask(
              client,
              host.schema,
              result.binding,
            ),
            binding: result.binding,
            receipt: frozenInput.receipt,
            creditAdmission: result.creditAdmission,
            unmeteredAdmission: result.unmeteredAdmission,
          });
        if (pluginQuery !== undefined)
          assertPluginQueryReplay(
            pluginQuery,
            await loadPostgresPluginQuery(client, host.schema, result.binding),
            result.binding,
            frozenInput.receipt,
          );
        if (host.projectGenerationsEnabled) {
          const rows = await client.query(
            projectGenerationReadSql(`${prefix}.`, true),
            projectGenerationLocator(result.binding),
          );
          assertProjectGenerationReceipt({
            prepared,
            link: decodeProjectGeneration(rows.rows[0], result.binding),
            binding: result.binding,
            receipt: frozenInput.receipt,
          });
        }
        if (prepared !== null)
          await assertCreativeProjectCommitCurrent(prepared.authority);
        if (host.projectQueriesEnabled)
          assertProjectQueryReceipt(
            projectQuery,
            await loadPostgresProjectQueryLink(
              client,
              host.schema,
              result.binding,
            ),
            result.binding,
            frozenInput.receipt,
          );
        if (projectQuery !== null)
          await assertCreativeProjectCommitCurrent(projectQuery.authority);
        await assertPostgresHistoricalQueryMarker(
          client,
          host.schema,
          result.binding,
          historicalQuery,
        );
        if (historicalQuery !== null)
          assertProjectHistoricalQueryReceipt(
            historicalQuery,
            await loadPostgresProjectHistoricalQueryLink(
              client,
              host.schema,
              result.binding,
            ),
            result.binding,
            frozenInput.receipt,
          );
        if (historicalQuery !== null)
          await assertCreativeProjectCommitCurrent(historicalQuery.authority);
        assertStageReplay(
          stage,
          await loadPostgresStageIfAvailable(
            client,
            host.schema,
            result.binding,
          ),
        );
        await assertPostgresFoundationTurnReplay(
          client,
          host.schema,
          stage?.admission ?? null,
          frozenInput,
          stage?.readScope === undefined ||
            stage.admission.stage.kind !== "discussion"
            ? undefined
            : await postgresFoundationStageReadAccess(client, host.schema, {
                scope: stage.readScope,
                stage: stage.admission,
                authority: stage.authority,
              }),
        );
        await stage?.authority.assertTransactionCurrent();
        await assetStage?.authority.assertTransactionCurrent();
        await mediaInputStage?.authority.assertTransactionCurrent();
        await plan?.q.authority.assertTransactionCurrent();
        const savedMediaInput = await loadPostgresMediaInputStage(
          client,
          host.schema,
          result.binding,
        );
        assertMediaInputStageReplay(mediaInputStage, savedMediaInput);
        const savedAsset = await loadPostgresAssetStage(
          client,
          host.schema,
          result.binding,
        );
        assertAssetStageReplay(assetStage, savedAsset);
        const savedPlan = await loadPostgresPlanAdmission(
          client,
          host.schema,
          result.binding,
        );
        planEqual(
          plan?.admission ?? null,
          savedPlan,
          "project_text_plan_admission_conflict",
        );
        if (media !== null)
          await assertProjectMediaGenerationCurrent(
            media.authority,
            "transaction",
          );
        return {
          ...result,
          ...(savedPlan === null
            ? {}
            : { projectTextPlanAdmission: savedPlan }),
          ...(savedMediaInput === null
            ? {}
            : { projectMediaInputStageAdmission: savedMediaInput }),
          ...(savedAsset === null
            ? {}
            : { projectAssetStageAdmission: savedAsset }),
        };
      }
      const creditAdmission = checkedExtensionCreditAdmission({
        admission: frozenInput.creditAdmission,
        binding,
        receipt: frozenInput.receipt,
      });
      creditPath = creditAdmission !== undefined;
      if (prepared?.publication !== undefined)
        await admitPostgresProjectGenerationPublication(
          client,
          host.schema,
          prepared.publication,
        );
      else if (pluginAdmission !== undefined)
        await admitPostgresPluginTask(client, host.schema, pluginAdmission);
      if (pluginQuery !== undefined)
        await admitPostgresPluginQuery(
          client,
          host.schema,
          pluginQuery,
          binding,
        );
      const queryLink =
        projectQuery === null
          ? undefined
          : await preparePostgresProjectQuery(
              client,
              host.schema,
              projectQuery,
              frozenInput,
              pluginQuery!,
            );
      const historicalLink =
        historicalQuery === null
          ? undefined
          : await preparePostgresProjectHistoricalQuery(
              client,
              host.schema,
              historicalQuery,
              frozenInput,
              pluginQuery!,
            );
      await host.admit(
        client,
        binding,
        frozenInput.expectedActivationRevision,
        {
          modelSelection: selectedModel.selection,
          queryAdmission: pluginQuery,
        },
      );
      const mediaLink =
        media === null
          ? null
          : await executeMedia(
              prepareProjectMediaGenerationTurn(
                mediaDialect,
                media,
                frozenInput,
              ),
            );
      let projectLink: ProjectGenerationLink | undefined;
      if (prepared !== null) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [
            JSON.stringify([
              "creative-project-project",
              host.schema,
              binding.tenantId,
              binding.spaceId,
              prepared.reference.projectId,
            ]),
          ],
        );
        projectLink = await preparePostgresProjectGeneration(
          prepared,
          frozenInput,
          `${prefix}.`,
          async (sql, values) => (await client.query(sql, [...values])).rows,
        );
        const occupied = await client.query(
          projectGenerationSlotSql(`${prefix}.`, true),
          projectGenerationSlotValues(projectLink),
        );
        if (occupied.rows.length !== 0)
          throw new Error("project_generation_slot_occupied");
        assertCreativeProjectCommitActive(prepared.authority);
      }
      if (creditAdmission !== undefined) {
        await lockPostgresPluginCreditAccount({
          client,
          schema: host.schema,
          scope: creditAdmission.reservation.scope,
          assertOpen: () => host.assertOpen(),
        });
        try {
          await reservePostgresPluginCreditsWithinTransaction({
            client,
            schema: host.schema,
            input: creditAdmission.reservation,
            assertOpen: () => host.assertOpen(),
            requireNew: true,
          });
        } catch (error) {
          if (
            error instanceof CreditLedgerError &&
            (error.code === "plugin_credit_idempotency_conflict" ||
              error.code === "plugin_credit_reservation_id_conflict")
          )
            throw new Error("extension_credit_orphaned_reservation", {
              cause: error,
            });
          throw error;
        }
      }
      const turn = await host.commitTurn(
        client,
        extensionTurnCommit(frozenInput),
      );
      if (
        turn.disposition !== "committed" ||
        turn.runState.runId !== binding.runId
      )
        throw new Error("extension_unbound_turn_receipt");
      await client.query(
        `INSERT INTO ${prefix}.extension_run_bindings VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          ...extensionScopeValues(binding),
          binding.runId,
          binding.configurationRevision,
          binding,
        ],
      );
      if (creditAdmission !== undefined)
        await client.query(
          `INSERT INTO ${prefix}.extension_credit_admissions VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            binding.tenantId,
            binding.spaceId,
            binding.runId,
            creditAdmission.reservation.scope.principalId,
            creditAdmission.reservation.scope.poolId,
            creditAdmission.reservation.reservationId,
            JSON.stringify(creditAdmission),
          ],
        );
      if (pluginAdmission !== undefined)
        await savePostgresPluginTask(
          client,
          host.schema,
          pluginAdmission,
          stage?.admission.contentDigest,
          plan?.admission.contentDigest,
          assetStage?.admission.contentDigest,
          mediaInputStage === null
            ? undefined
            : { stageDigest: mediaInputStage.admission.contentDigest },
        );
      if (unmetered.admission !== undefined)
        await savePostgresPluginTaskUnmeteredAdmission(
          client,
          host.schema,
          unmetered.admission,
        );
      if (pluginQuery !== undefined)
        await savePostgresPluginQuery(
          client,
          host.schema,
          pluginQuery,
          historicalLink?.contentDigest,
        );
      const result = extensionTurnResult(
        turn,
        binding,
        creditAdmission,
        unmetered.admission,
      );
      await host.saveReceipt(
        client,
        binding,
        "task",
        frozenInput.receipt,
        result,
      );
      if (mediaLink !== null)
        await executeMedia(
          saveProjectMediaGenerationTurn(mediaDialect, mediaLink),
        );
      if (projectLink !== undefined)
        await client.query(
          projectGenerationInsertSql(`${prefix}.`, true),
          projectGenerationValues(projectLink),
        );
      if (queryLink !== undefined)
        await client.query(
          projectQueryInsertSql(`${prefix}.`, true),
          projectQueryValues(queryLink),
        );
      if (historicalLink !== undefined)
        await client.query(
          projectHistoricalQueryInsertSql(`${prefix}.`, true),
          projectHistoricalQueryValues(historicalLink),
        );
      if (historicalQuery !== null)
        await assertCreativeProjectCommitCurrent(historicalQuery.authority);
      if (mediaInputStage !== null)
        await client.query(
          `INSERT INTO ${prefix}.project_media_input_stage_run_admissions VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [...mediaInputStageValues(mediaInputStage.admission)],
        );
      if (assetStage !== null)
        await client.query(
          `INSERT INTO ${prefix}.project_asset_stage_run_admissions VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [...assetStageValues(assetStage.admission)],
        );
      if (stage !== null) {
        await client.query(
          `INSERT INTO ${prefix}.project_stage_run_admissions VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [...stageValues(stage.admission)],
        );
        await stage.authority.assertTransactionCurrent();
        await plan?.q.authority.assertTransactionCurrent();
      }
      const foundationRun = await attachPostgresFoundationRun(
        client,
        host.schema,
        stage?.admission ?? null,
        frozenInput,
        stage?.readScope === undefined ||
          stage.admission.stage.kind !== "discussion"
          ? undefined
          : await postgresFoundationStageReadAccess(client, host.schema, {
              scope: stage.readScope,
              stage: stage.admission,
              authority: stage.authority,
            }),
      );
      if (prepared !== null)
        await assertCreativeProjectCommitCurrent(prepared.authority);
      if (projectQuery !== null)
        await assertCreativeProjectCommitCurrent(projectQuery.authority);
      if (unmetered.authority !== undefined)
        await unmetered.authority.assertCurrent();
      await finishPostgresPlanTurn(client, host.schema, plan, planCheckpoint);
      await assetStage?.authority.assertTransactionCurrent();
      await mediaInputStage?.authority.assertTransactionCurrent();
      if (media !== null)
        await assertProjectMediaGenerationCurrent(
          media.authority,
          "transaction",
        );
      await assertPostgresFoundationTurnCurrent(
        client,
        host.schema,
        stage?.admission ?? null,
        foundationRun,
        stage?.readScope === undefined ||
          stage.admission.stage.kind !== "discussion"
          ? undefined
          : await postgresFoundationStageReadAccess(client, host.schema, {
              scope: stage.readScope,
              stage: stage.admission,
              authority: stage.authority,
            }),
      );
      return {
        ...result,
        ...(plan === null ? {} : { projectTextPlanAdmission: plan.admission }),
        ...(mediaInputStage === null
          ? {}
          : { projectMediaInputStageAdmission: mediaInputStage.admission }),
        ...(assetStage === null
          ? {}
          : { projectAssetStageAdmission: assetStage.admission }),
      };
    },
    {
      beforeCommit: () => {
        if (media !== null) {
          host.assertOpen();
          assertProjectMediaGenerationActive(media.authority);
        }
        if (selectedModel.selection !== undefined)
          assertPluginTaskModelSelectionAdmission(
            selectedModel.selection,
            binding,
            pluginAdmission,
          );
        stage?.authority.assertActive();
        assetStage?.authority.assertActive();
        mediaInputStage?.authority.assertActive();
        plan?.q.authority.assertActive();
        if (unmetered.authority !== undefined) {
          host.assertOpen();
          unmetered.authority.assertActive();
        }
        if (creditPath) host.assertOpen();
        assertCreativeProjectCommitActive(prepared?.authority);
        assertCreativeProjectCommitActive(projectQuery?.authority);
        assertCreativeProjectCommitActive(historicalQuery?.authority);
        assertPluginTaskCommitActive(
          invocation.authority,
          binding,
          pluginAdmission ?? pluginQuery,
        );
      },
    },
  );
}
