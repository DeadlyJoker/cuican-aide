use crewon_app_server_protocol::JSONRPCErrorError;
use serde_json::Value as JsonValue;

use super::DomainKind;
use super::MAX_LIST_LIMIT;
use super::list_records;
use crate::error_code::internal_error;

pub(super) async fn configs_referencing_turn(
    cwd: &str,
    thread_id: &str,
    turn_id: &str,
) -> Result<Vec<JsonValue>, JSONRPCErrorError> {
    let thread_id = thread_id.trim();
    let turn_id = turn_id.trim();
    if thread_id.is_empty() || turn_id.is_empty() {
        return Ok(Vec::new());
    }
    let (records, next_cursor) = list_records(
        DomainKind::Office,
        cwd,
        /*cursor*/ None,
        Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    if next_cursor.is_some() {
        return Err(internal_error(
            "Office migration target scan exceeded its bounded record limit",
        ));
    }
    Ok(records
        .into_iter()
        .filter(|record| config_references_turn(&record.config, thread_id, turn_id))
        .map(|record| record.config)
        .collect())
}

fn config_references_turn(config: &JsonValue, thread_id: &str, turn_id: &str) -> bool {
    let manager_thread_matches = config
        .get("workspace")
        .and_then(|workspace| workspace.get("threadId"))
        .and_then(JsonValue::as_str)
        == Some(thread_id);
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .is_some_and(|runs| {
            runs.iter().any(|run| {
                (manager_thread_matches
                    && run.get("turnId").and_then(JsonValue::as_str) == Some(turn_id))
                    || run
                        .get("delegations")
                        .and_then(JsonValue::as_array)
                        .is_some_and(|delegations| {
                            delegations.iter().any(|delegation| {
                                delegation.get("threadId").and_then(JsonValue::as_str)
                                    == Some(thread_id)
                                    && delegation.get("turnId").and_then(JsonValue::as_str)
                                        == Some(turn_id)
                            })
                        })
                    || run
                        .get("verificationChecks")
                        .and_then(JsonValue::as_array)
                        .is_some_and(|checks| {
                            checks.iter().any(|check| {
                                check.get("automationThreadId").and_then(JsonValue::as_str)
                                    == Some(thread_id)
                                    && check.get("automationTurnId").and_then(JsonValue::as_str)
                                        == Some(turn_id)
                            })
                        })
            })
        })
}

#[cfg(test)]
#[path = "crewon_domain_office_migration_targets_tests.rs"]
mod tests;
