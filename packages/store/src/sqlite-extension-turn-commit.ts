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

type SqliteExtensionTurnHost = Readonly<{
  database: DatabaseSync;
  projectGenerationsEnabled: boolean;
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

/** Optional project source and original paid Turn share the same synchronous SQLite commit. */
export async function commitSqliteExtensionTurn(
  host: SqliteExtensionTurnHost,
  input: CommitExtensionTurnInput,
  options?: ProjectGenerationCommitOptions,
): Promise<CommitExtensionTurnResult> {
  const pluginQuery = checkedPluginQueryTurn(input);
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
  if (prepared !== null) {
    await assertCreativeProjectCommitCurrent(prepared.authority);
    assertCreativeProjectCommitActive(prepared.authority);
  }
  return host.transaction(
    () => {
      if (host.projectGenerationsEnabled)
        assertSqliteProjectGenerationSchema(host.database);
      const replay = host.receipt(binding, "task", input.receipt);
      if (replay !== null) {
        const saved = host.verifyCreditReceipt(
          parseExtensionTurnReceipt(replay, binding, input.receipt),
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
        return saved;
      }
      if (pluginAdmission !== undefined)
        admitSqlitePluginTask(host.database, pluginAdmission);
      if (pluginQuery !== undefined)
        admitSqlitePluginQuery(host.database, pluginQuery, binding);
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
      if (pluginQuery !== undefined)
        saveSqlitePluginQuery(host.database, pluginQuery);
      const result = extensionTurnResult(turn, binding, creditAdmission);
      host.saveReceipt(binding, "task", input.receipt, result);
      if (projectLink !== undefined)
        host.database
          .prepare(projectGenerationInsertSql())
          .run(...projectGenerationValues(projectLink));
      return result;
    },
    {
      beforeCommit: () => {
        if (prepared !== null) host.assertOpen();
        assertCreativeProjectCommitActive(prepared?.authority);
      },
    },
  );
}
