use std::sync::Arc;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindingProjection;
use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceListResponse;
use crewon_app_server_protocol::ResourceReadParams;
use crewon_app_server_protocol::ResourceReadResponse;
use crewon_app_server_protocol::ResourceUnbindParams;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_state::StateRuntime;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crate::error_code::invalid_request;
use crate::platform_control::RequestIdentity;
use crate::platform_control::provider_connection_descriptor::ProviderConnectionClock;
use crate::platform_control::provider_connection_production::SystemProviderConnectionClock;
use crate::platform_control::provider_connection_startup::PreparedProviderConnectionRuntime;
use crate::platform_control::provider_connection_startup::ProviderResourceRuntimeError;
use crate::platform_control::unbind_resource_binding;

pub(crate) struct ProviderResourceRequestProcessor<Clock = SystemProviderConnectionClock> {
    runtime: Option<Arc<PreparedProviderConnectionRuntime<Clock>>>,
    state: Option<Arc<StateRuntime>>,
}

impl<Clock> ProviderResourceRequestProcessor<Clock>
where
    Clock: ProviderConnectionClock,
{
    pub(crate) fn new(
        runtime: Option<Arc<PreparedProviderConnectionRuntime<Clock>>>,
        state: Option<Arc<StateRuntime>>,
    ) -> Self {
        Self { runtime, state }
    }

    pub(crate) async fn list(
        &self,
        identity: &RequestIdentity,
        params: ResourceListParams,
    ) -> Result<ResourceListResponse, JSONRPCErrorError> {
        self.runtime()?
            .list_resources(identity, params)
            .await
            .map_err(map_runtime_error)
    }

    pub(crate) async fn read(
        &self,
        identity: &RequestIdentity,
        params: ResourceReadParams,
    ) -> Result<ResourceReadResponse, JSONRPCErrorError> {
        self.runtime()?
            .read_resource(identity, params)
            .await
            .map_err(map_runtime_error)
    }

    pub(crate) async fn bind(
        &self,
        identity: &RequestIdentity,
        workspace: &WorkspaceRef,
        params: ResourceBindParams,
    ) -> Result<ResourceBindingProjection, JSONRPCErrorError> {
        self.runtime()?
            .bind_resource(identity, workspace, params)
            .await
            .map_err(map_runtime_error)
    }

    fn runtime(&self) -> Result<&PreparedProviderConnectionRuntime<Clock>, JSONRPCErrorError> {
        self.runtime
            .as_deref()
            .ok_or_else(|| internal_error("Provider resource runtime is unavailable"))
    }
}

impl ProviderResourceRequestProcessor<SystemProviderConnectionClock> {
    pub(crate) async fn unbind(
        &self,
        identity: &RequestIdentity,
        params: ResourceUnbindParams,
    ) -> Result<ResourceBindingProjection, JSONRPCErrorError> {
        let state = self
            .state
            .as_deref()
            .ok_or_else(|| internal_error("Provider resource binding state is unavailable"))?;
        let clock = SystemProviderConnectionClock;
        unbind_resource_binding(state, identity, &params.binding_id, clock.now())
            .await
            .map_err(ProviderResourceRuntimeError::from)
            .map_err(map_runtime_error)
    }
}

fn map_runtime_error(error: ProviderResourceRuntimeError) -> JSONRPCErrorError {
    match error {
        ProviderResourceRuntimeError::InvalidRequest => {
            invalid_params("Provider resource request is invalid")
        }
        ProviderResourceRuntimeError::Unauthorized
        | ProviderResourceRuntimeError::AuthorityChanged => {
            invalid_request("Provider resource request is not authorized")
        }
        ProviderResourceRuntimeError::NotFound => {
            invalid_request("Provider resource was not found")
        }
        ProviderResourceRuntimeError::CapacityExceeded => {
            invalid_request("Provider resource binding capacity was exceeded")
        }
        ProviderResourceRuntimeError::Conflict => {
            invalid_request("Provider resource binding conflicts with current state")
        }
        ProviderResourceRuntimeError::Unavailable => {
            internal_error("Provider resource is unavailable")
        }
        ProviderResourceRuntimeError::Incompatible => {
            invalid_request("Provider resource is incompatible")
        }
        ProviderResourceRuntimeError::InvalidResponse => {
            internal_error("Provider resource response is unavailable")
        }
    }
}

#[cfg(test)]
#[path = "provider_resource_request_processor_tests.rs"]
mod tests;
