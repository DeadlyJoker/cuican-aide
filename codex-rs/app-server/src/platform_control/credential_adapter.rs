use super::RequestIdentity;
use crewon_policy::ActionCredentialRef;
use crewon_policy::CredentialBinding;
use crewon_policy::CredentialExpiry;
use crewon_policy::CredentialState;
use crewon_policy::PolicyModelError;
use crewon_resource_federation::ModelError as ResourceModelError;
use crewon_resource_federation::ProviderId;
use crewon_secrets::CredentialMetadata;
use crewon_secrets::CredentialOwner;
use crewon_secrets::CredentialStatus;
use crewon_secrets::CredentialStoreError;
use std::fmt;

pub(crate) fn credential_owner(
    identity: &RequestIdentity,
) -> Result<CredentialOwner, CredentialAdapterError> {
    let reference = identity.reference();
    Ok(match (&reference.tenant_id, &reference.space_id) {
        (None, None) => CredentialOwner::user(&reference.actor_id)?,
        (Some(tenant_id), None) => CredentialOwner::tenant_user(&reference.actor_id, tenant_id)?,
        (Some(tenant_id), Some(space_id)) => {
            CredentialOwner::space_user(&reference.actor_id, tenant_id, space_id)?
        }
        (None, Some(_)) => return Err(CredentialAdapterError::IdentityScope),
    })
}

pub(crate) fn policy_credential_binding(
    identity: &RequestIdentity,
    metadata: &CredentialMetadata,
) -> Result<CredentialBinding, CredentialAdapterError> {
    if metadata.owner != credential_owner(identity)? {
        return Err(CredentialAdapterError::OwnerMismatch);
    }
    let status = match metadata.status {
        CredentialStatus::Available => CredentialState::Available,
        CredentialStatus::Expired => CredentialState::Expired,
        CredentialStatus::Revoked => CredentialState::Revoked,
    };
    let expiry = metadata
        .expires_at
        .map_or(CredentialExpiry::Never, CredentialExpiry::At);
    Ok(CredentialBinding::Reference(ActionCredentialRef::new(
        metadata.credential_id.as_str(),
        ProviderId::new(&metadata.provider_id)?,
        status,
        metadata.revision,
        expiry,
    )?))
}

#[derive(Debug)]
pub(crate) enum CredentialAdapterError {
    IdentityScope,
    OwnerMismatch,
    Credential(CredentialStoreError),
    Policy(PolicyModelError),
    Resource(ResourceModelError),
}

impl From<CredentialStoreError> for CredentialAdapterError {
    fn from(error: CredentialStoreError) -> Self {
        Self::Credential(error)
    }
}

impl From<PolicyModelError> for CredentialAdapterError {
    fn from(error: PolicyModelError) -> Self {
        Self::Policy(error)
    }
}

impl From<ResourceModelError> for CredentialAdapterError {
    fn from(error: ResourceModelError) -> Self {
        Self::Resource(error)
    }
}

impl fmt::Display for CredentialAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IdentityScope => {
                formatter.write_str("credential adapter rejected identity scope")
            }
            Self::OwnerMismatch => formatter.write_str("credential adapter owner mismatch"),
            Self::Credential(error) => write!(formatter, "credential adapter store: {error}"),
            Self::Policy(error) => write!(formatter, "credential adapter policy: {error}"),
            Self::Resource(error) => write!(formatter, "credential adapter provider: {error}"),
        }
    }
}

impl std::error::Error for CredentialAdapterError {}
