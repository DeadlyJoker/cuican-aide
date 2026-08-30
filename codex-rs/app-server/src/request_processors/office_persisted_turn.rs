use std::sync::Arc;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::Turn;
use crewon_protocol::ThreadId;
use crewon_thread_store::ReadThreadParams;
use crewon_thread_store::ThreadStore;

use super::build_api_turns_from_rollout_items;
use super::office_thread_workspace;
use crate::error_code::internal_error;

pub(crate) async fn for_dispatch_receipt(
    thread_store: &Arc<dyn ThreadStore>,
    cwd: &str,
    thread_id: &str,
    receipt_id: &str,
) -> Result<Option<Turn>, JSONRPCErrorError> {
    let thread_id_value = ThreadId::from_string(thread_id)
        .map_err(|error| internal_error(format!("invalid Office runtime thread id: {error}")))?;
    let stored_thread = thread_store
        .read_thread(ReadThreadParams {
            thread_id: thread_id_value,
            include_archived: true,
            include_history: true,
        })
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to read Office runtime thread {thread_id}: {error}"
            ))
        })?;
    let history = stored_thread.history.ok_or_else(|| {
        internal_error(format!(
            "Office runtime thread {thread_id} did not include persisted history"
        ))
    })?;
    office_thread_workspace::ensure_history_matches(cwd, thread_id, &history.items)?;
    let mut matches = build_api_turns_from_rollout_items(&history.items)
        .into_iter()
        .filter(|turn| {
            turn.items.iter().any(|item| {
                matches!(
                    item,
                    ThreadItem::UserMessage {
                        client_id: Some(client_id),
                        ..
                    } if client_id == receipt_id
                )
            })
        });
    let matched = matches.next();
    if matches.next().is_some() {
        return Err(internal_error(format!(
            "multiple Office turns matched dispatch receipt {receipt_id}"
        )));
    }
    Ok(matched)
}
