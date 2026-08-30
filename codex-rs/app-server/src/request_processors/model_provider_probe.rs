//! `modelProvider/probe` request handling.
//!
//! Exists as its own module because the answer it gives cannot be derived from
//! `model/list`: the models manager falls back to a bundled catalog when a
//! provider is unreachable, so a client has no way to tell a working provider
//! from a misconfigured one. This handler asks the provider directly.

use std::sync::Arc;

use crate::config_manager::ConfigManager;
use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ModelProviderProbeParams;
use crewon_app_server_protocol::ModelProviderProbeResponse;
use crewon_app_server_protocol::ModelProviderProbeStatus;
use crewon_core::ThreadManager;
use crewon_model_provider::ProbeStatus;
use crewon_model_provider::probe_model_provider;

/// Probes the requested provider, or the selected one when none is named.
pub(crate) async fn probe(
    config_manager: &ConfigManager,
    thread_manager: &Arc<ThreadManager>,
    params: ModelProviderProbeParams,
) -> Result<ModelProviderProbeResponse, JSONRPCErrorError> {
    let config = config_manager
        .load_latest_config(/*fallback_cwd*/ None)
        .await
        .map_err(|err| internal_error(format!("failed to reload config: {err}")))?;

    let (provider_id, provider) = match params.provider_id {
        Some(provider_id) => {
            let provider = config
                .model_providers
                .get(&provider_id)
                .ok_or_else(|| invalid_request(format!("unknown model provider `{provider_id}`")))?
                .clone();
            (provider_id, provider)
        }
        None => (
            config.model_provider_id.clone(),
            config.model_provider.clone(),
        ),
    };

    /*
     * The same auth the real catalog fetch would use, so a passing probe means
     * the credential that will actually be sent on a turn is the one that was
     * accepted. Provider-scoped credentials still take precedence inside
     * `probe_model_provider`.
     */
    let auth = thread_manager.auth_manager().auth().await;
    let outcome = probe_model_provider(&provider, auth.as_ref()).await;

    Ok(ModelProviderProbeResponse {
        provider_id,
        endpoint: outcome.endpoint,
        status: probe_status(outcome.status),
        http_status: outcome.http_status,
        model_count: outcome.model_count,
        authenticated: outcome.authenticated,
        message: outcome.message,
        latency_ms: outcome.latency_ms,
    })
}

fn probe_status(status: ProbeStatus) -> ModelProviderProbeStatus {
    match status {
        ProbeStatus::Ok => ModelProviderProbeStatus::Ok,
        ProbeStatus::Unauthorized => ModelProviderProbeStatus::Unauthorized,
        ProbeStatus::HttpError => ModelProviderProbeStatus::HttpError,
        ProbeStatus::Unreachable => ModelProviderProbeStatus::Unreachable,
        ProbeStatus::InvalidResponse => ModelProviderProbeStatus::InvalidResponse,
    }
}
