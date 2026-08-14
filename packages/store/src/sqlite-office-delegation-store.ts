import type { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  RunStoreError,
  type CommitOfficeDelegationStartInput,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type ListOfficeDelegationsResult,
  type OfficeDelegationPreparation,
  type OfficeDelegationStartResult,
  type OfficeDelegationStore,
  type RunRoute,
} from "@crewon/application";
import {
  OFFICE_DELEGATION_LIMITS,
  parseOfficeDefinition,
  parseOfficeDelegation,
  type OfficeDelegation,
  type RunState,
  type ThreadState,
} from "@crewon/domain";

import { rollback } from "./sqlite-schema.ts";

export function migrateSqliteOfficeDelegations(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS office_delegations (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
      delegation_id TEXT NOT NULL, office_id TEXT NOT NULL,
      office_version_id TEXT NOT NULL, workflow_version_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL,
      delegation_json TEXT NOT NULL CHECK (json_valid(delegation_json)),
      PRIMARY KEY (tenant_id, delegation_id), UNIQUE (tenant_id, run_id),
      FOREIGN KEY (tenant_id, space_id, office_version_id)
        REFERENCES office_definitions (tenant_id, space_id, office_version_id),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots (tenant_id, run_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS office_delegations_list
      ON office_delegations
      (tenant_id, space_id, office_version_id, created_at DESC, delegation_id DESC);
    CREATE TABLE IF NOT EXISTS office_delegation_receipts (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
      scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, delegation_id TEXT NOT NULL, run_id TEXT NOT NULL,
      PRIMARY KEY (scope, idempotency_key),
      FOREIGN KEY (tenant_id, delegation_id)
        REFERENCES office_delegations (tenant_id, delegation_id),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots (tenant_id, run_id)
    ) STRICT;
  `);
}

type Dependencies = Readonly<{
  assertOpen: () => void;
  loadThread: (input: {
    tenantId: string;
    threadId: string;
  }) => ThreadState | null;
  loadRun: (input: { tenantId: string; runId: string }) => RunState | null;
  replayWorkflowRun: (
    input: CommitWorkflowRunStartInput,
  ) => Promise<CommitWorkflowRunStartResult>;
  commitWorkflowRunWithinTransaction: (
    input: CommitWorkflowRunStartInput,
    route: RunRoute,
  ) => CommitWorkflowRunStartResult;
}>;

type ReceiptRow = Readonly<{
  tenant_id: string;
  space_id: string;
  fingerprint: string;
  delegation_id: string;
  run_id: string;
}>;

export class SqliteOfficeDelegationStore implements OfficeDelegationStore {
  readonly #database: DatabaseSync;
  readonly #dependencies: Dependencies;

  constructor(database: DatabaseSync, dependencies: Dependencies) {
    this.#database = database;
    this.#dependencies = dependencies;
  }

  async commitOfficeDelegationStart(
    input: CommitOfficeDelegationStartInput,
  ): Promise<OfficeDelegationStartResult> {
    this.#dependencies.assertOpen();
    validateStart(input);
    const replay = this.#loadReceipt(input);
    if (replay !== null) return this.#replay(input, replay);
    const candidateRoute = await input.resolveCandidateRoute();
    let concurrentReplay: ReceiptRow | null = null;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      concurrentReplay = this.#loadReceipt(input);
      if (concurrentReplay === null) {
        const office = this.#loadOffice(input);
        const thread = this.#dependencies.loadThread({
          tenantId: input.tenantId,
          threadId: input.threadId,
        });
        if (
          thread === null ||
          thread.spaceId !== input.spaceId ||
          thread.status !== "active"
        )
          throw new RunStoreError("thread_not_active");
        const holder: { value: OfficeDelegationPreparation | null } = {
          value: null,
        };
        const workflowInput = workflowAdmissionInput(input, (authority) => {
          let value: OfficeDelegationPreparation;
          try {
            value = input.prepare({ ...authority, office, thread });
          } catch (error) {
            throw new RunStoreError("office_delegation_prepare_rejected", {
              cause: error,
            });
          }
          holder.value = value;
          return {
            commit: value.runCommit,
            workflowInputValue: value.workflowInputValue,
          };
        });
        const workflow = this.#dependencies.commitWorkflowRunWithinTransaction(
          workflowInput,
          candidateRoute,
        );
        if (holder.value === null)
          throw new RunStoreError("office_delegation_prepare_invalid");
        const delegation = validatePrepared(
          input,
          office,
          workflow,
          holder.value,
        );
        this.#write(input, delegation);
        this.#database.exec("COMMIT");
        return { disposition: "committed", delegation, run: workflow.run };
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw normalize(error);
    }
    return this.#replay(input, concurrentReplay);
  }

  async listOfficeDelegations(input: {
    tenantId: string;
    spaceId: string;
    officeVersionId: string;
    before: { createdAt: string; delegationId: string } | null;
    limit: number;
  }): Promise<ListOfficeDelegationsResult> {
    this.#dependencies.assertOpen();
    validateList(input);
    const args: (string | number)[] = [
      input.tenantId,
      input.spaceId,
      input.officeVersionId,
    ];
    let cursor = "";
    if (input.before !== null) {
      cursor = ` AND (d.created_at < ? OR
        (d.created_at = ? AND CAST(d.delegation_id AS BLOB) < CAST(? AS BLOB)))`;
      args.push(
        input.before.createdAt,
        input.before.createdAt,
        input.before.delegationId,
      );
    }
    args.push(input.limit + 1);
    const rows = this.#database
      .prepare(
        `SELECT d.delegation_json,d.run_id FROM office_delegations d
         JOIN run_snapshots r ON r.tenant_id=d.tenant_id AND r.run_id=d.run_id
         WHERE d.tenant_id=? AND d.space_id=? AND d.office_version_id=?${cursor}
         ORDER BY d.created_at DESC,CAST(d.delegation_id AS BLOB) DESC LIMIT ?`,
      )
      .all(...args) as unknown as {
      delegation_json: string;
      run_id: string;
    }[];
    const page = rows.slice(0, input.limit).map((row) => {
      const delegation = decodeDelegation(row.delegation_json);
      const run = this.#dependencies.loadRun({
        tenantId: input.tenantId,
        runId: row.run_id,
      });
      if (
        run === null ||
        delegation.runId !== run.runId ||
        delegation.threadId !== run.threadId ||
        delegation.spaceId !== run.spaceId
      )
        throw new RunStoreError("office_delegation_run_corrupt");
      return { delegation, run };
    });
    const last = rows.length > input.limit ? page.at(-1) : undefined;
    return {
      items: page,
      next:
        last === undefined
          ? null
          : {
              createdAt: last.delegation.createdAt,
              delegationId: last.delegation.delegationId,
            },
    };
  }

  #loadReceipt(input: CommitOfficeDelegationStartInput): ReceiptRow | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id,space_id,fingerprint,delegation_id,run_id
         FROM office_delegation_receipts WHERE scope=? AND idempotency_key=?`,
      )
      .get(input.idempotency.scope, input.idempotency.key) as
      | ReceiptRow
      | undefined;
    if (row === undefined) return null;
    if (
      row.tenant_id !== input.tenantId ||
      row.space_id !== input.spaceId ||
      row.fingerprint !== input.idempotency.requestFingerprint
    )
      throw new RunStoreError("idempotency_conflict");
    return row;
  }

  async #replay(
    input: CommitOfficeDelegationStartInput,
    receipt: ReceiptRow,
  ): Promise<OfficeDelegationStartResult> {
    const row = this.#database
      .prepare(
        `SELECT delegation_json FROM office_delegations
         WHERE tenant_id=? AND delegation_id=? AND run_id=?`,
      )
      .get(input.tenantId, receipt.delegation_id, receipt.run_id) as
      | { delegation_json: string }
      | undefined;
    if (row === undefined)
      throw new RunStoreError("office_delegation_receipt_corrupt");
    const delegation = decodeDelegation(row.delegation_json);
    const workflow = await this.#dependencies.replayWorkflowRun(
      workflowAdmissionInput(input, () => {
        throw new RunStoreError("office_delegation_replay_callback_called");
      }),
    );
    if (
      delegation.tenantId !== input.tenantId ||
      delegation.spaceId !== input.spaceId ||
      delegation.officeVersionId !== input.officeVersionId ||
      delegation.workflowVersionBinding.workflowVersionId !==
        input.workflowVersionId ||
      delegation.threadId !== input.threadId ||
      delegation.runId !== receipt.run_id ||
      workflow.run.state.runId !== receipt.run_id
    )
      throw new RunStoreError("office_delegation_receipt_corrupt");
    return { disposition: "replayed", delegation, run: workflow.run };
  }

  #loadOffice(input: CommitOfficeDelegationStartInput) {
    const row = this.#database
      .prepare(
        `SELECT definition_json FROM office_definitions
         WHERE tenant_id=? AND space_id=? AND office_version_id=?`,
      )
      .get(input.tenantId, input.spaceId, input.officeVersionId) as
      | { definition_json: string }
      | undefined;
    if (row === undefined) throw new RunStoreError("office_version_not_found");
    try {
      return parseOfficeDefinition(JSON.parse(row.definition_json));
    } catch (error) {
      throw new RunStoreError("office_version_corrupt", { cause: error });
    }
  }

  #write(input: CommitOfficeDelegationStartInput, value: OfficeDelegation) {
    this.#database
      .prepare(
        `INSERT INTO office_delegations
         (tenant_id,space_id,delegation_id,office_id,office_version_id,
          workflow_version_id,thread_id,run_id,created_at,delegation_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        value.tenantId,
        value.spaceId,
        value.delegationId,
        value.officeId,
        value.officeVersionId,
        value.workflowVersionBinding.workflowVersionId,
        value.threadId,
        value.runId,
        value.createdAt,
        canonicalJson(value),
      );
    this.#database
      .prepare(
        `INSERT INTO office_delegation_receipts
         (tenant_id,space_id,scope,idempotency_key,fingerprint,delegation_id,run_id)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        input.tenantId,
        input.spaceId,
        input.idempotency.scope,
        input.idempotency.key,
        input.idempotency.requestFingerprint,
        value.delegationId,
        value.runId,
      );
  }
}

function workflowAdmissionInput(
  input: CommitOfficeDelegationStartInput,
  prepare: CommitWorkflowRunStartInput["prepare"],
): CommitWorkflowRunStartInput {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    workflowVersionId: input.workflowVersionId,
    threadId: input.threadId,
    workflowInput: input.workflowInput,
    idempotency: input.idempotency,
    resolveCandidateRoute: async () => {
      throw new RunStoreError("office_delegation_route_callback_called");
    },
    prepare,
  };
}

function validatePrepared(
  input: CommitOfficeDelegationStartInput,
  office: ReturnType<typeof parseOfficeDefinition>,
  workflow: CommitWorkflowRunStartResult,
  prepared: OfficeDelegationPreparation,
) {
  let delegation: OfficeDelegation;
  try {
    delegation = parseOfficeDelegation(prepared.delegation);
  } catch (error) {
    throw new RunStoreError("office_delegation_prepare_invalid", {
      cause: error,
    });
  }
  const binding = workflow.authority.workflowVersion;
  if (
    delegation.tenantId !== input.tenantId ||
    delegation.spaceId !== input.spaceId ||
    delegation.officeId !== office.officeId ||
    delegation.officeVersionId !== office.officeVersionId ||
    delegation.workflowVersionBinding.workflowId !== binding.workflowId ||
    delegation.workflowVersionBinding.workflowVersionId !==
      binding.workflowVersionId ||
    delegation.workflowVersionBinding.contentDigest !== binding.contentDigest ||
    delegation.threadId !== input.threadId ||
    delegation.runId !== workflow.run.state.runId ||
    delegation.createdAt !== workflow.run.state.createdAt
  )
    throw new RunStoreError("office_delegation_prepare_invalid");
  return delegation;
}

function validateStart(input: CommitOfficeDelegationStartInput) {
  for (const value of [
    input.tenantId,
    input.spaceId,
    input.officeVersionId,
    input.workflowVersionId,
    input.threadId,
    input.idempotency.scope,
    input.idempotency.key,
    input.idempotency.requestFingerprint,
  ])
    if (typeof value !== "string" || value.length === 0)
      throw new RunStoreError("office_delegation_input_invalid");
}

function validateList(input: {
  tenantId: string;
  spaceId: string;
  officeVersionId: string;
  before: { createdAt: string; delegationId: string } | null;
  limit: number;
}) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > OFFICE_DELEGATION_LIMITS.list ||
    [input.tenantId, input.spaceId, input.officeVersionId].some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    (input.before !== null &&
      (typeof input.before.createdAt !== "string" ||
        typeof input.before.delegationId !== "string" ||
        input.before.delegationId.length === 0))
  )
    throw new RunStoreError("office_delegation_list_invalid");
}

function decodeDelegation(json: string) {
  try {
    return parseOfficeDelegation(JSON.parse(json));
  } catch (error) {
    throw new RunStoreError("office_delegation_corrupt", { cause: error });
  }
}

function normalize(error: unknown): Error {
  if (
    error instanceof RunStoreError &&
    error.code === "office_delegation_prepare_rejected" &&
    error.cause instanceof Error
  )
    return error.cause;
  if (error instanceof RunStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/iu.test(message))
    return new RunStoreError("sqlite_busy", { cause: error });
  if (/constraint/iu.test(message))
    return new RunStoreError("sqlite_constraint", { cause: error });
  return error instanceof Error
    ? error
    : new RunStoreError("sqlite_error", { cause: error });
}
