use super::*;
use crewon_app_server_protocol::OfficeMemberAddParams;
use crewon_app_server_protocol::OfficeMemberAddResponse;

impl MessageProcessor {
    pub(super) async fn office_member_add_request(
        &self,
        params: OfficeMemberAddParams,
        connection_id: ConnectionId,
    ) -> Result<OfficeMemberAddResponse, JSONRPCErrorError> {
        let prepared = self
            .crewon_domain_processor
            .office_member_add_prepare(params)
            .await?;
        let thread = self
            .thread_processor
            .start_office_member_runtime_thread(
                OfficeMemberRuntimeThreadStart {
                    cwd: prepared.cwd.clone(),
                    permissions: Some(BUILT_IN_PERMISSION_PROFILE_READ_ONLY.to_string()),
                },
                connection_id,
            )
            .await?;
        let replacement_thread_id = thread.id;
        let committed = match self
            .crewon_domain_processor
            .office_member_add_commit(prepared, &replacement_thread_id)
            .await
        {
            Ok(committed) => committed,
            Err(error) => {
                self.discard_uncommitted_office_member_runtime(&replacement_thread_id)
                    .await;
                return Err(error);
            }
        };
        if !committed.replacement_runtime_used {
            self.discard_uncommitted_office_member_runtime(&replacement_thread_id)
                .await;
        }
        Ok(committed.response)
    }

    async fn discard_uncommitted_office_member_runtime(&self, thread_id: &str) {
        if let Err(error) = self
            .thread_processor
            .discard_office_runtime_thread(thread_id)
            .await
        {
            tracing::warn!(
                thread_id,
                error = %error.message,
                "failed to discard unused Office member runtime thread"
            );
        }
    }
}
