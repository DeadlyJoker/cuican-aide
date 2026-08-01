use reqwest::Method;
use reqwest::StatusCode;
use reqwest::header::HeaderMap;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crewon_provider_transport::PinnedProviderClient;
use crewon_provider_transport::classify_request_error;

use crate::AgentPlatformProviderError;
use crate::ProviderAuthorizationHeaders;
use crate::wire::ProviderErrorCodeWire;
use crate::wire::ProviderErrorWire;

const MAX_RETRY_AFTER_SECONDS: u64 = 24 * 60 * 60;

pub(crate) struct AgentPlatformHttpClient {
    transport: PinnedProviderClient,
}

pub(crate) struct RawProviderResponse {
    pub(crate) headers: HeaderMap,
    pub(crate) body: Vec<u8>,
}

impl AgentPlatformHttpClient {
    pub(crate) fn new(transport: PinnedProviderClient) -> Self {
        Self { transport }
    }

    pub(crate) async fn post_json<Request, Response>(
        &self,
        path: &str,
        authorization: ProviderAuthorizationHeaders,
        request: &Request,
    ) -> Result<Response, AgentPlatformProviderError>
    where
        Request: Serialize + ?Sized,
        Response: DeserializeOwned,
    {
        let builder = self.transport.request(Method::POST, path)?;
        let response = authorization
            .apply(builder.json(request))
            .send()
            .await
            .map_err(classify_request_error)?;
        let status = response.status();
        validate_json_content_type(response.headers())?;
        let retry_after_seconds = parse_retry_after(response.headers())?;
        let body = self.transport.read_bounded_body(response).await?;
        if status == StatusCode::OK {
            return serde_json::from_slice(&body)
                .map_err(|_| AgentPlatformProviderError::InvalidResponse);
        }
        let error = serde_json::from_slice::<ProviderErrorWire>(&body)
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        map_error(status, error, retry_after_seconds)
    }

    pub(crate) async fn post_raw<Request>(
        &self,
        path: &str,
        authorization: ProviderAuthorizationHeaders,
        request: &Request,
    ) -> Result<RawProviderResponse, AgentPlatformProviderError>
    where
        Request: Serialize + ?Sized,
    {
        let builder = self.transport.request(Method::POST, path)?;
        let response = authorization
            .apply(builder.json(request))
            .send()
            .await
            .map_err(classify_request_error)?;
        let status = response.status();
        let headers = response.headers().clone();
        let retry_after_seconds = parse_retry_after(&headers)?;
        let body = self.transport.read_bounded_body(response).await?;
        if status == StatusCode::OK {
            return Ok(RawProviderResponse { headers, body });
        }
        validate_json_content_type(&headers)?;
        let error = serde_json::from_slice::<ProviderErrorWire>(&body)
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        map_error(status, error, retry_after_seconds)
    }

    pub(crate) async fn put_bytes_json<Response>(
        &self,
        path: &str,
        authorization: ProviderAuthorizationHeaders,
        headers: HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response, AgentPlatformProviderError>
    where
        Response: DeserializeOwned,
    {
        let builder = self.transport.request(Method::PUT, path)?;
        let response = authorization
            .apply(builder.headers(headers).body(body))
            .send()
            .await
            .map_err(classify_request_error)?;
        let status = response.status();
        validate_json_content_type(response.headers())?;
        let retry_after_seconds = parse_retry_after(response.headers())?;
        let body = self.transport.read_bounded_body(response).await?;
        if status == StatusCode::OK {
            return serde_json::from_slice(&body)
                .map_err(|_| AgentPlatformProviderError::InvalidResponse);
        }
        let error = serde_json::from_slice::<ProviderErrorWire>(&body)
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        map_error(status, error, retry_after_seconds)
    }
}

fn parse_retry_after(headers: &HeaderMap) -> Result<Option<u64>, AgentPlatformProviderError> {
    let mut values = headers.get_all("retry-after").iter();
    let value = values.next();
    if values.next().is_some() {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    Ok(value
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds <= MAX_RETRY_AFTER_SECONDS))
}

pub(crate) fn validate_json_content_type(
    headers: &HeaderMap,
) -> Result<(), AgentPlatformProviderError> {
    let mut values = headers.get_all("content-type").iter();
    let Some(value) = values.next() else {
        return Err(AgentPlatformProviderError::InvalidResponse);
    };
    if values.next().is_some()
        || !value
            .to_str()
            .ok()
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
    {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    Ok(())
}

fn map_error<T>(
    status: StatusCode,
    error: ProviderErrorWire,
    retry_after_seconds: Option<u64>,
) -> Result<T, AgentPlatformProviderError> {
    if error.trace_id.is_empty()
        || error.trace_id.len() > 128
        || error.trace_id.chars().any(char::is_control)
        || error.provider_run_id.as_ref().is_some_and(|run_id| {
            run_id.is_empty() || run_id.len() > 255 || run_id.chars().any(char::is_control)
        })
    {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    match (status, error.code, error.retryable) {
        (StatusCode::UNAUTHORIZED, ProviderErrorCodeWire::Unauthorized, false)
        | (StatusCode::FORBIDDEN, ProviderErrorCodeWire::Forbidden, false) => {
            Err(AgentPlatformProviderError::Unauthorized)
        }
        (StatusCode::NOT_FOUND, ProviderErrorCodeWire::NotFound, false) => {
            Err(AgentPlatformProviderError::NotFound)
        }
        (StatusCode::CONFLICT, ProviderErrorCodeWire::Conflict, false) => {
            Err(AgentPlatformProviderError::Conflict)
        }
        (StatusCode::UNPROCESSABLE_ENTITY, ProviderErrorCodeWire::CapabilityUnsupported, false) => {
            Err(AgentPlatformProviderError::Incompatible)
        }
        (StatusCode::TOO_MANY_REQUESTS, ProviderErrorCodeWire::ProviderUnavailable, true) => {
            Err(AgentPlatformProviderError::RateLimited {
                retry_after_seconds,
            })
        }
        (StatusCode::SERVICE_UNAVAILABLE, ProviderErrorCodeWire::ProviderUnavailable, true) => {
            Err(AgentPlatformProviderError::Unavailable)
        }
        (StatusCode::GATEWAY_TIMEOUT, ProviderErrorCodeWire::Timeout, true) => {
            Err(AgentPlatformProviderError::Timeout)
        }
        (StatusCode::INTERNAL_SERVER_ERROR, ProviderErrorCodeWire::UnknownOutcome, false) => {
            Err(AgentPlatformProviderError::UnknownOutcome)
        }
        (StatusCode::BAD_REQUEST, ProviderErrorCodeWire::InvalidRequest, false) => {
            Err(AgentPlatformProviderError::InvalidRequest)
        }
        (status, ProviderErrorCodeWire::Internal, false) if status.is_server_error() => {
            Err(AgentPlatformProviderError::Unavailable)
        }
        _ => Err(AgentPlatformProviderError::InvalidResponse),
    }
}

#[cfg(test)]
#[path = "http_client_tests.rs"]
mod tests;
