/** The same bounded expression is used by the index and the report's seeks. */
export function accountingCallIdentity(postgres: boolean): string {
  const value = postgres
    ? "record_json->'observation'->>'callId'"
    : "json_extract(record_json,'$.observation.callId')";
  const type = postgres
    ? "jsonb_typeof(record_json->'observation'->'callId')='string'"
    : "json_type(record_json,'$.observation.callId')='text'";
  return `(CASE WHEN ${type} AND length(${value}) BETWEEN 1 AND 512 THEN ${value} ELSE NULL END)`;
}
export function modelAccountingIndexSql(
  postgres: boolean,
  schema = "",
): string {
  const expression = accountingCallIdentity(postgres);
  return `CREATE INDEX IF NOT EXISTS model_usage_call_identity ON ${schema}model_usage_observations
    (tenant_id,run_id,${expression},usage_order) WHERE ${expression} IS NOT NULL;`;
}
