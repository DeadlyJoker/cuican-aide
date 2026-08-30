use std::sync::Arc;

use crewon_core::ThreadManager;
use crewon_protocol::ThreadId;
use crewon_rollout::StateDbHandle;
use crewon_thread_store::DeleteThreadParams;
use crewon_thread_store::LoadThreadHistoryParams;
use crewon_thread_store::ThreadStore;
use crewon_thread_store::ThreadStoreError;

use super::ThreadRequestProcessor;
use super::build_api_turns_from_rollout_items;
use super::thread_lifecycle::ThreadShutdownResult;
use super::thread_lifecycle::wait_for_thread_shutdown;
use crate::error_code::internal_error;
use crate::error_code::invalid_request;

#[derive(Clone)]
pub(super) struct ThreadExecutionContextRollback {
    thread_manager: Arc<ThreadManager>,
    thread_store: Arc<dyn ThreadStore>,
    state_db: Option<StateDbHandle>,
}

impl ThreadExecutionContextRollback {
    pub(super) fn new(
        thread_manager: Arc<ThreadManager>,
        thread_store: Arc<dyn ThreadStore>,
        state_db: Option<StateDbHandle>,
    ) -> Self {
        Self {
            thread_manager,
            thread_store,
            state_db,
        }
    }

    pub(super) async fn rollback(&self, thread_id: ThreadId) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Some(thread) = self.thread_manager.remove_thread(&thread_id).await {
            match wait_for_thread_shutdown(&thread).await {
                ThreadShutdownResult::Complete => {}
                ThreadShutdownResult::SubmitFailed => {
                    errors.push(format!(
                        "failed to submit shutdown while rolling back thread {thread_id}"
                    ));
                }
                ThreadShutdownResult::TimedOut => {
                    errors.push(format!(
                        "timed out shutting down thread {thread_id} during rollback"
                    ));
                }
            }
        }
        match self
            .thread_store
            .delete_thread(DeleteThreadParams { thread_id })
            .await
        {
            Ok(()) | Err(ThreadStoreError::ThreadNotFound { .. }) => {}
            Err(error) => {
                errors.push(format!(
                    "failed to delete thread store record {thread_id} during rollback: {error}"
                ));
            }
        }
        if let Some(state_db) = self.state_db.as_ref()
            && let Err(error) = state_db.delete_threads_strict(&[thread_id]).await
        {
            errors.push(format!(
                "failed to delete State record {thread_id} during rollback: {error}"
            ));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

impl ThreadRequestProcessor {
    pub(crate) async fn ensure_execution_binding_can_attach(
        &self,
        thread_id: &str,
    ) -> Result<(), crewon_app_server_protocol::JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(thread_id)
            .map_err(|_| invalid_request("Thread execution context threadId is invalid"))?;
        let has_core_turns =
            match thread_has_core_turns(self.thread_store.as_ref(), thread_id).await {
                Ok(has_core_turns) => has_core_turns,
                Err(ThreadStoreError::ThreadNotFound { .. }) => false,
                Err(_) if self.thread_manager.get_thread(thread_id).await.is_ok() => {
                    self.thread_store
                        .persist_thread(thread_id)
                        .await
                        .map_err(|_| internal_error("Thread history is unavailable"))?;
                    thread_has_core_turns(self.thread_store.as_ref(), thread_id)
                        .await
                        .map_err(|_| internal_error("Thread history is unavailable"))?
                }
                Err(_) => return Err(internal_error("Thread history is unavailable")),
            };
        if has_core_turns {
            return Err(invalid_request(
                "A Thread with local turns cannot select a Cloud Agent execution binding",
            ));
        }
        Ok(())
    }
}

pub(crate) fn ensure_local_core_turn_route(
    context: &crewon_app_server_protocol::ThreadExecutionContext,
) -> Result<(), crewon_app_server_protocol::JSONRPCErrorError> {
    if context.execution_binding.is_some() {
        return Err(invalid_request(
            "Cloud Agent execution requires the durable Cloud Agent coordinator",
        ));
    }
    Ok(())
}

async fn thread_has_core_turns(
    thread_store: &dyn ThreadStore,
    thread_id: ThreadId,
) -> Result<bool, ThreadStoreError> {
    let history = thread_store
        .load_history(LoadThreadHistoryParams {
            thread_id,
            include_archived: true,
        })
        .await?;
    Ok(!build_api_turns_from_rollout_items(&history.items).is_empty())
}

#[cfg(test)]
#[path = "thread_execution_context_lifecycle_tests.rs"]
mod tests;
