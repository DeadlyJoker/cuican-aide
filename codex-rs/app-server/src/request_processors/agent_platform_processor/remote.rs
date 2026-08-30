use crewon_app_server_protocol::AgentPlatformUser;
use crewon_app_server_protocol::JSONRPCErrorError;
use futures::StreamExt;
use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;

use crate::error_code::internal_error;

use super::AgentPlatformRequestProcessor;
use super::MAX_ACCESS_TOKEN_BYTES;
use super::MAX_REMOTE_JSON_BYTES;
use super::RemoteAgentStatus;
use super::RemoteUser;
use super::RemoteWorkflowStatus;
use super::validation::validate_agent_id;
use super::validation::validate_workflow_id;

impl AgentPlatformRequestProcessor {
    pub(super) async fn verify_user(
        &self,
        access_token: &str,
    ) -> Result<AgentPlatformUser, JSONRPCErrorError> {
        validate_access_token(access_token)?;
        let url = format!("{}/api/v1/auth/me", self.base_url()?);
        let response = self
            .inner
            .client
            .get(url)
            .bearer_auth(access_token)
            .timeout(self.inner.preflight_timeout)
            .send()
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(remote_response_error(status, response).await);
        }
        let user = decode_json_response::<RemoteUser>(response).await?;
        Ok(AgentPlatformUser {
            id: user.id,
            username: user.username,
        })
    }

    pub(super) async fn send_open_api<T, B>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, JSONRPCErrorError>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize + ?Sized,
    {
        let mut request = self
            .inner
            .client
            .request(method, format!("{}{path}", self.base_url()?))
            .header("X-API-Key", self.api_key()?)
            .timeout(self.inner.request_timeout);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(remote_response_error(status, response).await);
        }
        decode_json_response(response).await
    }

    pub(super) async fn send_workflow_open_api<T, B>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, JSONRPCErrorError>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize + ?Sized,
    {
        let mut request = self
            .inner
            .client
            .request(method, format!("{}{path}", self.base_url()?))
            .timeout(self.inner.request_timeout);
        if let Some(api_key) = self.inner.api_key.as_deref() {
            request = request.header("X-API-Key", api_key);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(remote_response_error(status, response).await);
        }
        decode_json_response(response).await
    }

    pub(super) async fn verify_enabled_agent_access(
        &self,
        access_token: &str,
        agent_id: &str,
    ) -> Result<String, JSONRPCErrorError> {
        validate_access_token(access_token)?;
        validate_agent_id(agent_id)?;
        let response = self
            .inner
            .client
            .get(format!(
                "{}/api/v1/agents/{agent_id}/api-status",
                self.base_url()?
            ))
            .bearer_auth(access_token)
            .timeout(self.inner.preflight_timeout)
            .send()
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(remote_response_error(status, response).await);
        }
        let status = decode_json_response::<RemoteAgentStatus>(response).await?;
        if status.api_enabled != 1 {
            return Err(remote_error(
                StatusCode::FORBIDDEN,
                "Agent Open API is not enabled",
            ));
        }
        let canonical_id = status.uid.unwrap_or_else(|| status.id.to_string());
        validate_agent_id(&canonical_id)?;
        Ok(canonical_id)
    }

    pub(super) async fn verify_enabled_workflow_access(
        &self,
        access_token: &str,
        workflow_id: &str,
    ) -> Result<String, JSONRPCErrorError> {
        let status = self.read_workflow_status(access_token, workflow_id).await?;
        if status.api_enabled != 1 {
            return Err(remote_error(
                StatusCode::FORBIDDEN,
                "Workflow Open API is not enabled",
            ));
        }
        canonical_workflow_id(status)
    }

    pub(super) async fn verify_workflow_access(
        &self,
        access_token: &str,
        workflow_id: &str,
    ) -> Result<String, JSONRPCErrorError> {
        canonical_workflow_id(self.read_workflow_status(access_token, workflow_id).await?)
    }

    async fn read_workflow_status(
        &self,
        access_token: &str,
        workflow_id: &str,
    ) -> Result<RemoteWorkflowStatus, JSONRPCErrorError> {
        validate_access_token(access_token)?;
        validate_workflow_id(workflow_id)?;
        let response = self
            .inner
            .client
            .get(format!(
                "{}/api/v1/workflows/{workflow_id}/api-status",
                self.base_url()?
            ))
            .bearer_auth(access_token)
            .timeout(self.inner.preflight_timeout)
            .send()
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(remote_response_error(status, response).await);
        }
        decode_json_response(response).await
    }

    pub(super) fn base_url(&self) -> Result<&str, JSONRPCErrorError> {
        let base_url =
            self.inner.base_url.as_deref().ok_or_else(|| {
                internal_error("CREWON_AGENT_PLATFORM_BASE_URL is not configured")
            })?;
        let parsed = reqwest::Url::parse(base_url)
            .map_err(|_| internal_error("CREWON_AGENT_PLATFORM_BASE_URL is invalid"))?;
        let loopback = parsed.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
        if parsed.scheme() != "https"
            && !(parsed.scheme() == "http" && (loopback || self.inner.allow_insecure_http))
        {
            return Err(internal_error(
                "CREWON_AGENT_PLATFORM_BASE_URL must use HTTPS unless it is loopback",
            ));
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(internal_error(
                "CREWON_AGENT_PLATFORM_BASE_URL must not contain credentials",
            ));
        }
        Ok(base_url)
    }

    pub(super) fn api_key(&self) -> Result<&str, JSONRPCErrorError> {
        self.inner
            .api_key
            .as_deref()
            .ok_or_else(|| internal_error("CREWON_AGENT_PLATFORM_API_KEY is not configured"))
    }
}

pub(super) fn remote_error(status: StatusCode, message: impl Into<String>) -> JSONRPCErrorError {
    JSONRPCErrorError {
        code: i64::from(status.as_u16()),
        message: message.into(),
        data: None,
    }
}

pub(super) async fn remote_response_error(
    status: StatusCode,
    response: reqwest::Response,
) -> JSONRPCErrorError {
    let detail = read_limited_body(response).await.unwrap_or_default();
    let message = serde_json::from_slice::<serde_json::Value>(&detail)
        .ok()
        .and_then(|value| {
            value.get("detail").map(|detail| {
                detail
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| detail.to_string())
            })
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("Agent Platform request failed with HTTP {status}"));
    remote_error(status, message)
}

pub(super) async fn decode_json_response<T>(
    response: reqwest::Response,
) -> Result<T, JSONRPCErrorError>
where
    T: for<'de> Deserialize<'de>,
{
    let body = read_limited_body(response).await?;
    serde_json::from_slice(&body).map_err(|error| internal_error(error.to_string()))
}

fn canonical_workflow_id(status: RemoteWorkflowStatus) -> Result<String, JSONRPCErrorError> {
    let canonical_id = status.id.to_string();
    validate_workflow_id(&canonical_id)?;
    Ok(canonical_id)
}

async fn read_limited_body(response: reqwest::Response) -> Result<Vec<u8>, JSONRPCErrorError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_JSON_BYTES as u64)
    {
        return Err(internal_error("Agent Platform response body was too large"));
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| internal_error(error.to_string()))?;
        if body.len().saturating_add(chunk.len()) > MAX_REMOTE_JSON_BYTES {
            return Err(internal_error("Agent Platform response body was too large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn validate_access_token(access_token: &str) -> Result<(), JSONRPCErrorError> {
    if access_token.trim().is_empty() || access_token.len() > MAX_ACCESS_TOKEN_BYTES {
        return Err(remote_error(
            StatusCode::UNAUTHORIZED,
            "missing or invalid Agent Platform access token",
        ));
    }
    Ok(())
}
