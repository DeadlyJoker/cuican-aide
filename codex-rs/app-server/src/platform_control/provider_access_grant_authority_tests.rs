use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use crewon_state::ProviderIdentityBindingRevokeOutcome;
use crewon_state::ProviderIdentityBindingRevokeRequest;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;

use super::ConnectionRequestIdentity;
use super::authenticated_principal::AuthenticatedPrincipal;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::authenticated_principal::AuthenticatedPrincipalSource;
use super::authenticated_principal::AuthenticatedPrincipalSpec;
use super::provider_access_grant_authority::ProviderAccessGrantAuthorityError;
use super::provider_access_grant_authority::resolve_agent_platform_access_grant_authority;
use super::provider_access_grant_scope::agent_platform_scopes;
use super::provider_identity_adapter::ProviderIdentityAdapterError;
use super::provider_identity_adapter_tests::authenticated_identity;
use super::provider_identity_adapter_tests::authenticated_identity_in_space;
use super::provider_identity_adapter_tests::binding;
use super::provider_identity_adapter_tests::declared_client;
use super::provider_identity_adapter_tests::ready_mappings;
use crate::transport::ConnectionOrigin;

#[tokio::test]
async fn exact_grant_authority_replays_and_survives_state_restart() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("grant-authority-restart");
    let identity_binding = binding(&identity);
    assert_eq!(
        state
            .create_provider_identity_binding_record(&identity_binding)
            .await
            .expect("create identity binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );
    let grant = discovery_grant(&identity, /*expires_at*/ 190);
    assert_eq!(
        state
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create grant"),
        ProviderAccessGrantResolveOutcome::Created(grant.clone())
    );
    state.close().await;

    let reopened = initialized(&home).await;
    let first = resolve_agent_platform_access_grant_authority(
        &reopened, &identity, &ready, /*now*/ 150,
    )
    .await
    .expect("resolve after restart");
    let replay = resolve_agent_platform_access_grant_authority(
        &reopened, &identity, &ready, /*now*/ 151,
    )
    .await
    .expect("replay authority");
    assert_eq!(replay, first);
    assert_eq!(first.grant(), &grant);
    assert_eq!(
        format!("{:?}", first.provider_identity()),
        "ProviderAuthorizationIdentity([REDACTED])"
    );
    let debug = format!("{first:?}");
    for sensitive in [
        grant.local_actor_id.as_str(),
        grant.source_binding_id.as_str(),
        grant.granted_scopes[0].as_str(),
    ] {
        assert!(!debug.contains(sensitive));
    }

    reopened.close().await;
}

#[tokio::test]
async fn logout_context_drift_expiry_and_mapping_revoke_fail_closed() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("grant-authority-lifecycle");
    let identity_binding = binding(&identity);
    state
        .create_provider_identity_binding_record(&identity_binding)
        .await
        .expect("create identity binding");
    let grant = discovery_grant(&identity, /*expires_at*/ 190);
    state
        .resolve_provider_access_grant_record(&grant)
        .await
        .expect("create grant");

    let logged_out = ConnectionRequestIdentity::new(ConnectionOrigin::WebSocket)
        .derive(declared_client(), "grant-authority-logged-out".to_string());
    assert_eq!(
        resolve_agent_platform_access_grant_authority(
            &state,
            &logged_out,
            &ready,
            /*now*/ 150,
        )
        .await
        .expect_err("unauthenticated request rejected"),
        ProviderAccessGrantAuthorityError::Identity(ProviderIdentityAdapterError::Unauthenticated)
    );

    let other_space =
        authenticated_identity_in_space("grant-authority-context-switch", "space-local-2");
    assert_eq!(
        resolve_agent_platform_access_grant_authority(
            &state,
            &other_space,
            &ready,
            /*now*/ 150,
        )
        .await
        .expect_err("context switch rejected"),
        ProviderAccessGrantAuthorityError::Identity(ProviderIdentityAdapterError::MappingNotFound)
    );

    let source_drift =
        authenticated_identity_with_source_revision(declared_client(), /*source_revision*/ 2);
    assert_eq!(
        resolve_agent_platform_access_grant_authority(
            &state,
            &source_drift,
            &ready,
            /*now*/ 150,
        )
        .await
        .expect_err("source revision drift rejected"),
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::SessionBindingMismatch
        )
    );

    assert_eq!(
        resolve_agent_platform_access_grant_authority(&state, &identity, &ready, /*now*/ 190,)
            .await
            .expect_err("expired grant rejected"),
        ProviderAccessGrantAuthorityError::GrantNotFound
    );

    assert_eq!(
        state
            .revoke_provider_identity_binding_record(&ProviderIdentityBindingRevokeRequest {
                binding_id: identity_binding.binding_id,
                expected_revision: identity_binding.revision,
                authority_id: identity_binding.authority_id,
                source_revision: 2,
                source_fresh_until: 201,
                updated_at: 101,
            })
            .await
            .expect("revoke mapping"),
        ProviderIdentityBindingRevokeOutcome::Revoked
    );
    assert_eq!(
        resolve_agent_platform_access_grant_authority(&state, &identity, &ready, /*now*/ 150,)
            .await
            .expect_err("revoked mapping rejected"),
        ProviderAccessGrantAuthorityError::Identity(ProviderIdentityAdapterError::MappingNotFound)
    );

    state.close().await;
}

pub(super) fn discovery_grant(
    identity: &super::RequestIdentity,
    expires_at: i64,
) -> ProviderAccessGrantRecord {
    let reference = identity.reference();
    let principal = identity
        .authenticated_principal()
        .expect("authenticated principal");
    let AuthenticatedPrincipalBinding::AgentPlatform {
        source_binding_id,
        source_revision,
    } = principal.binding()
    else {
        panic!("Agent Platform principal binding");
    };
    let mut record = ProviderAccessGrantRecord {
        grant_id: "provider-grant:019f7400-0000-7000-8000-000000000001".to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: reference.tenant_id.clone().expect("tenant"),
        local_space_id: reference.space_id.clone().expect("space"),
        provider_id: "agent-platform".to_string(),
        source_binding_id: source_binding_id.clone(),
        source_revision: *source_revision,
        granted_scopes: agent_platform_scopes(),
        status: ProviderAccessGrantStatus::Active,
        expires_at,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        revoked_at: None,
    };
    record.record_hash = record.canonical_hash();
    record
}

fn authenticated_identity_with_source_revision(
    client: RequestIdentityClientRef,
    source_revision: u64,
) -> super::RequestIdentity {
    ConnectionRequestIdentity::new_authenticated(
        ConnectionOrigin::WebSocket,
        AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
            source: AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            issuer: "https://identity.example".to_string(),
            audience: "crewon-app-server".to_string(),
            subject: "identity-user-42".to_string(),
            tenant_id: "tenant-local-1".to_string(),
            space_id: "space-local-1".to_string(),
            token_id: "token-jti-redacted".to_string(),
            issued_at: 100,
            expires_at: 200,
            binding: AuthenticatedPrincipalBinding::AgentPlatform {
                source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
                source_revision,
            },
        })
        .expect("authenticated principal"),
    )
    .derive(client, "grant-authority-source-drift".to_string())
}

pub(super) async fn initialized(home: &tempfile::TempDir) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(home.path().to_path_buf(), "provider-test".to_string())
        .await
        .expect("initialize state")
}
