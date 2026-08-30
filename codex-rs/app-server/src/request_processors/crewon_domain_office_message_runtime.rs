use super::*;

pub(super) struct BlockingRun {
    pub(super) run_id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: Option<String>,
    pub(super) manager_is_steerable: bool,
}

pub(super) fn blocking_run(config: &JsonValue) -> Option<BlockingRun> {
    let canonical_manager_thread_id = office_thread_id(config)?;
    runs(config)?.iter().find_map(|run| {
        let status = run
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or("running");
        if run_status_is_terminal(status) && !run_has_active_child_dispatch(run) {
            return None;
        }
        let run_id = run.get("id").and_then(JsonValue::as_str)?.to_string();
        let thread_id = run
            .get("threadId")
            .and_then(JsonValue::as_str)
            .unwrap_or(canonical_manager_thread_id)
            .to_string();
        let turn_id = run
            .get("turnId")
            .and_then(JsonValue::as_str)
            .filter(|turn_id| !turn_id.trim().is_empty())
            .map(str::to_string);
        let canceling = run
            .get("cancelRequestedAt")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty())
            || matches!(status, "canceling" | "interrupted");
        let manager_terminal = run
            .get("managerTerminalStatus")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        let manager_is_steerable = status == "running"
            && turn_id.is_some()
            && !canceling
            && !manager_terminal
            && thread_id == canonical_manager_thread_id;
        Some(BlockingRun {
            run_id,
            thread_id,
            manager_is_steerable,
            turn_id,
        })
    })
}

pub(super) fn run_for_client_user_message_id<'a>(
    config: &'a JsonValue,
    client_user_message_id: &str,
) -> Option<&'a JsonValue> {
    runs(config)?.iter().find(|run| {
        run.get("clientUserMessageId").and_then(JsonValue::as_str) == Some(client_user_message_id)
    })
}

pub(super) fn required_run_field(
    run: &JsonValue,
    field: &str,
) -> Result<String, JSONRPCErrorError> {
    run.get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| internal_error(format!("Office run has no {field}")))
}

fn runs(config: &JsonValue) -> Option<&Vec<JsonValue>> {
    config
        .get("workspace")?
        .get("activity")?
        .get("runs")?
        .as_array()
}

pub(super) fn run_status_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

fn run_has_active_child_dispatch(run: &JsonValue) -> bool {
    let active = |value: &JsonValue, field: &str| {
        matches!(
            value.get(field).and_then(JsonValue::as_str),
            Some("queued" | "running" | "canceling")
        )
    };
    run.get("delegations")
        .and_then(JsonValue::as_array)
        .is_some_and(|items| items.iter().any(|item| active(item, "status")))
        || run
            .get("verificationChecks")
            .and_then(JsonValue::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| active(item, "dispatchStatus") || active(item, "automationStatus"))
            })
}
