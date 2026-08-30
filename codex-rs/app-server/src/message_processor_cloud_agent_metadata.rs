use crewon_app_server_protocol::JSONRPCErrorError;

use super::MessageProcessor;
use crate::error_code::internal_error;

impl MessageProcessor {
    pub(super) async fn ensure_cloud_agent_thread_metadata_synced(
        &self,
    ) -> Result<(), JSONRPCErrorError> {
        let Some(projector) = self.cloud_agent_thread_metadata_projector.as_ref() else {
            return Ok(());
        };
        projector.ensure_synced().await.map(|_| ()).map_err(|_| {
            internal_error("Cloud Agent Thread metadata synchronization is unavailable")
        })
    }

    pub(super) async fn sync_cloud_agent_thread_metadata_best_effort(&self) {
        let Some(projector) = self.cloud_agent_thread_metadata_projector.as_ref() else {
            return;
        };
        if let Err(error) = projector.ensure_synced().await {
            tracing::warn!(
                ?error,
                "Cloud Agent Thread metadata sync deferred to bounded list/search recovery"
            );
        }
    }
}
