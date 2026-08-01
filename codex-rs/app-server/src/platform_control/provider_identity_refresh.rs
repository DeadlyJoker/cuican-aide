use crewon_provider_agent_platform::ProviderIdentitySourceBinding;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_provider_agent_platform::ProviderIdentitySourceStatus;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::ProviderIdentityBindingRefreshOutcome;
use crewon_state::ProviderIdentityBindingRefreshRequest;
use crewon_state::ProviderIdentityBindingRevokeOutcome;
use crewon_state::ProviderIdentityBindingRevokeRequest;
use crewon_state::ProviderIdentityBindingStatus;
use crewon_state::StateRuntime;

const AUTHORITY_ID: &str = "agent-platform-identity";
const PROVIDER_ID: &str = "agent-platform";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderIdentityRefreshError {
    #[error("provider identity source owner does not match local authority")]
    OwnerMismatch,
    #[error("provider identity source conflicts with local state")]
    Conflict,
    #[error("provider identity local state is unavailable")]
    StateUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderIdentityRefreshOutcome {
    Created,
    ExistingFresh,
    Refreshed,
    Revoked,
    ExistingRevoked,
    AbsentRevoked,
}

pub(crate) async fn apply_provider_identity_source_snapshot(
    state: &StateRuntime,
    expected_owner: &ProviderIdentityBindingLookup,
    snapshot: &ProviderIdentitySourceSnapshot,
) -> Result<ProviderIdentityRefreshOutcome, ProviderIdentityRefreshError> {
    let binding = snapshot.binding();
    require_expected_owner(expected_owner, binding)?;
    let binding_id = binding.source_binding_id();
    let current = state
        .get_provider_identity_binding_record(binding_id)
        .await
        .map_err(|_| ProviderIdentityRefreshError::StateUnavailable)?;

    match (binding.status(), current) {
        (ProviderIdentitySourceStatus::Active, None) => {
            let record = active_record(binding, snapshot.fresh_until());
            match state
                .create_provider_identity_binding_record(&record)
                .await
                .map_err(|_| ProviderIdentityRefreshError::StateUnavailable)?
            {
                ProviderIdentityBindingCreateOutcome::Created => {
                    Ok(ProviderIdentityRefreshOutcome::Created)
                }
                ProviderIdentityBindingCreateOutcome::ExistingSame => {
                    Ok(ProviderIdentityRefreshOutcome::ExistingFresh)
                }
                ProviderIdentityBindingCreateOutcome::Conflict => {
                    Err(ProviderIdentityRefreshError::Conflict)
                }
            }
        }
        (ProviderIdentitySourceStatus::Active, Some(current)) => {
            require_same_immutable_identity(&current, binding)?;
            if current.status != ProviderIdentityBindingStatus::Active
                || current.source_revision != binding.source_revision()
                || current.updated_at != binding.updated_at()
            {
                return Err(ProviderIdentityRefreshError::Conflict);
            }
            match state
                .refresh_provider_identity_binding_record(&ProviderIdentityBindingRefreshRequest {
                    binding_id: current.binding_id,
                    expected_revision: current.revision,
                    authority_id: AUTHORITY_ID.to_string(),
                    source_binding_id: binding.source_binding_id().to_string(),
                    source_revision: binding.source_revision(),
                    source_fresh_until: snapshot.fresh_until(),
                })
                .await
                .map_err(|_| ProviderIdentityRefreshError::StateUnavailable)?
            {
                ProviderIdentityBindingRefreshOutcome::Refreshed => {
                    Ok(ProviderIdentityRefreshOutcome::Refreshed)
                }
                ProviderIdentityBindingRefreshOutcome::ExistingFresh => {
                    Ok(ProviderIdentityRefreshOutcome::ExistingFresh)
                }
                ProviderIdentityBindingRefreshOutcome::NotFound
                | ProviderIdentityBindingRefreshOutcome::Conflict => {
                    Err(ProviderIdentityRefreshError::Conflict)
                }
            }
        }
        (ProviderIdentitySourceStatus::Revoked, None) => {
            Ok(ProviderIdentityRefreshOutcome::AbsentRevoked)
        }
        (ProviderIdentitySourceStatus::Revoked, Some(current)) => {
            require_same_immutable_identity(&current, binding)?;
            if current.status == ProviderIdentityBindingStatus::Revoked {
                if current.source_revision == binding.source_revision()
                    && current.source_fresh_until == snapshot.fresh_until()
                    && current.updated_at == binding.updated_at()
                {
                    return Ok(ProviderIdentityRefreshOutcome::ExistingRevoked);
                }
                return Err(ProviderIdentityRefreshError::Conflict);
            }
            match state
                .revoke_provider_identity_binding_record(&ProviderIdentityBindingRevokeRequest {
                    binding_id: current.binding_id,
                    expected_revision: current.revision,
                    authority_id: AUTHORITY_ID.to_string(),
                    source_revision: binding.source_revision(),
                    source_fresh_until: snapshot.fresh_until(),
                    updated_at: binding.updated_at(),
                })
                .await
                .map_err(|_| ProviderIdentityRefreshError::StateUnavailable)?
            {
                ProviderIdentityBindingRevokeOutcome::Revoked => {
                    Ok(ProviderIdentityRefreshOutcome::Revoked)
                }
                ProviderIdentityBindingRevokeOutcome::ExistingRevoked => {
                    Ok(ProviderIdentityRefreshOutcome::ExistingRevoked)
                }
                ProviderIdentityBindingRevokeOutcome::NotFound
                | ProviderIdentityBindingRevokeOutcome::Conflict => {
                    Err(ProviderIdentityRefreshError::Conflict)
                }
            }
        }
    }
}

fn require_expected_owner(
    expected: &ProviderIdentityBindingLookup,
    binding: &ProviderIdentitySourceBinding,
) -> Result<(), ProviderIdentityRefreshError> {
    if expected.provider_id != PROVIDER_ID
        || expected.local_actor_id != binding.local_actor_id()
        || expected.local_tenant_id != binding.local_tenant_id()
        || expected.local_space_id != binding.local_space_id()
    {
        return Err(ProviderIdentityRefreshError::OwnerMismatch);
    }
    Ok(())
}

fn require_same_immutable_identity(
    current: &ProviderIdentityBindingRecord,
    source: &ProviderIdentitySourceBinding,
) -> Result<(), ProviderIdentityRefreshError> {
    if current.local_actor_id != source.local_actor_id()
        || current.local_tenant_id != source.local_tenant_id()
        || current.local_space_id != source.local_space_id()
        || current.provider_id != PROVIDER_ID
        || current.provider_subject != source.provider_subject()
        || current.provider_tenant_id != source.provider_tenant_id()
        || current.provider_space_id != source.provider_space_id()
        || current.authority_id != AUTHORITY_ID
        || current.source_binding_id != source.source_binding_id()
        || current.created_at != source.created_at()
    {
        return Err(ProviderIdentityRefreshError::Conflict);
    }
    Ok(())
}

fn active_record(
    binding: &ProviderIdentitySourceBinding,
    source_fresh_until: i64,
) -> ProviderIdentityBindingRecord {
    let mut record = ProviderIdentityBindingRecord {
        binding_id: binding.source_binding_id().to_string(),
        local_actor_id: binding.local_actor_id().to_string(),
        local_tenant_id: binding.local_tenant_id().to_string(),
        local_space_id: binding.local_space_id().to_string(),
        provider_id: PROVIDER_ID.to_string(),
        provider_subject: binding.provider_subject().to_string(),
        provider_tenant_id: binding.provider_tenant_id().to_string(),
        provider_space_id: binding.provider_space_id().to_string(),
        authority_id: AUTHORITY_ID.to_string(),
        source_binding_id: binding.source_binding_id().to_string(),
        source_revision: binding.source_revision(),
        source_fresh_until,
        revision: 1,
        status: ProviderIdentityBindingStatus::Active,
        record_hash: String::new(),
        created_at: binding.created_at(),
        updated_at: binding.updated_at(),
    };
    record.record_hash = record.canonical_hash();
    record
}
