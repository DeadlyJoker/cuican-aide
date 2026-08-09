//! Reachability check for a configured model provider.
//!
//! `model/list` cannot answer "does this provider work?": the models manager
//! falls back to a bundled catalog whenever the remote fetch fails, so a
//! completely unreachable provider still yields a full model list. That makes a
//! misconfigured `base_url` or credential invisible until the first turn fails.
//!
//! This module issues one request against the provider's own `/models`
//! endpoint and reports what actually happened, so a client can tell a rejected
//! credential apart from an unreachable address.

use std::time::Duration;
use std::time::Instant;

use crewon_client::HttpTransport;
use crewon_client::Request;
use crewon_client::ReqwestTransport;
use crewon_client::TransportError;
use crewon_login::CrewonAuth;
use crewon_login::default_client::build_reqwest_client;
use crewon_model_provider_info::ModelProviderInfo;
use http::Method;
use http::StatusCode;
use serde::Deserialize;
use tokio::time::timeout;

use crate::auth::resolve_provider_auth;

/// Deliberately shorter than the regular models refresh: this runs behind a
/// button a user is waiting on, and a dead address should report back quickly
/// rather than look like the app hung.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

const MODELS_PATH: &str = "models";

/// How a provider responded to a reachability check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeStatus {
    /// Answered with a usable model catalog.
    Ok,
    /// Answered, but rejected the credential.
    Unauthorized,
    /// Answered with some other error status.
    HttpError,
    /// Could not be reached at all: DNS, TLS, connection refused, or timeout.
    Unreachable,
    /// Answered, but the body was not a model catalog.
    InvalidResponse,
}

/// Result of probing one provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutcome {
    /// Endpoint that was requested, so a wrong base URL is visible.
    pub endpoint: String,
    pub status: ProbeStatus,
    pub http_status: Option<u16>,
    pub model_count: Option<u32>,
    /// Whether a credential was attached, so "reachable but unauthenticated"
    /// is distinguishable from "reachable and authorized".
    pub authenticated: bool,
    pub message: Option<String>,
    pub latency_ms: u64,
}

/// Probes a provider's `/models` endpoint using the same auth resolution the
/// real model catalog fetch uses, so a passing probe means the configured
/// credential is the one that will be sent on a turn.
pub async fn probe_model_provider(
    provider: &ModelProviderInfo,
    auth: Option<&CrewonAuth>,
) -> ProbeOutcome {
    let started = Instant::now();

    let api_provider = match provider.to_api_provider(auth.map(CrewonAuth::auth_mode)) {
        Ok(api_provider) => api_provider,
        Err(err) => {
            return ProbeOutcome {
                endpoint: provider.base_url.clone().unwrap_or_default(),
                status: ProbeStatus::Unreachable,
                http_status: None,
                model_count: None,
                authenticated: false,
                message: Some(err.to_string()),
                latency_ms: started.elapsed().as_millis() as u64,
            };
        }
    };
    let endpoint = api_provider.url_for_path(MODELS_PATH);

    /*
     * A provider whose credential cannot even be resolved -- an `env_key`
     * pointing at an unset variable, say -- is reported as unauthorized rather
     * than surfaced as a transport failure, because the address is not what is
     * wrong.
     */
    let api_auth = match resolve_provider_auth(auth, provider) {
        Ok(api_auth) => api_auth,
        Err(err) => {
            return ProbeOutcome {
                endpoint,
                status: ProbeStatus::Unauthorized,
                http_status: None,
                model_count: None,
                authenticated: false,
                message: Some(err.to_string()),
                latency_ms: started.elapsed().as_millis() as u64,
            };
        }
    };
    let authenticated = !api_auth.to_auth_headers().is_empty();

    let mut request = Request::new(Method::GET, endpoint.clone());
    request.headers = api_provider.headers.clone();
    let request = match api_auth.apply_auth(request).await {
        Ok(request) => request,
        Err(err) => {
            return ProbeOutcome {
                endpoint,
                status: ProbeStatus::Unauthorized,
                http_status: None,
                model_count: None,
                authenticated,
                message: Some(err.to_string()),
                latency_ms: started.elapsed().as_millis() as u64,
            };
        }
    };

    let transport = ReqwestTransport::new(build_reqwest_client());
    let response = match timeout(PROBE_TIMEOUT, transport.execute(request)).await {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => {
            let failure = classify_transport_error(&err);
            return ProbeOutcome {
                endpoint,
                status: failure.status,
                http_status: failure.http_status,
                model_count: None,
                authenticated,
                message: Some(failure.message),
                latency_ms: started.elapsed().as_millis() as u64,
            };
        }
        Err(_) => {
            return ProbeOutcome {
                endpoint,
                status: ProbeStatus::Unreachable,
                http_status: None,
                model_count: None,
                authenticated,
                message: Some(format!("no response within {}s", PROBE_TIMEOUT.as_secs())),
                latency_ms: started.elapsed().as_millis() as u64,
            };
        }
    };

    // Only success statuses reach here; the transport routes the rest through
    // `TransportError::Http` above.
    let latency_ms = started.elapsed().as_millis() as u64;
    let http_status = Some(response.status.as_u16());

    match serde_json::from_slice::<ProbeCatalog>(&response.body) {
        Ok(catalog) => ProbeOutcome {
            endpoint,
            status: ProbeStatus::Ok,
            http_status,
            model_count: Some(catalog.model_count()),
            authenticated,
            message: None,
            latency_ms,
        },
        Err(err) => ProbeOutcome {
            endpoint,
            status: ProbeStatus::InvalidResponse,
            http_status,
            model_count: None,
            authenticated,
            message: Some(format!("could not read model catalog: {err}")),
            latency_ms,
        },
    }
}

/// A `/models` body, in either shape a provider may return.
///
/// The probe only needs to know that the endpoint served a catalog and roughly
/// how large it was, so entries stay untyped. Deserializing the full
/// `ModelsResponse` would reject every OpenAI-compatible gateway, which answers
/// with `data` and per-entry fields Crewon's own catalog does not define.
#[derive(Deserialize)]
#[serde(untagged)]
enum ProbeCatalog {
    /// Crewon's own catalog shape.
    Crewon { models: Vec<serde_json::Value> },
    /// The OpenAI-compatible shape most third-party gateways serve.
    OpenAiCompatible { data: Vec<serde_json::Value> },
}

impl ProbeCatalog {
    fn model_count(&self) -> u32 {
        let entries = match self {
            Self::Crewon { models } => models.len(),
            Self::OpenAiCompatible { data } => data.len(),
        };
        entries as u32
    }
}

/// Caps how much of a provider's error body is echoed back.
///
/// The body is attacker-influenced and can be arbitrarily large; a client only
/// needs enough to see what the provider objected to.
const MAX_ERROR_BODY_CHARS: usize = 400;

/// How a failed transport attempt should be reported to the user.
struct TransportFailure {
    status: ProbeStatus,
    http_status: Option<u16>,
    message: String,
}

/// Maps a transport failure onto a probe status.
///
/// The transport turns any non-2xx into [`TransportError::Http`] rather than
/// handing back the response, so an error status has to be recovered from the
/// error itself to tell a rejected credential apart from an address that never
/// answered.
fn classify_transport_error(err: &TransportError) -> TransportFailure {
    match err {
        TransportError::Http { status, body, .. } => TransportFailure {
            status: if matches!(*status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                ProbeStatus::Unauthorized
            } else {
                ProbeStatus::HttpError
            },
            http_status: Some(status.as_u16()),
            message: error_message(body.clone().unwrap_or_default().as_bytes()),
        },
        TransportError::RetryLimit
        | TransportError::Timeout
        | TransportError::Network(_)
        | TransportError::Build(_) => TransportFailure {
            status: ProbeStatus::Unreachable,
            http_status: None,
            message: err.to_string(),
        },
    }
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;

fn error_message(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body).trim().to_string();
    if text.is_empty() {
        return "provider returned an error with no body".to_string();
    }
    match text.char_indices().nth(MAX_ERROR_BODY_CHARS) {
        Some((index, _)) => format!("{}...", &text[..index]),
        None => text,
    }
}
