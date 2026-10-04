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

type SqliteExtensionTurnHost = Readonly<{
  database: DatabaseSync;
  unmeteredEnabled: boolean;
  projectGenerationsEnabled: boolean;
  projectQueriesEnabled: boolean;
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
  return host.transaction(
    () => {
      if (host.projectGenerationsEnabled)
        assertSqliteProjectGenerationSchema(host.database);
      if (host.projectQueriesEnabled)
        assertSqliteProjectQuerySchema(host.database);
      if (projectQuery !== null)
        admitSqliteProjectQueryPublication(host.database, projectQuery);
      const replay = host.receipt(binding, "task", input.receipt);
      if (replay !== null) {
        const saved = host.verifyCreditReceipt(
          parseExtensionTurnReceipt(replay, binding, input.receipt),
        );
        assertUnmeteredReplay(saved.unmeteredAdmission, unmetered.admission);
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
        return saved;
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
      host.admit(binding, input.expectedActivationRevision);
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
        saveSqlitePluginTask(host.database, pluginAdmission);
      if (unmetered.admission !== undefined)
        saveSqlitePluginTaskUnmeteredAdmission(
          host.database,
          unmetered.admission,
        );
      if (pluginQuery !== undefined)
        saveSqlitePluginQuery(host.database, pluginQuery);
      const result = extensionTurnResult(
        turn,
        binding,
        creditAdmission,
        unmetered.admission,
      );
      host.saveReceipt(binding, "task", input.receipt, result);
      if (projectLink !== undefined)
        host.database
          .prepare(projectGenerationInsertSql())
          .run(...projectGenerationValues(projectLink));
      if (queryLink !== undefined)
        host.database
          .prepare(projectQueryInsertSql())
          .run(...projectQueryValues(queryLink));
      return result;
    },
    {
      beforeCommit: () => {
        if (unmetered.authority !== undefined) {
          host.assertOpen();
          unmetered.authority.assertActive();
        }
        if (prepared !== null) host.assertOpen();
        assertCreativeProjectCommitActive(prepared?.authority);
        assertCreativeProjectCommitActive(projectQuery?.authority);
      },
    },
  );
}
