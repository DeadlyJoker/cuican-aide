use super::*;
use crewon_app_server_protocol::OfficeManagerEnsureParams;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeManagerEnsureStatus;

impl MessageProcessor {
    pub(super) async fn office_manager_ensure_request(
        &self,
        params: OfficeManagerEnsureParams,
        connection_id: ConnectionId,
    ) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
        let prepared = self
            .crewon_domain_processor
            .office_manager_ensure_prepare(params)
            .await?;
        if let Some(existing_thread_id) = prepared.existing_thread_id.as_deref() {
            self.thread_processor
                .ensure_thread_loaded_for_office_dispatch(
                    &prepared.cwd,
                    existing_thread_id,
                    connection_id,
                )
                .await?;
            let status = match self
                .thread_processor
                .office_manager_runtime_provenance(&prepared.cwd, existing_thread_id)
                .await?
            {
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
