use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Deserialize;
use serde::Serialize;
use tokio::sync::Semaphore;

const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_CONCURRENT_EXCHANGES: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PrincipalSessionExchangeRequest {
    bootstrap_token: String,
}

impl PrincipalSessionExchangeRequest {
    pub(super) fn into_token(self) -> String {
        self.bootstrap_token
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrincipalSessionExchangeResponse {
    token: String,
    expires_at: i64,
}

impl From<PrincipalSessionExchangeResult> for PrincipalSessionExchangeResponse {
    fn from(result: PrincipalSessionExchangeResult) -> Self {
        let (token, expires_at) = result.into_parts();
        Self { token, expires_at }
    }
}

#[derive(Serialize)]
pub(super) struct PrincipalSessionExchangeErrorResponse {
    code: &'static str,
}

impl PrincipalSessionExchangeErrorResponse {
    pub(super) fn new(code: &'static str) -> Self {
        Self { code }
    }
}

type ExchangeFuture = Pin<
    Box<
        dyn Future<Output = Result<PrincipalSessionExchangeResult, PrincipalSessionExchangeError>>
            + Send,
    >,
>;
type ExchangeHandler = dyn Fn(String) -> ExchangeFuture + Send + Sync;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PrincipalSessionExchangeError {
    Invalid,
    Unauthorized,
    Conflict,
    Unavailable,
}

impl fmt::Display for PrincipalSessionExchangeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Invalid => "principal session exchange request is invalid",
            Self::Unauthorized => "principal session exchange is unauthorized",
            Self::Conflict => "principal session exchange conflicts with current authority",
            Self::Unavailable => "principal session exchange is unavailable",
        })
    }
}

impl std::error::Error for PrincipalSessionExchangeError {}

pub struct PrincipalSessionExchangeResult {
    token: String,
    expires_at: i64,
}

impl PrincipalSessionExchangeResult {
    pub fn new(
        token: impl Into<String>,
        expires_at: i64,
    ) -> Result<Self, PrincipalSessionExchangeError> {
        let token = token.into();
        if token.is_empty()
            || token.len() > MAX_TOKEN_BYTES
            || token.chars().any(char::is_control)
            || expires_at < 0
        {
            return Err(PrincipalSessionExchangeError::Invalid);
        }
        Ok(Self { token, expires_at })
    }

    pub(super) fn into_parts(self) -> (String, i64) {
        (self.token, self.expires_at)
    }

    pub fn reveal_token_for_transport(&self) -> &str {
        &self.token
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

impl fmt::Debug for PrincipalSessionExchangeResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalSessionExchangeResult")
            .field("token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone)]
pub struct PrincipalSessionExchangeService {
    handler: Arc<ExchangeHandler>,
    permits: Arc<Semaphore>,
}

impl PrincipalSessionExchangeService {
    pub fn new<Handler, HandlerFuture>(handler: Handler) -> Self
    where
        Handler: Fn(String) -> HandlerFuture + Send + Sync + 'static,
        HandlerFuture: Future<Output = Result<PrincipalSessionExchangeResult, PrincipalSessionExchangeError>>
            + Send
            + 'static,
    {
        Self {
            handler: Arc::new(move |token| Box::pin(handler(token))),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_EXCHANGES)),
        }
    }

    pub async fn exchange(
        &self,
        bootstrap_token: String,
    ) -> Result<PrincipalSessionExchangeResult, PrincipalSessionExchangeError> {
        if bootstrap_token.is_empty()
            || bootstrap_token.len() > MAX_TOKEN_BYTES
            || bootstrap_token.chars().any(char::is_control)
        {
            return Err(PrincipalSessionExchangeError::Invalid);
        }
        let _permit = self
            .permits
            .try_acquire()
            .map_err(|_| PrincipalSessionExchangeError::Unavailable)?;
        (self.handler)(bootstrap_token).await
    }
}

impl fmt::Debug for PrincipalSessionExchangeService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PrincipalSessionExchangeService([REDACTED])")
    }
}

#[cfg(test)]
#[path = "principal_session_exchange_tests.rs"]
mod tests;
