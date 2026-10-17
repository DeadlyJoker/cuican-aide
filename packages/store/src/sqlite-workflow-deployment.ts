import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  RunStoreError,
  WorkflowDeploymentPolicy,
  type WorkflowDeploymentConfiguration,
  type WorkflowDeploymentSyncReader,
  type WorkflowAgentVersionDecoder,
  type WorkflowHumanGateAuthority,
} from "@crewon/application";
import type { RunState, WorkflowContentDigester } from "@crewon/domain";
import type {
  SqliteWorkflowRouteResolver,
  SqliteWorkflowAdmissionPolicy,
  ExperimentalSqliteWorkflowRunAdmissionStore,
} from "./sqlite-workflow-run-admission.ts";
import type {
  SqliteWorkflowCompositionOptions,
  ExperimentalSqliteWorkflowRunCompositionStore,
} from "./sqlite-workflow-run-composition.ts";
import { migrateSqliteWorkflowRunAdmission } from "./sqlite-workflow-run-admission-schema.ts";

/** Only synchronous policy reads on the same SQLite connection may run while
 * BEGIN IMMEDIATE is held. The validation is shared with PostgreSQL.
 */
export function createSqliteWorkflowDeployment(input: {
  database: DatabaseSync;
  configuration: WorkflowDeploymentConfiguration;
  decodeAgentVersion: WorkflowAgentVersionDecoder;
  digester: WorkflowContentDigester;
  reader: WorkflowDeploymentSyncReader;
  migrateDefinition(): void;
  loadRoot(
    authority: Pick<WorkflowHumanGateAuthority, "tenantId" | "runId">,
  ): RunState | null;
  admission(
    resolve: SqliteWorkflowRouteResolver,
    policy: SqliteWorkflowAdmissionPolicy,
  ): ExperimentalSqliteWorkflowRunAdmissionStore;
  composition(
    options: SqliteWorkflowCompositionOptions,
  ): ExperimentalSqliteWorkflowRunCompositionStore;
}) {
  const policy = new WorkflowDeploymentPolicy(
    input.configuration,
    input.decodeAgentVersion,
    input.digester,
  );
  input.migrateDefinition();
  migrateSqliteWorkflowRunAdmission(input.database);
  const admission = input.admission(
    (context) => policy.resolveAdmissionRouteSync(context, input.reader),
    {
      authorizeCreatedRun: ({ run }) =>
        policy.authorizeSchedulerSync(run, input.reader),
    },
  );
  const composition = input.composition({
    maximumParallelNodes: policy.configuration.maximumParallelNodes,
    dispatchChildren: {
      resolveRoute: ({ parent, node }) =>
        policy.resolveChildRouteSync(parent, node, input.reader),
    },
    scheduler: {
      authorize: ({ run }) => policy.authorizeSchedulerSync(run, input.reader),
    },
    humanGates: {
      authorize: ({ actor, authority }) => {
        const run = input.loadRoot(authority);
        if (!run)
          return {
            outcome: "deny",
            reasonCode: "workflow_gate_authorization_denied",
          };
        try {
          return policy.authorizeGateSync(
            { run, actor, authority },
            input.reader,
          );
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.category === "authorization"
          )
            return { outcome: "deny", reasonCode: error.code };
          throw error;
        }
      },
    },
  });
  const identity = deploymentIdentity(input.database);
  // SQLite constructors migrate synchronously; keep the host capability shape.
  return Object.freeze({ admission, composition, identity, migrate: () => {} });
}

const IDENTITY_DDL = `CREATE TABLE workflow_deployment_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,identity TEXT NOT NULL
) STRICT;`;
function deploymentIdentity(db: DatabaseSync): string {
  db.exec("BEGIN IMMEDIATE");
  try {
    let table = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='workflow_deployment_identity'",
      )
      .get();
    if (!table) {
      db.exec(IDENTITY_DDL);
      db.prepare("INSERT INTO workflow_deployment_identity VALUES(1,1,?)").run(
        randomUUID(),
      );
      table = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='workflow_deployment_identity'",
        )
        .get();
    }
    const normalized = (sql: string) =>
      sql.replaceAll(/\s|;/gu, "").toLowerCase();
    if (!table || normalized(String(table.sql)) !== normalized(IDENTITY_DDL))
      throw new RunStoreError("workflow_deployment_identity_corrupt");
    const rows = db
      .prepare(
        "SELECT singleton,version,identity FROM workflow_deployment_identity LIMIT 2",
      )
      .all();
    if (
      rows.length !== 1 ||
      rows[0]!.singleton !== 1 ||
      rows[0]!.version !== 1 ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(
        String(rows[0]!.identity),
      )
    )
      throw new RunStoreError("workflow_deployment_identity_corrupt");
    db.exec("COMMIT");
    return String(rows[0]!.identity);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
