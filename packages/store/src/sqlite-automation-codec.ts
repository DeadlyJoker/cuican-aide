import {
  RunStoreError,
  type AutomationDefinitionRecord,
} from "@crewon/application";
import { parseAutomationScheduleState } from "@crewon/domain";
import { validateAutomationRecord } from "./automation-store-support.ts";
import { stableJson } from "./store-invariants.ts";

export type SqliteAutomationRow = Readonly<{
  tenant_id: string;
  space_id: string;
  automation_id: string;
  thread_id: string;
  revision: number;
  definition_digest: string;
  definition_json: string;
  schedule_state_json: string;
  updated_at: string;
}>;

export function decodeSqliteAutomationRecord(
  row: SqliteAutomationRow,
): AutomationDefinitionRecord {
  let definition: AutomationDefinitionRecord["definition"];
  let scheduleState: AutomationDefinitionRecord["scheduleState"];
  try {
    definition = JSON.parse(
      row.definition_json,
    ) as AutomationDefinitionRecord["definition"];
    stableJson(definition);
    scheduleState = parseAutomationScheduleState(
      JSON.parse(row.schedule_state_json),
    );
  } catch (error) {
    throw new RunStoreError("automation_record_invalid", { cause: error });
  }
  const record = {
    definition,
    definitionDigest: row.definition_digest,
    scheduleState,
  };
  validateAutomationRecord(record);
  if (
    row.tenant_id !== definition.tenantId ||
    row.space_id !== definition.spaceId ||
    row.automation_id !== definition.automationId ||
    row.thread_id !== definition.threadId ||
    row.revision !== definition.revision ||
    row.updated_at !== definition.updatedAt
  ) {
    throw new RunStoreError("automation_record_invalid");
  }
  return record;
}
