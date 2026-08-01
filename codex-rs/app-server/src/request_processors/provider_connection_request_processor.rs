use std::sync::Arc;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ProviderConnectParams;
use crewon_app_server_protocol::ProviderConnectResponse;
use crewon_app_server_protocol::ProviderReadParams;
use crewon_app_server_protocol::ProviderReadResponse;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crate::error_code::invalid_request;
use crate::platform_control::RequestIdentity;
use crate::platform_control::provider_connection_descriptor::ProviderConnectionClock;
use crate::platform_control::provider_connection_production::SystemProviderConnectionClock;
use crate::platform_control::provider_connection_startup::PreparedProviderConnectionRuntime;
use crate::platform_control::provider_connection_startup::ProviderConnectionRuntimeError;

pub(crate) struct ProviderConnectionRequestProcessor<Clock = SystemProviderConnectionClock> {
    runtime: Option<Arc<PreparedProviderConnectionRuntime<Clock>>>,
}

impl<Clock> ProviderConnectionRequestProcessor<Clock>
where
    Clock: ProviderConnectionClock,
{
    pub(crate) fn new(runtime: Option<Arc<PreparedProviderConnectionRuntime<Clock>>>) -> Self {
        Self { runtime }
    }

    pub(crate) async fn connect(
        &self,
        identity: &RequestIdentity,
        params: ProviderConnectParams,
    ) -> Result<ProviderConnectResponse, JSONRPCErrorError> {
        let runtime = self.runtime()?;
        runtime
            .connect(identity, &params.provider_id)
            .await
            .map(|provider| ProviderConnectResponse { provider })
            .map_err(map_runtime_error)
    }

    pub(crate) async fn read(
        &self,
        identity: &RequestIdentity,
        params: ProviderReadParams,
    ) -> Result<ProviderReadResponse, JSONRPCErrorError> {
        let runtime = self.runtime()?;
        runtime
            .read(identity, &params.connection_id)
            .await
            .map(|provider| ProviderReadResponse { provider })
            .map_err(map_runtime_error)
    }

    fn runtime(&self) -> Result<&PreparedProviderConnectionRuntime<Clock>, JSONRPCErrorError> {
        self.runtime
            .as_deref()
            .ok_or_else(|| internal_error("Provider connection runtime is unavailable"))
    }
}

fn map_runtime_error(error: ProviderConnectionRuntimeError) -> JSONRPCErrorError {
    match error {
        ProviderConnectionRuntimeError::InvalidRequest => {
            invalid_params("Provider connection request is invalid")
        }
        ProviderConnectionRuntimeError::Unauthorized
        | ProviderConnectionRuntimeError::AuthorityChanged => {
            invalid_request("Provider connection is not authorized")
        }
        ProviderConnectionRuntimeError::NotFound => {
            invalid_request("Provider connection was not found")
        }
        ProviderConnectionRuntimeError::CapacityExceeded
        | ProviderConnectionRuntimeError::Unavailable => {
            internal_error("Provider connection is unavailable")
        }
        ProviderConnectionRuntimeError::Incompatible => {
            invalid_request("Provider connection is incompatible")
        }
        ProviderConnectionRuntimeError::InvalidProjection => {
            internal_error("Provider connection response is unavailable")
        }
    }
}
