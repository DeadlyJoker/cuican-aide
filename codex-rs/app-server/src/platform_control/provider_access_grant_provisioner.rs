use crewon_provider_agent_platform::ProviderIdentitySourceOwner;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_provider_agent_platform::ProviderIdentitySourceStatus;
use crewon_state::ProviderAccessGrantOwnerLookup;
use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderAccessGrantRefreshOutcome;
use crewon_state::ProviderAccessGrantRefreshRequest;
use crewon_state::ProviderAccessGrantReplaceOutcome;
use crewon_state::ProviderAccessGrantReplaceRequest;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::StateRuntime;
use uuid::Uuid;

use super::provider_access_grant_scope::agent_platform_scopes;
use super::provider_access_grant_scope::has_exact_agent_platform_scopes;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";
const MAX_GRANT_ID_ATTEMPTS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderAccessGrantProvisionError {
    #[error("Provider access grant conflicts with current authority")]
    Conflict,
    #[error("Provider access grant capacity was exceeded")]
    CapacityExceeded,
    #[error("Provider access grant state is unavailable")]
    StateUnavailable,
}

pub(crate) async fn provision_agent_platform_access_grant(
    state: &StateRuntime,
    owner: &ProviderIdentitySourceOwner,
    snapshot: &ProviderIdentitySourceSnapshot,
    expires_at: i64,
    now: i64,
) -> Result<ProviderAccessGrantRecord, ProviderAccessGrantProvisionError> {
    require_exact_active_authority(owner, snapshot, expires_at, now)?;
    let lookup = owner_lookup(owner);
    if let Some(mut current) = current_grant(state, &lookup).await? {
        if matches_desired_authority(&current, snapshot) {
            for _ in 0..MAX_GRANT_ID_ATTEMPTS {
                if current.expires_at >= expires_at {
                    return Ok(current);
                }
                if current.expires_at <= now {
                    break;
                }
                match state
                    .refresh_provider_access_grant_record(&ProviderAccessGrantRefreshRequest {
                        grant_id: current.grant_id.clone(),
                        expected_revision: current.revision,
                        expected_expires_at: current.expires_at,
                        refreshed_expires_at: expires_at,
                        refreshed_at: now,
                    })
                    .await
                    .map_err(|_| ProviderAccessGrantProvisionError::StateUnavailable)?
                {
                    ProviderAccessGrantRefreshOutcome::Refreshed(record)
                    | ProviderAccessGrantRefreshOutcome::Existing(record) => return Ok(record),
                    ProviderAccessGrantRefreshOutcome::Conflict => {
                        let Some(latest) = current_grant(state, &lookup).await? else {
                            return Err(ProviderAccessGrantProvisionError::Conflict);
                        };
                        if latest.grant_id != current.grant_id
                            || latest.revision != current.revision
                            || !matches_desired_authority(&latest, snapshot)
                        {
                            return Err(ProviderAccessGrantProvisionError::Conflict);
                        }
                        current = latest;
                    }
                }
            }
            if current.expires_at > now {
                return Err(ProviderAccessGrantProvisionError::Conflict);
            }
        }
        for _ in 0..MAX_GRANT_ID_ATTEMPTS {
            let replacement = proposed_grant(owner, snapshot, expires_at, now);
            match state
                .replace_provider_access_grant_record(&ProviderAccessGrantReplaceRequest {
                    current_grant_id: current.grant_id.clone(),
                    expected_revision: current.revision,
                    replacement,
                    replaced_at: now,
                })
                .await
                .map_err(|_| ProviderAccessGrantProvisionError::StateUnavailable)?
            {
                ProviderAccessGrantReplaceOutcome::Replaced(record)
                | ProviderAccessGrantReplaceOutcome::Existing(record) => return Ok(record),
                ProviderAccessGrantReplaceOutcome::CapacityExceeded => {
                    return Err(ProviderAccessGrantProvisionError::CapacityExceeded);
                }
                ProviderAccessGrantReplaceOutcome::Conflict => {
                    let Some(latest) = current_grant(state, &lookup).await? else {
                        break;
                    };
                    if matches_desired_authority(&latest, snapshot)
                        && latest.expires_at == expires_at
                    {
                        return Ok(latest);
                    }
                    if latest.grant_id != current.grant_id || latest.revision != current.revision {
                        return Err(ProviderAccessGrantProvisionError::Conflict);
                    }
                }
            }
        }
        if let Some(current) = current_grant(state, &lookup).await? {
            if matches_desired_authority(&current, snapshot) && current.expires_at == expires_at {
                return Ok(current);
            }
            return Err(ProviderAccessGrantProvisionError::Conflict);
        }
    }

    for _ in 0..MAX_GRANT_ID_ATTEMPTS {
        let proposed = proposed_grant(owner, snapshot, expires_at, now);
        match state
            .resolve_provider_access_grant_record(&proposed)
            .await
            .map_err(|_| ProviderAccessGrantProvisionError::StateUnavailable)?
        {
            ProviderAccessGrantResolveOutcome::Created(record)
            | ProviderAccessGrantResolveOutcome::Existing(record) => return Ok(record),
            ProviderAccessGrantResolveOutcome::CapacityExceeded => {
                return Err(ProviderAccessGrantProvisionError::CapacityExceeded);
            }
            ProviderAccessGrantResolveOutcome::Conflict => {
                if let Some(current) = current_grant(state, &lookup).await? {
                    return if matches_desired_authority(&current, snapshot)
                        && current.expires_at == expires_at
                    {
                        Ok(current)
                    } else {
                        Err(ProviderAccessGrantProvisionError::Conflict)
                    };
                }
            }
        }
    }
    Err(ProviderAccessGrantProvisionError::StateUnavailable)
}

fn require_exact_active_authority(
    owner: &ProviderIdentitySourceOwner,
    snapshot: &ProviderIdentitySourceSnapshot,
    expires_at: i64,
    now: i64,
) -> Result<(), ProviderAccessGrantProvisionError> {
    let binding = snapshot.binding();
    if now < 0
        || expires_at <= now
        || binding.status() != ProviderIdentitySourceStatus::Active
        || binding.local_actor_id() != owner.actor_id()
        || binding.local_tenant_id() != owner.tenant_id()
        || binding.local_space_id() != owner.space_id()
    {
        return Err(ProviderAccessGrantProvisionError::Conflict);
    }
    Ok(())
}

fn owner_lookup(owner: &ProviderIdentitySourceOwner) -> ProviderAccessGrantOwnerLookup {
    ProviderAccessGrantOwnerLookup {
        local_actor_id: owner.actor_id().to_string(),
        local_tenant_id: owner.tenant_id().to_string(),
        local_space_id: owner.space_id().to_string(),
        provider_id: AGENT_PLATFORM_PROVIDER_ID.to_string(),
    }
}

async fn current_grant(
    state: &StateRuntime,
    lookup: &ProviderAccessGrantOwnerLookup,
) -> Result<Option<ProviderAccessGrantRecord>, ProviderAccessGrantProvisionError> {
    state
        .get_current_provider_access_grant_record(lookup)
        .await
        .map_err(|_| ProviderAccessGrantProvisionError::StateUnavailable)
}

fn matches_desired_authority(
    current: &ProviderAccessGrantRecord,
    snapshot: &ProviderIdentitySourceSnapshot,
) -> bool {
    current.status == ProviderAccessGrantStatus::Active
        && current.source_binding_id == snapshot.binding().source_binding_id()
        && current.source_revision == snapshot.binding().source_revision()
        && has_exact_agent_platform_scopes(&current.granted_scopes)
}

fn proposed_grant(
    owner: &ProviderIdentitySourceOwner,
    snapshot: &ProviderIdentitySourceSnapshot,
    expires_at: i64,
    now: i64,
) -> ProviderAccessGrantRecord {
    let mut record = ProviderAccessGrantRecord {
        grant_id: format!("provider-grant:{}", Uuid::now_v7()),
        local_actor_id: owner.actor_id().to_string(),
        local_tenant_id: owner.tenant_id().to_string(),
        local_space_id: owner.space_id().to_string(),
        provider_id: AGENT_PLATFORM_PROVIDER_ID.to_string(),
        source_binding_id: snapshot.binding().source_binding_id().to_string(),
        source_revision: snapshot.binding().source_revision(),
        granted_scopes: agent_platform_scopes(),
        status: ProviderAccessGrantStatus::Active,
        expires_at,
        revision: 1,
        record_hash: String::new(),
        created_at: now,
        updated_at: now,
        revoked_at: None,
    };
    record.record_hash = record.canonical_hash();
    record
}
