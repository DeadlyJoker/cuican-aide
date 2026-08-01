use crewon_app_server_protocol::IdentityReadResponse;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_app_server_protocol::RequestIdentityRef;
use crewon_app_server_protocol::RequestIdentityTransport;
use crewon_policy::PolicyActor;
use crewon_policy::PolicyModelError;
use uuid::Uuid;

use super::AuthenticatedPrincipal;
use crate::transport::ConnectionOrigin;

/// Server-derived identity attached to one app-server request.
///
/// The actor is connection-scoped unless a future trusted transport supplies
/// verified subject claims. Client-declared metadata is carried separately and
/// must never be used as an authorization principal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestIdentity {
    reference: RequestIdentityRef,
    transport: RequestIdentityTransport,
    audit_subject: String,
    client: RequestIdentityClientRef,
    authenticated_principal: Option<AuthenticatedPrincipal>,
}

impl RequestIdentity {
    /// Returns the canonical server-derived identity reference.
    pub fn reference(&self) -> &RequestIdentityRef {
        &self.reference
    }

    /// Returns the trusted transport category that created the connection.
    pub fn transport(&self) -> RequestIdentityTransport {
        self.transport
    }

    /// Returns the server-derived, connection-unique audit subject.
    pub fn audit_subject(&self) -> &str {
        &self.audit_subject
    }

    /// Returns client metadata declared during initialize.
    ///
    /// This metadata is not an authorization principal.
    pub fn declared_client(&self) -> &RequestIdentityClientRef {
        &self.client
    }

    pub(crate) fn authenticated_principal(&self) -> Option<&AuthenticatedPrincipal> {
        self.authenticated_principal.as_ref()
    }

    pub(crate) fn policy_actor(&self) -> Result<PolicyActor, RequestIdentityActorError> {
        match (&self.reference.tenant_id, &self.reference.space_id) {
            (None, None) => Ok(PolicyActor::user(&self.reference.actor_id)?),
            (Some(tenant_id), None) => Ok(PolicyActor::tenant_user(
                &self.reference.actor_id,
                tenant_id,
            )?),
            (Some(tenant_id), Some(space_id)) => Ok(PolicyActor::space_user(
                &self.reference.actor_id,
                tenant_id,
                space_id,
            )?),
            (None, Some(_)) => Err(RequestIdentityActorError::IdentityScope),
        }
    }

    pub(crate) fn into_response(self) -> IdentityReadResponse {
        IdentityReadResponse {
            identity: self.reference,
            transport: self.transport,
            audit_subject: self.audit_subject,
            client: self.client,
        }
    }
}

#[derive(Debug)]
pub(crate) enum RequestIdentityActorError {
    IdentityScope,
    Model(PolicyModelError),
}

impl From<PolicyModelError> for RequestIdentityActorError {
    fn from(error: PolicyModelError) -> Self {
        Self::Model(error)
    }
}

#[derive(Debug)]
pub(crate) struct ConnectionRequestIdentity {
    actor_id: String,
    tenant_id: Option<String>,
    space_id: Option<String>,
    session_id: String,
    transport: RequestIdentityTransport,
    audit_subject: String,
    authenticated_principal: Option<AuthenticatedPrincipal>,
}

impl ConnectionRequestIdentity {
    pub(crate) fn new(origin: ConnectionOrigin) -> Self {
        Self::from_principal(origin, /*authenticated_principal*/ None)
    }

    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "W2-04P constructor is harnessed before transport claims composition"
        )
    )]
    pub(crate) fn new_authenticated(
        origin: ConnectionOrigin,
        principal: AuthenticatedPrincipal,
    ) -> Self {
        Self::from_principal(origin, Some(principal))
    }

    fn from_principal(
        origin: ConnectionOrigin,
        authenticated_principal: Option<AuthenticatedPrincipal>,
    ) -> Self {
        let session_id = Uuid::now_v7().to_string();
        let (transport, actor_prefix, audit_subject_prefix) = match origin {
            ConnectionOrigin::Stdio => (
                RequestIdentityTransport::Stdio,
                "local-stdio",
                "localProcess:stdio",
            ),
            ConnectionOrigin::InProcess => (
                RequestIdentityTransport::InProcess,
                "local-in-process",
                "localProcess:inProcess",
            ),
            ConnectionOrigin::WebSocket => (
                RequestIdentityTransport::WebSocket,
                "remote-websocket",
                "remoteConnection:webSocket",
            ),
            ConnectionOrigin::RemoteControl => (
                RequestIdentityTransport::RemoteControl,
                "remote-control",
                "remoteConnection:remoteControl",
            ),
        };
        let actor_id = authenticated_principal.as_ref().map_or_else(
            || format!("{actor_prefix}:{session_id}"),
            |principal| principal.stable_actor_id().to_string(),
        );
        let tenant_id = authenticated_principal
            .as_ref()
            .map(|principal| principal.tenant_id().to_string());
        let space_id = authenticated_principal
            .as_ref()
            .map(|principal| principal.space_id().to_string());
        let audit_subject = format!("{audit_subject_prefix}:{session_id}");
        Self {
            actor_id,
            tenant_id,
            space_id,
            session_id,
            transport,
            audit_subject,
            authenticated_principal,
        }
    }

    pub(crate) fn derive(
        &self,
        client: RequestIdentityClientRef,
        trace_id: String,
    ) -> RequestIdentity {
        RequestIdentity {
            reference: RequestIdentityRef {
                actor_id: self.actor_id.clone(),
                tenant_id: self.tenant_id.clone(),
                space_id: self.space_id.clone(),
                session_id: self.session_id.clone(),
                trace_id,
            },
            transport: self.transport,
            audit_subject: self.audit_subject.clone(),
            client,
            authenticated_principal: self.authenticated_principal.clone(),
        }
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }
}

#[cfg(test)]
#[path = "request_identity_tests.rs"]
mod tests;
