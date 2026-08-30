use std::fmt;

use crewon_state::ProviderConnectionRecord;
use crewon_state::ProviderConnectionResolveOutcome;
use crewon_state::StateRuntime;
use uuid::Uuid;

use super::RequestIdentity;
use super::provider_access_grant_authority::ProviderAccessGrantAuthority;
use super::provider_access_grant_authority::ProviderAccessGrantAuthorityError;
use super::provider_access_grant_authority::resolve_agent_platform_access_grant_authority;
use super::provider_connection_descriptor::LiveProviderDescriptor;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_descriptor::ProviderDescriptorReadError;
use super::provider_connection_descriptor::ProviderDescriptorReadRequest;
use super::provider_connection_descriptor::ProviderDescriptorReader;
use super::provider_identity_adapter::ProviderIdentityAdapterError;
use super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";
const CONNECTION_ID_PREFIX: &str = "provider-connection:";
const MAX_CONNECTION_ID_ATTEMPTS: usize = 4;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ProviderConnectionView {
    connection: ProviderConnectionRecord,
    descriptor: LiveProviderDescriptor,
    observed_at: i64,
}

impl ProviderConnectionView {
    pub(crate) fn new(
        connection: ProviderConnectionRecord,
        descriptor: LiveProviderDescriptor,
        observed_at: i64,
    ) -> Self {
        Self {
            connection,
            descriptor,
            observed_at,
        }
    }

    pub(crate) fn connection(&self) -> &ProviderConnectionRecord {
        &self.connection
    }

    pub(crate) fn descriptor(&self) -> &LiveProviderDescriptor {
        &self.descriptor
    }

    pub(crate) fn observed_at(&self) -> i64 {
        self.observed_at
    }
}

impl fmt::Debug for ProviderConnectionView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderConnectionView")
            .field("connection_id", &self.connection.connection_id)
            .field("provider_id", &self.connection.provider_id)
            .field("protocol_version", &self.connection.protocol_version)
            .field("authority", &"[REDACTED]")
            .field("observed_at", &self.observed_at)
            .finish()
    }
}

pub(super) struct ProviderConnectionAccess {
    connection: ProviderConnectionRecord,
    authority: ProviderAccessGrantAuthority,
    started_at: i64,
}

impl ProviderConnectionAccess {
    pub(super) fn connection(&self) -> &ProviderConnectionRecord {
        &self.connection
    }

    pub(super) fn authorization_identity(
        &self,
    ) -> &crewon_provider_agent_platform::ProviderAuthorizationIdentity {
        self.authority.provider_identity()
    }
}

impl fmt::Debug for ProviderConnectionAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderConnectionAccess([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderConnectionProcessorError {
    #[error("Provider connection request is invalid")]
    InvalidRequest,
    #[error("Provider connection is not authorized")]
    Unauthorized,
    #[error("Provider connection was not found")]
    NotFound,
    #[error("Provider authority changed during descriptor validation")]
    AuthorityChanged,
    #[error("Provider connection capacity was exceeded")]
    CapacityExceeded,
    #[error("Provider connection is unavailable")]
    Unavailable,
    #[error("Provider connection is incompatible")]
    Incompatible,
}

pub(crate) struct ProviderConnectionProcessor<'a, Reader, Clock> {
    state: &'a StateRuntime,
    ready_mappings: &'a ReadyProviderIdentityMappings,
    descriptor_reader: &'a Reader,
    clock: &'a Clock,
}

impl<'a, Reader, Clock> ProviderConnectionProcessor<'a, Reader, Clock>
where
    Reader: ProviderDescriptorReader,
    Clock: ProviderConnectionClock,
{
    pub(crate) fn new(
        state: &'a StateRuntime,
        ready_mappings: &'a ReadyProviderIdentityMappings,
        descriptor_reader: &'a Reader,
        clock: &'a Clock,
    ) -> Self {
        Self {
            state,
            ready_mappings,
            descriptor_reader,
            clock,
        }
    }

    pub(crate) async fn connect(
        &self,
        identity: &RequestIdentity,
        provider_id: &str,
    ) -> Result<ProviderConnectionView, ProviderConnectionProcessorError> {
        if provider_id != AGENT_PLATFORM_PROVIDER_ID {
            return Err(ProviderConnectionProcessorError::InvalidRequest);
        }
        let before = checked_now(self.clock)?;
        let before_authority = resolve_agent_platform_access_grant_authority(
            self.state,
            identity,
            self.ready_mappings,
            before,
        )
        .await
        .map_err(map_pre_authority_error)?;
        let descriptor = self
            .descriptor_reader
            .read_descriptor(ProviderDescriptorReadRequest {
                provider_id: provider_id.to_string(),
                authorization_identity: before_authority.provider_identity().clone(),
            })
            .await
            .map_err(map_descriptor_error)?;
        let after = checked_now(self.clock)?;
        if after < before {
            return Err(ProviderConnectionProcessorError::Unavailable);
        }
        let after_authority = resolve_agent_platform_access_grant_authority(
            self.state,
            identity,
            self.ready_mappings,
            after,
        )
        .await
        .map_err(map_post_authority_error)?;
        if before_authority != after_authority {
            return Err(ProviderConnectionProcessorError::AuthorityChanged);
        }

        let reference = identity.reference();
        let tenant_id = reference
            .tenant_id
            .as_deref()
            .ok_or(ProviderConnectionProcessorError::Unauthorized)?;
        let space_id = reference
            .space_id
            .as_deref()
            .ok_or(ProviderConnectionProcessorError::Unauthorized)?;
        for _ in 0..MAX_CONNECTION_ID_ATTEMPTS {
            let grant = after_authority.grant();
            let mut record = ProviderConnectionRecord {
                connection_id: format!("{CONNECTION_ID_PREFIX}{}", Uuid::now_v7()),
                local_actor_id: reference.actor_id.clone(),
                local_tenant_id: tenant_id.to_string(),
                local_space_id: space_id.to_string(),
                provider_id: provider_id.to_string(),
                protocol_version: descriptor.provider().protocol_version.as_str().to_string(),
                credential_id: grant.grant_id.clone(),
                credential_revision: grant.revision,
                record_hash: String::new(),
                created_at: after,
            };
            record.record_hash = record.canonical_hash();
            match self
                .state
                .resolve_provider_connection_record(&record)
                .await
                .map_err(|_| ProviderConnectionProcessorError::Unavailable)?
            {
                ProviderConnectionResolveOutcome::Created(connection)
                | ProviderConnectionResolveOutcome::Existing(connection) => {
                    return Ok(ProviderConnectionView::new(connection, descriptor, after));
                }
                ProviderConnectionResolveOutcome::CapacityExceeded => {
                    return Err(ProviderConnectionProcessorError::CapacityExceeded);
                }
                ProviderConnectionResolveOutcome::Conflict => {}
            }
        }
        Err(ProviderConnectionProcessorError::Unavailable)
    }

    pub(crate) async fn read(
        &self,
        identity: &RequestIdentity,
        connection_id: &str,
    ) -> Result<ProviderConnectionView, ProviderConnectionProcessorError> {
        let access = begin_provider_connection_access(
            self.state,
            self.ready_mappings,
            self.clock,
            identity,
            connection_id,
        )
        .await?;
        let descriptor = self
            .descriptor_reader
            .read_descriptor(ProviderDescriptorReadRequest {
                provider_id: access.connection.provider_id.clone(),
                authorization_identity: access.authorization_identity().clone(),
            })
            .await
            .map_err(map_descriptor_error)?;
        let after = finish_provider_connection_access(
            self.state,
            self.ready_mappings,
            self.clock,
            identity,
            &access,
        )
        .await?;
        if descriptor.provider().protocol_version.as_str() != access.connection.protocol_version {
            return Err(ProviderConnectionProcessorError::Incompatible);
        }
        Ok(ProviderConnectionView::new(
            access.connection,
            descriptor,
            after,
        ))
    }
}

pub(super) async fn begin_provider_connection_access<Clock>(
    state: &StateRuntime,
    ready_mappings: &ReadyProviderIdentityMappings,
    clock: &Clock,
    identity: &RequestIdentity,
    connection_id: &str,
) -> Result<ProviderConnectionAccess, ProviderConnectionProcessorError>
where
    Clock: ProviderConnectionClock,
{
    let Some(raw_uuid) = connection_id.strip_prefix(CONNECTION_ID_PREFIX) else {
        return Err(ProviderConnectionProcessorError::InvalidRequest);
    };
    let parsed =
        Uuid::parse_str(raw_uuid).map_err(|_| ProviderConnectionProcessorError::InvalidRequest)?;
    if parsed.to_string() != raw_uuid {
        return Err(ProviderConnectionProcessorError::InvalidRequest);
    }
    let connection = state
        .get_provider_connection_record(connection_id)
        .await
        .map_err(|_| ProviderConnectionProcessorError::Unavailable)?
        .ok_or(ProviderConnectionProcessorError::NotFound)?;
    let reference = identity.reference();
    if connection.local_actor_id != reference.actor_id
        || reference.tenant_id.as_deref() != Some(connection.local_tenant_id.as_str())
        || reference.space_id.as_deref() != Some(connection.local_space_id.as_str())
    {
        return Err(ProviderConnectionProcessorError::NotFound);
    }

    let started_at = checked_now(clock)?;
    let authority =
        resolve_agent_platform_access_grant_authority(state, identity, ready_mappings, started_at)
            .await
            .map_err(map_pre_authority_error)?;
    if connection.provider_id != AGENT_PLATFORM_PROVIDER_ID
        || connection.credential_id != authority.grant().grant_id
        || connection.credential_revision != authority.grant().revision
    {
        return Err(ProviderConnectionProcessorError::Unauthorized);
    }
    Ok(ProviderConnectionAccess {
        connection,
        authority,
        started_at,
    })
}

pub(super) async fn finish_provider_connection_access<Clock>(
    state: &StateRuntime,
    ready_mappings: &ReadyProviderIdentityMappings,
    clock: &Clock,
    identity: &RequestIdentity,
    access: &ProviderConnectionAccess,
) -> Result<i64, ProviderConnectionProcessorError>
where
    Clock: ProviderConnectionClock,
{
    let observed_at = checked_now(clock)?;
    if observed_at < access.started_at {
        return Err(ProviderConnectionProcessorError::Unavailable);
    }
    let authority =
        resolve_agent_platform_access_grant_authority(state, identity, ready_mappings, observed_at)
            .await
            .map_err(map_post_authority_error)?;
    if access.authority != authority
        || access.connection.credential_id != authority.grant().grant_id
        || access.connection.credential_revision != authority.grant().revision
    {
        return Err(ProviderConnectionProcessorError::AuthorityChanged);
    }
    Ok(observed_at)
}

fn checked_now<Clock>(clock: &Clock) -> Result<i64, ProviderConnectionProcessorError>
where
    Clock: ProviderConnectionClock,
{
    let now = clock.now();
    if now < 0 {
        return Err(ProviderConnectionProcessorError::Unavailable);
    }
    Ok(now)
}

fn map_pre_authority_error(
    error: ProviderAccessGrantAuthorityError,
) -> ProviderConnectionProcessorError {
    match error {
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::MappingUnavailable,
        )
        | ProviderAccessGrantAuthorityError::StateUnavailable => {
            ProviderConnectionProcessorError::Unavailable
        }
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::InvalidMapping,
        )
        | ProviderAccessGrantAuthorityError::InvalidGrant => {
            ProviderConnectionProcessorError::Incompatible
        }
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::Unauthenticated
            | ProviderIdentityAdapterError::IdentityScope
            | ProviderIdentityAdapterError::PrincipalMismatch
            | ProviderIdentityAdapterError::CredentialOwnerMismatch
            | ProviderIdentityAdapterError::MappingNotFound
            | ProviderIdentityAdapterError::SessionBindingMismatch,
        )
        | ProviderAccessGrantAuthorityError::GrantNotFound => {
            ProviderConnectionProcessorError::Unauthorized
        }
    }
}

fn map_post_authority_error(
    error: ProviderAccessGrantAuthorityError,
) -> ProviderConnectionProcessorError {
    match error {
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::MappingUnavailable,
        )
        | ProviderAccessGrantAuthorityError::StateUnavailable => {
            ProviderConnectionProcessorError::Unavailable
        }
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::Unauthenticated
            | ProviderIdentityAdapterError::IdentityScope
            | ProviderIdentityAdapterError::PrincipalMismatch
            | ProviderIdentityAdapterError::CredentialOwnerMismatch
            | ProviderIdentityAdapterError::MappingNotFound
            | ProviderIdentityAdapterError::InvalidMapping
            | ProviderIdentityAdapterError::SessionBindingMismatch,
        )
        | ProviderAccessGrantAuthorityError::GrantNotFound
        | ProviderAccessGrantAuthorityError::InvalidGrant => {
            ProviderConnectionProcessorError::AuthorityChanged
        }
    }
}

fn map_descriptor_error(error: ProviderDescriptorReadError) -> ProviderConnectionProcessorError {
    match error {
        ProviderDescriptorReadError::Unauthorized => ProviderConnectionProcessorError::Unauthorized,
        ProviderDescriptorReadError::Unavailable => ProviderConnectionProcessorError::Unavailable,
        ProviderDescriptorReadError::Incompatible
        | ProviderDescriptorReadError::InvalidResponse => {
            ProviderConnectionProcessorError::Incompatible
        }
    }
}
