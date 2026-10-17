import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";

/** Shared identity contract; navigation does not depend on scheduler wake health. */
export const POSTGRES_WORKFLOW_CHILD_COLUMNS =
  "tenant_id:text!,run_id:text!,node_id:text!,claim_id:text!,child_thread_id:text!,child_run_id:text!,input_digest:text!,wake_work_item_id:text!,wake_json:jsonb!";
export function postgresWorkflowChildConstraints(
  schema: string,
): readonly string[] {
  validatePostgresSchemaName(schema);
  const sql = `"${schema}"`;
  return [
    "PRIMARY KEY(tenant_id,run_id,node_id)",
    "UNIQUE(claim_id)",
    "UNIQUE(child_thread_id)",
    "UNIQUE(child_run_id)",
    "UNIQUE(wake_work_item_id)",
    `FOREIGN KEY(tenant_id,run_id,node_id) REFERENCES ${sql}.workflow_node_admissions(tenant_id,run_id,node_id)`,
    `FOREIGN KEY(tenant_id,child_thread_id) REFERENCES ${sql}.threads(tenant_id,thread_id)`,
    `FOREIGN KEY(tenant_id,child_run_id) REFERENCES ${sql}.run_snapshots(tenant_id,run_id)`,
  ];
}
export function normalizePostgresWorkflowConstraint(value: string): string {
  return value.replaceAll(/[\s()"']/gu, "").toLowerCase();
}
