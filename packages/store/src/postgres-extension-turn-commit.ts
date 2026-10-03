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

type PostgresExtensionTurnHost = Readonly<{
  schema: string;
  projectGenerationsEnabled: boolean;
  projectQueriesEnabled: boolean;
  assertOpen(): void;
  transaction(
    scope: ExtensionScope,
    body: (client: PoolClient) => Promise<CommitExtensionTurnResult>,
    options: { beforeCommit(): void },
  ): Promise<CommitExtensionTurnResult>;
  receipt(
    client: PoolClient,
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
  ): Promise<unknown | null>;
  saveReceipt(
    client: PoolClient,
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
    result: unknown,
  ): Promise<void>;
  assertCreditLink(
    client: PoolClient,
    admission: ExtensionCreditAdmission | undefined,
  ): Promise<void>;
  admit(
    client: PoolClient,
    scope: CommitExtensionTurnInput["binding"],
    expectedRevision: number,
  ): Promise<void>;
  commitTurn(
    client: PoolClient,
    input: CommitTurnStartInput,
  ): Promise<CommitTurnStartResult>;
}>;

/** Keeps optional metadata association inside the original Turn/Run/hold transaction. */
export async function commitPostgresExtensionTurn(
  host: PostgresExtensionTurnHost,
  input: CommitExtensionTurnInput,
  options?: ProjectGenerationCommitOptions,
) {
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
  const binding = validateExtensionTurnCommit(frozenInput);
  if (prepared !== null)
    await assertCreativeProjectCommitCurrent(prepared.authority);
  assertCreativeProjectCommitActive(prepared?.authority);
  if (projectQuery !== null)
    await assertCreativeProjectCommitCurrent(projectQuery.authority);
  assertCreativeProjectCommitActive(projectQuery?.authority);
  let creditPath = false;
  return host.transaction(
    binding,
    async (client) => {
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
      const replay = await host.receipt(
        client,
        binding,
        "task",
        frozenInput.receipt,
      );
      if (replay !== null) {
        const result = parseExtensionTurnReceipt(
          replay,
          binding,
          frozenInput.receipt,
        );
        assertExtensionCreditReplayPrincipal({
          saved: result.creditAdmission,
          requested: frozenInput.creditAdmission,
        });
        creditPath = result.creditAdmission !== undefined;
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
        return result;
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
      await host.admit(client, binding, frozenInput.expectedActivationRevision);
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
        await savePostgresPluginTask(client, host.schema, pluginAdmission);
      if (pluginQuery !== undefined)
        await savePostgresPluginQuery(client, host.schema, pluginQuery);
      const result = extensionTurnResult(turn, binding, creditAdmission);
      await host.saveReceipt(
        client,
        binding,
        "task",
        frozenInput.receipt,
        result,
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
      if (prepared !== null)
        await assertCreativeProjectCommitCurrent(prepared.authority);
      if (projectQuery !== null)
        await assertCreativeProjectCommitCurrent(projectQuery.authority);
      return result;
    },
    {
      beforeCommit: () => {
        if (creditPath) host.assertOpen();
        assertCreativeProjectCommitActive(prepared?.authority);
        assertCreativeProjectCommitActive(projectQuery?.authority);
      },
    },
  );
}
