use std::future::Future;

use crate::AgentPlatformCapability;
use crate::AgentPlatformProviderClient;
use crate::AgentPlatformProviderError;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::ProviderRunCancelRequest;
use crate::ProviderRunCancelResult;
use crate::ProviderRunEventPage;
use crate::ProviderRunEventsRequest;
use crate::ProviderRunReadRequest;
use crate::ProviderRunSnapshot;
use crate::ProviderRunStartRequest;
use crate::ProviderRunStartResult;
use crate::RunAuthorizationOperation;
use crate::run_event_wire::EventsResponseWire;
use crate::run_wire::CancelCommandWire;
use crate::run_wire::CancelResponseWire;
use crate::run_wire::ListEventsCommandWire;
use crate::run_wire::ReadCommandWire;
use crate::run_wire::ReadResponseWire;
use crate::run_wire::StartCommandWire;
use crate::run_wire::StartResponseWire;

/// Durable Run port implemented by an external Provider adapter.
///
/// Implementations must preserve caller-supplied command and idempotency identities, must not
/// retry semantic operations internally, and must return only validated, typed Provider state.
pub trait DurableProviderRunClient {
    fn start(
        &self,
        request: ProviderRunStartRequest,
    ) -> impl Future<Output = Result<ProviderRunStartResult, AgentPlatformProviderError>> + Send;

    fn read(
        &self,
        request: ProviderRunReadRequest,
    ) -> impl Future<Output = Result<ProviderRunSnapshot, AgentPlatformProviderError>> + Send;

    fn list_events(
        &self,
        request: ProviderRunEventsRequest,
    ) -> impl Future<Output = Result<ProviderRunEventPage, AgentPlatformProviderError>> + Send;

    fn cancel(
        &self,
        request: ProviderRunCancelRequest,
    ) -> impl Future<Output = Result<ProviderRunCancelResult, AgentPlatformProviderError>> + Send;
}

impl<Authorizer> DurableProviderRunClient for AgentPlatformProviderClient<Authorizer>
where
    Authorizer: ProviderAuthorizer,
{
    async fn start(
        &self,
        request: ProviderRunStartRequest,
    ) -> Result<ProviderRunStartResult, AgentPlatformProviderError> {
        self.require_run_capabilities()?;
        let authorization = self
            .authorize_run(RunAuthorizationOperation::Start, request.authorization())
            .await?;
        self.http
            .post_json::<_, StartResponseWire>(
                "./runs:start",
                authorization,
                &StartCommandWire::from_domain(&request)?,
            )
            .await?
            .into_domain()
    }

    async fn read(
        &self,
        request: ProviderRunReadRequest,
    ) -> Result<ProviderRunSnapshot, AgentPlatformProviderError> {
        self.require_run_capabilities()?;
        let authorization = self
            .authorize_run(RunAuthorizationOperation::Read, request.authorization())
            .await?;
        self.http
            .post_json::<_, ReadResponseWire>(
                "./runs:read",
                authorization,
                &ReadCommandWire::from(&request),
            )
            .await?
            .into_domain(request.provider_run_id())
    }

    async fn list_events(
        &self,
        request: ProviderRunEventsRequest,
    ) -> Result<ProviderRunEventPage, AgentPlatformProviderError> {
        self.require_run_capabilities()?;
        let authorization = self
            .authorize_run(
                RunAuthorizationOperation::ListEvents,
                request.authorization(),
            )
            .await?;
        self.http
            .post_json::<_, EventsResponseWire>(
                "./runs:listEvents",
                authorization,
                &ListEventsCommandWire::from(&request),
            )
            .await?
            .into_domain(&request, &self.descriptor)
    }

    async fn cancel(
        &self,
        request: ProviderRunCancelRequest,
    ) -> Result<ProviderRunCancelResult, AgentPlatformProviderError> {
        self.require_run_capabilities()?;
        let authorization = self
            .authorize_run(RunAuthorizationOperation::Cancel, request.authorization())
            .await?;
        self.http
            .post_json::<_, CancelResponseWire>(
                "./runs:cancel",
                authorization,
                &CancelCommandWire::from(&request),
            )
            .await?
            .into_domain()
    }
}

impl<Authorizer> AgentPlatformProviderClient<Authorizer>
where
    Authorizer: ProviderAuthorizer,
{
    pub(crate) fn require_run_capabilities(&self) -> Result<(), AgentPlatformProviderError> {
        if self
            .descriptor
            .supports(AgentPlatformCapability::DurableRun)
            && self
                .descriptor
                .supports(AgentPlatformCapability::ResumableEvents)
        {
            Ok(())
        } else {
            Err(AgentPlatformProviderError::Incompatible)
        }
    }

    pub(crate) async fn authorize_run(
        &self,
        operation: RunAuthorizationOperation,
        binding: &crate::ProviderRunAuthorizationBinding,
    ) -> Result<crate::ProviderAuthorizationHeaders, AgentPlatformProviderError> {
        self.authorizer
            .authorize(ProviderAuthorizationRequest::Run {
                operation,
                binding: binding.clone(),
            })
            .await
            .map_err(map_authorization)
    }
}

fn map_authorization(error: ProviderAuthorizationError) -> AgentPlatformProviderError {
    match error {
        ProviderAuthorizationError::Unavailable => AgentPlatformProviderError::Unavailable,
        ProviderAuthorizationError::Unauthorized => AgentPlatformProviderError::Unauthorized,
    }
}

#[cfg(test)]
#[path = "run_client_tests.rs"]
mod tests;
