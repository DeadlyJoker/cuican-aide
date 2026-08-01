use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_state::StateRuntime;
use uuid::Uuid;

use super::RequestIdentity;
use super::WorkspaceRegistry;
use super::WorkspaceRootCatalog;
use super::workspace_key_mode;
use crate::error_code::invalid_params;

impl WorkspaceRegistry {
    pub(crate) async fn resolve_binding_ref_with_state(
        &self,
        identity: &RequestIdentity,
        catalog: &WorkspaceRootCatalog,
        state: Option<&StateRuntime>,
        binding_id: &str,
    ) -> Result<WorkspaceRef, JSONRPCErrorError> {
        self.authorize(identity)?;
        validate_workspace_binding_id(binding_id)?;
        self.refresh(catalog, workspace_key_mode(identity, state)?)
            .await?;
        let state = self.state.lock().await;
        state
            .bindings_by_identity
            .values()
            .find(|workspace| workspace.binding_id == binding_id)
            .cloned()
            .ok_or_else(|| invalid_params("workspace binding is not registered for this session"))
    }
}

fn validate_workspace_binding_id(binding_id: &str) -> Result<(), JSONRPCErrorError> {
    let valid = binding_id
        .strip_prefix("binding:")
        .and_then(|value| Uuid::parse_str(value).ok().map(|parsed| (value, parsed)))
        .is_some_and(|(value, parsed)| parsed.to_string() == value);
    if !valid {
        return Err(invalid_params("invalid workspace bindingId"));
    }
    Ok(())
}
