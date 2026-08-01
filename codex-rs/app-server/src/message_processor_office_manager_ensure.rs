use super::*;
use crate::platform_control::thread_execution_context_runtime::ThreadExecutionContextRequestRuntime;
use crate::platform_control::thread_execution_context_runtime::ThreadExecutionContextWorkspaceScope;
use crewon_app_server_protocol::OfficeManagerEnsureParams;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeManagerEnsureStatus;

impl MessageProcessor {
    pub(super) async fn office_manager_ensure_request(
        &self,
        params: OfficeManagerEnsureParams,
        connection_id: ConnectionId,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
    ) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
        if let Some(runtime) = execution_context_runtime.as_ref() {
            runtime
                .authorize_registered_workspace_root(std::path::Path::new(&params.cwd))
                .await?;
        }
        let prepared = self
            .crewon_domain_processor
            .office_manager_ensure_prepare(params)
            .await?;
        if let Some(existing_thread_id) = prepared.existing_thread_id.as_deref() {
            let provenance = self
                .thread_processor
                .office_manager_runtime_provenance(existing_thread_id)
                .await?;
            if let Some(runtime) = execution_context_runtime.as_ref() {
                let context = runtime.read_owned(existing_thread_id).await?;
                if provenance == OfficeManagerRuntimeProvenance::ServerOwned && context.is_none() {
                    return Err(invalid_request(
                        "Office manager execution context is missing; repair is required",
                    ));
                }
                if provenance == OfficeManagerRuntimeProvenance::Legacy {
                    runtime
                        .authorize_or_create_office_thread(
                            existing_thread_id,
                            &prepared.office_record_id,
                            std::path::Path::new(&prepared.cwd),
                            Utc::now().timestamp(),
                        )
                        .await?;
                } else {
                    runtime
                        .authorize_office_thread(
                            existing_thread_id,
                            &prepared.office_record_id,
                            std::path::Path::new(&prepared.cwd),
                        )
                        .await?;
                }
            }
            self.thread_processor
                .ensure_thread_loaded_for_office_dispatch(existing_thread_id, connection_id)
                .await?;
            let status = match provenance {
                OfficeManagerRuntimeProvenance::ServerOwned => {
                    OfficeManagerEnsureStatus::ReusedServerOwned
                }
                OfficeManagerRuntimeProvenance::Legacy => OfficeManagerEnsureStatus::ReusedLegacy,
            };
            let cwd = prepared.cwd.clone();
            let response = self
                .crewon_domain_processor
                .office_manager_ensure_reused(prepared, status)
                .await?;
            self.remember_office_scheduler_cwd(&cwd).await;
            return Ok(response);
        }

        let prepared_execution_context = match execution_context_runtime.as_ref() {
            Some(runtime) => Some(
                runtime
                    .prepare_create_for_registered_root(std::path::Path::new(&prepared.cwd))
                    .await?,
            ),
            None => None,
        };
        let thread = self
            .thread_processor
            .start_office_manager_runtime_thread(
                OfficeManagerRuntimeThreadStart {
                    cwd: prepared.cwd.clone(),
                },
                connection_id,
            )
            .await?;
        let replacement_thread_id = thread.id;
        if let Some((runtime, prepared_context)) = execution_context_runtime
            .as_ref()
            .zip(prepared_execution_context)
            && let Err(error) = runtime
                .create(
                    prepared_context,
                    &replacement_thread_id,
                    ThreadExecutionContextWorkspaceScope::Office {
                        office_id: prepared.office_record_id.clone(),
                    },
                    Utc::now().timestamp(),
                )
                .await
        {
            self.discard_uncommitted_office_manager_runtime(&replacement_thread_id)
                .await;
            return Err(error);
        }
        let cwd = prepared.cwd.clone();
        let response = match self
            .crewon_domain_processor
            .office_manager_ensure_commit(prepared, &replacement_thread_id)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.discard_uncommitted_office_manager_runtime(&replacement_thread_id)
                    .await;
                return Err(error);
            }
        };
        self.remember_office_scheduler_cwd(&cwd).await;
        Ok(response)
    }

    async fn discard_uncommitted_office_manager_runtime(&self, thread_id: &str) {
        if let Err(error) = self
            .thread_processor
            .discard_office_runtime_thread(thread_id)
            .await
        {
            tracing::warn!(
                thread_id,
                error = %error.message,
                "failed to discard uncommitted Office manager runtime thread"
            );
        }
    }
}
