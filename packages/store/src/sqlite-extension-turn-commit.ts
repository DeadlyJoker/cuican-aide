import {
  captureProjectMediaInputStageTurn,
  assertSqliteMediaInputStageTurn,
  assertMediaInputStageReplay,
  mediaInputStageValues,
} from "./project-media-input-stage-turn.ts";
import { loadSqliteMediaInputStage } from "./project-media-input-stage-markers.ts";
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
import { assertSqliteProjectMediaGenerationSchema } from "./project-media-generation-schema.ts";
import { executeSqliteMediaGenerationPlan } from "./project-media-generation-transaction.ts";
import { assertProjectMediaConversationTurn } from "./project-media-conversation-turn.ts";
import { assertSqliteConversationSchema } from "./project-conversation-schema.ts";
import type { ProjectMediaInputPlan } from "./project-media-input-plan.ts";
import {
  captureProjectAssetStageTurn,
  assertSqliteAssetStageTurn,
  assertAssetStageReplay,
  assetStageValues,
} from "./project-asset-stage-turn.ts";
import { loadSqliteAssetStage } from "./project-asset-stage-markers.ts";
import {
  captureProjectTextPlanTurn,
  beginSqlitePlanTurn,
  finishSqlitePlanTurn,
  assertPlanTurnCurrent,
} from "./project-text-plan-turn.ts";
import { loadSqlitePlanAdmission } from "./project-text-plan-markers.ts";
import { planEqual } from "./project-text-plan-records.ts";
import {
  captureProjectStageTurn,
  assertSqliteProjectStage,
  assertStageReplay,
  loadSqliteStageIfAvailable,
  stageValues,
} from "./project-stage-run-store-support.ts";
import { assertUnmeteredReplay } from "./plugin-task-unmetered-store-support.ts";
import {
  captureUnmeteredTurn,
  saveSqlitePluginTaskUnmeteredAdmission,
} from "./plugin-task-unmetered-store-support.ts";
import type { DatabaseSync } from "node:sqlite";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnResult,
  CommitTurnStartInput,
  CommitTurnStartResult,
  ExtensionMutationReceipt,
} from "@crewon/application";
import {
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitActive,
} from "@crewon/application";
import {
  CreditLedgerError,
  type ExtensionScope,
  type ExtensionRunBinding,
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
  admitSqlitePluginQuery,
  loadSqlitePluginQuery,
  saveSqlitePluginQuery,
  assertPluginQueryReplay,
} from "./plugin-query-task-store-support.ts";
import {
  admitSqlitePluginTask,
  assertPluginTaskAdmissionReplay,
  capturePluginTaskTurnInput,
  checkedPluginTaskAdmission,
  loadSqlitePluginTask,
  saveSqlitePluginTask,
} from "./plugin-task-admission-store-support.ts";
import { reserveSqlitePluginCreditsWithinTransaction } from "./sqlite-plugin-credit-reservation.ts";
import { assertSqliteProjectGenerationSchema } from "./project-generation-schema.ts";
import {
  captureProjectGeneration,
  assertProjectGenerationReceipt,
  prepareSqliteProjectGeneration,
  projectGenerationReadSql,
  projectGenerationLocator,
  decodeProjectGeneration,
  projectGenerationSlotSql,
  projectGenerationSlotValues,
  projectGenerationInsertSql,
  projectGenerationValues,
  type ProjectGenerationCommitOptions,
} from "./project-generation-store-support.ts";
import { admitSqliteProjectGenerationPublication } from "./project-generation-publication-admission.ts";
import { assertSqliteProjectQuerySchema } from "./project-query-schema.ts";
import {
  captureProjectQuery,
  admitSqliteProjectQueryPublication,
  prepareSqliteProjectQuery,
  loadSqliteProjectQueryLink,
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

type SqliteExtensionTurnHost = Readonly<{
  projectMediaGenerationsEnabled: boolean;
  database: DatabaseSync;
  unmeteredEnabled: boolean;
  projectGenerationsEnabled: boolean;
  projectQueriesEnabled: boolean;
  projectHistoricalQueriesEnabled: boolean;
  assertOpen(): void;
  transaction(
    body: () => CommitExtensionTurnResult,
    options: { beforeCommit(): void },
  ): CommitExtensionTurnResult;
  receipt(
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
  ): unknown | null;
  verifyCreditReceipt(
    result: CommitExtensionTurnResult,
  ): CommitExtensionTurnResult;
  admit(binding: ExtensionRunBinding, expectedRevision: number): void;
  commitTurn(input: CommitTurnStartInput): CommitTurnStartResult;
  saveCreditAdmission(admission: ExtensionCreditAdmission): void;
  saveReceipt(
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
    result: unknown,
  ): void;
}>;

/** Optional project source and explicit task financial mode share the original synchronous SQLite commit. */
export async function commitSqliteExtensionTurn(
  host: SqliteExtensionTurnHost,
  input: CommitExtensionTurnInput,
  options?: ProjectGenerationCommitOptions,
): Promise<CommitExtensionTurnResult> {
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
  if (pluginQuery !== undefined)
    input = structuredClone({ ...input, pluginQueryAdmission: pluginQuery });
  const pluginAdmission = checkedPluginTaskAdmission(input);
  const prepared = captureProjectGeneration(
    input,
    pluginAdmission,
    host.projectGenerationsEnabled,
    options,
  );
  if (prepared !== null)
    input = structuredClone({
      ...input,
      projectGeneration: prepared.reference,
    });
  if (pluginAdmission !== undefined)
    input = capturePluginTaskTurnInput(input, pluginAdmission);
  if (mediaInputStage !== null) {
    await mediaInputStage.authority.assertCurrent();
    await mediaInputStage.authority.assertTransactionCurrent();
    mediaInputStage.authority.assertActive();
  }
  if (assetStage !== null) {
    await assetStage.authority.assertCurrent();
    await assetStage.authority.assertTransactionCurrent();
    assetStage.authority.assertActive();
  }
  if (stage !== null) {
    await stage.authority.assertCurrent();
    await stage.authority.assertTransactionCurrent();
    stage.authority.assertActive();
  }
  const binding = validateExtensionTurnCommit(input);
  const creditAdmission = checkedExtensionCreditAdmission({
    admission: input.creditAdmission,
    binding,
    receipt: input.receipt,
  });
  if (unmetered.authority !== undefined) {
    await unmetered.authority.assertCurrent();
    unmetered.authority.assertActive();
  }
  if (prepared !== null) {
    await assertCreativeProjectCommitCurrent(prepared.authority);
    assertCreativeProjectCommitActive(prepared.authority);
  }
  if (projectQuery !== null) {
    await assertCreativeProjectCommitCurrent(projectQuery.authority);
    assertCreativeProjectCommitActive(projectQuery.authority);
  }
  if (historicalQuery !== null)
    await assertCreativeProjectCommitCurrent(historicalQuery.authority);
  assertCreativeProjectCommitActive(historicalQuery?.authority);
  if (media !== null) {
    await assertProjectMediaGenerationCurrent(media.authority, "before");
    await assertProjectMediaGenerationCurrent(media.authority, "transaction");
  }
  const mediaDialect = { postgres: false, schema: "main", prefix: "" };
  const executeMedia = <T>(plan: ProjectMediaInputPlan<T>) =>
    executeSqliteMediaGenerationPlan(
      host.database,
      plan,
      () => host.assertOpen(),
      media?.authority,
    );
  return host.transaction(
    () => {
      if (host.projectMediaGenerationsEnabled)
        assertSqliteProjectMediaGenerationSchema(host.database);
      if (host.projectGenerationsEnabled)
        assertSqliteProjectGenerationSchema(host.database);
      if (host.projectQueriesEnabled)
        assertSqliteProjectQuerySchema(host.database);
      if (projectQuery !== null)
        admitSqliteProjectQueryPublication(host.database, projectQuery);
      if (historicalQuery !== null) {
        assertSqliteProjectHistoricalQuerySchema(host.database);
        admitSqliteProjectHistoricalQueryPublication(
          host.database,
          historicalQuery,
        );
      }
      const replay = host.receipt(binding, "task", input.receipt);
      if (media?.authority.conversation !== undefined) {
        assertSqliteConversationSchema(host.database);
        executeMedia(
          assertProjectMediaConversationTurn(mediaDialect, media, input),
        );
      } else if (assetStage === null && mediaInputStage === null)
        assertSqliteProjectStage(host.database, stage, input, replay === null);
      assertSqliteAssetStageTurn(host.database, assetStage, replay === null);
      assertSqliteMediaInputStageTurn(
        host.database,
        mediaInputStage,
        replay === null,
      );
      const planCheckpoint = beginSqlitePlanTurn(
        host.database,
        plan,
        replay !== null,
      );
      if (replay !== null) {
        const saved = host.verifyCreditReceipt(
          parseExtensionTurnReceipt(replay, binding, input.receipt),
        );
        assertUnmeteredReplay(saved.unmeteredAdmission, unmetered.admission);
        if (host.projectMediaGenerationsEnabled)
          assertProjectMediaGenerationReplay(
            media,
            executeMedia(
              loadProjectMediaGenerationLinkPlan(mediaDialect, {
                tenantId: saved.binding.tenantId,
                spaceId: saved.binding.spaceId,
                runId: saved.binding.runId,
              }),
            ),
            { binding: saved.binding, receipt: input.receipt },
          );
        assertExtensionCreditReplayPrincipal({
          saved: saved.creditAdmission,
          requested: creditAdmission,
        });
        if (pluginAdmission !== undefined)
          assertPluginTaskAdmissionReplay({
            requested: pluginAdmission,
            saved: loadSqlitePluginTask(host.database, saved.binding),
            binding: saved.binding,
            receipt: input.receipt,
            creditAdmission: saved.creditAdmission,
            unmeteredAdmission: saved.unmeteredAdmission,
          });
        if (pluginQuery !== undefined)
          assertPluginQueryReplay(
            pluginQuery,
            loadSqlitePluginQuery(host.database, saved.binding),
            saved.binding,
            input.receipt,
          );
        if (host.projectGenerationsEnabled)
          assertProjectGenerationReceipt({
            prepared,
            link: decodeProjectGeneration(
              host.database
                .prepare(projectGenerationReadSql())
                .get(...projectGenerationLocator(saved.binding)),
              saved.binding,
            ),
            binding: saved.binding,
            receipt: input.receipt,
          });
        if (host.projectQueriesEnabled)
          assertProjectQueryReceipt(
            projectQuery,
            loadSqliteProjectQueryLink(host.database, saved.binding),
            saved.binding,
            input.receipt,
          );
        assertSqliteHistoricalQueryMarker(
          host.database,
          saved.binding,
          historicalQuery,
        );
        if (historicalQuery !== null)
          assertProjectHistoricalQueryReceipt(
            historicalQuery,
            loadSqliteProjectHistoricalQueryLink(host.database, saved.binding),
            saved.binding,
            input.receipt,
          );
        assertStageReplay(
          stage,
          loadSqliteStageIfAvailable(host.database, saved.binding),
        );
        const savedMediaInput = loadSqliteMediaInputStage(
          host.database,
          saved.binding,
        );
        assertMediaInputStageReplay(mediaInputStage, savedMediaInput);
        const savedAsset = loadSqliteAssetStage(host.database, saved.binding);
        assertAssetStageReplay(assetStage, savedAsset);
        const savedPlan = loadSqlitePlanAdmission(host.database, saved.binding);
        planEqual(
          plan?.admission ?? null,
          savedPlan,
          "project_text_plan_admission_conflict",
        );
        return {
          ...saved,
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
      if (prepared?.publication !== undefined)
        admitSqliteProjectGenerationPublication(
          host.database,
          prepared.publication,
        );
      else if (pluginAdmission !== undefined)
        admitSqlitePluginTask(host.database, pluginAdmission);
      if (pluginQuery !== undefined)
        admitSqlitePluginQuery(host.database, pluginQuery, binding);
      const queryLink =
        projectQuery === null
          ? undefined
          : prepareSqliteProjectQuery(
              host.database,
              projectQuery,
              input,
              pluginQuery!,
            );
      const historicalLink =
        historicalQuery === null
          ? undefined
          : prepareSqliteProjectHistoricalQuery(
              host.database,
              historicalQuery,
              input,
              pluginQuery!,
            );
      host.admit(binding, input.expectedActivationRevision);
      const mediaLink =
        media === null
          ? null
          : executeMedia(
              prepareProjectMediaGenerationTurn(mediaDialect, media, input),
            );
      let projectLink: ProjectGenerationLink | undefined;
      if (prepared !== null) {
        projectLink = prepareSqliteProjectGeneration(
          prepared,
          input,
          (sql, values) => host.database.prepare(sql).all(...values),
        );
        if (
          host.database
            .prepare(projectGenerationSlotSql())
            .get(...projectGenerationSlotValues(projectLink)) !== undefined
        )
          throw new Error("project_generation_slot_occupied");
        assertCreativeProjectCommitActive(prepared.authority);
      }
      if (creditAdmission !== undefined) {
        try {
          const reserved = reserveSqlitePluginCreditsWithinTransaction(
            host.database,
            creditAdmission.reservation,
          );
          if (reserved.disposition !== "created")
            throw new Error("extension_credit_orphaned_reservation");
        } catch (error) {
          if (
            error instanceof CreditLedgerError &&
            [
              "plugin_credit_idempotency_conflict",
              "plugin_credit_reservation_id_conflict",
            ].includes(error.code)
          )
            throw new Error("extension_credit_orphaned_reservation", {
              cause: error,
            });
          throw error;
        }
      }
      const turn = host.commitTurn(extensionTurnCommit(input));
      if (
        turn.disposition !== "committed" ||
        turn.runState.runId !== binding.runId
      )
        throw new Error("extension_unbound_turn_receipt");
      host.database
        .prepare(`INSERT INTO extension_run_bindings VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          ...extensionScopeValues(binding),
          binding.runId,
          binding.configurationRevision,
          JSON.stringify(binding),
        );
      if (creditAdmission !== undefined)
        host.saveCreditAdmission(creditAdmission);
      if (pluginAdmission !== undefined)
        saveSqlitePluginTask(
          host.database,
          pluginAdmission,
          stage?.admission.contentDigest,
          plan?.admission.contentDigest,
          assetStage?.admission.contentDigest,
          mediaInputStage === null
            ? undefined
            : { stageDigest: mediaInputStage.admission.contentDigest },
        );
      if (unmetered.admission !== undefined)
        saveSqlitePluginTaskUnmeteredAdmission(
          host.database,
          unmetered.admission,
        );
      if (pluginQuery !== undefined)
        saveSqlitePluginQuery(
          host.database,
          pluginQuery,
          historicalLink?.contentDigest,
        );
      const result = extensionTurnResult(
        turn,
        binding,
        creditAdmission,
        unmetered.admission,
      );
      host.saveReceipt(binding, "task", input.receipt, result);
      if (mediaLink !== null)
        executeMedia(saveProjectMediaGenerationTurn(mediaDialect, mediaLink));
      if (projectLink !== undefined)
        host.database
          .prepare(projectGenerationInsertSql())
          .run(...projectGenerationValues(projectLink));
      if (queryLink !== undefined)
        host.database
          .prepare(projectQueryInsertSql())
          .run(...projectQueryValues(queryLink));
      if (stage !== null)
        host.database
          .prepare(
            "INSERT INTO project_stage_run_admissions VALUES(?,?,?,?,?,?,?)",
          )
          .run(...stageValues(stage.admission));
      if (historicalLink !== undefined)
        host.database
          .prepare(projectHistoricalQueryInsertSql())
          .run(...projectHistoricalQueryValues(historicalLink));
      if (mediaInputStage !== null)
        host.database
          .prepare(
            "INSERT INTO project_media_input_stage_run_admissions VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(...mediaInputStageValues(mediaInputStage.admission));
      if (assetStage !== null)
        host.database
          .prepare(
            "INSERT INTO project_asset_stage_run_admissions VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(...assetStageValues(assetStage.admission));
      finishSqlitePlanTurn(host.database, plan, planCheckpoint);
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
        stage?.authority.assertActive();
        assetStage?.authority.assertActive();
        mediaInputStage?.authority.assertActive();
        plan?.q.authority.assertActive();
        if (unmetered.authority !== undefined) {
          host.assertOpen();
          unmetered.authority.assertActive();
        }
        if (prepared !== null) host.assertOpen();
        assertCreativeProjectCommitActive(prepared?.authority);
        assertCreativeProjectCommitActive(projectQuery?.authority);
        assertCreativeProjectCommitActive(historicalQuery?.authority);
      },
    },
  );
}
