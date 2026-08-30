use crewon_policy::ActionCredentialRef;
use crewon_policy::CredentialBinding;
use crewon_policy::CredentialExpiry;
use crewon_policy::CredentialState;
use crewon_resource_federation::ProviderId;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderConnectionRecord;
use crewon_state::ProviderConnectionResolveOutcome;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceKind;
use pretty_assertions::assert_eq;

use super::StateDynamicToolCredentialResolver;
use crate::platform_control::dynamic_tool_router::ports::DynamicToolCredentialRequest;
use crate::platform_control::dynamic_tool_router::ports::DynamicToolCredentialResolver;
use crate::platform_control::dynamic_tool_router::ports::DynamicToolPortError;
use crate::platform_control::dynamic_tool_router_tests::binding as resource_binding;
use crate::platform_control::provider_access_grant_authority_tests::discovery_grant;
use crate::platform_control::provider_access_grant_authority_tests::initialized;
use crate::platform_control::provider_connection_descriptor::ProviderConnectionClock;
use crate::platform_control::provider_identity_adapter_tests::authenticated_identity;
use crate::platform_control::provider_identity_adapter_tests::binding as identity_binding;
use crate::platform_control::provider_identity_adapter_tests::ready_mappings;

#[tokio::test]
async fn provider_credential_freezes_live_grant_connection_and_identity_mapping() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("dynamic-credential");
    let mapping = identity_binding(&identity);
    assert_eq!(
        state
            .create_provider_identity_binding_record(&mapping)
            .await
            .expect("create identity mapping"),
        ProviderIdentityBindingCreateOutcome::Created
    );
    let grant = discovery_grant(&identity, /*expires_at*/ 190);
    assert_eq!(
        state
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create access grant"),
        ProviderAccessGrantResolveOutcome::Created(grant.clone())
    );
    let connection = connection(&identity, &grant.grant_id, grant.revision);
    assert_eq!(
        state
            .resolve_provider_connection_record(&connection)
            .await
            .expect("create connection"),
        ProviderConnectionResolveOutcome::Created(connection.clone())
    );
    let binding = binding_for_identity(&identity, &connection.connection_id);
    let clock = FixedClock(/*now*/ 150);
    let resolver = StateDynamicToolCredentialResolver::new(state.as_ref(), &ready, &clock);

    let snapshot = resolver
        .resolve_credential(DynamicToolCredentialRequest { identity, binding })
        .await
        .expect("resolve exact provider credential");

    assert_eq!(snapshot.credential_id(), Some(grant.grant_id.as_str()));
    assert_eq!(snapshot.revision(), Some(grant.revision));
    let provider_identity = snapshot.provider_identity().expect("provider identity");
    assert_eq!(provider_identity.binding_id, mapping.binding_id);
    assert_eq!(provider_identity.binding_revision, mapping.revision);
    assert_eq!(provider_identity.subject, mapping.provider_subject);
    assert_eq!(provider_identity.tenant_id, mapping.provider_tenant_id);
    assert_eq!(provider_identity.space_id, mapping.provider_space_id);
    assert_eq!(
        snapshot.policy_binding(),
        CredentialBinding::Reference(
            ActionCredentialRef::new(
                grant.grant_id,
                ProviderId::new("agent-platform").expect("provider"),
                CredentialState::Available,
                grant.revision,
                CredentialExpiry::At(190),
            )
            .expect("expected credential")
        )
    );

    state.close().await;
}

#[tokio::test]
async fn credential_scope_and_connection_drift_fail_closed() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("dynamic-credential-drift");
    let mapping = identity_binding(&identity);
    state
        .create_provider_identity_binding_record(&mapping)
        .await
        .expect("create identity mapping");
    let mut grant = discovery_grant(&identity, /*expires_at*/ 190);
    grant.granted_scopes = vec!["provider.discovery".to_string()];
    grant.record_hash = grant.canonical_hash();
    state
        .resolve_provider_access_grant_record(&grant)
        .await
        .expect("create legacy grant");
    let connection = connection(&identity, &grant.grant_id, grant.revision);
    state
        .resolve_provider_connection_record(&connection)
        .await
        .expect("create connection");
    let binding = binding_for_identity(&identity, &connection.connection_id);
    let clock = FixedClock(/*now*/ 150);
    let resolver = StateDynamicToolCredentialResolver::new(state.as_ref(), &ready, &clock);
    assert_eq!(
        resolver
            .resolve_credential(DynamicToolCredentialRequest {
                identity: identity.clone(),
                binding: binding.clone(),
            })
            .await
            .expect_err("legacy discovery-only grant rejected"),
        DynamicToolPortError::Unauthorized
    );

    let provider_binding = binding_for_identity(&identity, &connection.connection_id);
    let mut local = resource_binding(
        ProviderResourceKind::McpTool,
        ProviderResourceBindingMode::LocalSnapshot,
    );
    local
        .local_actor_id
        .clone_from(&provider_binding.local_actor_id);
    local
        .local_tenant_id
        .clone_from(&provider_binding.local_tenant_id);
    local
        .local_space_id
        .clone_from(&provider_binding.local_space_id);
    local
        .connection_id
        .clone_from(&provider_binding.connection_id);
    local.record_hash = local.canonical_hash();
    assert_eq!(
        resolver
            .resolve_credential(DynamicToolCredentialRequest {
                identity,
                binding: local,
            })
            .await
            .expect_err("local materialization is outside the Provider dynamic router"),
        DynamicToolPortError::Unauthorized
    );

    state.close().await;
}

fn binding_for_identity(
    identity: &crate::platform_control::RequestIdentity,
    connection_id: &str,
) -> crewon_state::ProviderResourceBindingRecord {
    let reference = identity.reference();
    let mut binding = resource_binding(
        ProviderResourceKind::McpTool,
        ProviderResourceBindingMode::ProviderManaged,
    );
    binding.local_actor_id = reference.actor_id.clone();
    binding.local_tenant_id = reference.tenant_id.clone().expect("tenant");
    binding.local_space_id = reference.space_id.clone().expect("space");
    binding.connection_id = connection_id.to_string();
    binding.record_hash = binding.canonical_hash();
    binding
}

fn connection(
    identity: &crate::platform_control::RequestIdentity,
    credential_id: &str,
    credential_revision: u64,
) -> ProviderConnectionRecord {
    let reference = identity.reference();
    let mut record = ProviderConnectionRecord {
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: reference.tenant_id.clone().expect("tenant"),
        local_space_id: reference.space_id.clone().expect("space"),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        credential_id: credential_id.to_string(),
        credential_revision,
        record_hash: String::new(),
        created_at: 120,
    };
    record.record_hash = record.canonical_hash();
    record
}

struct FixedClock(i64);

impl ProviderConnectionClock for FixedClock {
    fn now(&self) -> i64 {
        self.0
    }
}
